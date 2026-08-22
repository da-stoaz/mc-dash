import fs from 'fs';
import os from 'os';
import { config } from '../config';
import { logger } from '../logger';
import { serverStore } from '../serverStore';
import { metricsStore } from '../metricsStore';
import { metricsCollector } from './metricsCollector';
import { hibernationService } from './hibernationService';
import { UserFacingError } from '../apiErrors';
import { dockerService } from './dockerService';
import { containerMemoryPlan, jvmOverheadMb } from './memoryPlan';
import { readProcMemory } from './procMeminfo';
import { ResourceConfig, ServerRecord, ServerStatus } from '../types';

// ---------------------------------------------------------------------------
// Host capacity ledger and start admission
//
// Docker's `Memory` is a ceiling, not a booking. Nothing in Docker, and nothing
// in MC Dash before this, stopped the sum of every server's ceiling from
// exceeding physical RAM — so three servers capped at 8 GB start happily on a
// 12 GB box and only collide once they all actually fill their heaps. By then
// the kernel is swapping and the box is unusable, including the SSH session you
// would need to fix it.
//
// The fix is an admission check with a ledger, the same shape as a cluster
// scheduler's — and, like a scheduler's, it has to be two-tier to be useful.
//
//   Guaranteed tier — every running server's idle floor (min RAM + JVM
//     overhead). Never overcommitted. This is the actual promise: whatever
//     happens, each running server can always have this much. For a server
//     whose ceiling is 6 GB it costs about 1.5 GB.
//
//   Burst tier — the sum of ceilings, allowed to exceed physical RAM by
//     config.memoryBurstRatio. Booking every ceiling in full is what makes a
//     ledger *strict but stupid*: a 12 GB host would admit exactly one 6 GB
//     server, even though three of them idle at 3 GB together and never peak
//     at the same instant.
//
// The burst tier is an explicit bet that servers don't all peak together. What
// makes it a reasonable bet rather than a reckless one is what happens when it
// is lost: with container swap off (the default), the kernel kills the one
// container that overran its own cap. That is a bad minute for one server, not
// a frozen host — and a frozen host is the thing this whole feature exists to
// prevent. Set memoryBurstRatio to 1.0 for strict worst-case admission.
//
// The ceiling itself is also an estimate, and usually a bad one — people set
// max RAM by superstition. Where there is a week of metrics to draw on, we use
// the server's *observed* peak plus a margin instead, and fall back to the
// configured ceiling when the history is too thin to be evidence.
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;

// Statuses that hold host memory this instant. 'stopping' counts: the JVM is
// still resident until the container actually exits.
const LIVE_STATUSES: ReadonlySet<ServerStatus> = new Set<ServerStatus>([
  'running',
  'starting',
  'restarting',
  'stopping',
]);

export type HostMemory = {
  totalMb: number;
  /** Reclaimable + free, per MemAvailable. Meaningless when availableKnown is false. */
  availableMb: number;
  /**
   * False when we can read the host's total but not a trustworthy live figure —
   * e.g. a Docker Desktop VM, where /proc/meminfo describes the wrong machine.
   * The live-pressure gate is skipped rather than guessed at.
   */
  availableKnown: boolean;
  swapTotalMb: number;
  swapUsedMb: number;
  source: 'proc' | 'docker' | 'os';
};

export type ServerCommitment = {
  id: string;
  name: string;
  status: ServerStatus;
  /** Counted against the budget right now. */
  live: boolean;
  maxRamMb: number;
  minRamMb: number;
  /** maxRamMb plus JVM overhead — the hard cgroup cap. */
  ceilingMb: number;
  /** minRamMb plus JVM overhead — the guaranteed floor, booked outright. */
  floorMb: number;
  /**
   * What the burst tier actually books: the observed peak plus margin where
   * there is enough history, the configured ceiling otherwise.
   */
  expectedPeakMb: number;
  /** The 7-day observed peak in MB, or null when never measured. */
  observedPeakMb: number | null;
  /** True when observedPeakMb had enough history behind it to be used. */
  observedPeakTrusted: boolean;
  /** What this server is using right now, or null when stopped. */
  actualMb: number | null;
  actualCpuCores: number | null;
  /** Players online per the last RCON read, or null when unknown. */
  players: number | null;
  /** Auto-stopped for being empty, and will start again on connect. */
  hibernated: boolean;
};

