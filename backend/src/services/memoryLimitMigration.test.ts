import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrateMemoryLimits } from './memoryLimitMigration';
import { containerMemoryPlan } from './memoryPlan';

test('legacy heap settings migrate once without reducing the old container limit or losing boot history', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE servers (id TEXT PRIMARY KEY, resources TEXT); CREATE TABLE boot_memory (serverId TEXT, profile TEXT, peakMb REAL, PRIMARY KEY(serverId,profile));');
    db.prepare('INSERT INTO servers VALUES (?,?)').run('old', JSON.stringify({ minRamMb: 1024, maxRamMb: 8192, cpuLimit: 2 }));
    db.prepare('INSERT INTO boot_memory VALUES (?,?,?)').run('old', JSON.stringify([1024,8192,'java:21','pack.zip']), 4500);
    migrateMemoryLimits(db);
    const resources = JSON.parse((db.prepare('SELECT resources FROM servers').get() as any).resources);
    assert.deepEqual(resources, { minRamMb: 1024, maxRamMb: 9421, cpuLimit: 2 });
    assert.equal(containerMemoryPlan(resources)?.heapMaxMb, 8192);
    assert.equal((db.prepare('SELECT peakMb FROM boot_memory WHERE profile=?').get(JSON.stringify([1024,9421,'java:21','pack.zip'])) as any).peakMb, 4500);
    migrateMemoryLimits(db);
    assert.deepEqual(JSON.parse((db.prepare('SELECT resources FROM servers').get() as any).resources), resources);
  } finally { db.close(); }
});
