'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, CardBody, CardHeader, Chip, Divider, Input, Spinner } from '@heroui/react';
import { Camera, Download, RotateCcw, Trash2 } from 'lucide-react';
import { API_BASE, apiFetch, apiOperation } from '../../lib/api';
import { getApiErrorMessage } from '../../lib/apiErrors';
import { Snapshot, ServerStatus } from '../../lib/serverTypes';

type SnapshotsCardProps = {
  serverId: string;
  status: ServerStatus;
  onRestored?: () => void;
};

type SnapshotJob = {
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
};

const RUNNING_STATES: ServerStatus[] = ['running', 'starting', 'restarting', 'stopping', 'creating'];

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function SnapshotsCard({ serverId, status, onRestored }: SnapshotsCardProps) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [job, setJob] = useState<SnapshotJob | null>(null);
  const [statusKnown, setStatusKnown] = useState(false);
  const revision = useRef(0);
  const viewController = useRef<AbortController | null>(null);
  const creating = job?.status === 'running';

  const serverRunning = RUNNING_STATES.includes(status);

  const load = useCallback(async (signal?: AbortSignal) => {
    const requestRevision = ++revision.current;
    const current = () => !signal?.aborted && revision.current === requestRevision;
    try {
      const jobRes = await apiFetch(`${API_BASE}/servers/${serverId}/snapshots/job`, { signal, cache: 'no-store' });
      if (!jobRes.ok) {
        if (current()) setStatusKnown(false);
        throw new Error(await getApiErrorMessage(jobRes, 'Could not check snapshot status'));
      }
      const nextJob = await jobRes.json() as SnapshotJob | null;
      if (!current()) return;
      // A slow or failed archive listing must not hide an accepted job.
      setJob(nextJob);
      setStatusKnown(true);
      const res = await apiFetch(`${API_BASE}/servers/${serverId}/snapshots`, { signal, cache: 'no-store' });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Failed to load snapshots'));
      const nextSnapshots = await res.json() as Snapshot[];
      if (!current()) return;
      setSnapshots(nextSnapshots);
      setError(null);
    } catch (err) {
      if (!current()) return;
      setError((err as Error).message);
    } finally {
      if (current()) setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    const controller = new AbortController();
    viewController.current = controller;
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true);
    setJob(null);
    setStatusKnown(false);
    setSnapshots([]);
    const poll = async () => {
      await load(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => { controller.abort(); ++revision.current; clearTimeout(timer); };
  }, [load]);

  const takeSnapshot = async () => {
    const signal = viewController.current?.signal;
    ++revision.current;
    setBusy('create');
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}/servers/${serverId}/snapshots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim() || undefined, background: true }),
      });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Snapshot failed'));
      const accepted = await res.json() as SnapshotJob;
      if (signal?.aborted) return;
      ++revision.current;
      setJob(accepted);
      setStatusKnown(true);
      setLabel('');
      await load(signal);
    } catch (err) {
      if (signal?.aborted) return;
      setError((err as Error).message);
    } finally {
      if (!signal?.aborted) setBusy(null);
    }
  };

  const restore = async (snapshot: Snapshot) => {
    if (
      !window.confirm(
        'Restore this snapshot? An automatic safety backup of the current state is taken first, then the current server data is replaced.'
      )
    ) {
      return;
    }
    setBusy(snapshot.id);
    setError(null);
    try {
      const res = await apiOperation(`${API_BASE}/servers/${serverId}/snapshots/${snapshot.id}/restore`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Restore failed'));
      await load();
      onRestored?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (snapshot: Snapshot) => {
    if (!window.confirm('Delete this snapshot permanently? This cannot be undone.')) return;
    setBusy(snapshot.id);
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}/servers/${serverId}/snapshots/${snapshot.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Delete failed'));
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const download = (snapshot: Snapshot) => {
    // Stream directly from the API so large archives go to disk, not memory.
    // Same-site session cookie is sent on this GET navigation.
    window.open(`${API_BASE}/servers/${serverId}/snapshots/${snapshot.id}/download`, '_blank');
  };

  return (
    <Card className="bg-white/5 border border-white/10">
      <CardHeader className="flex flex-col items-start gap-1">
        <div className="text-lg font-semibold">Snapshots</div>
        <div className="text-xs muted">
          A snapshot archives the whole server folder so you can download it or roll back to it later.
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            size="sm"
            label="Label (optional)"
            placeholder="e.g. before mod update"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="sm:max-w-xs"
          />
          <Button
            size="sm"
            color="primary"
            startContent={<Camera size={14} />}
            onPress={takeSnapshot}
            isLoading={busy === 'create' || creating}
            isDisabled={busy !== null || creating || loading || !statusKnown}
          >
            Take snapshot
          </Button>
        </div>

        {error && <div className="text-sm text-rose-300">{error}</div>}
        {job && (
          <div role={job.status === 'failed' ? 'alert' : 'status'} className={`text-sm ${job.status === 'failed' ? 'text-rose-300' : 'muted'}`}>
            {creating
              ? `Creating snapshot · started ${formatDate(job.startedAt)}. You can leave this page; creation continues on the server.`
              : job.status === 'failed'
                ? `Snapshot failed: ${job.error}`
                : `Last snapshot completed ${formatDate(job.finishedAt!)}.`}
          </div>
        )}

        <Divider />

        {loading ? (
          <div className="flex justify-center py-6">
            <Spinner size="sm" />
          </div>
        ) : snapshots.length === 0 ? (
          <div className="text-sm muted py-2">{error ? 'Snapshot status could not be refreshed. Retrying automatically…' : creating ? 'No completed snapshots yet. The new snapshot will appear here when ready.' : 'No completed snapshots yet.'}</div>
        ) : (
          <ul className="space-y-2">
            {snapshots.map((snap) => (
              <li
                key={snap.id}
                className="flex flex-col gap-2 rounded-lg border border-white/10 bg-white/5 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{snap.label || 'Snapshot'}</span>
                    {snap.kind === 'auto-pre-restore' && (
                      <Chip size="sm" variant="flat" color="warning">
                        auto-backup
                      </Chip>
                    )}
                  </div>
                  <div className="text-xs muted">
                    {formatDate(snap.createdAt)} · {formatBytes(snap.sizeBytes)}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="bordered"
                    startContent={<Download size={14} />}
                    onPress={() => download(snap)}
                    isDisabled={busy !== null}
                  >
                    Download
                  </Button>
                  <Button
                    size="sm"
                    variant="flat"
                    startContent={<RotateCcw size={14} />}
                    onPress={() => restore(snap)}
                    isLoading={busy === snap.id}
                    isDisabled={busy !== null || serverRunning || creating || loading || !statusKnown}
                  >
                    Restore
                  </Button>
                  <Button
                    size="sm"
                    color="danger"
                    variant="flat"
                    isIconOnly
                    aria-label="Delete snapshot"
                    onPress={() => remove(snap)}
                    isDisabled={busy !== null}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {serverRunning && snapshots.length > 0 && (
          <div className="text-xs muted">Stop the server to enable Restore.</div>
        )}
      </CardBody>
    </Card>
  );
}
