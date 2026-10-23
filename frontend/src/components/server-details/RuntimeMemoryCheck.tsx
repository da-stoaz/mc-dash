'use client';

import { useState } from 'react';
import { API_BASE, apiFetch } from '../../lib/api';

type Inspection = {
  status: 'verified' | 'mismatch' | 'unverified';
  initialHeapMb: number | null;
  maximumHeapMb: number | null;
  containerLimitMb: number | null;
  checkedAt: number;
  reason: string;
};
const gb = (mb: number | null) => mb === null ? 'Unknown' : `${(mb / 1024).toFixed(2)} GB`;

export function RuntimeMemoryCheck({ serverId, running }: { serverId: string; running: boolean }) {
  const [result, setResult] = useState<Inspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function check() {
    setBusy(true); setError(null); setResult(null);
    try {
      const response = await apiFetch(`${API_BASE}/servers/${encodeURIComponent(serverId)}/memory-runtime`);
      if (!response.ok) throw new Error('Memory inspection failed. Try again.');
      setResult(await response.json());
    } catch {
      setError('Memory inspection could not complete. Check the connection and try again.');
    } finally { setBusy(false); }
  }
  return (
    <details className="rounded-lg border border-white/10 px-4 py-3 text-sm">
      <summary className="cursor-pointer">Check running memory settings</summary>
      <p className="mt-3 text-xs muted">Compare the running Java heap with this server’s saved settings.</p>
      <button type="button" disabled={!running || busy} onClick={check}
        className="mt-3 rounded-md border border-white/20 px-3 py-2 disabled:opacity-50">
        {busy ? 'Checking…' : 'Check settings'}
      </button>
      {!running && <p className="mt-2 text-xs muted">Start the server to check its settings.</p>}
      <div aria-live="polite">
        {error && <p className="mt-3 text-amber-400">{error}</p>}
        {result && <div className="mt-3 space-y-2">
          <p className={result.status === 'verified' ? 'text-emerald-400' : 'text-amber-400'}>
            {result.status === 'verified' ? 'Heap settings match' : result.status === 'mismatch' ? 'Settings differ' : 'Could not verify'}
          </p>
          <p className="text-xs muted">{result.reason}</p>
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <dt>Initial Java heap</dt><dd>{gb(result.initialHeapMb)}</dd>
            <dt>Maximum Java heap</dt><dd>{gb(result.maximumHeapMb)}</dd>
            <dt>Container limit</dt><dd>{gb(result.containerLimitMb)}</dd>
          </dl>
          <p className="text-xs muted">Checked {new Date(result.checkedAt).toLocaleTimeString()}. Run again after changing or restarting the server.</p>
        </div>}
      </div>
    </details>
  );
}
