import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdash-recent-metrics-'));
process.env.DATA_ROOT = root; process.env.SQLITE_PATH = path.join(root, 'db.sqlite');
const { MetricsCollector, metricsCollector } = require('./metricsCollector');
const { dockerService } = require('./dockerService');
const { serverStore } = require('../serverStore');
const { metricsStore } = require('../metricsStore');
const { db } = require('../db');
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('recent readings exist before a viewer connects, expire, and use actual sample times', async t => {
  let now = 1_000_000;
  const server = { id: 'recent', status: 'running' };
  t.mock.method(Date, 'now', () => now);
  t.mock.method(serverStore, 'list', () => [server]);
  t.mock.method(metricsStore, 'prune', () => {});
  t.mock.method(metricsStore, 'writeFineBucket', () => {});
  t.mock.method(dockerService, 'metrics', async () => ({ status: 'running', cpuPercent: 25, cpuCores: 1, cpuCoresAvailable: 4, memoryPercent: 50, memoryBytes: 1024, memoryLimitBytes: 2048 }));
  const collector = new MetricsCollector();
  for (let i = 0; i < 15; i++) { await collector.tick(); now += 5000; }
  const history = collector.recentFor(server.id);
  assert.equal(history.length, 12);
  assert.equal(history[0].at, now - 60000);
  assert.equal(history.at(-1).cpuCores, 1);
  let received: any;
  const stop = collector.watch(server.id, (sample: any) => { received = sample; });
  await collector.tick(); now += 1000; await collector.tick();
  assert.equal(received.at, now);
  assert.equal(collector.recentFor(server.id).at(-1).at, now);
  stop(); now += 61000;
  assert.deepEqual(collector.recentFor(server.id), []);
});

test('every SSE connection receives a snapshot, including reconnects', t => {
  const { addDetailClient } = require('./serverEvents');
  const sample = { at: Date.now() - 5000, cpuPercent: 25 };
  t.mock.method(serverStore, 'get', () => ({ id: 's' }));
  t.mock.method(metricsCollector, 'recentFor', () => [sample]);
  t.mock.method(metricsCollector, 'watch', () => () => {});
  for (let i = 0; i < 2; i++) {
    const response: any = new EventEmitter(); let output = '';
    response.writeHead = () => {}; response.write = (chunk: string) => { output += chunk; };
    addDetailClient('s', response);
    response.emit('close');
    assert.match(output, /event: metrics-history/);
    assert.ok(output.includes(JSON.stringify([sample])));
  }
});

test('startup learning excludes file cache from measured demand', async t => {
  const {bootMemoryDemand}=require('./bootMemory');
  const server={id:'boot-cache',status:'starting',resources:{minRamMb:512,maxRamMb:8192}};
  t.mock.method(serverStore,'list',()=>[server]);
  t.mock.method(metricsStore,'prune',()=>{});
  t.mock.method(dockerService,'metrics',async()=>({status:'running',cpuPercent:0,cpuCores:0,
    memoryPercent:80,memoryBytes:7000*1024**2,memoryWorkingSetBytes:2000*1024**2,
    memoryLimitBytes:8192*1024**2,uptimeSeconds:30}));
  await new MetricsCollector().tick();
  assert.equal(bootMemoryDemand(server),2200);
});
