'use client';
import { useEffect, useState } from 'react';
import { HardDrive, RefreshCw } from 'lucide-react';
import { API_BASE, apiFetch } from '../../lib/api';
import { formatBytes } from './metricsUtils';

type Usage = { filesBytes: number; snapshotsBytes: number; totalBytes: number; checkedAt: number };
export function StorageUsage({ serverId }: { serverId: string }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError(false);
    apiFetch(`${API_BASE}/servers/${encodeURIComponent(serverId)}/storage`, { signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error('Storage unavailable'); return response.json(); })
      .then((data: Usage) => {
        if (![data.filesBytes, data.snapshotsBytes, data.totalBytes, data.checkedAt].every(value => Number.isFinite(value) && value >= 0)) throw new Error('Invalid storage reading');
        if (!controller.signal.aborted) setUsage(data);
      })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [serverId, revision]);
  const filesPercent = usage && usage.totalBytes > 0 ? Math.min(100, Math.max(0, usage.filesBytes / usage.totalBytes * 100)) : 0;
  return <section aria-label="Storage usage" aria-busy={busy} className="rounded-lg border border-white/10 bg-white/5 p-5">
    <div className="flex items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-base font-semibold"><HardDrive size={16} />Storage</h2>
      <button type="button" aria-label="Refresh storage" title="Refresh storage" disabled={busy} onClick={() => setRevision(n => n + 1)}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-cyan-400 disabled:opacity-50">
        <RefreshCw size={15} className={busy ? 'animate-spin' : ''} aria-hidden />
      </button>
    </div>
    <div className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="text-3xl font-semibold tabular-nums">{usage ? formatBytes(usage.totalBytes) : '—'}</span>
      <span className="text-xs muted">used on disk</span>
    </div>
    <div aria-hidden className="mt-5 flex h-2 overflow-hidden rounded-full bg-white/10">
      {usage && usage.totalBytes > 0 && <><div className="bg-cyan-400" style={{ width: `${filesPercent}%` }} /><div className="flex-1 bg-violet-400" /></>}
    </div>
    <dl className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2 text-sm tabular-nums">
      {[{ label: 'Server files', bytes: usage?.filesBytes, color: 'bg-cyan-400' }, { label: 'Snapshots', bytes: usage?.snapshotsBytes, color: 'bg-violet-400' }].map(({ label, bytes, color }) => (
        <div key={label} className="flex items-center justify-between gap-3">
          <dt className="flex items-center gap-2 text-xs muted"><span aria-hidden className={`h-2 w-2 rounded-full ${color}`} />{label}</dt>
          <dd className="font-medium">{bytes != null ? formatBytes(bytes) : '—'}</dd>
        </div>
      ))}
    </dl>
    {error ? <p role="status" className="mt-4 text-xs text-amber-300">Could not measure storage. Use refresh to try again.</p>
      : <p className="mt-4 text-xs muted">{busy ? 'Measuring storage…' : usage ? <>Updated <time dateTime={new Date(usage.checkedAt).toISOString()}>{new Date(usage.checkedAt).toLocaleTimeString()}</time></> : 'Not measured yet'}</p>}
  </section>;
}
