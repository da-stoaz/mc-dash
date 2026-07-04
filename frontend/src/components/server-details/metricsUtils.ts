export const HISTORY_LIMIT = 60;

export function formatBytes(bytes?: number | null) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
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
export function buildSparklinePath(values: number[], width = 100, height = 36, max = 100) {
  if (values.length === 0) return '';
  const scale = max > 0 ? max : 1;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  return values
    .map((value, index) => {
      const x = index * step;
      const y = height - (value / scale) * height;
      return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
    })
    .join(' ');
}

export function buildSparklineArea(values: number[], width = 100, height = 36, max = 100) {
  const line = buildSparklinePath(values, width, height, max);
  if (!line) return '';
  return `${line} L ${width} ${height} L 0 ${height} Z`;
}

export const METRIC_RANGES = ['1h', '1d', '7d'] as const;
export type MetricRange = (typeof METRIC_RANGES)[number];

// One consolidated bucket as returned by GET /servers/:id/metrics/history.
export type MetricPoint = {
  t: number; // bucket start, ms epoch
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
