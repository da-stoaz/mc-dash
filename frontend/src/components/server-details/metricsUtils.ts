import type { ServerMetrics } from '../../lib/serverTypes';

export const HISTORY_LIMIT = 60;
export const LIVE_GAP_MS = 15_000;

/** Keep the sample immediately before the window so lines reach its boundary.
 * Older samples cannot bridge an outage and must still expire. Input is sorted. */
export function retainLiveWindow<T>(points: T[], time: (point: T) => number, now = Date.now()): T[] {
  const start = now - HISTORY_LIMIT * 1000;
  const first = points.findIndex(point => time(point) >= start);
  if (first < 0) return [];
  const predecessor = first > 0 && time(points[first - 1]) >= start - LIVE_GAP_MS;
  return points.slice(predecessor ? first - 1 : first);
}

export type LiveMetricsHistory = {
  cpuCores: (number | null)[];
  memoryBytes: (number | null)[];
  cpu: number[];
  memory: number[];
  timestamps: number[];
  cpuLimits: number[];
  memoryLimits: number[];
};

export const emptyLiveHistory = (): LiveMetricsHistory => ({ cpu: [], memory: [], timestamps: [], cpuCores: [], memoryBytes: [], cpuLimits: [], memoryLimits: [] });

/** Merge reconnect snapshots and streaming readings by their collection time. */
export function mergeLiveHistory(previous: LiveMetricsHistory, samples: (ServerMetrics & { at: number })[], now = Date.now()): LiveMetricsHistory {
  const points = new Map(previous.timestamps.map((at, i) => [at, {
    at, cpuPercent: previous.cpu[i], memoryPercent: previous.memory[i], cpuCores: previous.cpuCores[i],
    memoryBytes: previous.memoryBytes[i], cpuCoresAvailable: previous.cpuLimits[i], memoryLimitBytes: previous.memoryLimits[i],
  }]));
  for (const sample of samples) {
    if (Number.isFinite(sample.at) && sample.status === 'running') points.set(sample.at, sample);
  }
  const result = emptyLiveHistory();
  const sorted = [...points.values()].filter(p => p.at <= now + 1000).sort((a, b) => a.at - b.at);
  for (const point of retainLiveWindow(sorted, p => p.at, now).slice(-120)) {
    result.timestamps.push(point.at);
    result.cpu.push(point.cpuPercent);
    result.memory.push(point.memoryPercent);
    result.cpuCores.push(point.cpuCores);
    result.memoryBytes.push(point.memoryBytes);
    result.cpuLimits.push(point.cpuCoresAvailable);
    result.memoryLimits.push(point.memoryLimitBytes);
  }
  return result;
}

/** One absolute scale only exists when the allocation was constant in this range. */
export function chartCapacity(values: number[], absolute: (number | null | undefined)[], limits: number[] = []): number | null {
  const capacities = limits.filter(n => Number.isFinite(n) && n > 0);
  if (!capacities.length) values.forEach((percent, i) => {
    const usage = absolute[i];
    if (percent > 0 && usage != null && usage > 0) capacities.push(usage * 100 / percent);
  });
  if (!capacities.length) return null;
  const first = capacities[0];
  return capacities.every(n => Math.abs(n - first) <= first * 0.001) ? first : null;
}

export function formatBytes(bytes?: number | null) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatUptime(seconds?: number | null) {
  if (!seconds || seconds <= 0) return '0s';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const parts = [] as string[];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (secs && parts.length === 0) parts.push(`${secs}s`);
  return parts.join(' ');
}

export function clampPercent(value?: number | null) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value as number));
}

// `max` scales the y-axis: percentages pass 100, byte/sec rates pass the
// series peak so the curve fills the box regardless of magnitude.
export function buildSparklinePath(values: number[], width = 100, height = 36, max = 100, positions?: number[], gapBefore?: boolean[]) {
  if (values.length === 0) return '';
  const scale = max > 0 ? max : 1;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  return values
    .map((value, index) => {
      if (!Number.isFinite(value)) return '';
      const x = positions ? positions[index] * width : index * step;
      const y = height - (value / scale) * height;
      return `${index === 0 || !Number.isFinite(values[index - 1]) || gapBefore?.[index] ? 'M' : 'L'} ${x} ${y}`;
    })
    .join(' ');
}

export function buildSparklineArea(values: number[], width = 100, height = 36, max = 100, positions?: number[], gapBefore?: boolean[]) {
  const line = buildSparklinePath(values, width, height, max, positions, gapBefore);
  if (!line) return '';
  // Close each contiguous segment separately so missing samples remain gaps.
  return line.split('M ').filter(Boolean).map(segment => {
    const coordinates = segment.trim().split(/[ML] /).map(pair => pair.trim().split(' ').map(Number));
    return `M ${segment.trim()} L ${coordinates.at(-1)![0]} ${height} L ${coordinates[0][0]} ${height} Z`;
  }).join(' ');
}

export const METRIC_RANGES = ['1h', '1d', '7d'] as const;
export type MetricRange = (typeof METRIC_RANGES)[number];

// One consolidated bucket as returned by GET /servers/:id/metrics/history.
export type MetricPoint = {
  t: number; // bucket start, ms epoch
  cpuCoresAvg?: number | null;
  cpuCoresMax?: number | null;
  memoryBytesAvg?: number | null;
  memoryBytesMax?: number | null;
  cpuMin: number;
  cpuAvg: number;
  cpuMax: number;
  memMin: number;
  memAvg: number;
  memMax: number;
  netRxAvg: number;
  netRxMax: number;
  netTxAvg: number;
  netTxMax: number;
  diskRAvg: number;
  diskRMax: number;
  diskWAvg: number;
  diskWMax: number;
  samples: number;
};

export type MetricsHistory = {
  range: MetricRange;
  resolution: number;
  points: MetricPoint[];
};