export type CapacityReport = {
  memory: HostMemory;
  reserveMb: number;
  /** totalMb minus the OS reserve: everything servers may share. */
  budgetMb: number;
  burstRatio: number;
  /** budgetMb x burstRatio: what the burst tier is checked against. */
  burstAllowanceMb: number;
  /** Sum of live floors. Booked outright and never overcommitted. */
  guaranteedMb: number;
  /** Sum of live expected peaks — what admission weighs. */
  expectedPeakMb: number;
  /** Sum of live configured ceilings — the true worst case, for display. */
  ceilingMb: number;
  /**
   * What running servers are using *this second*, summed from the metrics
   * collector. Deliberately not part of any admission decision — it is the
   * number that stops being true the moment someone logs in — but without it on
   * screen there is no way to tell whether any of the rest of this is working.
   */
  actualMb: number;
  /** Cores actually in use across all running servers, and how many the host has. */
  actualCpuCores: number;
  hostCpuCores: number;
  /** Budget left in the guaranteed tier: the number that gates a start hardest. */
  remainingGuaranteedMb: number;
  /** Budget left in the burst tier. */
  remainingBurstMb: number;
  /**
   * ceilingMb / budgetMb. Above 1.0 means the host is oversubscribed if every
   * server peaked at once — normal and intended, but worth showing plainly.
   */
  oversubscription: number;
  admissionEnabled: boolean;
  swapMode: 'off' | 'limit' | 'host';
  servers: ServerCommitment[];
  generatedAt: string;
};

export type AdmissionDecision = {
  allowed: boolean;
  code?: 'MEMORY_GUARANTEE_EXCEEDED' | 'MEMORY_BURST_EXCEEDED' | 'HOST_MEMORY_LOW';
  reason?: string;
  details?: string;
  /** The floor this start books outright. */
  requestFloorMb: number;
  /** The peak it books against the burst tier. */
  requestPeakMb: number;
  report: CapacityReport;
};

function mb(bytes: number) {
  return Math.round(bytes / MB);
}

/**
 * What a server's container is entitled to — the same number dockerService puts
 * on the cgroup, so the ledger and the container can't drift apart.
 */
export function committedMbFor(resources: ResourceConfig | undefined): number {
  return containerMemoryPlan(resources)?.capMb ?? 0;
}

/** Where the same server should sit while idle, once elastic heap does its job. */
export function floorMbFor(resources: ResourceConfig | undefined): number {
  return containerMemoryPlan(resources)?.floorMb ?? 0;
}

export { jvmOverheadMb };

export type PeakEstimate = {
  /** What the burst tier books for this server. */
  expectedPeakMb: number;
  /** The measured 7-day peak in MB, or null if never measured. */
  observedPeakMb: number | null;
  /** Whether the measurement was solid enough to be used instead of the ceiling. */
  trusted: boolean;
};

/**
 * What this server will realistically want at its worst, rather than what its
 * config says it is allowed to want.
 *
 * Max RAM is a number people pick once, usually by copying a forum post. A
 * modpack configured for 6 GB that has never crossed 2.1 GB in a week of real
 * play is not a 6 GB server, and treating it as one is precisely why strict
 * worst-case admission refuses starts that would have been completely fine.
 *
 * Three guards keep this from becoming wishful thinking:
 *   - a margin on top of the observation, because last week's peak is not a
 *     ceiling — a new dimension or twice the players moves it;
 *   - a minimum amount of history, so "hasn't been busy yet" can't masquerade
 *     as "doesn't need the memory";
 *   - the configured ceiling as a hard clamp, since the cgroup will not let the
 *     server exceed it anyway.
 */
