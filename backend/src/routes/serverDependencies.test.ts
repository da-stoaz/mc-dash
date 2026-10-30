import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-dash-lifecycle-test-'));
process.env.DATA_ROOT = root;
process.env.SQLITE_PATH = path.join(root, 'test.sqlite');
const { default: router } = require('./servers');
const { dockerService } = require('../services/dockerService');
const { serverStore } = require('../serverStore');
const prepare = require('../services/prepareService');
const { UserFacingError } = require('../apiErrors');
const { preparing } = require('../state');
const capacity = require('../services/hostCapacityService');
const { hibernationService } = require('../services/hibernationService');
after(() => fs.rmSync(root, { recursive: true, force: true }));

function handler(action: string) {
  return router.stack.find((layer: any) => layer.route?.path === `/:id/${action}`).route.stack[0].handle;
}
function response() {
  return { statusCode: 200, body: undefined as any, status(code: number) { this.statusCode = code; return this; }, json(body: any) { this.body = body; return this; } };
}
function setup(t: any) {
  const server = { id: 'deps-test', status: 'stopped', containerId: 'container', resources: {}, game: {} };
  const calls: string[] = [];
  t.mock.method(serverStore, 'get', () => server);
  t.mock.method(serverStore, 'update', (_id: string, updates: any) => { calls.push(`status:${updates.status}`); return { ...server, ...updates }; });
  t.mock.method(dockerService, 'status', async () => 'stopped');
  t.mock.method(dockerService, 'needsUserMigration', async () => false);
  t.mock.method(dockerService, 'start', async () => { calls.push('start'); return 'container'; });
  t.mock.method(dockerService, 'stop', async () => { calls.push('stop'); });
  t.mock.method(capacity, 'assertCanStart', async () => {});
  t.mock.method(hibernationService, 'releasePort', async () => {});
  t.mock.method(prepare, 'ensurePreparedModDependencies', async () => { calls.push('check'); return { installed: [] }; });
  return { server, calls };
}

test('Start checks dependencies before starting Docker, including existing prepared servers', async t => {
  const { server, calls } = setup(t);
  const res = response();
  await handler('start')({ params: { id: server.id } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.lastError, null);
  assert.deepEqual(calls, ['status:starting', 'check', 'start', 'status:starting']);
  assert.equal(preparing.has(server.id), false);
});

test('failed dependency check returns an actionable 422 and never launches Docker', async t => {
  const { server, calls } = setup(t);
  t.mock.method(prepare, 'ensurePreparedModDependencies', async () => { throw new UserFacingError({ error: 'Mod dependency check failed', code: 'MOD_DEPENDENCY_UNRESOLVED', status: 422, reason: 'nightlib missing' }); });
  const res = response();
  await handler('start')({ params: { id: server.id } }, res);
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.code, 'MOD_DEPENDENCY_UNRESOLVED');
  assert.equal(res.body.reason, 'nightlib missing');
  const updates = serverStore.update.mock.calls.map((call: any) => call.arguments[1]);
  assert.equal(updates[0].lastError, null);
  assert.equal(updates.at(-1).lastError, 'nightlib missing');
  assert.equal(calls.includes('start'), false);
});

test('Restart stops Docker before touching mods, then starts only after dependencies pass', async t => {
  const { server, calls } = setup(t);
  const res = response();
  await handler('restart')({ params: { id: server.id } }, res);
  assert.equal(res.body.lastError, null);
  assert.deepEqual(calls, ['status:restarting', 'stop', 'check', 'start', 'status:restarting']);
});

test('Restart releases a sleeping server port and clears its sleep flag', async t => {
  const {server}=setup(t);
  const sleeping={...server,hibernated:true};
  t.mock.method(serverStore,'get',()=>sleeping);
  let released=false;
  t.mock.method(hibernationService,'releasePort',async()=>{released=true;});
  t.mock.method(dockerService,'start',async()=>{assert.equal(released,true);return 'started-container';});
  const res=response();
  await handler('restart')({params:{id:server.id}},res);
  assert.equal(res.statusCode,200);
  assert.equal(res.body.hibernated,false);
  assert.equal(res.body.containerId,'started-container');
});

