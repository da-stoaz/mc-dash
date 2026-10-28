import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdash-mem-'));
process.env.DATA_ROOT = TMP;
process.env.SQLITE_PATH = path.join(TMP, 'test.sqlite');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { containerMemoryPlan, jvmOverheadMb } = require('./memoryPlan');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { memoryHostConfig, isSwapLimitUnsupported } = require('./dockerService');

const MB = 1024 * 1024;

test('10000 MiB is the actual limit, not 11500 MiB', () => {
  const resources = { minRamMb: 1024, maxRamMb: 10000 };
  const plan = containerMemoryPlan(resources);
  assert.equal(memoryHostConfig(resources).Memory, 10000 * MB);
  assert.equal(plan.heapMaxMb, 8696);
  assert.equal(plan.capMb, 10000);
  const { requireStartRoom } = require('./memoryPool');
  assert.doesNotThrow(() => requireStartRoom({ enabled: true, enforced: true, limitMb: 12000, usedMb: 0 }, plan.floorMb, 0));
});

test('the user limit is the Docker cap, with Java overhead inside it', () => {
  const plan = containerMemoryPlan({ minRamMb: 1024, maxRamMb: 8192 });
  assert.equal(plan.capMb, 8192);
  assert.equal(plan.heapMaxMb, 7123);
  assert.ok(plan.heapMaxMb + jvmOverheadMb(plan.heapMaxMb) <= plan.capMb);
});

test('small heaps get a flat overhead floor, not a useless percentage', () => {
  // 15% of 512 MB is 77 MB — nowhere near enough for metaspace plus stacks.
  assert.equal(jvmOverheadMb(512), 256);
  assert.equal(jvmOverheadMb(8192), 1229);
});

test('the soft floor tracks minRamMb — the footprint an idle server should fall to', () => {
  const plan = containerMemoryPlan({ minRamMb: 1024, maxRamMb: 8192 });
  assert.equal(plan.floorMb, 1024 + jvmOverheadMb(plan.heapMaxMb));
  assert.ok(plan.floorMb < plan.capMb);
});

test('no configured max means no plan; we leave the container unlimited', () => {
  assert.equal(containerMemoryPlan(undefined), null);
  assert.equal(containerMemoryPlan({ minRamMb: 1024, maxRamMb: 0 }), null);
  assert.equal(containerMemoryPlan({ maxRamMb: 1e100 }), null);
});

test('swap off means MemorySwap equals Memory — the container cannot page at all', () => {
  const limits = memoryHostConfig({ minRamMb: 1024, maxRamMb: 8192 }, 'off');
  assert.equal(limits.MemorySwap, limits.Memory);
  assert.equal(limits.MemorySwappiness, undefined);
});

test('swap limit allows paging but makes the kernel reach for it last', () => {
  const limits = memoryHostConfig({ minRamMb: 1024, maxRamMb: 8192 }, 'limit');
  assert.equal(limits.MemorySwap, limits.Memory * 2);
  assert.equal(limits.MemorySwappiness, 0);
});

test('swap host leaves the daemon default alone', () => {
  const limits = memoryHostConfig({ minRamMb: 1024, maxRamMb: 8192 }, 'host');
  assert.equal(limits.MemorySwap, undefined);
  assert.equal(limits.MemorySwappiness, undefined);
});

test('the reservation is always a soft limit below the hard one', () => {
  const limits = memoryHostConfig({ minRamMb: 2048, maxRamMb: 4096 }, 'off');
  assert.ok(limits.MemoryReservation < limits.Memory);
  assert.equal(limits.Memory, 4096 * MB);
});

test('a min equal to the max still leaves the reservation valid', () => {
  const limits = memoryHostConfig({ minRamMb: 4096, maxRamMb: 4096 }, 'off');
  assert.ok(limits.MemoryReservation <= limits.Memory);
});

test('an unlimited server gets no memory keys at all', () => {
  assert.deepEqual(memoryHostConfig(undefined, 'off'), {});
});

test('a daemon without swap accounting is recognised so the container still starts', () => {
  // The three wordings a rootless / non-MEMCG_SWAP daemon actually produces.
  assert.equal(
    isSwapLimitUnsupported(new Error('Your kernel does not support swap limit capabilities')),
    true
  );
  assert.equal(isSwapLimitUnsupported(new Error('memory swap: unsupported in rootless mode')), true);
  assert.equal(
    isSwapLimitUnsupported(new Error('cannot set memory.swap.max: no such file or directory')),
    true
  );
});

test('unrelated failures are not mistaken for a missing swap controller', () => {
  // These must still surface: silently dropping the swap limit for a port clash
  // or an image problem would hide the real error behind a downgrade warning.
  assert.equal(isSwapLimitUnsupported(new Error('port is already allocated')), false);
  assert.equal(isSwapLimitUnsupported(new Error('No such image: eclipse-temurin:21-jre')), false);
  assert.equal(isSwapLimitUnsupported(undefined), false);
});
