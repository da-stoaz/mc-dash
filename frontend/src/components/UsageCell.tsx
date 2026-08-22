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
//
// The cell holds a fixed size whether or not there is a reading yet. Live data
// arrives a beat after the server list does, so a cell that grew from one line
// to two when it landed made every row in the table taller at once, and one
// that sized itself to its text made the whole grid reflow sideways every time
// a digit changed.

const RAM_PLACEHOLDER = '—';

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

  const tooltip = live ? `${Math.round(live.memoryPercent)}% of its limit · ${configured}` : configured;

  const primary = live ? (
    <span className={pressureClass(live.memoryPercent)}>
      {ramLabel(live.memoryMb)}
      <span className="muted"> / {ramLabel(live.memoryLimitMb)}</span>
    </span>
  ) : (
    <span className="muted">{server.hibernated ? 'Sleeping' : RAM_PLACEHOLDER}</span>
  );

  // Cores, not percent-of-cap: "0.4 cores" is a figure you can add up across
  // servers and compare against the host, which a percentage is not. Kept in
  // the layout even when empty so the row never changes height.
  const secondary = live ? (
    <span className="muted">{live.cpuCores.toFixed(2)} cores</span>
  ) : (
    <span aria-hidden className="invisible">
      0.00 cores
    </span>
  );

  return (
    <Tooltip content={tooltip} size="sm" delay={200} closeDelay={0}>
      <div
        className={`flex text-sm tabular-nums cursor-help ${
          compact ? 'flex-row items-baseline gap-2 justify-end' : 'flex-col justify-center h-9 min-w-34'
        }`}
      >
        {primary}
        <span className="text-xs leading-4">{secondary}</span>
      </div>
    </Tooltip>
  );
}