test('a refused restart of a sleeping server restores wake-on-connect', async t => {
  const {server}=setup(t);
  t.mock.method(serverStore,'get',()=>({...server,hibernated:true}));
  t.mock.method(dockerService,'start',async()=>{throw new UserFacingError({error:'Not enough shared RAM to start',code:'MEMORY_POOL_PRESSURE',status:409});});
  const restore=t.mock.method(hibernationService,'restoreSleep',async()=>{});
  const res=response();
  await handler('restart')({params:{id:server.id}},res);
  assert.equal(res.statusCode,409);
  assert.equal(restore.mock.calls.length,1);
  assert.equal(restore.mock.calls[0].arguments[0],server.id);
});

test('concurrent lifecycle requests cannot start Docker during dependency repair', async t => {
  const { server, calls } = setup(t);
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(prepare, 'ensurePreparedModDependencies', () => { entered(); return new Promise<void>(resolve => { release = resolve; }); });
  const req = { params: { id: server.id } };
  const first = handler('start')(req, response());
  await waiting;
  const second = response();
  await handler('restart')(req, second);
  assert.equal(second.statusCode, 409);
  assert.equal(calls.includes('start'), false);
  release();
  await first;
  assert.equal(calls.filter(c => c === 'start').length, 1);
  assert.equal(preparing.has(server.id), false);
});

test('Start refuses to mutate a running server', async t => {
  const { server, calls } = setup(t);
  t.mock.method(dockerService, 'status', async () => 'running');
  const res = response();
  await handler('start')({ params: { id: server.id } }, res);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(calls, []);
});

test('Prepare refuses to mutate a running container even if its stored status is stale', async t => {
  const { server, calls } = setup(t);
  t.mock.method(dockerService, 'status', async () => 'running');
  const res = response();
  await handler('prepare')({ params: { id: server.id } }, res);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(calls, []);
});

test('entity broadcast range is validated before updating a server', async t => {
  const { server } = setup(t);
  const patch = router.stack.find((layer: any) => layer.route?.path === '/:id' && layer.route.methods.patch).route.stack[0].handle;
  for (const value of [9, 1001, 50.5, '100']) {
    let error: any;
    await patch({ params: { id: server.id }, body: { game: { entityBroadcastRangePercentage: value } } }, response(), (err: any) => { error = err; });
    assert.ok(error, `Expected rejection for ${value}`);
  }
  assert.equal(serverStore.update.mock.calls.length, 0);
});

test('entity broadcast range saves to server.properties and requires restart', async t => {
  const { server } = setup(t);
  const packDir = path.join(root, 'servers', server.id, 'pack');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(packDir, 'server.properties'), 'entity-broadcast-range-percentage=75\nmotd=Keep me\n');
  const patch = router.stack.find((layer: any) => layer.route?.path === '/:id' && layer.route.methods.patch).route.stack[0].handle;
  let current: any = { ...server, resources: { minRamMb: 1024, maxRamMb: 2048 }, game: {} };
  t.mock.method(serverStore, 'get', () => current);
  t.mock.method(serverStore, 'update', (_id: string, changes: any) => { current = { ...current, ...changes }; return current; });

  // Unmanaged settings in existing packs must survive unrelated config writes.
  await prepare.applyConfigFiles(current);
  assert.match(fs.readFileSync(path.join(packDir, 'server.properties'), 'utf8'), /entity-broadcast-range-percentage=75/);

  for (const value of [10, 100, 1000]) {
    const res = response();
    await patch({ params: { id: server.id }, body: { game: { entityBroadcastRangePercentage: value } } }, res, (err: any) => { throw err; });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.game.entityBroadcastRangePercentage, value);
    assert.equal(res.body.restartRequired, true);
    const properties = fs.readFileSync(path.join(packDir, 'server.properties'), 'utf8');
    assert.match(properties, new RegExp(`entity-broadcast-range-percentage=${value}\\n`));
    assert.match(properties, /motd=Keep me/);
  }
});

