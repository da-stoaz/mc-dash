import { dockerService } from './dockerService';
import { serverStore } from '../serverStore';
import { metricsStore, FINE_RESOLUTION, MetricBucket } from '../metricsStore';
import { preparing } from '../state';
import { logger } from '../logger';

// The collector is the single metrics poller. It runs a 1s base loop and
// samples each server on an adaptive cadence:
//   - ACTIVE (a live client is watching) -> every 1s, for a responsive graph
//   - IDLE (nobody watching)             -> every 5s, just enough to persist
// Sampling a server also pushes the live reading to any watchers (the SSE
// room), so the detail stream no longer polls Docker on its own.
const BASE_INTERVAL_MS = 1000;
const ACTIVE_INTERVAL_MS = 1000;
const IDLE_INTERVAL_MS = 5000;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;
// Cadence tolerance so setInterval jitter doesn't skip an otherwise-due sample.
const DUE_SLACK_MS = 250;

export type MetricsPayload = Awaited<ReturnType<typeof dockerService.metrics>>;
type MetricsListener = (metrics: MetricsPayload | null) => void;

type Sample = {
  cpu: number;
  mem: number;
  netRx: number;
  netTx: number;
  diskR: number;
  diskW: number;
};

// Cumulative Docker counters + timestamp, used to derive per-second rates.
type Counters = { rx: number; tx: number; read: number; write: number; tsMs: number };

type Accumulator = {
  bucketStart: number; // 30s-aligned epoch seconds
  samples: Sample[];
  prev?: Counters; // survives bucket rotation so rates stay continuous
  lastSampledAt?: number; // ms, drives the adaptive cadence gate
};

function bucketFor(nowMs: number) {
  return Math.floor(nowMs / 1000 / FINE_RESOLUTION) * FINE_RESOLUTION;
}

// Rate of a monotonic counter. Clamps counter resets (container restart) to 0.
function rate(curr: number, prev: number, dtSec: number) {
  if (dtSec <= 0 || curr < prev) return 0;
  return (curr - prev) / dtSec;
}

function min(values: number[]) {
  return values.reduce((a, b) => Math.min(a, b), values[0]);
}
function max(values: number[]) {
  return values.reduce((a, b) => Math.max(a, b), values[0]);
}
function avg(values: number[]) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function toBucket(serverId: string, bucketStart: number, samples: Sample[]): MetricBucket {
  return {
    serverId,
    bucketStart,
    cpuMin: min(samples.map((s) => s.cpu)),
    cpuAvg: avg(samples.map((s) => s.cpu)),
    cpuMax: max(samples.map((s) => s.cpu)),
    memMin: min(samples.map((s) => s.mem)),
    memAvg: avg(samples.map((s) => s.mem)),
    memMax: max(samples.map((s) => s.mem)),
    netRxAvg: avg(samples.map((s) => s.netRx)),
    netRxMax: max(samples.map((s) => s.netRx)),
    netTxAvg: avg(samples.map((s) => s.netTx)),
    netTxMax: max(samples.map((s) => s.netTx)),
    diskRAvg: avg(samples.map((s) => s.diskR)),
    diskRMax: max(samples.map((s) => s.diskR)),
    diskWAvg: avg(samples.map((s) => s.diskW)),
    diskWMax: max(samples.map((s) => s.diskW)),
    samples: samples.length,
  };
}

