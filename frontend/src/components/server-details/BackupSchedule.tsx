'use client';

import { useEffect, useId, useState } from 'react';
import { Select, SelectItem, Spinner, Tooltip } from '@heroui/react';
import { Info } from 'lucide-react';
import { API_BASE, apiFetch } from '../../lib/api';
import { getApiErrorMessage } from '../../lib/apiErrors';
import { Snapshot } from '../../lib/serverTypes';

const OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: '1', label: 'Daily' },
  { value: '2', label: 'Every 2 days' },
  { value: '3', label: 'Every 3 days' },
  { value: '7', label: 'Weekly' },
];

type Schedule = { intervalDays: number | null; keep?: number };

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Per-server automatic backup interval. The backend runs the backups. */
export function BackupSchedule({ serverId, snapshots }: { serverId: string; snapshots: Snapshot[] }) {
  const id = useId();
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setSchedule(null);
    apiFetch(`${API_BASE}/servers/${serverId}/snapshots/schedule`, { signal: controller.signal, cache: 'no-store' })
      .then(async res => {
        if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Could not load the backup schedule'));
        const body = await res.json() as Partial<Schedule>;
        setSchedule({ intervalDays: body.intervalDays ?? null, keep: body.keep });
      })
      .catch(err => { if (!controller.signal.aborted) setError((err as Error).message); });
    return () => controller.abort();
  }, [serverId]);

  const change = async (value: string) => {
    const intervalDays = value === 'off' ? null : Number(value);
    if (intervalDays === schedule?.intervalDays) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}/servers/${serverId}/snapshots/schedule`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intervalDays }),
      });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Could not save the backup schedule'));
      const body = await res.json() as Partial<Schedule>;
      setSchedule({ intervalDays: body.intervalDays ?? null, keep: body.keep });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const interval = schedule?.intervalDays ?? null;
  const keep = schedule?.keep ?? 2;
  const last = snapshots.find(snapshot => snapshot.kind === 'scheduled');
  const lastMs = last ? Date.parse(last.createdAt) : null;
  const dueMs = interval && lastMs !== null ? lastMs + interval * 24 * 60 * 60_000 : null;

  const status = interval === null ? 'Off'
    : dueMs !== null && dueMs > now ? `Next after ${formatDate(dueMs)}`
      : 'Next: when the server is idle';

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span id={`${id}-label`} className="text-sm font-medium">Automatic backups</span>
            <Tooltip size="sm" placement="top-start" delay={150} closeDelay={0} isOpen={helpOpen} onOpenChange={setHelpOpen}
              classNames={{ content: 'max-w-72 px-3 py-2 text-xs' }}
              content={<ul className="list-disc space-y-1 pl-4">
                <li>Runs once the server has been stopped or asleep for 10 minutes.</li>
                <li>A server that stays online is backed up live 12 hours after it is due.</li>
                <li>If no files changed, the last archive is kept.</li>
                <li>Keeps the {keep} newest. Manual snapshots are never removed.</li>
              </ul>}>
              <button type="button" aria-label="How automatic backups work"
                className="inline-flex rounded-full text-default-400 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                onMouseEnter={() => setHelpOpen(true)} onMouseLeave={() => setHelpOpen(false)}
                onFocus={() => setHelpOpen(true)} onBlur={() => setHelpOpen(false)} onClick={() => setHelpOpen(open => !open)}>
                <Info size={14} aria-hidden />
              </button>
            </Tooltip>
          </div>
          <p id={`${id}-description`} className="text-xs muted">
            {lastMs !== null && interval !== null ? <>Last {formatDate(lastMs)} · </> : null}{status}
          </p>
        </div>
        {schedule === null && !error ? <Spinner size="sm" /> : (
          <Select aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} size="sm" variant="bordered"
            className="w-40" disableAnimation selectedKeys={[interval === null ? 'off' : String(interval)]}
            isDisabled={saving || schedule === null}
            onSelectionChange={keys => {
              const selected = Array.from(keys)[0];
              if (selected !== undefined) void change(String(selected));
            }}>
            {OPTIONS.map(option => <SelectItem key={option.value}>{option.label}</SelectItem>)}
          </Select>
        )}
      </div>
      {error && <p role="alert" className="mt-1 text-xs text-rose-300">{error}</p>}
    </div>
  );
}
