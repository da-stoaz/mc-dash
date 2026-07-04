import { useEffect, useState, type ReactNode } from 'react';
import { Card, CardBody, CardHeader, Divider, Progress } from '@heroui/react';
import { Cpu, HardDrive, MemoryStick, Network, Users } from 'lucide-react';
import type { PlayerInfo, ServerMetrics, ServerStatus } from '../../lib/serverTypes';
import { API_BASE, apiFetch } from '../../lib/api';
import {
  buildSparklineArea,
  buildSparklinePath,
  formatBytes,
  formatUptime,
  HISTORY_LIMIT,
  METRIC_RANGES,
  MetricPoint,
  MetricRange,
  MetricsHistory,
} from './metricsUtils';

const CPU_STROKE = '#22d3ee';
const CPU_FILL = 'rgba(34, 211, 238, 0.18)';
const MEM_STROKE = '#3b82f6';
const MEM_FILL = 'rgba(59, 130, 246, 0.18)';

const RANGE_LABELS: Record<MetricRange, string> = { '1h': '1h', '1d': '1d', '7d': '7d' };

type ChartProps = {
  label: string;
  /** Trend line (avg). */
  values: number[];
  /** Optional worst-case band rendered behind the line (max). */
  band?: number[];
  stroke: string;
  fill: string;
  /** y-axis ceiling; 100 for percentages, series peak for rates. */
  max?: number;
  avgLabel: string;
  /** Shown when there aren't enough points to draw a line. */
  emptyLabel?: string;
};

// Draws the max as a translucent band with the avg as a solid line on top, so a
// single glance shows both typical load and the spikes that cause lag/GC/OOM.
function Chart({ label, values, band, stroke, fill, max = 100, avgLabel, emptyLabel = 'Collecting data…' }: ChartProps) {
  const linePath = buildSparklinePath(values, 100, 36, max);
  const areaPath = buildSparklineArea(band ?? values, 100, 36, max);
  const hasData = values.length > 1;

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-3">
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold">{label}</span>
        <span className="muted">Avg {avgLabel}</span>
      </div>
      <div className="mt-2 h-16">
        {hasData ? (
          <svg viewBox="0 0 100 36" className="h-full w-full" preserveAspectRatio="none">
            <path d={areaPath} fill={fill} />
            <path d={linePath} fill="none" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <div className="flex h-full items-center justify-center text-xs muted">{emptyLabel}</div>
        )}
      </div>
    </div>
  );
}

function pct(value: number) {
  return `${Math.round(value)}%`;
}

function mean(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

type RateSummaryProps = { icon: ReactNode; title: string; inLabel: string; outLabel: string };

function RateSummary({ icon, title, inLabel, outLabel }: RateSummaryProps) {
  return (
    <div className="flex items-start gap-2">
      {icon}
      <div>
        <div className="font-semibold">{title}</div>
        <div className="muted">{inLabel}</div>
        <div className="muted">{outLabel}</div>
      </div>
    </div>
  );
}

// Historical view for a persisted range (1h / 1d / 7d).
function HistoryView({ history }: { history: MetricsHistory | null }) {
  const points = history?.points ?? [];
  const cpuAvg = points.map((p) => p.cpuAvg);
  const cpuMax = points.map((p) => p.cpuMax);
  const memAvg = points.map((p) => p.memAvg);
  const memMax = points.map((p) => p.memMax);

  const peakRate = (pick: (p: MetricPoint) => number) => points.reduce((m, p) => Math.max(m, pick(p)), 0);
  const avgRate = (pick: (p: MetricPoint) => number) => mean(points.map(pick));

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <Chart
          label="CPU usage"
          values={cpuAvg}
          band={cpuMax}
          stroke={CPU_STROKE}
          fill={CPU_FILL}
          avgLabel={points.length ? pct(mean(cpuAvg)) : '--'}
        />
        <Chart
          label="Memory usage"
          values={memAvg}
          band={memMax}
          stroke={MEM_STROKE}
          fill={MEM_FILL}
          avgLabel={points.length ? pct(mean(memAvg)) : '--'}
        />
      </div>
      <div className="grid gap-3 md:grid-cols-2 text-sm">
        <RateSummary
          icon={<Network size={16} />}
          title="Network"
          inLabel={`In: ${formatBytes(avgRate((p) => p.netRxAvg))}/s avg · ${formatBytes(peakRate((p) => p.netRxMax))}/s peak`}
          outLabel={`Out: ${formatBytes(avgRate((p) => p.netTxAvg))}/s avg · ${formatBytes(peakRate((p) => p.netTxMax))}/s peak`}
        />
        <RateSummary
          icon={<HardDrive size={16} />}
          title="Disk"
          inLabel={`Read: ${formatBytes(avgRate((p) => p.diskRAvg))}/s avg · ${formatBytes(peakRate((p) => p.diskRMax))}/s peak`}
          outLabel={`Write: ${formatBytes(avgRate((p) => p.diskWAvg))}/s avg · ${formatBytes(peakRate((p) => p.diskWMax))}/s peak`}
        />
      </div>
    </div>
  );
}

