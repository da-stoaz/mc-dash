import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdash-capacity-'));
process.env.DATA_ROOT = TMP;
process.env.SQLITE_PATH = path.join(TMP, 'test.sqlite');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { decideAdmission, committedMbFor, floorMbFor, expectedPeakMb } = require('./hostCapacityService');

// The host this whole feature exists for: 12 GB, servers configured at 6 GB.
const HOST_MB = 12288;
const RESERVE_MB = 1536;
const BUDGET_MB = HOST_MB - RESERVE_MB; // 10752
const BURST_RATIO = 2;

type Live = { id: string; maxRamMb: number; minRamMb: number; live: boolean; peakPercent?: number };

// Enough 30-minute buckets to clear the evidence threshold (a day of uptime).
const TRUSTED_SAMPLES = 96;

function ledger(entries: Live[], overrides: Record<string, unknown> = {}) {
  const servers = entries.map((entry) => {
    const resources = { maxRamMb: entry.maxRamMb, minRamMb: entry.minRamMb };
    const peak =
      entry.peakPercent === undefined ? null : { memPercent: entry.peakPercent, samples: TRUSTED_SAMPLES };
    const estimate = expectedPeakMb(resources, peak);
    return {
      id: entry.id,
      name: entry.id,
      status: entry.live ? 'running' : 'stopped',
      live: entry.live,
      maxRamMb: entry.maxRamMb,
      minRamMb: entry.minRamMb,
      ceilingMb: committedMbFor(resources),
      floorMb: floorMbFor(resources),
      expectedPeakMb: estimate.expectedPeakMb,
      observedPeakMb: estimate.observedPeakMb,
      observedPeakTrusted: estimate.trusted,
    };
  });

  const live = servers.filter((s) => s.live);
  const sum = (pick: (s: (typeof servers)[number]) => number) => live.reduce((total, s) => total + pick(s), 0);
  const guaranteedMb = sum((s) => s.floorMb);
  const peakMb = sum((s) => s.expectedPeakMb);
  const ceilingMb = sum((s) => s.ceilingMb);
  const burstAllowanceMb = BUDGET_MB * BURST_RATIO;

  return {
    memory: {
      totalMb: HOST_MB,
      availableMb: HOST_MB,
      availableKnown: false, // exercise the ledger tiers in isolation
      swapTotalMb: 0,
      swapUsedMb: 0,
      source: 'proc',
    },
    reserveMb: RESERVE_MB,
    budgetMb: BUDGET_MB,
    burstRatio: BURST_RATIO,
    burstAllowanceMb,
    guaranteedMb,
    expectedPeakMb: peakMb,
    ceilingMb,
    remainingGuaranteedMb: BUDGET_MB - guaranteedMb,
    remainingBurstMb: burstAllowanceMb - peakMb,
    oversubscription: ceilingMb / BUDGET_MB,
    admissionEnabled: true,
    swapMode: 'off',
    servers,
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const server = (id: string, maxRamMb: number, minRamMb = 1024) => ({
  id,
  name: id,
  resources: { minRamMb, maxRamMb },
});

const running = (id: string, maxRamMb: number, minRamMb = 1024, peakPercent?: number): Live => ({
  id,
  maxRamMb,
  minRamMb,
  live: true,
  peakPercent,
});

// --- the case that motivated two tiers ------------------------------------

test('three 6 GB servers fit on a 12 GB host — strict worst-case admission refused this', () => {
  // Each books 6144+922 = 6.9 GB of ceiling, so worst-case accounting allows
  // exactly one. Their floors are 1.9 GB each, and 3 x 1.9 fits with room over.
  let report = ledger([]);
  assert.equal(decideAdmission(report, server('one', 6144)).allowed, true);

  report = ledger([running('one', 6144)]);
  assert.equal(decideAdmission(report, server('two', 6144)).allowed, true);

  report = ledger([running('one', 6144), running('two', 6144)]);
  assert.equal(decideAdmission(report, server('three', 6144)).allowed, true);
});

test('the fourth is refused — the bet has a limit, it is not unbounded', () => {
  const report = ledger([running('one', 6144), running('two', 6144), running('three', 6144)]);
  const decision = decideAdmission(report, server('four', 6144));
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'MEMORY_BURST_EXCEEDED');
  assert.match(decision.details, /MC_DASH_MEMORY_BURST_RATIO/);
});

// --- tier 1: the guarantee is never overcommitted --------------------------

test('floors that cannot coexist are refused outright, however low the peaks', () => {
  // Two servers demanding 5 GB *minimum* each cannot share a 10.5 GB budget
  // with a third, no matter how generous the burst ratio is.
  const report = ledger([running('one', 6144, 5120), running('two', 6144, 5120)]);
  const decision = decideAdmission(report, server('three', 6144, 5120));
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'MEMORY_GUARANTEE_EXCEEDED');
  assert.match(decision.reason, /even while idle/);
});

