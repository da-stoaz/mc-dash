'use client';

import { Card, CardBody, Chip, Tooltip } from '@heroui/react';
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

// Three bands, because each answers a different question.
//
//   solid  — what running servers are using *right now*. The only measured
//            figure here, and the one that was missing entirely: without it
//            there is no way to tell whether any of the memory management is
//            doing anything.
//   mid    — the guaranteed tier: memory reserved so every running server can
//            always idle, never overcommitted.
//   faint  — expected peak: what they could grow into. Allowed to exceed the
//            host, with the oversubscription chip saying by how much.
//
// Showing only peak made three servers idling at 3 GB look like a full 12 GB
// box. Showing only the guarantee would hide the real risk. Showing only actual
// usage would hide both. All three, then, in one bar.
//
// Live usage is summed from the server list rather than taken from the capacity
// endpoint. The ledger only moves when a server starts or stops, so it is
// fetched on those events — but usage moves constantly, and reading it from
// that same once-in-a-while fetch left the headline number frozen at whatever
// it was when something last changed state. The SSE list already carries a
// fresh per-server reading every couple of seconds, so the bar and the table
// now agree by construction instead of drifting apart between two sources.

// The same shell at the same height, with no data in it.
//
// Rendering nothing until the first fetch landed meant ~60px of card appeared
// out of nowhere and shoved the status bar and the whole table down the page.
function CapacitySkeleton() {
  return (
    <Card shadow="sm" className="mb-4 bg-white/5 border border-white/10">
      <CardBody className="flex flex-col gap-2 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-h-6">
          <MemoryStick size={16} className="shrink-0 text-white/25" aria-hidden />
          <span className="text-sm muted">Reading host capacity…</span>
        </div>
        <div className="h-2.5 w-full rounded-full bg-white/10" />
      </CardBody>
    </Card>
  );
}

export function CapacityBar({ capacity, servers }: Props) {
  if (!capacity) return <CapacitySkeleton />;

  const { guaranteedMb, expectedPeakMb, ceilingMb, budgetMb, memory, remainingGuaranteedMb, remainingBurstMb } =
    capacity;

  const running = servers.filter((server) => server.live);
  const actualMb = running.reduce((sum, server) => sum + (server.live?.memoryMb ?? 0), 0);
  const actualCpuCores = running.reduce((sum, server) => sum + (server.live?.cpuCores ?? 0), 0);

  const pctOfBudget = (valueMb: number) => (budgetMb > 0 ? Math.min(100, (valueMb / budgetMb) * 100) : 0);
  const guaranteedPct = pctOfBudget(guaranteedMb);
  const peakPct = pctOfBudget(expectedPeakMb);
  const actualPct = pctOfBudget(actualMb);

  const booked = capacity.servers.filter((server) => server.live);
  // How much room is left, judged by whichever tier binds first.
  const headroomMb = Math.min(remainingGuaranteedMb, remainingBurstMb);
  const full = headroomMb <= 0;
  const tight = !full && headroomMb < budgetMb * 0.15;
  const barColor = full ? 'bg-danger' : tight ? 'bg-warning' : 'bg-emerald-500';

  // Worst case if every running server hit its configured ceiling at once.
  const oversubscribed = ceilingMb > budgetMb;
  const measured = booked.filter((server) => server.observedPeakTrusted).length;

  return (
    <Card shadow="sm" className="mb-4 bg-white/5 border border-white/10">
      <CardBody className="flex flex-col gap-2 py-3">
        {/* min-h keeps the row's height steady as chips appear and disappear. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-h-6">
          <MemoryStick size={16} className="shrink-0 text-white/50" aria-hidden />
          <span className="text-sm font-medium">Memory in use</span>
          {/* tabular-nums throughout: these redraw every couple of seconds, and
              proportional digits make the whole row shuffle sideways each time. */}
          <span className="text-sm tabular-nums">
            <span className="font-semibold">{gb(actualMb)}</span>
            <span className="muted"> / {gb(budgetMb)}</span>
          </span>
          <Tooltip
            size="sm"
            delay={200}
            closeDelay={0}
            content={`Cores actually busy across all running servers, out of ${capacity.hostCpuCores} on the host.`}
          >
            <span className="text-sm tabular-nums cursor-help">
              <span className="font-semibold">{actualCpuCores.toFixed(2)}</span>
              <span className="muted"> / {capacity.hostCpuCores} cores</span>
            </span>
          </Tooltip>
          <span className="muted text-xs tabular-nums">
            {running.length} running · {gb(guaranteedMb)} reserved · {gb(memory.totalMb)} host
          </span>

          {oversubscribed && (
            <Tooltip
              size="sm"
              delay={200}
              closeDelay={0}
              content={`If every running server hit its configured max at once they'd want ${gb(
                ceilingMb
              )} on a ${gb(budgetMb)} host. That's allowed up to ${capacity.burstRatio}x on the assumption they
                don't all peak together — with container swap off, losing that bet costs one killed server rather
                than a frozen host.`}
            >
              <Chip
                size="sm"
                variant="flat"
                color={ceilingMb > capacity.burstAllowanceMb ? 'warning' : 'default'}
                className="cursor-help tabular-nums"
              >
                {(ceilingMb / budgetMb).toFixed(1)}x oversubscribed
              </Chip>
            </Tooltip>
          )}
          {capacity.swapMode === 'off' && (
            <Tooltip
              size="sm"
              delay={200}
              closeDelay={0}
              content="Server containers cannot use swap. One that exceeds its own limit is stopped by the kernel instead of dragging the whole host into swap."
            >
              <Chip size="sm" variant="flat" className="cursor-help">
                Swap off
              </Chip>
            </Tooltip>
          )}
          {!capacity.admissionEnabled && (
            <Chip size="sm" variant="flat" color="warning" startContent={<TriangleAlert size={13} />}>
              Start limit off
            </Chip>
          )}

          <span className="ml-auto text-xs tabular-nums">
            {full ? (
              <span className="text-danger">No room left — stop a server before starting another</span>
            ) : (
              <span className="muted">{gb(headroomMb)} free for new starts</span>
            )}
          </span>
        </div>

        <Tooltip
          size="sm"
          delay={200}
          closeDelay={0}
          content={`Solid: ${gb(actualMb)} actually in use right now. Mid: ${gb(
            guaranteedMb
          )} reserved so running servers can always idle. Faint: ${gb(expectedPeakMb)} of expected peak${
            measured > 0 ? `, measured for ${measured} of ${booked.length} servers` : ''
          }.`}
        >
          <div
            className="relative h-2.5 w-full overflow-hidden rounded-full bg-white/10 cursor-help"
            role="meter"
            aria-valuenow={Math.round(actualMb)}
            aria-valuemin={0}
            aria-valuemax={Math.round(budgetMb)}
            aria-label="Host memory in use by running servers"
          >
            {/* Expected peak first, faint: what they could grow into. */}
            <div
              className={`absolute inset-y-0 left-0 ${barColor} opacity-30 transition-[width] duration-500`}
              style={{ width: `${peakPct}%` }}
            />
            {/* The guarantee: memory held even while idle. */}
            <div
              className={`absolute inset-y-0 left-0 ${barColor} opacity-60 transition-[width] duration-500`}
              style={{ width: `${guaranteedPct}%` }}
            />
            {/* Actual usage on top, solid — the only figure that is measured
                rather than forecast, so it gets the most legible treatment. */}
            <div
              className={`absolute inset-y-0 left-0 ${barColor} transition-[width] duration-500`}
              style={{ width: `${actualPct}%` }}
            />
          </div>
        </Tooltip>
      </CardBody>
    </Card>
  );
}
