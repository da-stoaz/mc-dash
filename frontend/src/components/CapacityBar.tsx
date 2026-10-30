'use client';

import { useState } from 'react';
import { Card, CardBody, Tooltip } from '@heroui/react';
import { MemoryStick, TriangleAlert } from 'lucide-react';
import type { HostCapacity } from '../lib/hostCapacity';

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

export function CapacityBar({ capacity }: { capacity: HostCapacity | null }) {
  const [monitoringDetailsOpen, setMonitoringDetailsOpen] = useState(false);
  const pool = capacity?.pool;
  const monitoring = capacity != null && pool?.enabled === false;
  const running = capacity?.servers?.filter(server => server.live) ?? [];
  const usageKnown = monitoring && capacity?.servers != null && running.every(server => server.actualMb != null);
  const measuredMb = running.reduce((sum, server) => sum + (server.actualMb ?? 0), 0);
  const usedMb = pool?.workingSetMb ?? pool?.usedMb;
  const known = pool?.enforced && usedMb != null;
  const percent = known && pool.limitMb > 0 ? Math.min(100, Math.max(0, usedMb / pool.limitMb * 100)) : 0;
  const warning = capacity && !monitoring && (!pool?.enforced || pool.pressure);
  const message = !capacity ? 'Waiting for a current RAM reading…'
    : monitoring ? 'Monitoring only. The shared RAM limit is not enforced on this host.'
    : !pool ? 'Shared RAM protection has not been verified.'
    : !pool.enforced ? pool.reason || 'Shared RAM protection has not been verified.'
    : pool.lastAction ? pool.lastAction
    : pool.pressure ? pool.automaticSleepEnabled
      ? 'RAM is high. New starts are limited. Servers may save and sleep; players are warned first.'
      : 'RAM is high. New starts are limited. Automatic sleep is disabled.'
    : 'Shared by Minecraft servers. MC Dash runs outside this limit.';

  return (
    <Card shadow="sm" className="mb-4 border border-white/10 bg-white/5">
      <CardBody className="gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="flex items-center gap-2 font-medium"><MemoryStick size={16} className="muted" aria-hidden />Minecraft RAM</h2>
            {monitoring && <Tooltip content={message} size="sm" className="max-w-64"
              isOpen={monitoringDetailsOpen} onOpenChange={setMonitoringDetailsOpen} delay={150} closeDelay={0}>
              <button type="button"
                className="inline-flex h-6 items-center gap-1 rounded-full bg-warning/15 px-2 text-xs text-warning focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-warning"
                onMouseEnter={() => setMonitoringDetailsOpen(true)} onMouseLeave={() => setMonitoringDetailsOpen(false)}
                onFocus={() => setMonitoringDetailsOpen(true)} onBlur={() => setMonitoringDetailsOpen(false)}
                onClick={() => setMonitoringDetailsOpen(true)}>
                <TriangleAlert size={12} aria-hidden />
                Monitoring only
              </button>
            </Tooltip>}
          </div>
          <span className="tabular-nums">
            {known ? <><strong className="font-semibold">{gb(usedMb)}</strong><span className="muted"> / {gb(pool.limitMb)} limit</span></>
              : monitoring ? <span>{usageKnown ? `${gb(measuredMb)} used` : 'Waiting for usage readings…'}</span>
              : pool?.enabled ? <span className="muted">{pool.limitMb > 0 ? `${gb(pool.limitMb)} detected · unverified` : 'Limit unverified'}</span> : <span className="muted">—</span>}
          </span>
        </div>
        {!monitoring && <div className="h-2 overflow-hidden rounded-full bg-white/10"
          role={known ? 'meter' : undefined} aria-label="Minecraft shared RAM usage"
          aria-valuenow={known ? Math.round(percent) : undefined} aria-valuemin={0} aria-valuemax={100}
          aria-valuetext={known ? `${gb(usedMb)} used out of ${gb(pool.limitMb)}` : undefined}>
          {known && <div className={`h-full rounded-full ${pool.pressure ? 'bg-warning' : 'bg-emerald-500'} transition-[width] duration-500`} style={{ width: `${percent}%` }} />}
        </div>}
        {!monitoring && <p className={`flex items-start gap-2 text-xs ${warning ? 'text-amber-300' : 'muted'}`}>
          {warning && <TriangleAlert size={14} className="shrink-0" aria-hidden />}{message}
        </p>}
        {known && pool.reclaimableMb != null && pool.reclaimableMb > 0 && <p className="text-xs muted">
          {gb(pool.reclaimableMb)} of reclaimable file cache excluded. Linux can reuse this memory, including after servers stop.
        </p>}
      </CardBody>
    </Card>
  );
}