export function expectedPeakMb(
  resources: ResourceConfig | undefined,
  peak: { memPercent: number; samples: number } | null
): PeakEstimate {
  const plan = containerMemoryPlan(resources);
  if (!plan) return { expectedPeakMb: 0, observedPeakMb: null, trusted: false };

  const ceilingMb = plan.capMb;
  // memMax is a percentage of the container limit at the time it was sampled,
  // which is this same cap unless it was reconfigured mid-week. Close enough to
  // budget on, and the clamp below bounds the error either way.
  const observedPeakMb = peak ? Math.round((peak.memPercent / 100) * ceilingMb) : null;

  if (!config.memoryUseObservedPeaks || !peak || observedPeakMb === null) {
    return { expectedPeakMb: ceilingMb, observedPeakMb, trusted: false };
  }
  if (peak.samples < config.memoryObservedPeakMinSamples) {
    return { expectedPeakMb: ceilingMb, observedPeakMb, trusted: false };
  }

  const withMargin = Math.round(observedPeakMb * (1 + config.memoryObservedPeakMarginPercent / 100));
  // Never below the floor we already guarantee, never above the cgroup cap.
  const bounded = Math.min(ceilingMb, Math.max(plan.floorMb, withMargin));
  return { expectedPeakMb: bounded, observedPeakMb, trusted: true };
}

// Cache the daemon's view briefly: `docker info` is a round trip and the answer
// only changes when the host is resized.
let dockerMemTotalCache: { bytes: number; atMs: number } | null = null;
const DOCKER_INFO_TTL_MS = 60_000;

async function dockerHostMemoryBytes(): Promise<number | null> {
  const now = Date.now();
  if (dockerMemTotalCache && now - dockerMemTotalCache.atMs < DOCKER_INFO_TTL_MS) {
    return dockerMemTotalCache.bytes;
  }
  try {
    const info = await dockerService.hostInfo();
    if (!info?.memTotalBytes) return null;
    dockerMemTotalCache = { bytes: info.memTotalBytes, atMs: now };
    return info.memTotalBytes;
  } catch (err) {
    logger.debug({ err }, 'docker info unavailable for capacity accounting');
    return null;
  }
}

/**
 * Where the servers actually live, in memory terms.
 *
 * /proc/meminfo is the good source: it has MemAvailable, which counts
 * reclaimable page cache and is the only figure worth gating on. But the
 * process reading it is not always on the same machine as the Docker daemon —
 * on Docker Desktop the daemon is a VM with its own, smaller RAM. So we take
 * the daemon's MemTotal as the authority on size, and only trust /proc's live
 * figures when the two agree on how big the machine is.
 */
export async function readHostMemory(): Promise<HostMemory> {
  const proc = readProcMemory();
  const dockerTotalBytes = await dockerHostMemoryBytes();

  if (proc) {
    const procTotalMb = proc.totalMb;
    const dockerTotalMb = dockerTotalBytes ? mb(dockerTotalBytes) : null;
    const sameMachine = !dockerTotalMb || Math.abs(dockerTotalMb - procTotalMb) / procTotalMb < 0.1;

    if (sameMachine) {
      return {
        totalMb: procTotalMb,
        availableMb: proc.availableMb,
        availableKnown: true,
        swapTotalMb: proc.swapTotalMb,
        swapUsedMb: proc.swapUsedMb,
        source: 'proc',
      };
    }
  }

  if (dockerTotalBytes) {
    // The daemon knows how big it is but not how much is free right now, and
    // /proc describes a different machine. Size the budget, skip the live gate.
    return {
      totalMb: mb(dockerTotalBytes),
      availableMb: 0,
      availableKnown: false,
      swapTotalMb: 0,
      swapUsedMb: 0,
      source: 'docker',
    };
  }

  return {
    totalMb: mb(os.totalmem()),
    availableMb: mb(os.freemem()),
    // os.freemem() is free-not-reclaimable on Linux and wildly pessimistic once
    // the page cache warms, so it sizes the budget but never blocks a start.
    availableKnown: false,
    swapTotalMb: 0,
    swapUsedMb: 0,
    source: 'os',
  };
}

/**
 * Which servers are holding memory. Docker is asked first because the stored
 * status can drift — a server the DB still calls 'running' after a crash would
 * otherwise reserve memory nothing is using, and block real starts forever.
 */
async function liveServerIds(servers: ServerRecord[]): Promise<Set<string>> {
  const fromDocker = await dockerService.runningServerIds();
  if (fromDocker) return fromDocker;
  return new Set(servers.filter((server) => LIVE_STATUSES.has(server.status)).map((server) => server.id));
}

