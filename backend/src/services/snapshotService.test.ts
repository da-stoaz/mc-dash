import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';

// Point the app's data root at a throwaway dir BEFORE loading config/store, then
// require the modules so they read this env. (require runs here, after the env
// is set, unlike hoisted imports.)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdash-snap-'));
process.env.DATA_ROOT = TMP;
// Pin the SQLite DB inside the temp dir too, so a fixed SQLITE_PATH in a local
// .env can't leak state between test runs.
process.env.SQLITE_PATH = path.join(TMP, 'test.sqlite');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createSnapshot, restoreSnapshot, deleteSnapshot } = require('./snapshotService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { serverStore } = require('../serverStore');

after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

function serverRoot(id: string): string {
  return path.join(TMP, 'servers', id);
}

function writeFile(id: string, rel: string, content: string): void {
  const p = path.join(serverRoot(id), rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const fakeServer = (id: string) => ({ id, name: 'Test', status: 'stopped' }) as any;

test('snapshot + restore round-trips full server data and preserves history', async () => {
  const id = 'srv-roundtrip';
  writeFile(id, 'server.properties', 'online-mode=true\n');
  writeFile(id, 'world/level.dat', 'ORIGINAL');
  writeFile(id, 'mods/cool.jar', 'JARDATA');

  const snap = await createSnapshot(fakeServer(id), { label: 'v1' });
  assert.ok(snap.sizeBytes > 0);
  assert.ok(fs.existsSync(path.join(serverRoot(id), 'snapshots', snap.fileName)));

  // Mutate the live data after taking the snapshot.
  writeFile(id, 'world/level.dat', 'CHANGED');
  fs.rmSync(path.join(serverRoot(id), 'mods/cool.jar'));
  writeFile(id, 'world/junk.dat', 'JUNK');

  const result = await restoreSnapshot(fakeServer(id), snap.id);
  assert.equal(result.safetySnapshot.kind, 'auto-pre-restore');

  // Original content is restored exactly...
  assert.equal(fs.readFileSync(path.join(serverRoot(id), 'world/level.dat'), 'utf8'), 'ORIGINAL');
  assert.equal(fs.readFileSync(path.join(serverRoot(id), 'mods/cool.jar'), 'utf8'), 'JARDATA');
  // ...and files created after the snapshot are gone.
  assert.ok(!fs.existsSync(path.join(serverRoot(id), 'world/junk.dat')));

  // History is preserved: the original snapshot + the pre-restore safety backup.
  assert.equal(serverStore.listSnapshots(id).length, 2);
});

test('snapshot excludes the snapshots/ directory (no self-inclusion)', async () => {
  const id = 'srv-exclude';
  writeFile(id, 'world/level.dat', 'W');
  await createSnapshot(fakeServer(id), { label: 'first' });
  const second = await createSnapshot(fakeServer(id), { label: 'second' });

  const archive = path.join(serverRoot(id), 'snapshots', second.fileName);
  const listing = execFileSync('tar', ['--force-local', '-tzf', archive]).toString();
  assert.ok(!/(^|\/)snapshots\//m.test(listing), `archive must not contain snapshots/:\n${listing}`);
});

test('delete removes both the DB row and the archive file', async () => {
  const id = 'srv-delete';
  writeFile(id, 'world/level.dat', 'W');
  const snap = await createSnapshot(fakeServer(id));
  const archive = path.join(serverRoot(id), 'snapshots', snap.fileName);
  assert.ok(fs.existsSync(archive));

  assert.ok(await deleteSnapshot(fakeServer(id), snap.id));
  assert.ok(!fs.existsSync(archive));
  assert.equal(serverStore.getSnapshot(snap.id), null);
});
