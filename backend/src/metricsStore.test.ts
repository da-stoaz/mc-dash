import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-metrics-'));
process.env.DATA_ROOT = root;
process.env.SQLITE_PATH = path.join(root, 'test.sqlite');
const { metricsStore } = require('./metricsStore');
const { db } = require('./db');
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
test('absolute readings roll up with weighted averages and preserve unknown legacy values', () => {
  const bucketStart = Math.floor(Date.now() / 1000 / 1800) * 1800;
  const base = {serverId:'absolute',bucketStart,cpuMin:10,cpuAvg:20,cpuMax:30,memMin:40,memAvg:50,memMax:60,netRxAvg:0,netRxMax:0,netTxAvg:0,netTxMax:0,diskRAvg:0,diskRMax:0,diskWAvg:0,diskWMax:0,samples:1};
  metricsStore.writeFineBucket({...base,cpuCoresAvg:1,cpuCoresMax:2,memoryBytesAvg:1024 ** 3,memoryBytesMax:2 * 1024 ** 3});
  metricsStore.writeFineBucket({...base,bucketStart:bucketStart+30,samples:3,cpuCoresAvg:3,cpuCoresMax:4,memoryBytesAvg:3 * 1024 ** 3,memoryBytesMax:4 * 1024 ** 3});
  for (const range of ['1d','7d']) {
    const point = metricsStore.query('absolute',range)[0];
    assert.equal(point.cpuCoresAvg,2.5);
    assert.equal(point.cpuCoresMax,4);
    assert.equal(point.memoryBytesAvg,2.5 * 1024 ** 3);
    assert.equal(point.memoryBytesMax,4 * 1024 ** 3);
  }
  metricsStore.writeFineBucket({...base,bucketStart:bucketStart+60});
  const mixed = metricsStore.query('absolute','7d')[0];
  assert.equal(mixed.cpuCoresAvg,null);
  assert.equal(mixed.memoryBytesMax,null);
  assert.equal(metricsStore.query('absolute','1h')[0].cpuCoresAvg,1);
});