type MetricsCardProps = {
  serverId: string;
  metrics: ServerMetrics | null;
  players: PlayerInfo | null;
  status: ServerStatus | null;
  history: { cpu: number[]; memory: number[] };
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
    <Card className="bg-white/5 border border-white/10">
      <CardHeader className="flex items-center gap-2 text-lg font-semibold">
        <Cpu size={18} />
        <span>Metrics</span>
      </CardHeader>
      <CardBody className="space-y-4">
        <div className="rounded-lg border border-white/10 bg-white/5 p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Users size={16} />
              <span>Players online</span>
            </div>
            <div className="text-lg font-semibold tabular-nums">
              {players ? (
                <>
                  {players.online}
                  <span className="muted text-sm"> / {players.max}</span>
                </>
              ) : (
                <span className="muted text-sm">{playerFallbackLabel(status)}</span>
              )}
            </div>
          </div>
          {players && players.names.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {players.names.map((name) => (
                <span
                  key={name}
                  className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-xs"
                >
                  {name}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <div className="text-sm muted mb-2">CPU</div>
            <Progress aria-label="CPU usage" size="sm" value={metrics?.cpuPercent ?? 0} showValueLabel />
          </div>
          <div>
            <div className="text-sm muted mb-2">Memory</div>
            <Progress aria-label="Memory usage" size="sm" value={metrics?.memoryPercent ?? 0} showValueLabel />
            <div className="text-xs muted mt-1">
              {formatBytes(metrics?.memoryBytes)} / {formatBytes(metrics?.memoryLimitBytes)}
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs uppercase tracking-wide muted">
            <span>Usage history</span>
            <div className="flex items-center gap-1 normal-case">
              {(['live', ...METRIC_RANGES] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTab(key)}
                  className={`rounded px-2 py-0.5 text-xs transition-colors ${
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
              <Chart
                label="CPU usage"
                values={history.cpu}
                stroke={CPU_STROKE}
                fill={CPU_FILL}
                avgLabel={cpuAvgLive}
                emptyLabel={liveChartEmptyLabel(status)}
              />
              <Chart
                label="Memory usage"
                values={history.memory}
                stroke={MEM_STROKE}
                fill={MEM_FILL}
                avgLabel={memAvgLive}
                emptyLabel={liveChartEmptyLabel(status)}
              />
            </div>
          ) : rangeError ? (
            <div className="flex h-16 items-center justify-center text-xs muted">Failed to load history</div>
          ) : (
            <HistoryView history={rangeData} />
          )}
        </div>

        <Divider className="bg-white/10" />

        <div className="grid gap-3 md:grid-cols-3 text-sm">
          <RateSummary
            icon={<Network size={16} />}
            title="Network"
            inLabel={`In: ${formatBytes(metrics?.networkRxBytes)}`}
            outLabel={`Out: ${formatBytes(metrics?.networkTxBytes)}`}
          />
          <RateSummary
            icon={<HardDrive size={16} />}
            title="Disk"
            inLabel={`Read: ${formatBytes(metrics?.blkReadBytes)}`}
            outLabel={`Write: ${formatBytes(metrics?.blkWriteBytes)}`}
          />
          <div className="flex items-start gap-2">
            <MemoryStick size={16} />
            <div>
              <div className="font-semibold">Runtime</div>
              <div className="muted">PIDs: {metrics?.pids ?? '-'}</div>
              <div className="muted">Uptime: {uptimeLabel}</div>
            </div>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
