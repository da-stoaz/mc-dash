import { useEffect, useState, type ReactNode } from 'react';
import { Card, CardBody, CardHeader, Divider } from '@heroui/react';
import { Cpu, HardDrive, MemoryStick, Network, Users } from 'lucide-react';
import type { PlayerInfo, ServerMetrics, ServerStatus } from '../../lib/serverTypes';
import { API_BASE, apiFetch } from '../../lib/api';
import {
  clampPercent,
  formatBytes,
  formatUptime,
  HISTORY_LIMIT,
  METRIC_RANGES,
  MetricRange,
  MetricsHistory,
  LiveMetricsHistory,
} from './metricsUtils';

import { UsageChart } from './UsageChart';

const CPU_STROKE = '#22d3ee';
const CPU_FILL = 'rgba(34, 211, 238, 0.18)';
const MEM_STROKE = '#3b82f6';
const MEM_FILL = 'rgba(59, 130, 246, 0.18)';

const RANGE_LABELS: Record<MetricRange, string> = { '1h': '1h', '1d': '1d', '7d': '7d' };

// Past this, player names collapse into a "+N more" chip instead of wrapping.
const MAX_PLAYER_CHIPS = 5;

// Real elapsed time since an epoch (ms), for the chart's left timeline edge.
function formatAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'now';
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Cores as a short number: "12", "1.8", "0.04". Gives a bare CPU 0% real context.
function formatCores(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 10) return Math.round(n).toString();
  return parseFloat(n.toFixed(n >= 1 ? 1 : 2)).toString();
}

// Shared tile chrome so every panel in the card reads as one system.
const TILE = 'rounded-lg border border-white/10 bg-white/5';

function pct(value: number) {
  return `${Math.round(value)}%`;
}

function mean(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// A live percentage gauge. The value and the fill share the metric's brand
// colour so it lines up visually with its sparkline below.
type GaugeProps = { icon: ReactNode; label: string; percent: number; color: string; detail?: string };

function Gauge({ icon, label, percent, color, detail }: GaugeProps) {
  const value = clampPercent(percent);
  return (
    <div className={`${TILE} flex flex-col p-4`}>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm font-medium muted">
          {icon}
          {label}
        </span>
        <span className="text-2xl font-semibold leading-none tabular-nums">{Math.round(value)}%</span>
      </div>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full transition-[width]" style={{ width: `${value}%`, backgroundColor: color }} />
      </div>
      {/* Reserve the sub-line on both gauges so CPU and Memory stay the same height. */}
      <div className="mt-2 min-h-4 text-xs tabular-nums muted">{detail ?? ''}</div>
    </div>
  );
}

// Icon + two-line readout used for Network / Disk / Runtime, in both the live
// footer and the historical avg/peak view.
type StatBlockProps = { icon: ReactNode; title: string; primary: string; secondary: string };

function StatBlock({ icon, title, primary, secondary }: StatBlockProps) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/5 muted">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xs uppercase tracking-wide muted">{title}</div>
        <div className="mt-0.5 text-sm tabular-nums">{primary}</div>
        <div className="text-sm tabular-nums">{secondary}</div>
      </div>
    </div>
  );
}

// Historical view for a persisted range (1h / 1d / 7d): just the trend charts.
// Current Network/Disk/Runtime live in the footer, so we don't repeat them here.
function HistoryView({ history }: { history: MetricsHistory | null }) {
  const points = history?.points ?? [];
  const timestamps = points.map((p) => p.t);
  const cpuAvg = points.map((p) => p.cpuAvg);
  const cpuMax = points.map((p) => p.cpuMax);
  const memAvg = points.map((p) => p.memAvg);
  const memMax = points.map((p) => p.memMax);
  // Left edge = age of the oldest real bucket; right edge = present.
  const startLabel = points.length ? formatAgo(points[0].t) : undefined;

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <UsageChart
        label="CPU usage"
        values={cpuAvg}
        timestamps={timestamps}
        resolution={history?.resolution}
        band={cpuMax}
        stroke={CPU_STROKE}
        fill={CPU_FILL}
        avgLabel={points.length ? pct(mean(cpuAvg)) : '--'}
        startLabel={startLabel}
        endLabel="now"
      />
      <UsageChart
        label="Memory usage"
        values={memAvg}
        timestamps={timestamps}
        resolution={history?.resolution}
        band={memMax}
        stroke={MEM_STROKE}
        fill={MEM_FILL}
        avgLabel={points.length ? pct(mean(memAvg)) : '--'}
        startLabel={startLabel}
        endLabel="now"
      />
    </div>
  );
}

type MetricsCardProps = {
  serverId: string;
  metrics: ServerMetrics | null;
  players: PlayerInfo | null;
  status: ServerStatus | null;
  history: LiveMetricsHistory;
};

// A live count is only expected while the server is up. When it's knowingly
// offline we say so; while it's coming up we say "Starting…"; only a running
// server that fails to answer over RCON is genuinely "Unknown".
function playerFallbackLabel(status: ServerStatus | null): string {
  switch (status) {
    case 'starting':
    case 'restarting':
      return 'Starting…';
    case 'running':
      return 'Unknown';
    default:
      // stopped, exited, stopping, creating, error, or unknown status
      return 'Offline';
  }
}

