'use client';

import { Card, CardBody } from '@heroui/react';
import { MemoryStick, TriangleAlert } from 'lucide-react';
import { HostCapacity } from '../lib/hostCapacity';
import { ServerRecord } from '../lib/serverTypes';

type Props = {
  capacity: HostCapacity | null;
  servers: ServerRecord[];
};

function gb(valueMb: number) {
  if (Math.abs(valueMb) >= 1024) return `${(valueMb / 1024).toFixed(1)} GB`;
  return `${Math.round(valueMb)} MB`;
}

export function CapacityBar({ capacity, servers }: Props) {
  // Use the same live readings as the server table; the capacity ledger only
  // refreshes when allocations change.
  const active = servers.filter(server => ['running', 'starting', 'restarting', 'stopping'].includes(server.status));
  const readings = servers.filter(server => server.live);
  const usageKnown = active.every(server => server.live != null);
  const actualMb = readings.reduce((sum, server) => sum + (server.live?.memoryMb ?? 0), 0);
  const actualCpuCores = readings.reduce((sum, server) => sum + (server.live?.cpuCores ?? 0), 0);
  const budgetMb = capacity?.budgetMb ?? 0;
  const actualPct = budgetMb > 0 ? Math.max(0, Math.min(100, actualMb / budgetMb * 100)) : 0;
  const headroomMb = capacity ? Math.min(capacity.remainingGuaranteedMb, capacity.remainingBurstMb) : 0;
  const limited = capacity?.admissionEnabled && headroomMb < budgetMb * 0.15;
  const barColor = actualPct >= 90 ? 'bg-warning' : 'bg-emerald-500';

  return (
    <Card shadow="sm" className="mb-4 border border-white/10 bg-white/5">
      <CardBody className="gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <h2 className="flex items-center gap-2 font-medium"><MemoryStick size={16} className="muted" aria-hidden />Server memory</h2>
          <span className="tabular-nums">
            {!capacity ? <span className="muted">Loading…</span> : usageKnown ? (
              <><strong className="font-semibold">{gb(actualMb)}</strong><span className="muted"> / {gb(budgetMb)} budget</span></>
            ) : <span className="muted">Waiting for usage readings</span>}
          </span>
        </div>
        <div
          className="h-2 overflow-hidden rounded-full bg-white/10"
          role={capacity && usageKnown && budgetMb > 0 ? 'meter' : undefined}
          aria-label="Server memory usage"
          aria-valuenow={capacity && usageKnown ? Math.round(actualPct) : undefined}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={capacity && usageKnown ? `${gb(actualMb)} used out of a ${gb(budgetMb)} server budget` : undefined}
        >
          {capacity && usageKnown && <div className={`h-full rounded-full ${barColor} transition-[width] duration-500`} style={{ width: `${actualPct}%` }} />}
        </div>

        {limited && <p className="flex items-start gap-2 text-xs text-amber-300"><TriangleAlert size={14} className="shrink-0" aria-hidden />
          {headroomMb <= 0 ? 'No capacity for another start. Stop a server or reduce its memory allocation.' : `Limited capacity for new starts: ${gb(headroomMb)} remaining.`}
        </p>}
        {capacity && !capacity.admissionEnabled && <p className="flex items-center gap-2 text-xs text-amber-300"><TriangleAlert size={14} aria-hidden />Memory checks for new starts are disabled.</p>}

        {capacity && <details className="text-xs">
          <summary className="w-fit cursor-pointer text-gray-400 hover:text-white focus-visible:outline-2 focus-visible:outline-cyan-400">Capacity details</summary>
          <div className="mt-3 border-t border-white/10 pt-3">
            <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
              {[
                ['Available for new starts', gb(Math.max(0, headroomMb))],
                ['Reserved memory', gb(capacity.guaranteedMb)],
                ['Expected peak usage', gb(capacity.expectedPeakMb)],
                ['Configured maximum total', gb(capacity.ceilingMb)],
                ['Physical host memory', gb(capacity.memory.totalMb)],
                ['Reserved for the host', gb(capacity.reserveMb)],
                ['CPU in use', usageKnown ? `${actualCpuCores.toFixed(2)} / ${capacity.hostCpuCores} cores` : 'Waiting for readings'],
                ['Container swap', capacity.swapMode === 'off' ? 'Off' : capacity.swapMode === 'limit' ? 'Limited' : 'Host settings'],
              ].map(([label, value]) => <div key={label} className="flex items-baseline justify-between gap-3"><dt className="muted">{label}</dt><dd className="text-right tabular-nums">{value}</dd></div>)}
            </dl>
            <p className="mt-4 muted">The bar shows current server usage. Capacity for new starts is based on reservations and expected peaks, so it differs from unused memory.</p>
            {capacity.ceilingMb > budgetMb && <p className="mt-2 text-amber-300">Configured maximums exceed the server budget. There may not be enough memory if all servers reach their limits at once.</p>}
          </div>
        </details>}
      </CardBody>
    </Card>
  );
}