test('settings cannot recreate a container while restore or rebuild owns its lifecycle lock', async t => {
  const { server } = setup(t);
  const { lifecycleBusy } = require('../state');
  const patch = router.stack.find((layer: any) => layer.route?.path === '/:id' && layer.route.methods.patch).route.stack[0].handle;
  const recreate = t.mock.method(prepare, 'recreateContainer', async () => { throw Error('Must not recreate'); });
  lifecycleBusy.add(server.id);
  try {
    const res = response();
    await patch({ params: { id: server.id }, body: { javaImage: 'new:java' } }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(serverStore.update.mock.calls.length, 0);
    assert.equal(recreate.mock.calls.length, 0);
    assert.equal(lifecycleBusy.has(server.id), true);
  } finally { lifecycleBusy.delete(server.id); }
});

test('a pending configuration write keeps start requests out until it finishes', async t => {
  const { server } = setup(t);
  const patch = router.stack.find((layer: any) => layer.route?.path === '/:id' && layer.route.methods.patch).route.stack[0].handle;
  let release!: () => void;
  t.mock.method(prepare, 'applyConfigFiles', () => new Promise<void>(resolve => { release = resolve; }));
  const editing = patch({ params: { id: server.id }, body: { game: { renderDistance: 12 } } }, response());
  const res = response();
  await handler('start')({ params: { id: server.id } }, res);
  assert.equal(res.statusCode, 409);
  release();
  await editing;
});

test('shared-pool RAM edits do not reserve every configured maximum', async t => {
  const { server } = setup(t);
  const { config } = require('../config');
  const pool = require('../services/memoryPool');
  const previousPoolEnabled = config.memoryPoolEnabled;
  config.memoryPoolEnabled = true;
  t.after(() => { config.memoryPoolEnabled = previousPoolEnabled; });
  const current = { ...server, status: 'running', resources: { minRamMb: 512, maxRamMb: 6000 } };
  t.mock.method(serverStore, 'get', () => current);
  t.mock.method(serverStore, 'update', (_id: string, changes: any) => ({ ...current, ...changes }));
  t.mock.method(pool, 'readVerifiedMemoryPool', async () => ({ enabled: true, enforced: true, limitMb: 12000, usedMb: 2000 }));
  const oldGate = t.mock.method(capacity, 'capacityReport', async () => { throw Error('Legacy accounting must not run'); });
  t.mock.method(prepare, 'applyConfigFiles', async () => {});
  t.mock.method(dockerService, 'updateResources', async () => {});
  const patch = router.stack.find((layer: any) => layer.route?.path === '/:id' && layer.route.methods.patch).route.stack[0].handle;
  const res = response();
  await patch({ params: { id: server.id }, body: { resources: { minRamMb: 512, maxRamMb: 6500 } } }, res, (err: any) => { throw err; });
  assert.equal(res.statusCode, 200);
  assert.equal(oldGate.mock.calls.length, 0);
  for (const [enforced, maxRamMb, expected] of [[false, 6500, 'MEMORY_POOL_UNVERIFIED'], [true, 13000, 'MEMORY_POOL_LIMIT_EXCEEDED']] as const) {
    t.mock.method(pool, 'readVerifiedMemoryPool', async () => ({ enabled: true, enforced, limitMb: 12000, usedMb: 2000 }));
    const refused = response();
    await patch({ params: { id: server.id }, body: { resources: { minRamMb: 512, maxRamMb } } }, refused, (err: any) => { throw err; });
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.body.code, expected);
  }
});

