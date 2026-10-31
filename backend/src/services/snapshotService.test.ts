import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import * as tar from 'tar';
import { randomBytes } from 'crypto';

// Point the app's data root at a throwaway dir BEFORE loading config/store, then
// require the modules so they read this env. (require runs here, after the env
// is set, unlike hoisted imports.)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdash-snap-'));
process.env.DATA_ROOT = TMP;
// Pin the SQLite DB inside the temp dir too, so a fixed SQLITE_PATH in a local
// .env can't leak state between test runs.
process.env.SQLITE_PATH = path.join(TMP, 'test.sqlite');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createSnapshot, restoreSnapshot, deleteSnapshot, importSnapshotArchive, cancelSnapshot, SnapshotCancelledError } = require('./snapshotService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { purgeServerData } = require('./prepareService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { serverStore } = require('../serverStore');
const snapshotJobs = require('./snapshotJobStore');
const { getSnapshotJob, beginSnapshotJob } = snapshotJobs;

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

test('snapshot can be cancelled before file checks without touching server data', async () => {
  const id = 'cancel-before-check';
  writeFile(id, 'world/level.dat', 'CURRENT');
  const pending = createSnapshot(fakeServer(id));
  const startedAt = getSnapshotJob(id).startedAt;
  assert.equal(cancelSnapshot(id, 'stale-job'), null);
  assert.equal(cancelSnapshot(id, startedAt).cancelRequested, true);
  await assert.rejects(pending, SnapshotCancelledError);
  assert.equal(getSnapshotJob(id).status, 'cancelled');
  assert.equal(cancelSnapshot(id, startedAt).status, 'cancelled');
  assert.equal(serverStore.listSnapshots(id).length, 0);
  assert.equal(fs.readFileSync(path.join(serverRoot(id), 'world/level.dat'), 'utf8'), 'CURRENT');
  await createSnapshot(fakeServer(id));
  assert.equal(getSnapshotJob(id).status, 'completed');
  assert.equal(getSnapshotJob(id).cancelRequested, false);
});

test('cancel while saving waits for the save operation and then re-enables autosaving', async t => {
  const id = 'cancel-flushing';
  writeFile(id, 'world/level.dat', 'CURRENT');
  let release!: () => void;
  let entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const flushing = new Promise<void>(resolve => { entered = resolve; });
  const commands: string[][] = [];
  t.mock.method(require('./rconService'), 'runServerRcon', async (_server: any, batch: string[]) => {
    commands.push(batch);
    if (batch[0] === 'save-off') { entered(); await hold; }
    return ['ok'];
  });
  const pending = createSnapshot({ ...fakeServer(id), status: 'running' });
  const rejected = assert.rejects(pending, SnapshotCancelledError);
  try {
    await flushing;
    cancelSnapshot(id, getSnapshotJob(id).startedAt);
    assert.equal(getSnapshotJob(id).status, 'running');
    assert.equal(getSnapshotJob(id).cancelRequested, true);
  } finally { release(); }
  await rejected;
  assert.deepEqual(commands, [['save-off', 'save-all flush'], ['save-on']]);
  assert.equal(getSnapshotJob(id).status, 'cancelled');
  assert.deepEqual(fs.readdirSync(path.join(serverRoot(id), 'snapshots')), []);
});

test('cancel endpoint aborts a live archive and retains the lock until cleanup and save-on finish', async t => {
  const id = 'cancel-archive';
  writeFile(id, 'world/level.dat', 'CURRENT');
  // Incompressible data keeps the real archive worker busy long enough to
  // cancel after it reports actual disk writes.
  fs.writeFileSync(path.join(serverRoot(id), 'world/region.dat'), randomBytes(64 * 1024 * 1024));
  let release!: () => void;
  let entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const resuming = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(require('./rconService'), 'runServerRcon', async (_server: any, batch: string[]) => {
    if (batch[0] === 'save-on') { entered(); await hold; }
    return ['ok'];
  });
  const { default: router } = require('../routes/servers');
  const route = (routePath: string) => router.stack.find((layer: any) => layer.route?.path === routePath && layer.route.methods.post).route.stack[0].handle;
  const reply = () => ({ code: 200, body: null as any, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; } });
  const { lifecycleBusy } = require('../state');
  t.mock.method(serverStore, 'get', () => ({ ...fakeServer(id), status: 'running' }));
  const created = reply();
  await route('/:id/snapshots')({ params: { id }, body: { background: true } }, created);
  const startedAt = created.body.startedAt;
  try {
    const deadline = Date.now() + 5000;
    while (!getSnapshotJob(id).bytesProcessed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(getSnapshotJob(id).bytesProcessed > 0);
    assert.equal(getSnapshotJob(id).phase, 'archiving');
    const stale = reply();
    route('/:id/snapshots/job/cancel')({ params: { id }, body: { startedAt: 'older-job' } }, stale);
    assert.equal(stale.code, 409);
    const cancelled = reply();
    route('/:id/snapshots/job/cancel')({ params: { id }, body: { startedAt } }, cancelled);
    assert.equal(cancelled.code, 202);
    assert.equal(cancelled.body.cancelRequested, true);
    await resuming;
    assert.equal(lifecycleBusy.has(id), true);
    assert.equal(getSnapshotJob(id).status, 'running');
    assert.equal(getSnapshotJob(id).phase, 'resuming');
    assert.equal(serverStore.listSnapshots(id).length, 0);
  } finally { release(); }
  const deadline = Date.now() + 5000;
  while (lifecycleBusy.has(id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(lifecycleBusy.has(id), false);
  assert.equal(getSnapshotJob(id).status, 'cancelled');
  assert.deepEqual(fs.readdirSync(path.join(serverRoot(id), 'snapshots')), []);
  assert.equal(fs.readFileSync(path.join(serverRoot(id), 'world/level.dat'), 'utf8'), 'CURRENT');
});

test('cancellation never hides a failure to re-enable autosaving', async t => {
  const id = 'cancel-save-on-failure';
  writeFile(id, 'world/level.dat', 'CURRENT');
  t.mock.method(require('./rconService'), 'runServerRcon', async (_server: any, batch: string[]) => {
    if (batch[0] === 'save-on') return null;
    cancelSnapshot(id, getSnapshotJob(id).startedAt);
    return ['ok'];
  });
  await assert.rejects(createSnapshot({ ...fakeServer(id), status: 'running' }), /Run save-on/);
  assert.equal(getSnapshotJob(id).status, 'failed');
  assert.match(getSnapshotJob(id).error, /Run save-on/);
  assert.deepEqual(fs.readdirSync(path.join(serverRoot(id), 'snapshots')), []);
});

test('a restore and its safety backup cannot be cancelled through snapshot cancellation', () => {
  beginSnapshotJob('restore-not-cancellable', 'restore', 'snapshot');
  assert.equal(cancelSnapshot('restore-not-cancellable', getSnapshotJob('restore-not-cancellable').startedAt), null);
  assert.equal(getSnapshotJob('restore-not-cancellable').cancelRequested, false);
  snapshotJobs.finishSnapshotJob('restore-not-cancellable', null, 'test finished');
});

test('snapshot status reports stages and actual archive bytes, prevents duplicates and records completion', async t => {
  const id = 'job-completion';
  writeFile(id, 'world/level.dat', 'world data');
  const progress: any[] = [];
  const update = snapshotJobs.updateSnapshotProgress;
  t.mock.method(snapshotJobs, 'updateSnapshotProgress', (...args: any[]) => {
    update(...args);
    progress.push(getSnapshotJob(id));
  });
  const pending = createSnapshot(fakeServer(id));
  assert.equal(getSnapshotJob(id).status, 'running');
  assert.equal(getSnapshotJob(id).phase, 'checking-files');
  assert.equal(serverStore.listSnapshots(id).length, 0);
  await assert.rejects(createSnapshot(fakeServer(id)), /already being created/);
  assert.equal(getSnapshotJob(id).status, 'running');
  const snapshot = await pending;
  assert.equal(getSnapshotJob(id).status, 'completed');
  assert.equal(getSnapshotJob(id).snapshotId, snapshot.id);
  assert.ok(getSnapshotJob(id).finishedAt);
  assert.equal(serverStore.listSnapshots(id).length, 1);
  assert.deepEqual([...new Set(progress.map(job => job.phase))], ['flushing', 'archiving', 'resuming', 'finalizing']);
  assert.ok(progress.every(job => job.status === 'running' && job.operation === 'create'));
  assert.ok(progress.some(job => job.phase === 'archiving' && job.bytesProcessed === snapshot.sizeBytes));
  assert.equal(getSnapshotJob(id).bytesProcessed, snapshot.sizeBytes);
  assert.equal(getSnapshotJob(id).totalBytes, null, 'compressed size is not known in advance');
});

test('snapshot remains in progress until autosaving is confirmed, even after all bytes are written', async t => {
  const id = 'snapshot-resuming';
  writeFile(id, 'pack/world/level.dat', 'current world');
  let release!: () => void;
  let reachedResume!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const resuming = new Promise<void>(resolve => { reachedResume = resolve; });
  t.mock.method(require('./rconService'), 'runServerRcon', async (_server: any, batch: string[]) => {
    if (batch[0] === 'save-off') {
      assert.equal(getSnapshotJob(id).phase, 'flushing');
    } else {
      reachedResume();
      await hold;
    }
    return ['ok'];
  });
  const pending = createSnapshot({ ...fakeServer(id), status: 'running' });
  try {
    await resuming;
    const job = getSnapshotJob(id);
    assert.equal(job.status, 'running');
    assert.equal(job.phase, 'resuming');
    assert.ok(job.bytesProcessed > 0);
    assert.equal(serverStore.listSnapshots(id).length, 0);
  } finally { release(); }
  const snapshot = await pending;
  assert.equal(getSnapshotJob(id).status, 'completed');
  assert.equal(getSnapshotJob(id).bytesProcessed, snapshot.sizeBytes);
});

test('snapshot failure remains available and a successful retry replaces it', async () => {
  const id = 'job-failure';
  await assert.rejects(createSnapshot(fakeServer(id)), /no data on disk/);
  assert.equal(getSnapshotJob(id).status, 'failed');
  assert.match(getSnapshotJob(id).error, /no data on disk/);
  assert.equal(serverStore.listSnapshots(id).length, 0);
  writeFile(id, 'world/level.dat', 'recovered');
  await createSnapshot(fakeServer(id));
  assert.equal(getSnapshotJob(id).status, 'completed');
  assert.equal(getSnapshotJob(id).error, null);
});

test('backend initialization marks persisted unfinished jobs as interrupted', () => {
  beginSnapshotJob('interrupted-job');
  beginSnapshotJob('interrupted-restore', 'restore', 'original-snapshot');
  snapshotJobs.setSafetySnapshot('interrupted-restore', 'safety-copy');
  delete require.cache[require.resolve('./snapshotJobStore')];
  const reloaded = require('./snapshotJobStore');
  assert.equal(reloaded.getSnapshotJob('interrupted-job').status, 'failed');
  assert.match(reloaded.getSnapshotJob('interrupted-job').error, /backend restart/);
  assert.equal(reloaded.getSnapshotJob('job-completion').status, 'completed');
  assert.equal(reloaded.getSnapshotJob('interrupted-restore').status, 'failed');
  assert.match(reloaded.getSnapshotJob('interrupted-restore').error, /Keep the server stopped/);
  assert.equal(reloaded.getSnapshotJob('interrupted-restore').safetySnapshotId, 'safety-copy');
});

test('background snapshot endpoint responds before completion and status survives another request', async t => {
  const id = 'background-request';
  writeFile(id, 'world/level.dat', 'world data');
  const { default: router } = require('../routes/servers');
  const route = (method: string, routePath: string) => router.stack.find((layer: any) => layer.route?.path === routePath && layer.route.methods[method]).route.stack[0].handle;
  t.mock.method(serverStore, 'get', () => fakeServer(id));
  const reply = () => ({ code: 200, body: null as any, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; }, setHeader() {} });
  const res = reply();
  await route('post', '/:id/snapshots')({ params: { id }, body: { background: true } }, res);
  assert.equal(res.code, 202);
  assert.equal(res.body.status, 'running');
  const duplicate = reply();
  await route('post', '/:id/snapshots')({ params: { id }, body: { background: true } }, duplicate);
  assert.equal(duplicate.code, 409);
  const deadline = Date.now() + 5000;
  while (getSnapshotJob(id).status === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  const later = reply();
  route('get', '/:id/snapshots/job')({ params: { id } }, later);
  assert.equal(later.body.status, 'completed');
  assert.ok(serverStore.getSnapshot(later.body.snapshotId));
});

test('snapshot + restore reports real progress, round-trips full server data and preserves history', async t => {
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

  const progress: any[] = [];
  const updateProgress = snapshotJobs.updateSnapshotProgress;
  t.mock.method(snapshotJobs, 'updateSnapshotProgress', (...args: any[]) => {
    updateProgress(...args);
    progress.push(getSnapshotJob(id));
  });
  const pending = restoreSnapshot(fakeServer(id), snap.id);
  assert.equal(getSnapshotJob(id).operation, 'restore');
  assert.equal(getSnapshotJob(id).status, 'running');
  await assert.rejects(restoreSnapshot(fakeServer(id), snap.id), /already being created/);
  const result = await pending;
  assert.equal(result.safetySnapshot.kind, 'auto-pre-restore');
  assert.deepEqual([...new Set(progress.map(job => job.phase))], ['validating', 'backup', 'clearing', 'extracting', 'permissions']);
  assert.ok(progress.every(job => job.status === 'running' && job.operation === 'restore'));
  for (const phase of ['validating', 'extracting']) {
    assert.ok(progress.some(job => job.phase === phase && job.bytesProcessed === snap.sizeBytes && job.totalBytes === snap.sizeBytes));
  }
  assert.ok(progress.some(job => job.phase === 'backup' && job.bytesProcessed > 0));
  assert.equal(getSnapshotJob(id).status, 'completed');
  assert.equal(getSnapshotJob(id).snapshotId, snap.id);
  assert.equal(getSnapshotJob(id).safetySnapshotId, result.safetySnapshot.id);

  // Original content is restored exactly...
  assert.equal(fs.readFileSync(path.join(serverRoot(id), 'world/level.dat'), 'utf8'), 'ORIGINAL');
  assert.equal(fs.readFileSync(path.join(serverRoot(id), 'mods/cool.jar'), 'utf8'), 'JARDATA');
  // ...and files created after the snapshot are gone.
  assert.ok(!fs.existsSync(path.join(serverRoot(id), 'world/junk.dat')));

  // History is preserved: the original snapshot + the pre-restore safety backup.
  assert.equal(serverStore.listSnapshots(id).length, 2);
  // The faster-compressed safety archive remains restorable too.
  await restoreSnapshot(fakeServer(id), result.safetySnapshot.id);
  assert.equal(fs.readFileSync(path.join(serverRoot(id), 'world/level.dat'), 'utf8'), 'CHANGED');
});

test('restore without a safety backup preserves validation, restores files, and skips the backup stage', async t => {
  const id = 'restore-no-backup';
  writeFile(id, 'world/level.dat', 'ORIGINAL');
  const snap = await createSnapshot(fakeServer(id));
  writeFile(id, 'world/level.dat', 'CURRENT');
  const phases: string[] = [];
  const update = snapshotJobs.updateSnapshotProgress;
  t.mock.method(snapshotJobs, 'updateSnapshotProgress', (...args: any[]) => { phases.push(args[1]); update(...args); });
  const result = await restoreSnapshot(fakeServer(id), snap.id, { createSafetySnapshot: false });
  assert.equal(result.safetySnapshot, null);
  assert.equal(getSnapshotJob(id).createSafetySnapshot, false);
  assert.equal(getSnapshotJob(id).safetySnapshotId, null);
  assert.deepEqual([...new Set(phases)], ['validating', 'clearing', 'extracting', 'permissions']);
  assert.equal(serverStore.listSnapshots(id).length, 1);
  assert.equal(fs.readFileSync(path.join(serverRoot(id), 'world/level.dat'), 'utf8'), 'ORIGINAL');
});

test('restore API accepts explicit opt-out and rejects non-boolean options', async t => {
  const id = 'restore-option-api';
  writeFile(id, 'world/level.dat', 'ORIGINAL');
  const snap = await createSnapshot(fakeServer(id));
  writeFile(id, 'world/level.dat', 'CURRENT');
  const { default: router } = require('../routes/servers');
  const handler = router.stack.find((layer: any) => layer.route?.path === '/:id/snapshots/:snapshotId/restore' && layer.route.methods.post).route.stack[0].handle;
  t.mock.method(serverStore, 'get', () => fakeServer(id));
  t.mock.method(serverStore, 'update', () => fakeServer(id));
  t.mock.method(require('./dockerService').dockerService, 'status', async () => 'stopped');
  for (const value of ['false', 0, null, false]) {
    const res = { code: 200, body: null as any, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; } };
    await handler({ params: { id, snapshotId: snap.id }, body: { createSafetySnapshot: value } }, res);
    assert.equal(res.code, value === false ? 200 : 400);
    if (value === false) assert.equal(res.body.safetySnapshot, null);
    else assert.equal(fs.readFileSync(path.join(serverRoot(id), 'world/level.dat'), 'utf8'), 'CURRENT');
  }
  assert.equal(serverStore.listSnapshots(id).length, 1);
});

test('failure without a backup does not promise an automatic recovery snapshot', async t => {
  const id = 'restore-no-backup-failure';
  writeFile(id, 'world/level.dat', 'ORIGINAL');
  const snap = await createSnapshot(fakeServer(id));
  const files = require('./serverFiles');
  const prepare = files.prepareServerFiles;
  t.mock.method(files, 'prepareServerFiles', (serverId: string, repair = true) => {
    if (repair) throw new Error('Permission repair failed');
    return prepare(serverId, repair);
  });
  await assert.rejects(restoreSnapshot(fakeServer(id), snap.id, { createSafetySnapshot: false }), /Permission repair failed/);
  assert.match(getSnapshotJob(id).error, /No safety backup was created/);
  assert.doesNotMatch(getSnapshotJob(id).error, /restore the automatic safety backup/);
});

for (const createSafetySnapshot of [true, false]) test(`a corrupt restore fails before replacing files (backup=${createSafetySnapshot})`, async () => {
  const id = `restore-corrupt-${createSafetySnapshot}`;
  writeFile(id, 'world/level.dat', 'ORIGINAL');
  const snap = await createSnapshot(fakeServer(id));
  writeFile(id, 'world/level.dat', 'CURRENT');
  fs.truncateSync(path.join(serverRoot(id), 'snapshots', snap.fileName), 32);
  await assert.rejects(restoreSnapshot(fakeServer(id), snap.id, { createSafetySnapshot }));
  assert.equal(getSnapshotJob(id).status, 'failed');
  assert.match(getSnapshotJob(id).error, /Existing server data has not been replaced/);
  assert.equal(fs.readFileSync(path.join(serverRoot(id), 'world/level.dat'), 'utf8'), 'CURRENT');
  assert.equal(serverStore.listSnapshots(id).length, 1);
});

test('failure after replacement retains the safety backup and recovery instructions', async t => {
  const id = 'restore-permissions-failure';
  writeFile(id, 'world/level.dat', 'ORIGINAL');
  const snap = await createSnapshot(fakeServer(id));
  writeFile(id, 'world/level.dat', 'CURRENT');
  const files = require('./serverFiles');
  const prepare = files.prepareServerFiles;
  t.mock.method(files, 'prepareServerFiles', (serverId: string, repair = true) => {
    if (repair) throw new Error('Permission repair failed');
    return prepare(serverId, repair);
  });
  await assert.rejects(restoreSnapshot(fakeServer(id), snap.id), /Permission repair failed/);
  const job = getSnapshotJob(id);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /Keep the server stopped/);
  const safety = serverStore.getSnapshot(job.safetySnapshotId);
  assert.ok(fs.existsSync(path.join(serverRoot(id), 'snapshots', safety.fileName)));
});

test('async restore retains its lifecycle lock and prevents deletion until completion', async t => {
  const id = 'restore-background';
  writeFile(id, 'world/level.dat', 'ORIGINAL');
  const snap = await createSnapshot(fakeServer(id));
  const { default: router } = require('../routes/servers');
  const route = (method: string, routePath: string) => router.stack.find((layer: any) => layer.route?.path === routePath && layer.route.methods[method]).route.stack[0].handle;
  const reply = () => ({ code: 200, body: null as any, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; } });
  t.mock.method(serverStore, 'get', () => fakeServer(id));
  t.mock.method(serverStore, 'update', () => fakeServer(id));
  t.mock.method(require('./dockerService').dockerService, 'status', async () => 'stopped');
  const files = require('./serverFiles');
  const prepare = files.prepareServerFiles;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(files, 'prepareServerFiles', async (...args: any[]) => { await held; return prepare(...args); });
  const res = reply();
  const params = { id, snapshotId: snap.id };
  await route('post', '/:id/snapshots/:snapshotId/restore')({ params, headers: { prefer: 'respond-async' } }, res);
  assert.equal(res.code, 202);
  const { lifecycleBusy } = require('../state');
  try {
    assert.equal(lifecycleBusy.has(id), true);
    const deletion = reply();
    await route('delete', '/:id/snapshots/:snapshotId')({ params }, deletion);
    assert.equal(deletion.code, 409);
    const duplicate = reply();
    await route('post', '/:id/snapshots/:snapshotId/restore')({ params }, duplicate);
    assert.equal(duplicate.code, 409);
  } finally { release(); }
  const { getServerOperation } = require('./serverOperationStore');
  const deadline = Date.now() + 5000;
  while (lifecycleBusy.has(id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(lifecycleBusy.has(id), false);
  assert.equal(getSnapshotJob(id).status, 'completed');
  assert.equal(getServerOperation(id, res.body.operationId).httpStatus, 200);
});

test('snapshot excludes the snapshots/ directory (no self-inclusion)', async () => {
  const id = 'srv-exclude';
  writeFile(id, 'world/level.dat', 'W');
  await createSnapshot(fakeServer(id), { label: 'first' });
  const second = await createSnapshot(fakeServer(id), { label: 'second' });

  const archive = path.join(serverRoot(id), 'snapshots', second.fileName);
  const paths: string[] = [];
  await tar.list({ file: archive, onentry: (entry) => paths.push(entry.path) });
  assert.ok(
    !paths.some((p) => p.replace(/^\.\//, '').split('/')[0] === 'snapshots'),
    `archive must not contain snapshots/:\n${paths.join('\n')}`
  );
});

test('import extracts a snapshot archive into a fresh server root', async () => {
  const source = 'srv-import-src';
  writeFile(source, 'pack/server.properties', 'level-seed=42\n');
  writeFile(source, 'pack/world/level.dat', 'WORLD');
  const snap = await createSnapshot(fakeServer(source), { label: 'export' });
  const archive = path.join(serverRoot(source), 'snapshots', snap.fileName);

  const target = 'srv-import-dst';
  await importSnapshotArchive(target, archive);

  // World + config land under the new server root, ready for recreateContainer.
  assert.equal(fs.readFileSync(path.join(serverRoot(target), 'pack/world/level.dat'), 'utf8'), 'WORLD');
  assert.equal(fs.readFileSync(path.join(serverRoot(target), 'pack/server.properties'), 'utf8'), 'level-seed=42\n');
});

test('import rejects an archive that is not a server snapshot (no pack/)', async () => {
  const bogus = path.join(TMP, 'bogus.tar.gz');
  const stray = fs.mkdtempSync(path.join(TMP, 'stray-'));
  fs.writeFileSync(path.join(stray, 'notes.txt'), 'hello');
  await tar.create({ gzip: true, file: bogus, cwd: stray, portable: true }, ['notes.txt']);

  await assert.rejects(() => importSnapshotArchive('srv-import-bad', bogus), /not a valid MC Dash server snapshot/);
});

test('purgeServerData removes the server root and the uploaded pack', async () => {
  const id = 'srv-purge';
  writeFile(id, 'pack/world/level.dat', 'W');
  const upload = path.join(TMP, 'uploads', `${id}-pack.zip`);
  fs.mkdirSync(path.dirname(upload), { recursive: true });
  fs.writeFileSync(upload, 'ZIP');

  await purgeServerData({ id, serverPackUrl: upload } as any);

  assert.ok(!fs.existsSync(serverRoot(id)), 'server root should be gone');
  assert.ok(!fs.existsSync(upload), 'uploaded pack should be gone');
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

test('partial flush failure always attempts save-on and does not record a successful backup', async t => {
  const rcon = require('./rconService');
  const id = 'partial-flush';
  writeFile(id, 'pack/world/level.dat', 'current world');
  const commands: string[][] = [];
  t.mock.method(rcon, 'runServerRcon', async (_server: any, batch: string[]) => {
    commands.push(batch);
    return batch[0] === 'save-on' ? ['Saving enabled'] : null;
  });
  await assert.rejects(createSnapshot({ ...fakeServer(id), status: 'running' }), /Could not flush/);
  assert.deepEqual(commands, [['save-off', 'save-all flush'], ['save-on']]);
  assert.equal(serverStore.listSnapshots(id).length, 0);
  assert.equal(getSnapshotJob(id).status, 'failed');
});

test('failure to restore autosaving is visible and never reported as a successful snapshot', async t => {
  const rcon = require('./rconService');
  const id = 'failed-save-on';
  writeFile(id, 'pack/world/level.dat', 'current world');
  t.mock.method(rcon, 'runServerRcon', async (_server: any, batch: string[]) =>
    batch[0] === 'save-on' ? null : ['Saving disabled', 'Saved']);
  await assert.rejects(createSnapshot({ ...fakeServer(id), status: 'running' }), /Run save-on/);
  assert.equal(serverStore.listSnapshots(id).length, 0);
  assert.deepEqual(fs.readdirSync(path.join(serverRoot(id), 'snapshots')), []);
});

test('archive failure still re-enables autosaving', async t => {
  const rcon = require('./rconService');
  const id = 'failed-archive-save-on';
  writeFile(id, 'pack/world/level.dat', 'current world');
  const commands: string[][] = [];
  t.mock.method(rcon, 'runServerRcon', async (_server: any, batch: string[]) => {
    commands.push(batch);
    if (batch[0] === 'save-off') fs.rmSync(path.join(serverRoot(id), 'snapshots'), { recursive: true });
    return ['ok'];
  });
  await assert.rejects(createSnapshot({ ...fakeServer(id), status: 'running' }));
  assert.deepEqual(commands, [['save-off', 'save-all flush'], ['save-on']]);
});

test('a failed progress update cannot prevent autosaving from being re-enabled', async t => {
  const id = 'failed-progress-save-on';
  writeFile(id, 'pack/world/level.dat', 'current world');
  const commands: string[][] = [];
  t.mock.method(require('./rconService'), 'runServerRcon', async (_server: any, batch: string[]) => {
    commands.push(batch);
    return ['ok'];
  });
  const update = snapshotJobs.updateSnapshotProgress;
  t.mock.method(snapshotJobs, 'updateSnapshotProgress', (...args: any[]) => {
    if (args[1] === 'resuming') throw new Error('Could not persist progress');
    return update(...args);
  });
  await assert.rejects(createSnapshot({ ...fakeServer(id), status: 'running' }), /Could not persist progress/);
  assert.deepEqual(commands, [['save-off', 'save-all flush'], ['save-on']]);
  assert.equal(getSnapshotJob(id).status, 'failed');
  assert.equal(serverStore.listSnapshots(id).length, 0);
  assert.deepEqual(fs.readdirSync(path.join(serverRoot(id), 'snapshots')), []);
});

test('snapshot rejects hard-linked working files before sending save-off', async t => {
  const rcon = require('./rconService');
  const id = 'unsafe-working-files';
  writeFile(id, 'pack/world/level.dat', 'current world');
  fs.linkSync(path.join(serverRoot(id), 'pack/world/level.dat'), path.join(serverRoot(id), 'pack/world/linked'));
  const send = t.mock.method(rcon, 'runServerRcon', async () => ['ok']);
  await assert.rejects(createSnapshot({ ...fakeServer(id), status: 'running' }), /Unsafe server file/);
  assert.equal(send.mock.calls.length, 0);
});