// Empty live-chart label. A stopped server will never stream samples, so
// promising "Collecting data…" is a lie — only say that while it's actually up.
function liveChartEmptyLabel(status: ServerStatus | null): string {
  switch (status) {
    case 'starting':
    case 'restarting':
      return 'Starting…';
    case 'running':
      return 'Collecting data…';
    default:
      return 'Offline';
  }
}

export function MetricsCard({ serverId, metrics, players, status, history }: MetricsCardProps) {
  const uptimeLabel = formatUptime(metrics?.uptimeSeconds ?? null);
  const [tab, setTab] = useState<'live' | MetricRange>('live');
  const [rangeData, setRangeData] = useState<MetricsHistory | null>(null);
  const [rangeError, setRangeError] = useState(false);

  // Fetch (and periodically refresh) persisted rollups when a range tab is active.
  useEffect(() => {
    if (tab === 'live' || !serverId) return;
    let active = true;
    const load = async () => {
      try {
        const res = await apiFetch(`${API_BASE}/servers/${serverId}/metrics/history?range=${tab}`);
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as MetricsHistory;
        if (active) {
          setRangeData(data);
          setRangeError(false);
        }
      } catch {
        if (active) setRangeError(true);
      }
    };
    setRangeData(null);
    load();
    const timer = setInterval(load, 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [tab, serverId]);

  const cpuAvgLive = history.cpu.length ? pct(mean(history.cpu)) : '--';
  const memAvgLive = history.memory.length ? pct(mean(history.memory)) : '--';

  return (
    <Card className={TILE}>
      <CardHeader className="flex items-center gap-2 text-lg font-semibold">
        <Cpu size={18} />
        <span>Metrics</span>
      </CardHeader>
      <CardBody className="space-y-4">
        <div className={`${TILE} p-4`}>
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm font-medium muted">
              <Users size={16} />
              Players online
            </span>
            <div className="text-2xl font-semibold leading-none tabular-nums">
              {players ? (
                <>
                  {players.online}
                  <span className="muted text-base font-normal"> / {players.max}</span>
                </>
              ) : (
                <span className="muted text-sm font-normal">{playerFallbackLabel(status)}</span>
              )}
            </div>
          </div>
          {players && players.names.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {players.names.slice(0, MAX_PLAYER_CHIPS).map((name) => (
                <span
                  key={name}
                  className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-xs"
                >
                  {name}
                </span>
              ))}
              {players.names.length > MAX_PLAYER_CHIPS && (
                <span className="rounded-full px-2.5 py-0.5 text-xs muted">
                  +{players.names.length - MAX_PLAYER_CHIPS} more
                </span>
              )}
            </div>
          )}
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <Gauge
            icon={<Cpu size={16} />}
            label="CPU"
            percent={metrics?.cpuPercent ?? 0}
            color={CPU_STROKE}
            detail={metrics ? `${formatCores(metrics.cpuCores)} / ${formatCores(metrics.cpuCoresAvailable)} cores` : undefined}
          />
          <Gauge
            icon={<MemoryStick size={16} />}
            label="Memory"
            percent={metrics?.memoryPercent ?? 0}
            color={MEM_STROKE}
            detail={`${formatBytes(metrics?.memoryBytes)} / ${formatBytes(metrics?.memoryLimitBytes)}`}
          />
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs uppercase tracking-wide muted">Usage history</span>
            <div className="flex items-center gap-0.5 rounded-md border border-white/10 bg-white/5 p-0.5">
              {(['live', ...METRIC_RANGES] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTab(key)}
                  className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                    tab === key ? 'bg-white/15 text-white' : 'text-white/50 hover:text-white/80'
                  }`}
                >
                  {key === 'live' ? `Live ${HISTORY_LIMIT}s` : RANGE_LABELS[key]}
                </button>
              ))}
            </div>
          </div>

          {tab === 'live' ? (
            <div className="grid gap-3 md:grid-cols-2">
              <UsageChart
                label="CPU usage"
                values={history.cpu}
                timestamps={history.timestamps}
                stroke={CPU_STROKE}
                fill={CPU_FILL}
                avgLabel={cpuAvgLive}
                emptyLabel={liveChartEmptyLabel(status)}
              />
              <UsageChart
                label="Memory usage"
                values={history.memory}
                timestamps={history.timestamps}
                stroke={MEM_STROKE}
                fill={MEM_FILL}
                avgLabel={memAvgLive}
                emptyLabel={liveChartEmptyLabel(status)}
              />
            </div>
          ) : rangeError ? (
            <div className={`${TILE} flex h-16 items-center justify-center text-xs muted`}>Failed to load history</div>
          ) : (
            <HistoryView history={rangeData} />
          )}
        </div>

        <Divider className="bg-white/10" />

        <div className="grid gap-4 md:grid-cols-3">
          <StatBlock
            icon={<Network size={16} />}
            title="Network"
            primary={`In: ${formatBytes(metrics?.networkRxBytes)}`}
            secondary={`Out: ${formatBytes(metrics?.networkTxBytes)}`}
          />
          <StatBlock
            icon={<HardDrive size={16} />}
            title="Disk"
            primary={`Read: ${formatBytes(metrics?.blkReadBytes)}`}
            secondary={`Write: ${formatBytes(metrics?.blkWriteBytes)}`}
          />
          <StatBlock
            icon={<MemoryStick size={16} />}
            title="Runtime"
            primary={`PIDs: ${metrics?.pids ?? '-'}`}
            secondary={`Uptime: ${uptimeLabel}`}
          />
        </div>
      </CardBody>
    </Card>
  );
}