test('async start responds immediately, keeps the lock, and exposes the final original response', async t => {
  const { server } = setup(t);
  const { getServerOperation } = require('../services/serverOperationStore');
  let release!: () => void;
  t.mock.method(prepare, 'ensurePreparedModDependencies', () => new Promise<void>(resolve => { release = resolve; }));
  const res = response();
  await handler('start')({ params: { id: server.id }, headers: { prefer: 'respond-async' } }, res);
  assert.equal(res.statusCode, 202);
  assert.match(res.body.statusUrl, /\/operations\//);
  assert.equal(getServerOperation(server.id, res.body.operationId).status, 'running');
  const duplicate = response();
  await handler('start')({ params: { id: server.id } }, duplicate);
  assert.equal(duplicate.statusCode, 409);
  // Reach the blocked dependency check without waiting for a real 30s timeout.
  await new Promise(resolve => setImmediate(resolve));
  release();
  const deadline = Date.now() + 2000;
  while (getServerOperation(server.id, res.body.operationId).status === 'running' && Date.now() < deadline) {
    await new Promise(resolve => setImmediate(resolve));
  }
  const result = getServerOperation(server.id, res.body.operationId);
  assert.equal(result.status, 'completed');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.containerId, 'container');
  assert.equal(getServerOperation('different-server', res.body.operationId), null);
});

test('async failures retain their API status and actionable error', async t => {
  const { server } = setup(t);
  const { getServerOperation } = require('../services/serverOperationStore');
  t.mock.method(prepare, 'ensurePreparedModDependencies', async () => { throw new UserFacingError({ error: 'Dependency unavailable', code: 'MISSING_MOD', status: 422 }); });
  const res = response();
  await handler('start')({ params: { id: server.id }, headers: { prefer: 'respond-async' } }, res);
  const deadline = Date.now() + 2000;
  while (getServerOperation(server.id, res.body.operationId).status === 'running' && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  const result = getServerOperation(server.id, res.body.operationId);
  assert.equal(result.status, 'failed');
  assert.equal(result.httpStatus, 422);
  assert.equal(result.body.code, 'MISSING_MOD');
});

test('unfinished server operations are marked interrupted on backend initialization', () => {
  const store = require('../services/serverOperationStore');
  const id = store.beginServerOperation('interrupted');
  delete require.cache[require.resolve('../services/serverOperationStore')];
  const reloaded = require('../services/serverOperationStore');
  assert.equal(reloaded.getServerOperation('interrupted', id).status, 'failed');
  assert.match(reloaded.getServerOperation('interrupted', id).body.error, /backend restart/);
});

test('background import retains its upload and server lock until extraction finishes', async t => {
  const snapshots = require('../services/snapshotService');
  const { getServerOperation } = require('../services/serverOperationStore');
  const archive = path.join(root, 'import-fixture.tar');
  fs.writeFileSync(archive, 'fixture upload');
  let release!: () => void;
  let importedId: string | undefined;
  t.mock.method(snapshots, 'importSnapshotArchive', async (id: string, file: string) => {
    importedId = id;
    assert.equal(file, archive);
    await new Promise<void>(resolve => { release = resolve; });
    assert.equal(fs.existsSync(archive), true);
  });
  t.mock.method(prepare, 'recreateContainer', async () => ({ containerId: 'imported', image: 'test:java', javaSource: 'override' }));
  const importHandler = router.stack.find((layer: any) => layer.route?.path === '/import').route.stack.at(-1).handle;
  const res = response();
  await importHandler({ params: {}, headers: { prefer: 'respond-async' },
    body: { name: 'Imported fixture', minRamMb: '512', maxRamMb: '2048' },
    file: { path: archive, originalname: 'snapshot.tar' },
  }, res, (err: any) => { throw err; });
  assert.equal(res.statusCode, 202);
  assert.equal(fs.existsSync(archive), true);
  assert.equal(preparing.has(importedId), true);
  const competing = response();
  await handler('start')({ params: { id: importedId } }, competing);
  assert.equal(competing.statusCode, 409);
  release();
  const deadline = Date.now() + 2000;
  while (getServerOperation(importedId, res.body.operationId).status === 'running' && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.equal(getServerOperation(importedId, res.body.operationId).httpStatus, 201);
  assert.equal(fs.existsSync(archive), false);
  assert.equal(preparing.has(importedId), false);
});
