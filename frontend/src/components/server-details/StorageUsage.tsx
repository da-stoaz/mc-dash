'use client';
import { useEffect, useState } from 'react';
import { API_BASE, apiFetch } from '../../lib/api';
import { formatBytes } from './metricsUtils';

type Usage = { filesBytes: number; snapshotsBytes: number; totalBytes: number; checkedAt: number };
export function StorageUsage({ serverId, visible }: { serverId: string; visible: boolean }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    setBusy(true); setError(false);
    apiFetch(`${API_BASE}/servers/${encodeURIComponent(serverId)}/storage`, { signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error('Storage unavailable'); return response.json(); })
      .then(data => { if (!controller.signal.aborted) setUsage(data); })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [serverId, visible, revision]);
  return <section aria-label="Storage usage" className="mt-5 border-t border-white/10 pt-4">
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-sm font-medium">Storage used</h3>
      <button type="button" disabled={busy} onClick={() => setRevision(n => n + 1)} className="text-xs text-cyan-300 disabled:text-white/50">{busy ? 'Measuring…' : 'Refresh storage'}</button>
    </div>
    {error && <p role="status" className="mt-2 text-xs text-amber-300">Could not measure storage. Try again.</p>}
    <dl className="mt-3 grid gap-3 sm:grid-cols-3 text-sm tabular-nums">
      {[['Server files', usage?.filesBytes], ['Snapshots', usage?.snapshotsBytes], ['Total', usage?.totalBytes]].map(([label, bytes]) => <div key={label}><dt className="text-xs muted">{label}</dt><dd className="mt-1">{typeof bytes === 'number' ? formatBytes(bytes) : '—'}</dd></div>)}
    </dl>
    <p className="mt-2 text-xs muted">Disk space allocated to this server’s files, downloads and snapshots.{usage && ` Measured ${new Date(usage.checkedAt).toLocaleTimeString()}.`}</p>
  </section>;
}
