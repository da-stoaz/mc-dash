import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { Card, CardBody, CardHeader } from '@heroui/react';
import { Activity, Clock, Cpu, HardDrive, MemoryStick, Network, Users } from 'lucide-react';
import type { PlayerInfo, ServerMetrics, ServerStatus } from '../../lib/serverTypes';
import { API_BASE, apiFetch } from '../../lib/api';
import {
  clampPercent,
  chartCapacity,
  formatBytes,
  formatUptime,
  HISTORY_LIMIT,
  METRIC_RANGES,
  MetricRange,
  MetricsHistory,
  LiveMetricsHistory,
} from './metricsUtils';

import { StorageUsage } from './StorageUsage';
import { RuntimeMemoryCheck } from './RuntimeMemoryCheck';
import { UsageChart } from './UsageChart';
import { useTpsHistory } from './useTpsHistory';

const formatCpuAbsolute = (value: number) => `${Number(value.toFixed(2))} cores`;
const formatMemoryAbsolute = (value: number) => `${(value / 1024 ** 3).toFixed(2)} GiB`;

const formatTps = (value: number) => `${value.toFixed(2)} TPS`;

const CPU_STROKE = '#22d3ee';
const CPU_FILL = 'rgba(34, 211, 238, 0.18)';
const MEM_STROKE = '#3b82f6';
const MEM_FILL = 'rgba(59, 130, 246, 0.18)';

// The collector closes a 30s bucket on its first tick past the boundary, and
// the coarser tiers are rebuilt from it in the same write.
const BUCKET_FLUSH_DELAY_MS = 5000;

const RANGE_LABELS: Record<MetricRange, string> = { '1h': '1h', '1d': '1d', '7d': '7d' };


// Real elapsed time since an epoch (ms), for the chart's left timeline edge.
function formatAgo(ms: number, now: number): string {
  const diff = now - ms;
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
  return `${Number(value.toFixed(1))}%`;
}

