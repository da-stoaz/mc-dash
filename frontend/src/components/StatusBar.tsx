'use client';

import type { ComponentType, ReactNode } from 'react';
import { Button, Card, CardBody, Chip, Tooltip } from '@heroui/react';
import { CircleAlert, CircleCheck, CircleOff, Loader, Power, RefreshCw, RotateCw } from 'lucide-react';
import { ServerStatus, statusColor, statusLabel } from '../lib/serverTypes';

type ChipColor = 'primary' | 'secondary' | 'success' | 'warning' | 'danger' | 'default';
type IconType = ComponentType<{ size?: number | string; className?: string }>;

type Props = {
  counts: Record<ServerStatus, number>;
  restartRequiredCount: number;
  loading: boolean;
  /** SSE stream is connected — the table updates without the refresh button. */
  live: boolean;
  lastUpdated: Date | null;
  onRefresh: () => void;
};

// Every state except "running", which gets its own tile. Ordered by how loudly
// it wants the operator's attention: the old bar printed all nine states in
// declaration order, so "Error: 2" sat between two zeroes with nothing to mark
// it as the only line that mattered.
const ATTENTION_ORDER: ServerStatus[] = [
  'error',
  'exited',
  'creating',
  'starting',
  'restarting',
  'stopping',
  'stopped',
];

const statusIcon: Record<ServerStatus, IconType> = {
  error: CircleAlert,
  exited: CircleOff,
  creating: Loader,
  starting: Loader,
  restarting: Loader,
  stopping: Loader,
  stopped: Power,
  running: CircleCheck,
};

// States that are mid-transition, so the icon spins rather than sitting still.
const TRANSIENT: ServerStatus[] = ['creating', 'starting', 'restarting', 'stopping'];

type AttentionItem = {
  key: string;
  label: string;
  count: number;
  color: ChipColor;
  Icon: IconType;
  spin: boolean;
};

// The count is the figure, so it stays in plain ink at a readable size; the
// coloured icon beside it carries the state. Status colour never lands on the
// number itself.
function StatTile({ label, value, icon }: { label: string; value: number; icon?: ReactNode }) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-2xl font-semibold leading-none">{value}</span>
      </div>
      <span className="muted text-xs mt-1">{label}</span>
    </div>
  );
}

export function StatusBar({ counts, restartRequiredCount, loading, live, lastUpdated, onRefresh }: Props) {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  // Only non-zero states get a chip. A row of "Starting: 0 · Stopping: 0" is
  // noise that hides the one state that is actually set.
  const attention: AttentionItem[] = ATTENTION_ORDER.filter((status) => counts[status] > 0).map((status) => ({
    key: status,
    label: statusLabel[status],
    count: counts[status],
    color: statusColor[status],
    Icon: statusIcon[status],
    spin: TRANSIENT.includes(status),
  }));

  // Not a status, but it is the other thing worth acting on, so it rides at the
  // front of the same list.
  if (restartRequiredCount > 0) {
    attention.unshift({
      key: 'restart-required',
      label: 'Restart required',
      count: restartRequiredCount,
      color: 'warning',
      Icon: RotateCw,
      spin: false,
    });
  }

  return (
    <Card shadow="sm" className="mb-4 bg-white/5 border border-white/10">
      <CardBody className="flex flex-row flex-wrap items-center gap-x-5 gap-y-3 py-3">
        <div className="flex items-center gap-5">
          <StatTile label="Servers" value={total} />
          <StatTile
            label="Running"
            value={counts.running}
            icon={<CircleCheck size={16} className={counts.running > 0 ? 'text-emerald-400' : 'text-white/25'} />}
          />
        </div>

        <div className="hidden sm:block h-9 w-px bg-white/10" />

        <div className="flex flex-wrap items-center gap-2 min-w-0">
          {attention.length === 0 ? (
            <span className="muted text-sm">Nothing needs attention</span>
          ) : (
            attention.map(({ key, label, count, color, Icon, spin }) => (
              <Chip
                key={key}
                color={color}
                variant="flat"
                size="sm"
                startContent={<Icon size={13} className={spin ? 'animate-spin' : undefined} />}
              >
                {label}: {count}
              </Chip>
            ))
          )}
        </div>

        <div className="ml-auto flex items-center gap-3">
          <Tooltip
            content={live ? 'Live updates connected' : 'Stream dropped — reconnecting'}
            size="sm"
            delay={200}
            closeDelay={0}
          >
            <span className="flex items-center gap-1.5 text-xs muted">
              <span
                className={`h-2 w-2 rounded-full ${live ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`}
                aria-hidden
              />
              {live ? 'Live' : 'Reconnecting'}
            </span>
          </Tooltip>
          {lastUpdated && (
            <span className="muted text-xs hidden md:inline">Updated {lastUpdated.toLocaleTimeString()}</span>
          )}
          <Tooltip content="Refresh now" size="sm" delay={200} closeDelay={0}>
            <Button isIconOnly size="sm" variant="flat" onPress={onRefresh} isDisabled={loading} aria-label="Refresh">
              <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
            </Button>
          </Tooltip>
        </div>
      </CardBody>
    </Card>
  );
}