export async function capacityReport(): Promise<CapacityReport> {
  const memory = await readHostMemory();
  const servers = serverStore.list();
  const live = await liveServerIds(servers);

  const commitments: ServerCommitment[] = servers.map((server) => {
    const estimate = expectedPeakMb(server.resources, metricsStore.peak(server.id));
    const now = metricsCollector.liveFor(server.id);
    return {
      id: server.id,
      name: server.name,
      status: server.status,
      live: live.has(server.id),
      maxRamMb: Number(server.resources?.maxRamMb) || 0,
      minRamMb: Number(server.resources?.minRamMb) || 0,
      ceilingMb: committedMbFor(server.resources),
      floorMb: floorMbFor(server.resources),
      expectedPeakMb: estimate.expectedPeakMb,
      observedPeakMb: estimate.observedPeakMb,
      observedPeakTrusted: estimate.trusted,
      actualMb: now ? Math.round(now.memoryBytes / MB) : null,
      actualCpuCores: now ? now.cpuCores : null,
      players: hibernationService.playersFor(server.id),
      hibernated: server.hibernated === true,
    };
  });

  const budgetMb = Math.max(0, memory.totalMb - config.memoryReserveMb);
  const burstAllowanceMb = Math.round(budgetMb * config.memoryBurstRatio);
  const liveServers = commitments.filter((entry) => entry.live);
  const sum = (pick: (entry: ServerCommitment) => number) => liveServers.reduce((total, e) => total + pick(e), 0);

  const guaranteedMb = sum((entry) => entry.floorMb);
  const peakMb = sum((entry) => entry.expectedPeakMb);
  const ceilingMb = sum((entry) => entry.ceilingMb);
  const actualMb = sum((entry) => entry.actualMb ?? 0);
  const actualCpuCores = sum((entry) => entry.actualCpuCores ?? 0);
  const hostCpuCores = liveServers[0]?.actualCpuCores !== undefined ? (await dockerService.hostInfo())?.ncpu ?? os.cpus().length : os.cpus().length;

  return {
    memory,
    reserveMb: config.memoryReserveMb,
    budgetMb,
    burstRatio: config.memoryBurstRatio,
    burstAllowanceMb,
    guaranteedMb,
    expectedPeakMb: peakMb,
    ceilingMb,
    actualMb,
    actualCpuCores,
    hostCpuCores,
    remainingGuaranteedMb: budgetMb - guaranteedMb,
    remainingBurstMb: burstAllowanceMb - peakMb,
    oversubscription: budgetMb > 0 ? ceilingMb / budgetMb : 0,
    admissionEnabled: config.memoryAdmissionEnabled,
    swapMode: config.containerSwapMode,
    servers: commitments,
    generatedAt: new Date().toISOString(),
  };
}

function gb(valueMb: number) {
  return `${(valueMb / 1024).toFixed(1)} GB`;
}

/**
 * Can this server start without putting the host over its budget?
 *
 * Two independent gates, because they fail for different reasons. The ledger
 * catches over-subscription that has not bitten yet — servers idling well below
 * their ceilings. The live gate catches memory MC Dash never issued: another
 * service on the box, a backup job, a runaway process.
 *
 * Pure, so the decision can be tested against a constructed ledger instead of
 * whatever RAM the machine running the tests happens to have.
 */
