import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';

// jvmTuning imports config, whose import ensures the data dir exists. Point it
// at a throwaway dir before requiring so it can't create a stray ./data folder.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdash-jvm-'));
process.env.DATA_ROOT = TMP;
process.env.SQLITE_PATH = path.join(TMP, 'test.sqlite');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  elasticHeapFlags,
  heapPlan,
  isManagedFlag,
  mergeJvmArgs,
  tokenizeJvmArgs,
} = require('./jvmTuning');

const ELASTIC = { elastic: true, idleSeconds: 300 };

test('AlwaysPreTouch is forced off — it is what pins an idle heap at -Xmx', () => {
  const flags = elasticHeapFlags({ idleSeconds: 300 });
  assert.ok(flags.includes('-XX:-AlwaysPreTouch'));
  assert.ok(!flags.includes('-XX:+AlwaysPreTouch'));
});

test('the periodic GC is concurrent — the full-GC variant is a 365ms freeze', () => {
  const flags = elasticHeapFlags({ idleSeconds: 300 });
  assert.ok(flags.includes('-XX:G1PeriodicGCInterval=300000'));
  // Measured: on a 1.5 GB live set the full-GC variant pauses 365ms and fires
  // on a timer even while someone is playing, because a quiet server can go
  // minutes between young GCs. The concurrent cycle reclaimed the same amount
  // with no pause, so this flag must never regress to '-'.
  assert.ok(flags.includes('-XX:+G1PeriodicGCInvokesConcurrent'));
  assert.ok(!flags.includes('-XX:-G1PeriodicGCInvokesConcurrent'));
});

test('unknown-option tolerance comes first, or an old JVM dies on the next flag', () => {
  assert.equal(elasticHeapFlags({ idleSeconds: 60 })[0], '-XX:+IgnoreUnrecognizedVMOptions');
});

test('heap free ratios are tightened below G1 defaults of 40/70', () => {
  const flags = elasticHeapFlags({ idleSeconds: 300 });
  assert.ok(flags.includes('-XX:MinHeapFreeRatio=10'));
  assert.ok(flags.includes('-XX:MaxHeapFreeRatio=30'));
});

test("Aikar's flags survive; only the memory-profile ones are replaced", () => {
  const aikar = tokenizeJvmArgs(
    '-Xms8192M -Xmx8192M -XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 ' +
      '-XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:+DisableExplicitGC'
  );
  const merged = mergeJvmArgs(aikar, { minMb: 1024, maxMb: 8192 }, ELASTIC);

  // The pack author's GC tuning is untouched...
  assert.ok(merged.includes('-XX:+UseG1GC'));
  assert.ok(merged.includes('-XX:MaxGCPauseMillis=200'));
  assert.ok(merged.includes('-XX:G1NewSizePercent=30'));
  assert.ok(merged.includes('-XX:+DisableExplicitGC'));
  // ...but pre-touch is gone and -Xms is the real floor, not a second -Xmx.
  assert.ok(!merged.includes('-XX:+AlwaysPreTouch'));
  assert.ok(merged.includes('-Xms1024M'));
  assert.ok(merged.includes('-Xmx8192M'));
  assert.equal(merged.filter((f: string) => f.startsWith('-Xms')).length, 1);
});

test('merging twice yields the same flags — prepare runs on every rebuild', () => {
  const once = mergeJvmArgs(tokenizeJvmArgs('-Xmx4096M -XX:+AlwaysPreTouch'), { minMb: 512, maxMb: 4096 }, ELASTIC);
  const twice = mergeJvmArgs(once, { minMb: 512, maxMb: 4096 }, ELASTIC);
  assert.deepEqual(twice, once);
});

test('-Xms/-Xmx come last so nothing kept from the pack can override them', () => {
  const merged = mergeJvmArgs(tokenizeJvmArgs('-XX:+UseG1GC'), { minMb: 512, maxMb: 2048 }, ELASTIC);
  assert.deepEqual(merged.slice(-2), ['-Xms512M', '-Xmx2048M']);
});

test('elastic off still fixes the heap sizing', () => {
  const merged = mergeJvmArgs([], { minMb: 512, maxMb: 2048 }, { elastic: false, idleSeconds: 300 });
  assert.deepEqual(merged, ['-Xms512M', '-Xmx2048M']);
});

test('tokenizer handles the quoting variables.txt uses', () => {
  assert.deepEqual(tokenizeJvmArgs('"-Xmx8192M -Xms2048M"'), ['-Xmx8192M', '-Xms2048M']);
  assert.deepEqual(tokenizeJvmArgs("  -Xmx8G   -XX:+UseG1GC  "), ['-Xmx8G', '-XX:+UseG1GC']);
  assert.deepEqual(tokenizeJvmArgs(''), []);
});

test('managed flags are matched on both polarities', () => {
  assert.equal(isManagedFlag('-XX:+AlwaysPreTouch'), true);
  assert.equal(isManagedFlag('-XX:-AlwaysPreTouch'), true);
  assert.equal(isManagedFlag('-XX:+UseG1GC'), false);
});

test('-Xms above -Xmx is clamped rather than passed on — the JVM would refuse to boot', () => {
  assert.deepEqual(heapPlan({ minRamMb: 8192, maxRamMb: 4096 }), { minMb: 4096, maxMb: 4096 });
});

test('a missing min gets a small floor, so the heap has room to shrink into', () => {
  assert.deepEqual(heapPlan({ maxRamMb: 8192 }), { minMb: 512, maxMb: 8192 });
  assert.deepEqual(heapPlan({ maxRamMb: 256 }), { minMb: 256, maxMb: 256 });
});

test('no max means no plan — we do not invent a ceiling', () => {
  assert.equal(heapPlan({}), null);
  assert.equal(heapPlan({ maxRamMb: 0 }), null);
});