class MetricsCollector {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastPruneAt = 0;
  private readonly accums = new Map<string, Accumulator>();
  // serverId -> live listeners. A server with >=1 listener is "active".
  private readonly watchers = new Map<string, Set<MetricsListener>>();

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), BASE_INTERVAL_MS);
    logger.info(`Metrics collector started (base ${BASE_INTERVAL_MS}ms, active ${ACTIVE_INTERVAL_MS}ms, idle ${IDLE_INTERVAL_MS}ms)`);
  }

  // Subscribe to live samples for a server. Registering makes the server
  // "active" (sampled every 1s) until the returned disposer runs.
  watch(serverId: string, listener: MetricsListener): () => void {
    let set = this.watchers.get(serverId);
    if (!set) {
      set = new Set();
      this.watchers.set(serverId, set);
    }
    set.add(listener);
    // Sample on the next tick rather than after a full idle interval.
    const acc = this.accums.get(serverId);
    if (acc) acc.lastSampledAt = undefined;
    return () => {
      const current = this.watchers.get(serverId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.watchers.delete(serverId);
    };
  }

  private notify(serverId: string, metrics: MetricsPayload | null) {
    const set = this.watchers.get(serverId);
    if (!set) return;
    for (const listener of set) listener(metrics);
  }

  private flush(serverId: string, acc: Accumulator) {
    if (acc.samples.length === 0) return; // nothing sampled this bucket
    try {
      metricsStore.writeFineBucket(toBucket(serverId, acc.bucketStart, acc.samples));
    } catch (err) {
      logger.warn({ err, serverId }, 'metrics flush failed');
    }
  }

  private async tick() {
    if (this.running) return; // avoid overlap when Docker stats are slow
    this.running = true;
    const nowMs = Date.now();
    const currentBucket = bucketFor(nowMs);
    try {
      const servers = serverStore.list();
      const liveIds = new Set(servers.map((s) => s.id));
      // Drop accumulators for servers that no longer exist.
      for (const id of this.accums.keys()) if (!liveIds.has(id)) this.accums.delete(id);

      for (const server of servers) {
        if (preparing.has(server.id)) continue;

        // Rotate the bucket on the wall clock every tick, independent of
        // sampling, so a stopped server's open bucket still gets persisted.
        let acc = this.accums.get(server.id);
        if (acc && acc.bucketStart !== currentBucket) {
          this.flush(server.id, acc);
          acc = { bucketStart: currentBucket, samples: [], prev: acc.prev, lastSampledAt: acc.lastSampledAt };
          this.accums.set(server.id, acc);
        }
        if (!acc) {
          acc = { bucketStart: currentBucket, samples: [] };
          this.accums.set(server.id, acc);
        }

        // Adaptive cadence: fast while a live client watches this server.
        const interval = this.watchers.has(server.id) ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;
        if (acc.lastSampledAt && nowMs - acc.lastSampledAt < interval - DUE_SLACK_MS) continue;
        acc.lastSampledAt = nowMs;

        let metrics: MetricsPayload;
        try {
          metrics = await dockerService.metrics(server);
        } catch {
          this.notify(server.id, null); // container missing/unreadable this tick
          continue;
        }

        if (metrics.status !== 'running') {
          acc.prev = undefined; // reset rate baseline so restart isn't a huge spike
          this.notify(server.id, null);
          continue;
        }

        const dtSec = acc.prev ? (nowMs - acc.prev.tsMs) / 1000 : 0;
        acc.samples.push({
          cpu: Math.max(0, metrics.cpuPercent),
          mem: Math.max(0, metrics.memoryPercent),
          netRx: acc.prev ? rate(metrics.networkRxBytes, acc.prev.rx, dtSec) : 0,
          netTx: acc.prev ? rate(metrics.networkTxBytes, acc.prev.tx, dtSec) : 0,
          diskR: acc.prev ? rate(metrics.blkReadBytes, acc.prev.read, dtSec) : 0,
          diskW: acc.prev ? rate(metrics.blkWriteBytes, acc.prev.write, dtSec) : 0,
        });
        acc.prev = {
          rx: metrics.networkRxBytes,
          tx: metrics.networkTxBytes,
          read: metrics.blkReadBytes,
          write: metrics.blkWriteBytes,
          tsMs: nowMs,
        };
        this.notify(server.id, metrics); // live push to the SSE room
      }

      if (nowMs - this.lastPruneAt >= PRUNE_INTERVAL_MS) {
        metricsStore.prune();
        this.lastPruneAt = nowMs;
      }
    } catch (err) {
      logger.warn({ err }, 'metrics collector tick failed');
    } finally {
      this.running = false;
    }
  }
}

export const metricsCollector = new MetricsCollector();
