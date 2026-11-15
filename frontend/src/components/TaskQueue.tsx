// SPDX-License-Identifier: AGPL-3.0-only

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Badge, Button, Popover, PopoverContent, Progress, Spinner, Tooltip } from '@heroui/react';
import { CalendarClock, CircleCheck, CircleSlash, CircleX, ListChecks, X } from 'lucide-react';
import { API_BASE, apiFetch } from '../lib/api';

type TaskKind = 'snapshot' | 'scheduled-backup' | 'restore';
type RunningTask = {
  id: string; kind: TaskKind; serverId: string; serverName: string | null; startedAt: string;
  phase: string | null; bytesProcessed: number; totalBytes: number | null; cancelRequested: boolean;
};
type FinishedTask = {
  id: string; kind: TaskKind; serverId: string; serverName: string | null; status: 'completed' | 'failed' | 'cancelled';
  startedAt: string; finishedAt: string; bytes: number | null; detail: string | null; error: string | null;
};
type PlannedTask = {
  serverId: string; serverName: string | null; kind: TaskKind; intervalDays: number;
  dueAt: string; waitingFor: 'idle' | 'stop' | null; liveAt: string;
};
type Tasks = { running: RunningTask[]; history: FinishedTask[]; planned: PlannedTask[] };

const KIND_LABEL: Record<TaskKind, string> = { snapshot: 'Snapshot', 'scheduled-backup': 'Automatic backup', restore: 'Restore' };
const PHASE_LABEL: Record<string, string> = {
  'checking-files': 'Checking files', flushing: 'Saving the world', archiving: 'Compressing',
  resuming: 'Re-enabling autosave', finalizing: 'Finishing', validating: 'Checking the archive',
  backup: 'Creating a safety backup', clearing: 'Removing current files', extracting: 'Extracting', permissions: 'Setting permissions',
};

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function ago(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function serverLink(task: { serverId: string; serverName: string | null }) {
  return task.serverName
    ? <Link href={`/servers/${task.serverId}?tab=snapshots`} className="truncate hover:underline">{task.serverName}</Link>
    : <span className="truncate muted">Deleted server</span>;
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return <section className="space-y-2">
    <div className="flex items-center justify-between">
      <h3 className="text-xs font-semibold uppercase tracking-wide muted">{title}</h3>
      {action}
    </div>
    <ul className="space-y-2">{children}</ul>
  </section>;
}

/** Header button with a popover listing running, finished and planned background tasks. */
export function TaskQueue() {
  const [tasks, setTasks] = useState<Tasks | null>(null);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_BASE}/tasks`, { cache: 'no-store' });
      if (!res.ok) return;
      const body = await res.json() as Partial<Tasks>;
      setTasks({ running: body.running ?? [], history: body.history ?? [], planned: body.planned ?? [] });
    } catch {
      // Keep the last list; the next poll retries.
    }
    setNow(Date.now());
  }, []);

  const active = open || (tasks?.running.length ?? 0) > 0;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const poll = async () => {
      if (!document.hidden) await load();
      if (!stopped) timer = setTimeout(poll, active ? 2000 : 15000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [load, active]);

  const dismiss = async (id?: string) => {
    setTasks(current => current && { ...current, history: id ? current.history.filter(task => task.id !== id) : [] });
    await apiFetch(`${API_BASE}/tasks/history${id ? `/${id}` : ''}`, { method: 'DELETE' }).catch(() => undefined);
    void load();
  };

  const running = tasks?.running ?? [];
  const history = tasks?.history ?? [];
  const planned = tasks?.planned ?? [];
  const failed = history.some(task => task.status === 'failed');

  return (
    <Popover placement="bottom-end" isOpen={open} onOpenChange={setOpen} triggerRef={triggerRef as React.RefObject<HTMLElement>}>
      {/* Not a PopoverTrigger, so the button can carry a hover tooltip as well. */}
      <Badge content={history.length} isInvisible={history.length === 0} color={failed ? 'danger' : 'primary'} size="sm" shape="circle">
        <Tooltip content="Tasks" size="sm" delay={200} closeDelay={0} isDisabled={open}>
          <Button ref={triggerRef} isIconOnly variant="light" aria-haspopup="dialog" aria-expanded={open}
            aria-label={`Tasks: ${running.length} running, ${history.length} finished`} onPress={() => setOpen(value => !value)}>
            {running.length ? <Spinner size="sm" color="current" /> : <ListChecks size={18} />}
          </Button>
        </Tooltip>
      </Badge>
      <PopoverContent className="w-[min(24rem,calc(100vw-2rem))] p-0">
        <div className="max-h-[70vh] w-full space-y-4 overflow-y-auto p-4">
          {!tasks && <div className="flex justify-center py-4"><Spinner size="sm" /></div>}
          {tasks && !running.length && !history.length && !planned.length && (
            <p className="py-2 text-center text-sm muted">No tasks. Turn on automatic backups in a server&apos;s Snapshots tab.</p>
          )}

          {running.length > 0 && <Section title="Running">
            {running.map(task => {
              const percent = task.totalBytes ? Math.min(100, task.bytesProcessed / task.totalBytes * 100) : undefined;
              return <li key={task.id} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="flex min-w-0 gap-1"><span className="shrink-0 font-medium">{KIND_LABEL[task.kind]}</span><span className="muted">·</span>{serverLink(task)}</span>
                  <span className="shrink-0 text-xs muted">{ago(task.startedAt, now).replace('just now', 'started now')}</span>
                </div>
                <Progress aria-label={`${KIND_LABEL[task.kind]} progress`} size="sm" isIndeterminate={percent === undefined}
                  value={percent} classNames={{ indicator: 'bg-cyan-400' }} />
                <div className="flex justify-between gap-2 text-xs muted">
                  <span>{task.cancelRequested ? 'Cancelling…' : PHASE_LABEL[task.phase ?? ''] ?? 'Starting'}</span>
                  {task.bytesProcessed > 0 && <span className="tabular-nums">
                    {formatBytes(task.bytesProcessed)}{task.totalBytes ? ` / ${formatBytes(task.totalBytes)}` : ''}
                  </span>}
                </div>
              </li>;
            })}
          </Section>}

          {history.length > 0 && <Section title="Finished"
            action={<Button size="sm" variant="light" className="h-6 min-w-0 px-2 text-xs" onPress={() => void dismiss()}>Clear all</Button>}>
            {history.map(task => {
              const Icon = task.status === 'completed' ? CircleCheck : task.status === 'failed' ? CircleX : CircleSlash;
              const color = task.status === 'completed' ? 'text-emerald-400' : task.status === 'failed' ? 'text-rose-400' : 'text-default-400';
              const summary = task.status === 'failed' ? task.error
                : task.status === 'cancelled' ? 'Cancelled'
                  : task.detail ?? (task.bytes ? `Archive ${formatBytes(task.bytes)}` : 'Done');
              return <li key={task.id} className="group flex gap-2">
                <Icon size={16} className={`mt-0.5 shrink-0 ${color}`} aria-label={task.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="flex min-w-0 gap-1"><span className="shrink-0 font-medium">{KIND_LABEL[task.kind]}</span><span className="muted">·</span>{serverLink(task)}</span>
                    <span className="shrink-0 text-xs muted">{ago(task.finishedAt, now)}</span>
                  </div>
                  <p className={`line-clamp-2 text-xs ${task.status === 'failed' ? 'text-rose-300' : 'muted'}`} title={summary ?? undefined}>{summary}</p>
                </div>
                <Button isIconOnly size="sm" variant="light" className="-mr-1 h-6 w-6 min-w-6 shrink-0 text-default-400"
                  aria-label="Dismiss" onPress={() => void dismiss(task.id)}><X size={14} /></Button>
              </li>;
            })}
          </Section>}

          {planned.length > 0 && <Section title="Planned">
            {planned.map(task => <li key={task.serverId} className="flex gap-2">
              <CalendarClock size={16} className="mt-0.5 shrink-0 text-default-400" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 gap-1 text-sm"><span className="shrink-0 font-medium">{KIND_LABEL[task.kind]}</span><span className="muted">·</span>{serverLink(task)}</div>
                <p className="text-xs muted">
                  {task.waitingFor === null ? `Due ${when(task.dueAt)}`
                    : task.waitingFor === 'idle' ? 'Starts after 10 min stopped'
                      : `Waiting for the server to stop · live backup ${when(task.liveAt)}`}
                </p>
              </div>
            </li>)}
          </Section>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
