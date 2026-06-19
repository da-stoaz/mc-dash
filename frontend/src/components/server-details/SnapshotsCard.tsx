'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Card, CardBody, CardHeader, Chip, Divider, Input, Spinner } from '@heroui/react';
import { Camera, Download, RotateCcw, Trash2 } from 'lucide-react';
import { API_BASE, apiFetch } from '../../lib/api';
import { getApiErrorMessage } from '../../lib/apiErrors';
import { Snapshot, ServerStatus } from '../../lib/serverTypes';

type SnapshotsCardProps = {
  serverId: string;
  status: ServerStatus;
  onRestored?: () => void;
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

  const serverRunning = RUNNING_STATES.includes(status);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_BASE}/servers/${serverId}/snapshots`);
      if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Failed to load snapshots'));
      setSnapshots((await res.json()) as Snapshot[]);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    load();
  }, [load]);

  const takeSnapshot = async () => {
    setBusy('create');
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}/servers/${serverId}/snapshots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim() || undefined }),
      });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Snapshot failed'));
      setLabel('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
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
      const res = await apiFetch(`${API_BASE}/servers/${serverId}/snapshots/${snapshot.id}/restore`, {
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
            isLoading={busy === 'create'}
            isDisabled={busy !== null}
          >
            Take snapshot
          </Button>
        </div>

        {error && <div className="text-sm text-rose-300">{error}</div>}

        <Divider />

        {loading ? (
          <div className="flex justify-center py-6">
            <Spinner size="sm" />
          </div>
        ) : snapshots.length === 0 ? (
          <div className="text-sm muted py-2">No snapshots yet. Take one before risky changes.</div>
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
                <div className="flex shrink-0 gap-2">
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
                    isDisabled={busy !== null || serverRunning}
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