function mean(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// A live percentage gauge. The value and the fill share the metric's brand
// colour so it lines up visually with its sparkline below.
type GaugeProps = { icon: ReactNode; label: string; percent: number | null; color: string; detail?: string };

function Gauge({ icon, label, percent, color, detail }: GaugeProps) {
  const value = clampPercent(percent);
  return (
    <div className={`${TILE} flex flex-col p-4`}>
      <div className="flex flex-col items-start">
        <span className="flex items-center gap-2 text-sm font-medium muted">
          {icon}
          {label}
        </span>
        <span className="mt-3 text-3xl font-semibold tabular-nums">{percent === null ? '—' : `${Number(value.toFixed(1))}%`}</span>
      </div>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full transition-[width]" style={{ width: `${percent === null ? 0 : value}%`, backgroundColor: color }} />
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
function HistoryView({ history, now }: { history: MetricsHistory | null; now: number }) {
  const points = history?.points ?? [];
  const timestamps = points.map((p) => p.t);
  const cpuAvg = points.map((p) => p.cpuAvg);
  const cpuMax = points.map((p) => p.cpuMax);
  const memAvg = points.map((p) => p.memAvg);
  const memMax = points.map((p) => p.memMax);
  // Left edge = age of the oldest real bucket; right edge = present.
  const startLabel = points.length ? formatAgo(points[0].t, now) : undefined;

  return (
    <div className="divide-y divide-white/10">
      <UsageChart
        label="CPU usage"
        absoluteValues={points.map(p => p.cpuCoresAvg)} absolutePeaks={points.map(p => p.cpuCoresMax)} formatAbsolute={formatCpuAbsolute}
        absoluteCapacity={chartCapacity(cpuAvg, points.map(p => p.cpuCoresAvg))}
        values={cpuAvg}
        timestamps={timestamps}
        resolution={history?.resolution}
        band={cpuMax}
        stroke={CPU_STROKE}
        fill={CPU_FILL}
        avgLabel={points.length ? pct(mean(cpuAvg)) : '--'}
        startLabel={startLabel}
        endLabel={points.length ? formatAgo(points[points.length - 1].t, now) : undefined}
        emptyLabel="No recorded data in this range"
      />
      <UsageChart
        label="Memory usage"
        absoluteValues={points.map(p => p.memoryBytesAvg)} absolutePeaks={points.map(p => p.memoryBytesMax)} formatAbsolute={formatMemoryAbsolute}
        absoluteCapacity={chartCapacity(memAvg, points.map(p => p.memoryBytesAvg))}
        values={memAvg}
        timestamps={timestamps}
        resolution={history?.resolution}
        band={memMax}
        stroke={MEM_STROKE}
        fill={MEM_FILL}
        avgLabel={points.length ? pct(mean(memAvg)) : '--'}
        startLabel={startLabel}
        endLabel={points.length ? formatAgo(points[points.length - 1].t, now) : undefined}
        emptyLabel="No recorded data in this range"
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
  const tps = useTpsHistory(serverId, status);
  const uptimeLabel = formatUptime(metrics?.uptimeSeconds ?? null);
  const [tab, setTab] = useState<'live' | MetricRange>('live');
  const [rangeData, setRangeData] = useState<MetricsHistory | null>(null);
  const [rangeError, setRangeError] = useState(false);
  const [fetchedAt, setFetchedAt] = useState(0);

  // Persisted rollups only change when a bucket closes, so refetch just after
  // the next boundary of this range's resolution instead of on a fixed timer.
  useEffect(() => {
    if (tab === 'live' || !serverId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      let resolution = 30;
      try {
        const res = await apiFetch(`${API_BASE}/servers/${serverId}/metrics/history?range=${tab}`);
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as MetricsHistory;
        resolution = data.resolution;
        if (active) {
          setRangeData(data);
          setFetchedAt(Date.now());
          setRangeError(false);
        }
      } catch {
        if (active) setRangeError(true);
      }
      if (!active) return;
      const period = resolution * 1000;
      timer = setTimeout(load, period - (Date.now() % period) + BUCKET_FLUSH_DELAY_MS);
    };
    setRangeData(null);
    setRangeError(false);
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [tab, serverId]);

  // The live window ends at the newest reading, not the browser clock, so the
  // chart moves only when a sample arrives and its right edge is never empty.
  const liveEnd = history.timestamps.at(-1) ?? 0;
  const liveWindow: [number, number] = [liveEnd - HISTORY_LIMIT * 1000, liveEnd];
  const visibleCpu = history.cpu.filter((_, i) => history.timestamps[i] >= liveWindow[0]);
  const visibleMemory = history.memory.filter((_, i) => history.timestamps[i] >= liveWindow[0]);
  const cpuAvgLive = visibleCpu.length ? pct(mean(visibleCpu)) : '--';
  const memAvgLive = visibleMemory.length ? pct(mean(visibleMemory)) : '--';

  const live = status === 'running';
  const currentMetrics = live ? metrics : null;
  const currentPlayers = live ? players : null;
  const unavailable = live ? 'Waiting for a reading' : playerFallbackLabel(status);

  return (
    <div className="space-y-5">
      <section aria-label="Current server health" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <div className={`${TILE} p-4`}>
          <div className="flex items-center gap-2 text-sm muted"><Users size={16} />Players online</div>
          <div className="mt-3 text-3xl font-semibold tabular-nums">{currentPlayers ? currentPlayers.online : '—'}
            {currentPlayers && <span className="text-base font-normal muted"> / {currentPlayers.max}</span>}
          </div>
          <p className="mt-2 text-xs muted">{currentPlayers ? 'Connected right now' : playerFallbackLabel(status)}</p>
          <Link href={`/servers/${serverId}?tab=settings&section=players`} className="mt-2 inline-block rounded-sm py-1 text-xs text-cyan-300 hover:underline focus-visible:outline-2 focus-visible:outline-cyan-400">Manage player access</Link>
        </div>
        <Gauge icon={<Cpu size={16} />} label="CPU" percent={currentMetrics?.cpuPercent ?? null} color={CPU_STROKE}
          detail={currentMetrics ? `${formatCores(currentMetrics.cpuCores)} / ${formatCores(currentMetrics.cpuCoresAvailable)} cores` : unavailable} />
        <Gauge icon={<MemoryStick size={16} />} label="Memory" percent={currentMetrics?.memoryPercent ?? null} color={MEM_STROKE}
          detail={currentMetrics ? `${formatBytes(currentMetrics.memoryBytes)} / ${formatBytes(currentMetrics.memoryLimitBytes)}` : unavailable} />
        <div className={`${TILE} p-4`}>
          <div className="flex items-center gap-2 text-sm muted"><Clock size={16} />Uptime</div>
          <div className="mt-3 text-3xl font-semibold tabular-nums">{currentMetrics?.uptimeSeconds != null ? uptimeLabel : '—'}</div>
          <p className="mt-2 text-xs muted">{currentMetrics ? 'Since the last start' : unavailable}</p>
        </div>
      </section>

      <RuntimeMemoryCheck key={`${serverId}:${status}`} serverId={serverId} running={status === 'running'} />

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
        <Card className="border border-white/10 bg-white/[0.03] shadow-none">
          <CardHeader className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
            <div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <h2 className="text-base font-semibold">Resource usage</h2>
                <Link href={`/servers/${serverId}?tab=settings&section=resources`} className="rounded-sm py-1 text-xs text-cyan-300 hover:underline focus-visible:outline-2 focus-visible:outline-cyan-400">Adjust resources</Link>
              </div>
              <p className="mt-1 text-xs muted">{tab === 'live' ? 'Recent CPU and memory readings' : 'Average usage with peaks shaded'}</p>
            </div>
            <div role="group" aria-label="Resource history range" className="flex rounded-lg border border-white/10 p-1">
              {(['live', ...METRIC_RANGES] as const).map((key) => (
                <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)}
                  className={`rounded-md px-3 py-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-cyan-400 ${tab === key ? 'bg-white/15 text-white' : 'text-gray-400 hover:text-white'}`}>
                  {key === 'live' ? `Live ${HISTORY_LIMIT}s` : RANGE_LABELS[key]}
                </button>
              ))}
            </div>
          </CardHeader>
          <CardBody className="px-5 pb-5 pt-0">
            {tab === 'live' ? (
              <div className="divide-y divide-white/10">
                <UsageChart label="CPU usage" absoluteCapacity={chartCapacity(history.cpu, history.cpuCores, history.cpuLimits)} window={liveWindow} values={history.cpu} absoluteValues={history.cpuCores} formatAbsolute={formatCpuAbsolute} timestamps={history.timestamps} stroke={CPU_STROKE} fill={CPU_FILL}
                  avgLabel={cpuAvgLive} emptyLabel={liveChartEmptyLabel(status)} startLabel="60s ago" endLabel="Now" />
                <UsageChart label="Memory usage" absoluteCapacity={chartCapacity(history.memory, history.memoryBytes, history.memoryLimits)} window={liveWindow} values={history.memory} absoluteValues={history.memoryBytes} formatAbsolute={formatMemoryAbsolute} timestamps={history.timestamps} stroke={MEM_STROKE} fill={MEM_FILL}
                  avgLabel={memAvgLive} emptyLabel={liveChartEmptyLabel(status)} startLabel="60s ago" endLabel="Now" />
              </div>
            ) : rangeError ? (
              <div role="status" className="py-12 text-center text-sm muted">Could not load history. Retrying automatically…</div>
            ) : rangeData ? <HistoryView history={rangeData} now={fetchedAt} /> : (
              <div role="status" className="py-12 text-center text-sm muted">Loading history…</div>
            )}
          </CardBody>
        </Card>

        <div className="space-y-5">
          {tps.visible && (
            <section aria-label="Server tick rate" className={`${TILE} p-5`}>
              <h2 className="flex items-center gap-2 text-base font-semibold"><Activity size={16} />Server tick rate</h2>
              <div className="mt-3 text-3xl font-semibold tabular-nums">{tps.current ? formatTps(tps.current.tps) : '—'}</div>
              <p className="mt-1 text-xs muted">20 TPS is the target for smooth gameplay.</p>
              <UsageChart label="TPS" window={tps.window} values={tps.points.map(point => point.tps ?? NaN)} timestamps={tps.points.map(point => point.t)}
                stroke="#34d399" fill="rgba(52, 211, 153, 0.18)" maxValue={Math.max(20, ...tps.points.map(point => point.tps ?? 0))}
                formatValue={formatTps} avgLabel="" summary="Every 5s" startLabel="60s earlier" endLabel="Latest sample"
                emptyLabel={tps.unavailable ? 'Unavailable' : 'Collecting data…'} />
              {tps.unavailable && tps.points.length > 1 && <p className="text-xs text-amber-300">Current reading unavailable; showing recent samples.</p>}
            </section>
          )}
          <section aria-label="Connected players" className={`${TILE} p-5`}>
            <h2 className="text-base font-semibold">Connected players</h2>
            {currentPlayers?.names.length ? (
              <ul className="mt-3 max-h-56 space-y-2 overflow-y-auto">
                {currentPlayers.names.map(name => <li key={name} className="flex items-center gap-2 break-all text-sm"><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />{name}</li>)}
              </ul>
            ) : <p className="mt-3 text-sm muted">{currentPlayers ? currentPlayers.online ? 'Player names unavailable.' : 'No players connected.' : live ? 'Player list unavailable.' : 'Players will appear here when the server is running.'}</p>}
          </section>
        </div>
      </div>

      <StorageUsage key={serverId} serverId={serverId} />

      <details className={`${TILE} p-4`}>
        <summary className="cursor-pointer text-sm font-medium">Process diagnostics</summary>
        {currentMetrics ? <>
        <p className="mt-4 text-xs muted">Totals since the current start</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <StatBlock icon={<Network size={16} />} title="Network transfer" primary={`Received: ${currentMetrics ? formatBytes(currentMetrics.networkRxBytes) : '—'}`} secondary={`Sent: ${currentMetrics ? formatBytes(currentMetrics.networkTxBytes) : '—'}`} />
          <StatBlock icon={<HardDrive size={16} />} title="Disk I/O" primary={`Read: ${currentMetrics ? formatBytes(currentMetrics.blkReadBytes) : '—'}`} secondary={`Written: ${currentMetrics ? formatBytes(currentMetrics.blkWriteBytes) : '—'}`} />
          <StatBlock icon={<Cpu size={16} />} title="Processes" primary={`${currentMetrics?.pids ?? '—'} PIDs`} secondary="Inside this container" />
        </div>
        </> : <p className="mt-4 text-sm muted">{live ? 'Waiting for a reading.' : 'Available while the server is running.'}</p>}
      </details>
    </div>
  );
}
