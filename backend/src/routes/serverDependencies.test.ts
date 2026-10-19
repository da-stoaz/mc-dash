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
