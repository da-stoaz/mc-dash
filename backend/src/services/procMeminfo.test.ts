import { test } from 'node:test';
import assert from 'node:assert/strict';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseMeminfo, toProcMemory, readProcMemory } = require('./procMeminfo');

// Captured verbatim from a real Linux /proc/meminfo. Trimmed to the lines that
// matter plus a few that must be ignored — the point is to parse the real
// format, including the unitless HugePages_* entries that follow the sized ones.
const REAL = `MemTotal:       16337080 kB
MemFree:         2074632 kB
MemAvailable:   13657052 kB
Buffers:          237632 kB
Cached:         11455028 kB
SwapCached:            0 kB
Active:          4823064 kB
Inactive:        8395184 kB
SwapTotal:       4194304 kB
SwapFree:        4194304 kB
Dirty:              1284 kB
AnonPages:       1526452 kB
Slab:             646140 kB
HugePages_Total:       0
HugePages_Free:        0
Hugepagesize:       2048 kB
`;

test('a real /proc/meminfo parses into the figures the budget is built from', () => {
  const memory = toProcMemory(parseMeminfo(REAL));
  assert.equal(memory.totalMb, Math.round(16337080 / 1024)); // 15954
  assert.equal(memory.availableMb, Math.round(13657052 / 1024)); // 13337
  assert.equal(memory.availableExact, true);
  assert.equal(memory.swapTotalMb, 4096);
  assert.equal(memory.swapUsedMb, 0);
});

test('unitless entries are ignored rather than read as kB', () => {
  const values = parseMeminfo(REAL);
  assert.equal(values.HugePages_Total, undefined);
  assert.equal(values.HugePages_Free, undefined);
  assert.equal(values.Hugepagesize, 2048); // this one *is* in kB
});

test('used swap is derived, since /proc only reports total and free', () => {
  const busy = REAL.replace('SwapFree:        4194304 kB', 'SwapFree:        1048576 kB');
  assert.equal(toProcMemory(parseMeminfo(busy)).swapUsedMb, 3072);
});

test('kernels without MemAvailable get a usable reconstruction, not MemFree', () => {
  // Pre-3.14. MemFree alone is 2 GB here while ~13 GB is genuinely available,
  // so gating starts on it would refuse nearly everything.
  const old = REAL.split('\n').filter((line) => !line.startsWith('MemAvailable:')).join('\n');
  const memory = toProcMemory(parseMeminfo(old));

  assert.equal(memory.availableExact, false);
  const memFreeMb = Math.round(2074632 / 1024);
  assert.ok(memory.availableMb > memFreeMb * 4, 'must count reclaimable cache, not just free pages');
  // Verified against the same file's real MemAvailable: within a few percent.
  assert.ok(Math.abs(memory.availableMb - 13337) / 13337 < 0.05);
});

test('a machine with no swap reports zero rather than NaN', () => {
  const noSwap = REAL.replace(/SwapTotal:.*\n/, 'SwapTotal:             0 kB\n').replace(
    /SwapFree:.*\n/,
    'SwapFree:              0 kB\n'
  );
  const memory = toProcMemory(parseMeminfo(noSwap));
  assert.equal(memory.swapTotalMb, 0);
  assert.equal(memory.swapUsedMb, 0);
});

test('a missing or unreadable /proc means "unknown", never a wrong number', () => {
  // Windows and macOS dev boxes have no /proc at all; the budget must fall back
  // to the Docker daemon rather than gate on a fabricated figure.
  assert.equal(readProcMemory(() => { throw new Error('ENOENT'); }), null);
  assert.equal(readProcMemory(() => ''), null);
  assert.equal(toProcMemory({ MemFree: 100 }), null, 'no MemTotal means no usable reading');
});