test('the guarantee is checked before the burst tier — it is the real promise', () => {
  // Contrived so both tiers would fail; the guarantee must be the one reported,
  // because raising the burst ratio would not help here.
  const report = ledger([running('one', 8192, 6144), running('two', 8192, 4096)]);
  const decision = decideAdmission(report, server('three', 8192, 4096));
  assert.equal(decision.code, 'MEMORY_GUARANTEE_EXCEEDED');
});

// --- observed peaks --------------------------------------------------------

test('a server that has never used its ceiling is not budgeted as if it had', () => {
  // 30% of a 7066 MB cap is ~2.1 GB observed; +30% margin = ~2.8 GB booked,
  // rather than the full 6.9 GB the config claims.
  const estimate = expectedPeakMb({ maxRamMb: 6144, minRamMb: 1024 }, { memPercent: 30, samples: TRUSTED_SAMPLES });
  assert.equal(estimate.trusted, true);
  assert.ok(estimate.observedPeakMb < 2200);
  assert.ok(estimate.expectedPeakMb < 3000, 'books the measured need, not the configured one');
  assert.ok(estimate.expectedPeakMb > estimate.observedPeakMb, 'margin is applied on top');
});

test('a thin history is not evidence — the ceiling is assumed instead', () => {
  const estimate = expectedPeakMb({ maxRamMb: 6144, minRamMb: 1024 }, { memPercent: 30, samples: 4 });
  assert.equal(estimate.trusted, false);
  assert.equal(estimate.expectedPeakMb, committedMbFor({ maxRamMb: 6144, minRamMb: 1024 }));
  // The measurement is still reported, so the UI can show it as unproven.
  assert.ok(estimate.observedPeakMb > 0);
});

test('a server measured at its ceiling is never booked below it', () => {
  const estimate = expectedPeakMb({ maxRamMb: 6144, minRamMb: 1024 }, { memPercent: 98, samples: TRUSTED_SAMPLES });
  assert.equal(estimate.expectedPeakMb, committedMbFor({ maxRamMb: 6144, minRamMb: 1024 }));
});

test('an observed peak never books less than the guaranteed floor', () => {
  const resources = { maxRamMb: 6144, minRamMb: 4096 };
  const estimate = expectedPeakMb(resources, { memPercent: 5, samples: TRUSTED_SAMPLES });
  assert.ok(estimate.expectedPeakMb >= floorMbFor(resources));
});

test('measured light servers pack in where assumed-heavy ones would not', () => {
  const heavy = ledger([running('one', 6144), running('two', 6144), running('three', 6144)]);
  assert.equal(decideAdmission(heavy, server('four', 6144)).allowed, false);

  // Same four servers, but a week of metrics says each tops out near 25%.
  const measured = ledger([
    running('one', 6144, 1024, 25),
    running('two', 6144, 1024, 25),
    running('three', 6144, 1024, 25),
  ]);
  const decision = decideAdmission(measured, server('four', 6144), {
    memPercent: 25,
    samples: TRUSTED_SAMPLES,
  });
  assert.equal(decision.allowed, true, 'evidence buys headroom that assumption does not');
});

// --- unchanged guarantees --------------------------------------------------

test('a stopped server holds nothing, so its neighbour starts fine', () => {
  const report = ledger([{ id: 'one', maxRamMb: 8192, minRamMb: 1024, live: false }]);
  assert.equal(decideAdmission(report, server('two', 8192)).allowed, true);
});

test('restarting a running server is never blocked, even over budget', () => {
  const report = ledger([
    running('one', 8192, 4096),
    running('two', 8192, 4096),
    running('three', 8192, 4096),
  ]);
  assert.ok(report.remainingBurstMb < 0 || report.remainingGuaranteedMb < 0, 'genuinely over budget');
  assert.equal(decideAdmission(report, server('one', 8192, 4096)).allowed, true);
});

test('a server with no configured ceiling is not gated — we have nothing to weigh', () => {
  const decision = decideAdmission(ledger([]), { id: 'legacy', name: 'legacy' });
  assert.equal(decision.allowed, true);
  assert.equal(decision.requestPeakMb, 0);
});

test('live host pressure blocks a start the ledger would have allowed', () => {
  const report = ledger([], {
    memory: {
      totalMb: HOST_MB,
      availableMb: 1024,
      availableKnown: true,
      swapTotalMb: 0,
      swapUsedMb: 0,
      source: 'proc',
    },
  });
  const decision = decideAdmission(report, server('one', 6144, 4096));
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'HOST_MEMORY_LOW');
  assert.match(decision.details, /outside MC Dash/);
});

test('the live gate weighs the floor, not the peak — the heap grows into the rest later', () => {
  // 3 GB free, a server that idles at ~1.9 GB but may reach 6.9 GB. It boots.
  const report = ledger([], {
    memory: {
      totalMb: HOST_MB,
      availableMb: 3072,
      availableKnown: true,
      swapTotalMb: 0,
      swapUsedMb: 0,
      source: 'proc',
    },
  });
  assert.equal(decideAdmission(report, server('one', 6144, 1024)).allowed, true);
});
