import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-dash-tps-'));
process.env.DATA_ROOT = root;
process.env.SQLITE_PATH = path.join(root, 'test.sqlite');
const { parseTps, TpsService } = require('./tpsService');
after(() => fs.rmSync(root, { recursive: true, force: true }));

const spark = '§6[spark] TPS from last 5s, 10s, 1m, 5m, 15m:\n§a[spark] *19.95, *20.0, 19.9, 19.8, 19.7\nCPU usage from last 10s, 1m, 15m: 30%, 20%, 10%';
const forge = 'Dim minecraft:overworld: Mean tick time: 2.0 ms. Mean TPS: 20.0\nOverall: Mean tick time: 60.0 ms. Mean TPS: 16.667';
const server = { id: 'test', status: 'running', containerId: 'one' };

test('parses spark sample after its header, ignoring time windows and CPU figures', () => {
  assert.deepEqual(parseTps(spark, 'spark'), { tps: 19.95, source: 'spark', window: '5s' });
  assert.equal(parseTps('TPS from last 1m, 5m, 15m: 18.5, 19.0, 20.0', 'spark').tps, 18.5);
  assert.equal(parseTps('TPS from last 5s, 10s, 1m, 5m, 15m: unavailable', 'spark'), null);
  assert.equal(parseTps('Unknown command: spark tps', 'spark'), null);
});

test('Forge uses the overall TPS, never a dimension reading', () => {
  assert.equal(parseTps(forge, 'forge').tps, 16.667);
  assert.equal(parseTps(forge.split('\n')[0], 'forge'), null);
});

test('shares in-flight work and cached samples across viewers, falling back to Forge', async () => {
  let now = 0;
  const calls: string[] = [];
  const service = new TpsService(async (_server: unknown, commands: string[]) => {
    calls.push(commands[0]);
    return [commands[0] === 'spark tps' ? 'Unknown command' : forge];
  }, () => now);
  const [a, b] = await Promise.all([service.read(server), service.read(server)]);
  assert.equal(a, b);
  assert.equal(a.current.tps, 16.667);
  assert.deepEqual(calls, ['spark tps', 'forge tps']);
  now = 5000;
  await service.read(server);
  assert.equal(calls.length, 2);
  now = 10000;
  assert.equal((await service.read(server)).points.length, 2);
});

test('missing readings create gaps, stopped servers clear history, and outages recover', async () => {
  let now = 0;
  let available = true;
  let calls = 0;
  const service = new TpsService(async () => { calls++; return available ? [spark] : null; }, () => now);
  await service.read(server);
  available = false;
  now = 10000;
  const outage = await service.read(server);
  assert.equal(outage.state, 'unavailable');
  assert.equal(outage.current, null);
  assert.equal(outage.points[1].tps, null);
  const stopped = await service.read({ ...server, status: 'stopped' });
  assert.deepEqual(stopped.points, []);
  assert.equal(calls, 2);
  available = true;
  now = 11000;
  assert.equal((await service.read(server)).current.tps, 19.95);
});

test('history is bounded, and container replacement discards old samples', async () => {
  let now = 0;
  const service = new TpsService(async () => [spark], () => now);
  for (let i = 0; i < 70; i++) { now += 10000; await service.read(server); }
  assert.equal((await service.read(server)).points.length, 60);
  assert.equal((await service.read({ ...server, containerId: 'two' })).points.length, 1);
});

test('unsupported commands and thrown RCON errors never become zero TPS', async () => {
  const unsupported = new TpsService(async () => ['Unknown command']);
  assert.equal((await unsupported.read(server)).state, 'unsupported');
  const unavailable = new TpsService(async () => { throw new Error('Docker unavailable'); });
  const result = await unavailable.read(server);
  assert.equal(result.state, 'unavailable');
  assert.equal(result.current, null);
  assert.equal(result.points[0].tps, null);
});

test('unexpected output and permission errors do not confirm missing TPS support', async () => {
  for (const output of ['You do not have permission', 'TPS from last 5s: warming up', '']) {
    const service = new TpsService(async () => [output]);
    assert.equal((await service.read(server)).state, 'unavailable');
  }
  const service = new TpsService(async () => ['Unknown or incomplete command, see below for error']);
  assert.equal((await service.read(server)).state, 'unsupported');
});
