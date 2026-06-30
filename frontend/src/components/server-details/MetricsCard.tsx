import { Card, CardBody, CardHeader, Divider, Progress } from '@heroui/react';
import { Cpu, HardDrive, MemoryStick, Network } from 'lucide-react';
import type { ServerMetrics } from '../../lib/serverTypes';
import { buildSparklineArea, buildSparklinePath, formatBytes, formatUptime, HISTORY_LIMIT } from './metricsUtils';

type SparklineProps = {
  label: string;
  values: number[];
  stroke: string;
  fill: string;
};

function SparklineCard({ label, values, stroke, fill }: SparklineProps) {
  const linePath = buildSparklinePath(values);
  const areaPath = buildSparklineArea(values);
  const hasData = values.length > 1;
  const avgValue =
    values.length > 0 ? `${Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)}%` : '--';

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-3">
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold">{label}</span>
        <span className="muted">Avg {avgValue}</span>
      </div>
      <div className="mt-2 h-16">
        {hasData ? (
          <svg viewBox="0 0 100 36" className="h-full w-full" preserveAspectRatio="none">
            <path d={areaPath} fill={fill} />
            <path d={linePath} fill="none" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <div className="flex h-full items-center justify-center text-xs muted">Waiting for data</div>
        )}
      </div>
    </div>
  );
}

type MetricsCardProps = {
  metrics: ServerMetrics | null;
  history: { cpu: number[]; memory: number[] };
};

export function MetricsCard({ metrics, history }: MetricsCardProps) {
  const uptimeLabel = formatUptime(metrics?.uptimeSeconds ?? null);

  return (
    <Card className="bg-white/5 border border-white/10">
      <CardHeader className="flex items-center gap-2 text-lg font-semibold">
        <Cpu size={18} />
        <span>Metrics</span>
      </CardHeader>
      <CardBody className="space-y-4">
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
            <span className="normal-case">Last {HISTORY_LIMIT}s</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <SparklineCard label="CPU usage" values={history.cpu} stroke="#22d3ee" fill="rgba(34, 211, 238, 0.18)" />
            <SparklineCard
              label="Memory usage"
              values={history.memory}
              stroke="#3b82f6"
              fill="rgba(59, 130, 246, 0.18)"
            />
          </div>
        </div>

        <Divider className="bg-white/10" />

        <div className="grid gap-3 md:grid-cols-3 text-sm">
          <div className="flex items-start gap-2">
            <Network size={16} />
            <div>
              <div className="font-semibold">Network</div>
              <div className="muted">In: {formatBytes(metrics?.networkRxBytes)}</div>
              <div className="muted">Out: {formatBytes(metrics?.networkTxBytes)}</div>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <HardDrive size={16} />
            <div>
              <div className="font-semibold">Disk</div>
              <div className="muted">Read: {formatBytes(metrics?.blkReadBytes)}</div>
              <div className="muted">Write: {formatBytes(metrics?.blkWriteBytes)}</div>
            </div>
          </div>
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
