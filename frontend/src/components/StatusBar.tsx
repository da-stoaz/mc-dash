'use client';

import type { ComponentType, ReactNode } from 'react';
import { Button, Card, CardBody, Chip, Input, Tooltip } from '@heroui/react';
import { CircleAlert, CircleCheck, CircleOff, Loader, Power, RefreshCw, RotateCw, Search } from 'lucide-react';
import { ServerStatus, statusColor, statusLabel } from '../lib/serverTypes';

type ChipColor = 'primary' | 'secondary' | 'success' | 'warning' | 'danger' | 'default';
type IconType = ComponentType<{ size?: number | string; className?: string }>;

/** "Restart required" is a flag rather than a status, but it filters the same way. */
export type FilterKey = ServerStatus | 'restart-required';

type Props = {
  counts: Record<ServerStatus, number>;
  restartRequiredCount: number;
  loading: boolean;
  /** SSE stream is connected — the table updates without the refresh button. */
  live: boolean;
  lastUpdated: Date | null;
  onRefresh: () => void;
  selected: FilterKey[];
  onToggleFilter: (key: FilterKey) => void;
  onClearFilters: () => void;
  search: string;
  onSearchChange: (value: string) => void;
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

type FilterChip = {
  key: FilterKey;
  label: string;
  count: number;
  color: ChipColor;
  Icon: IconType;
  spin: boolean;
};

// The count is the figure, so it stays in plain ink at a readable size; the
// coloured icon beside it carries the state. Status colour never lands on the
// number itself.
function StatTile({
  label,
  value,
  icon,
  active,
  onPress,
}: {
  label: string;
  value: number;
  icon?: ReactNode;
  active?: boolean;
  onPress?: () => void;
}) {
  const body = (
    <>
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-2xl font-semibold leading-none">{value}</span>
      </div>
      <span className="muted text-xs mt-1">{label}</span>
    </>
  );

  if (!onPress) {
    return <div className="flex flex-col px-1">{body}</div>;
  }

  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onPress}
      className={`flex flex-col items-start rounded-lg px-2 py-1 -mx-1 transition-colors hover:bg-white/10 ${
        active ? 'bg-white/10 ring-1 ring-white/25' : ''
      }`}
    >
      {body}
    </button>
  );
}

export function StatusBar({
  counts,
  restartRequiredCount,
  loading,
  live,
  lastUpdated,
  onRefresh,
  selected,
  onToggleFilter,
  onClearFilters,
  search,
  onSearchChange,
}: Props) {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  // Only non-zero states get a chip. A row of "Starting: 0 · Stopping: 0" is
  // noise that hides the one state that is actually set — and as filters, a
  // chip that can only ever match nothing is worse than absent.
  const chips: FilterChip[] = ATTENTION_ORDER.filter((status) => counts[status] > 0).map((status) => ({
    key: status,
    label: statusLabel[status],
    count: counts[status],
    color: statusColor[status],
    Icon: statusIcon[status],
    spin: TRANSIENT.includes(status),
  }));

  if (restartRequiredCount > 0) {
    chips.unshift({
      key: 'restart-required',
      label: 'Restart required',
      count: restartRequiredCount,
      color: 'warning',
      Icon: RotateCw,
      spin: false,
    });
  }

  const filtering = selected.length > 0;

  return (
    <Card shadow="sm" className="mb-4 bg-white/5 border border-white/10">
      <CardBody className="flex flex-row flex-wrap items-center gap-x-5 gap-y-3 py-3">
        <div className="flex items-center gap-4">
          <StatTile label="Servers" value={total} />
          <StatTile
            label="Running"
            value={counts.running}
            icon={<CircleCheck size={16} className={counts.running > 0 ? 'text-emerald-400' : 'text-white/25'} />}
            active={selected.includes('running')}
            onPress={counts.running > 0 ? () => onToggleFilter('running') : undefined}
          />
        </div>

        <div className="hidden sm:block h-9 w-px bg-white/10" />

        <div className="flex flex-wrap items-center gap-2 min-w-0">
          {chips.length === 0 ? (
            <span className="muted text-sm">Nothing needs attention</span>
          ) : (
            chips.map(({ key, label, count, color, Icon, spin }) => {
              const active = selected.includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onToggleFilter(key)}
                  className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                >
                  <Chip
                    color={color}
                    variant={active ? 'solid' : 'flat'}
                    size="sm"
                    className="cursor-pointer"
                    startContent={<Icon size={13} className={spin ? 'animate-spin' : undefined} />}
                  >
                    {label}: {count}
                  </Chip>
                </button>
              );
            })
          )}
          {filtering && (
            <Button size="sm" variant="light" className="h-6 px-2 min-w-0 text-xs" onPress={onClearFilters}>
              Clear
            </Button>
          )}
        </div>

        <div className="ml-auto flex items-center gap-3">
          <Input
            size="sm"
            variant="bordered"
            placeholder="Search name, hostname, id"
            value={search}
            onValueChange={onSearchChange}
            isClearable
            onClear={() => onSearchChange('')}
            startContent={<Search size={14} className="shrink-0 text-white/40" />}
            classNames={{ inputWrapper: 'h-8 min-h-8', base: 'w-56' }}
            aria-label="Search servers"
          />
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
