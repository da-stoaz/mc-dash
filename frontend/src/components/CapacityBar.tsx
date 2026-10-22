'use client';

import { Card, CardBody } from '@heroui/react';
import { MemoryStick, TriangleAlert } from 'lucide-react';
import type { HostCapacity } from '../lib/hostCapacity';

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

export function CapacityBar({ capacity }: { capacity: HostCapacity | null }) {
  const pool = capacity?.pool;
  const monitoring = capacity != null && pool?.enabled === false;
  const running = capacity?.servers?.filter(server => server.live) ?? [];
  const usageKnown = monitoring && capacity?.servers != null && running.every(server => server.actualMb != null);
  const measuredMb = running.reduce((sum, server) => sum + (server.actualMb ?? 0), 0);
  const known = pool?.enforced && pool.usedMb != null;
  const percent = known && pool.limitMb > 0 ? Math.min(100, Math.max(0, pool.usedMb! / pool.limitMb * 100)) : 0;
  const warning = capacity && !monitoring && (!pool?.enforced || pool.pressure);
  const message = !capacity ? 'Waiting for a current RAM reading…'
    : monitoring ? 'Monitoring only. The shared RAM limit is not enforced on this host.'
    : !pool ? 'Shared RAM protection has not been verified.'
    : !pool.enforced ? pool.reason || 'Shared RAM protection has not been verified.'
    : pool.lastAction ? pool.lastAction
    : pool.pressure ? 'RAM is high. New starts are limited. Servers may save and sleep; players are warned first.'
    : 'Shared by Minecraft servers. MC Dash runs outside this limit.';

  return (
    <Card shadow="sm" className="mb-4 border border-white/10 bg-white/5">
      <CardBody className="gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <h2 className="flex items-center gap-2 font-medium"><MemoryStick size={16} className="muted" aria-hidden />Minecraft RAM</h2>
          <span className="tabular-nums">
            {known ? <><strong className="font-semibold">{gb(pool.usedMb!)}</strong><span className="muted"> / {gb(pool.limitMb)} limit</span></>
              : monitoring ? <span>{usageKnown ? `${gb(measuredMb)} used` : 'Waiting for usage readings…'}</span>
              : pool?.enabled ? <span className="muted">{pool.limitMb > 0 ? `${gb(pool.limitMb)} detected · unverified` : 'Limit unverified'}</span> : <span className="muted">—</span>}
          </span>
        </div>
        {!monitoring && <div className="h-2 overflow-hidden rounded-full bg-white/10"
          role={known ? 'meter' : undefined} aria-label="Minecraft shared RAM usage"
          aria-valuenow={known ? Math.round(percent) : undefined} aria-valuemin={0} aria-valuemax={100}
          aria-valuetext={known ? `${gb(pool.usedMb!)} used out of ${gb(pool.limitMb)}` : undefined}>
          {known && <div className={`h-full rounded-full ${pool.pressure ? 'bg-warning' : 'bg-emerald-500'} transition-[width] duration-500`} style={{ width: `${percent}%` }} />}
        </div>}
        <p className={`flex items-start gap-2 text-xs ${warning ? 'text-amber-300' : 'muted'}`}>
          {warning && <TriangleAlert size={14} className="shrink-0" aria-hidden />}{message}
        </p>
      </CardBody>
    </Card>
  );
}