export function decideAdmission(
  report: CapacityReport,
  server: { id: string; name: string; resources?: ResourceConfig },
  peak: { memPercent: number; samples: number } | null = null
): AdmissionDecision {
  const requestFloorMb = floorMbFor(server.resources);
  const estimate = expectedPeakMb(server.resources, peak);
  const requestPeakMb = estimate.expectedPeakMb;

  if (requestPeakMb === 0) {
    // No configured ceiling means nothing to reason about, and refusing here
    // would block servers created before resources were mandatory.
    return { allowed: true, requestFloorMb, requestPeakMb, report };
  }

  // A server that is already running is asking to keep memory it already holds,
  // so it always passes — its commitment is in the total on both sides of the
  // comparison. Gating it would mean an over-budget host (one filled before
  // admission was switched on, or after the reserve was raised) could no longer
  // restart anything, which is a trap rather than a safeguard: refusing the
  // restart doesn't free a byte.
  const alreadyLive = report.servers.find((entry) => entry.id === server.id)?.live ?? false;
  if (alreadyLive) return { allowed: true, requestFloorMb, requestPeakMb, report };

  // Tier 1, the real promise: every running server's idle floor must fit in
  // physical memory with nothing overcommitted. Failing this means the servers
  // cannot coexist even while all of them are doing nothing, which no amount of
  // burst optimism makes acceptable.
  if (report.guaranteedMb + requestFloorMb > report.budgetMb) {
    const shortfallMb = report.guaranteedMb + requestFloorMb - report.budgetMb;
    return {
      allowed: false,
      code: 'MEMORY_GUARANTEE_EXCEEDED',
      reason:
        `Not enough memory: ${server.name} needs ${gb(requestFloorMb)} guaranteed even while idle, but only ` +
        `${gb(Math.max(0, report.remainingGuaranteedMb))} of ${gb(report.budgetMb)} is unreserved.`,
      details:
        `Running servers already reserve ${gb(report.guaranteedMb)} just to idle. Free ${gb(shortfallMb)} by ` +
        `stopping a server or lowering a min-RAM setting.`,
      requestFloorMb,
      requestPeakMb,
      report,
    };
  }

  // Tier 2: the peaks may exceed physical memory, but only by the burst ratio.
  // This is where the "they never all peak at once" bet is priced.
  if (report.expectedPeakMb + requestPeakMb > report.burstAllowanceMb) {
    const shortfallMb = report.expectedPeakMb + requestPeakMb - report.burstAllowanceMb;
    return {
      allowed: false,
      code: 'MEMORY_BURST_EXCEEDED',
      reason:
        `Too much peak demand: starting ${server.name} would put ${gb(report.expectedPeakMb + requestPeakMb)} of ` +
        `possible peak on a ${gb(report.budgetMb)} host, past the ${report.burstRatio}x burst limit.`,
      details:
        `Free ${gb(shortfallMb)} by stopping a server or lowering a max-RAM setting${
          estimate.trusted ? '' : ` (${server.name} has no usage history yet, so its full ceiling is assumed)`
        }, or raise MC_DASH_MEMORY_BURST_RATIO to take a bigger bet.`,
      requestFloorMb,
      requestPeakMb,
      report,
    };
  }

  if (report.memory.availableKnown) {
    // Gate on the floor, not the peak: the server needs its floor to boot, and
    // the heap only grows into the rest as demand appears — by which time other
    // servers may well have handed memory back.
    const headroomMb = report.memory.availableMb - requestFloorMb;
    if (headroomMb < config.hostFreeFloorMb) {
      return {
        allowed: false,
        code: 'HOST_MEMORY_LOW',
        reason:
          `Host memory is too low right now: ${gb(report.memory.availableMb)} available, ` +
          `${server.name} needs ${gb(requestFloorMb)} to start.`,
        details:
          `Starting it would leave under ${gb(config.hostFreeFloorMb)} free. Something outside MC Dash may be ` +
          `holding memory — check the host before retrying.`,
        requestFloorMb,
        requestPeakMb,
        report,
      };
    }
  }

  return { allowed: true, requestFloorMb, requestPeakMb, report };
}

/** decideAdmission against a freshly-read ledger. */
export async function evaluateStart(server: ServerRecord): Promise<AdmissionDecision> {
  return decideAdmission(await capacityReport(), server, metricsStore.peak(server.id));
}

/**
 * Gate a start, unless the caller explicitly overrode it.
 *
 * The override exists because the ledger is a forecast, not a measurement: an
 * operator who knows a pack never approaches its ceiling should be able to say
 * so, once, rather than edit env vars. It is logged at warn precisely so the
 * next freeze has a trail.
 */
export async function assertCanStart(server: ServerRecord, opts: { force?: boolean } = {}): Promise<void> {
  if (!config.memoryAdmissionEnabled) return;

  const decision = await evaluateStart(server);
  if (decision.allowed) return;

  if (opts.force) {
    logger.warn(
      {
        serverId: server.id,
        code: decision.code,
        requestPeakMb: decision.requestPeakMb,
        guaranteedMb: decision.report.guaranteedMb,
        expectedPeakMb: decision.report.expectedPeakMb,
      },
      'Memory admission overridden by force'
    );
    return;
  }

  throw new UserFacingError({
    error: 'Not enough memory',
    code: decision.code ?? 'MEMORY_BURST_EXCEEDED',
    status: 409,
    reason: decision.reason,
    details: decision.details,
  });
}
