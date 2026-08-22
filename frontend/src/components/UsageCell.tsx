'use client';

import { Tooltip } from '@heroui/react';
import { ServerRecord } from '../lib/serverTypes';

// Live RAM and CPU for one server.
//
// The list used to show only configured limits — "1024–6144 MB, 2 CPU" — which
// says what a server is *allowed* to use and nothing about what it is doing.
// That made it impossible to tell whether the memory management was working at
// all, so the configured range moved to a tooltip and the live figure took the
// column.

function ramLabel(mb: number) {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

// Anything above ~85% of a container's own cap is close enough to an OOM kill
// to deserve colour; below that, plain ink keeps the column calm.
function pressureClass(percent: number) {
  if (percent >= 90) return 'text-danger';
  if (percent >= 75) return 'text-warning';
  return '';
}

export function UsageCell({ server, compact = false }: { server: ServerRecord; compact?: boolean }) {
  const live = server.live;
  const configured = `${server.resources.minRamMb}–${server.resources.maxRamMb} MB configured${
    server.resources.cpuLimit ? ` · ${server.resources.cpuLimit} CPU cap` : ''
  }`;

  if (!live) {
    return (
      <Tooltip content={configured} size="sm" delay={200} closeDelay={0}>
        <span className="muted text-sm cursor-help">
          {server.hibernated ? 'Sleeping' : '—'}
        </span>
      </Tooltip>
    );
  }

  const ram = (
    <span className={pressureClass(live.memoryPercent)}>
      {ramLabel(live.memoryMb)}
      <span className="muted"> / {ramLabel(live.memoryLimitMb)}</span>
    </span>
  );
  // Cores, not percent-of-cap: "0.4 cores" is a figure you can add up across
  // servers and compare against the host, which a percentage is not.
  const cpu = <span className="muted">{live.cpuCores.toFixed(2)} cores</span>;

  return (
    <Tooltip
      content={`${Math.round(live.memoryPercent)}% of its limit · ${configured}`}
      size="sm"
      delay={200}
      closeDelay={0}
    >
      <div className={`flex ${compact ? 'flex-row gap-2' : 'flex-col'} text-sm cursor-help`}>
        {ram}
        <span className="text-xs">{cpu}</span>
      </div>
    </Tooltip>
  );
}
