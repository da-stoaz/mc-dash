import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Data and snapshot drive in throwaway dirs, set before config is loaded.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdash-backup-'));
const DRIVE = path.join(TMP, 'drive');
fs.mkdirSync(DRIVE);
process.env.DATA_ROOT = path.join(TMP, 'data');
process.env.SQLITE_PATH = path.join(TMP, 'test.sqlite');
process.env.SNAPSHOT_ROOT = DRIVE;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createSnapshot, snapshotFilePath, deleteSnapshot } = require('./snapshotService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runScheduledBackup, runDueBackups, setBackupSchedule, getBackupSchedule } = require('./backupScheduler');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { serverStore } = require('../serverStore');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rconService = require('./rconService');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const MARKER = path.join(DRIVE, '.mc-dash-snapshots');
beforeEach(() => fs.writeFileSync(MARKER, ''));

function newServer(status = 'stopped') {
  const created = serverStore.create({ name: `backup-${Math.random().toString(36).slice(2, 8)}`, resources: { minRamMb: 512, maxRamMb: 1024 }, game: {} });
  const server = serverStore.update(created.id, { status, packReady: true });
  writeFile(server.id, 'pack/world/level.dat', 'v1');
  return server;
}

function writeFile(id: string, rel: string, content: string): void {
  const file = path.join(process.env.DATA_ROOT!, 'servers', id, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const scheduled = (id: string) => serverStore.listSnapshots(id).filter((s: any) => s.kind === 'scheduled');
const HOUR = 60 * 60_000;

test('snapshots are written to the snapshot drive, not the server folder', async t => {
  t.mock.method(rconService, 'runServerRcon', async () => null);
  const server = newServer();
  const snapshot = await createSnapshot(server);
  assert.equal(snapshotFilePath(server.id, snapshot.fileName), path.join(DRIVE, server.id, snapshot.fileName));
  assert.ok(fs.existsSync(path.join(DRIVE, server.id, snapshot.fileName)));
  assert.ok(!fs.existsSync(path.join(process.env.DATA_ROOT!, 'servers', server.id, 'snapshots')));
});

test('an unmounted drive (no marker file) fails the snapshot instead of filling the local disk', async t => {
  t.mock.method(rconService, 'runServerRcon', async () => null);
  const server = newServer();
  fs.rmSync(MARKER);
  await assert.rejects(createSnapshot(server), /snapshot drive is not available/);
  assert.ok(!fs.existsSync(path.join(DRIVE, server.id)));
});

test('archives from before the drive was configured are still found in the server folder', async () => {
  const server = newServer();
  const legacy = path.join(process.env.DATA_ROOT!, 'servers', server.id, 'snapshots', 'old.tar.gz');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, 'x');
  assert.equal(snapshotFilePath(server.id, 'old.tar.gz'), legacy);
});

test('unchanged files keep the existing archive and only move its time forward', async t => {
  t.mock.method(rconService, 'runServerRcon', async () => null);
  const server = newServer();
  assert.equal(await runScheduledBackup(server, true), 'created');
  const [first] = scheduled(server.id);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(await runScheduledBackup(server, true), 'unchanged');
  const [again] = scheduled(server.id);
  assert.equal(scheduled(server.id).length, 1);
  assert.equal(again.id, first.id);
  assert.ok(again.createdAt > first.createdAt);

  writeFile(server.id, 'pack/world/level.dat', 'v2 with more bytes');
  assert.equal(await runScheduledBackup(server, true), 'created');
  assert.equal(scheduled(server.id).length, 2);
});

test('a running server is always archived, since its unsaved changes are not on disk yet', async t => {
  t.mock.method(rconService, 'runServerRcon', async () => ['Saved the game']);
  const server = newServer('running');
  assert.equal(await runScheduledBackup(server, false), 'created');
  assert.equal(await runScheduledBackup(server, false), 'created');
  assert.equal(scheduled(server.id)[0].fingerprint, null);
});

test('retention keeps the two newest scheduled snapshots and never touches manual ones', async t => {
  t.mock.method(rconService, 'runServerRcon', async () => null);
  const server = newServer();
  const manual = await createSnapshot(server, { label: 'mine' });
  for (let version = 1; version <= 4; version++) {
    writeFile(server.id, 'pack/world/level.dat', 'x'.repeat(version * 10));
    await runScheduledBackup(server, true);
  }
  const kept = scheduled(server.id);
  assert.equal(kept.length, 2);
  assert.ok(serverStore.getSnapshot(manual.id));
  const files = fs.readdirSync(path.join(DRIVE, server.id)).sort();
  assert.deepEqual(files, [manual.fileName, ...kept.map((s: any) => s.fileName)].sort());
  await deleteSnapshot(server, manual.id);
});

test('a due server is backed up once it has been stopped for a while, not while it is running', async t => {
  t.mock.method(rconService, 'runServerRcon', async () => ['Saved the game']);
  const stopped = newServer();
  const running = newServer('running');
  setBackupSchedule(stopped.id, 1);
  setBackupSchedule(running.id, 1);
  const start = Date.now();

  await runDueBackups(start);                       // first seen stopped: let it settle
  assert.equal(scheduled(stopped.id).length, 0);
  await runDueBackups(start + 11 * 60_000);
  assert.equal(scheduled(stopped.id).length, 1);
  assert.equal(scheduled(running.id).length, 0);    // waits for a stop

  await runDueBackups(start + 13 * HOUR);           // still running long after it was due
  assert.equal(scheduled(running.id).length, 1);

  const schedule = getBackupSchedule(stopped.id);
  assert.equal(schedule.intervalDays, 1);
  assert.ok(Date.parse(schedule.nextDueAt) - Date.parse(schedule.lastBackupAt) === 24 * HOUR);
  await runDueBackups(start + 12 * HOUR);           // not due again yet
  assert.equal(scheduled(stopped.id).length, 1);

  setBackupSchedule(stopped.id, null);
  assert.equal(getBackupSchedule(stopped.id).intervalDays, null);
});
