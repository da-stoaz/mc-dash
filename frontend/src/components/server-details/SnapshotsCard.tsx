'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, CardBody, CardHeader, Checkbox, Chip, Divider, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Progress, Spinner } from '@heroui/react';
import { Camera, Download, RotateCcw, Trash2 } from 'lucide-react';
import { API_BASE, apiFetch, apiOperation } from '../../lib/api';
import { getApiErrorMessage } from '../../lib/apiErrors';
import { Snapshot, ServerStatus } from '../../lib/serverTypes';
import { DisabledAction } from '../DisabledAction';

type SnapshotsCardProps = {
  serverId: string;
  status: ServerStatus;
  onRestored?: () => void;
};

type SnapshotJob = {
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  operation?: 'create' | 'restore';
  phase?: string | null;
  snapshotId?: string | null;
  safetySnapshotId?: string | null;
  createSafetySnapshot?: boolean;
  bytesProcessed?: number;
  totalBytes?: number | null;
  updatedAt?: string | null;
  cancelRequested?: boolean;
};

const RESTORE_STAGES = [
  { id: 'validating', label: 'Checking snapshot', detail: 'Reading the archive to check it before changing any server files.' },
  { id: 'backup', label: 'Creating safety backup', detail: 'Compressing the current server files so you can undo this restore. Large worlds can take several minutes.' },
  { id: 'clearing', label: 'Replacing current files', detail: 'Removing the current server files. Your snapshot history is retained.' },
  { id: 'extracting', label: 'Extracting snapshot', detail: 'Reading the archive and writing the restored server files to disk.' },
  { id: 'permissions', label: 'Finishing restore', detail: 'Checking the restored files and preparing their permissions for the Minecraft server.' },
];

const SNAPSHOT_STAGES = [
  { id: 'checking-files', label: 'Checking server files', detail: 'Checking that the server files can be safely archived. Large folders can take time to scan.' },
  { id: 'flushing', label: 'Saving world to disk', detail: 'If the server is running, saving recent changes and pausing autosaves while the snapshot is created.' },
  { id: 'archiving', label: 'Compressing snapshot', detail: 'Reading server files and writing the compressed archive. Large worlds can take several minutes.' },
  { id: 'resuming', label: 'Re-enabling autosaves', detail: 'Confirming that Minecraft can save normally again before marking the snapshot complete.' },
  { id: 'finalizing', label: 'Finalizing snapshot', detail: 'Recording the finished archive so it is available to download or restore.' },
];

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

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
  const [cancelBusy, setCancelBusy] = useState(false);
  const [label, setLabel] = useState('');
  const [restoreTarget, setRestoreTarget] = useState<Snapshot | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Snapshot | null>(null);
  const focusDeleteCancel = useCallback((button: HTMLButtonElement | null) => { button?.focus(); }, []);
  const [createSafetySnapshot, setCreateSafetySnapshot] = useState(true);
  const [job, setJob] = useState<SnapshotJob | null>(null);
  const [statusKnown, setStatusKnown] = useState(false);
  const [checkedAt, setCheckedAt] = useState(0);
  const [now, setNow] = useState(0);
  const restoredNotification = useRef<string | null>(null);
  const revision = useRef(0);
  const viewController = useRef<AbortController | null>(null);
  const activeJob = job?.status === 'running';
  const restoring = activeJob && job.operation === 'restore';
  const creating = activeJob && !restoring;
  const startingRestore = !!busy?.startsWith('restore:') && !activeJob;
  const restoreStages = RESTORE_STAGES.filter(stage => stage.id !== 'backup' || job?.createSafetySnapshot !== false);
  const stageIndex = restoreStages.findIndex(stage => stage.id === job?.phase);
  const stage = restoreStages[stageIndex];
  const snapshotStageIndex = SNAPSHOT_STAGES.findIndex(stage => stage.id === job?.phase);
  const snapshotStage = SNAPSHOT_STAGES[snapshotStageIndex];

  useEffect(() => {
    if (!activeJob) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activeJob]);

  useEffect(() => {
    if (job?.operation !== 'restore' || job.status !== 'completed' || restoredNotification.current === job.startedAt) return;
    restoredNotification.current = job.startedAt;
    onRestored?.();
  }, [job, onRestored]);

  const serverRunning = RUNNING_STATES.includes(status);
  const jobIsRestore = job?.operation === 'restore';
  const stages = jobIsRestore ? restoreStages : SNAPSHOT_STAGES;
  const currentStageIndex = jobIsRestore ? stageIndex : snapshotStageIndex;
  const currentStage = jobIsRestore ? stage : snapshotStage;
  const cancelling = creating && (cancelBusy || job.cancelRequested);
  const actionDisabledReason = cancelling ? 'The snapshot is being cancelled.'
    : restoring || startingRestore ? 'Wait for the restore to finish.'
      : creating || busy === 'create' ? 'A snapshot is already being created.'
        : busy !== null ? 'Wait for the current snapshot action to finish.'
          : loading ? 'Loading snapshot status…'
            : !statusKnown ? 'Snapshot status is unavailable. Reconnecting…' : null;
  const restoreDisabledReason = actionDisabledReason ?? (serverRunning ? 'Stop the server before restoring a snapshot.' : null);

  const load = useCallback(async (signal?: AbortSignal) => {
    const requestRevision = ++revision.current;
    const current = () => !signal?.aborted && revision.current === requestRevision;
    let receivedStatus = false;
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
      receivedStatus = true;
      setCheckedAt(Date.now());
      setNow(Date.now());
      const res = await apiFetch(`${API_BASE}/servers/${serverId}/snapshots`, { signal, cache: 'no-store' });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Failed to load snapshots'));
      const nextSnapshots = await res.json() as Snapshot[];
      if (!current()) return;
      setSnapshots(nextSnapshots);
      setError(null);
    } catch (err) {
      if (!current()) return;
      if (!receivedStatus) setStatusKnown(false);
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
    if (busy !== null || serverRunning || activeJob || loading || !statusKnown) return;
    setRestoreTarget(null);
    const signal = viewController.current?.signal;
    ++revision.current;
    setBusy(`restore:${snapshot.id}`);
    setError(null);
    try {
      const res = await apiOperation(`${API_BASE}/servers/${serverId}/snapshots/${snapshot.id}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ createSafetySnapshot }),
      });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Restore failed'));
      if (signal?.aborted) return;
      await load(signal);
    } catch (err) {
      if (signal?.aborted) return;
      setError((err as Error).message);
    } finally {
      if (!signal?.aborted) setBusy(null);
    }
  };

  const cancel = async () => {
    if (!creating || cancelBusy || job.cancelRequested) return;
    const signal = viewController.current?.signal;
    ++revision.current;
    setCancelBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}/servers/${serverId}/snapshots/job/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startedAt: job.startedAt }),
      });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Could not cancel the snapshot'));
      const accepted = await res.json() as SnapshotJob;
      if (signal?.aborted) return;
      ++revision.current;
      setJob(accepted);
      await load(signal);
    } catch (err) {
      if (!signal?.aborted) setError((err as Error).message);
    } finally {
      if (!signal?.aborted) setCancelBusy(false);
    }
  };

  const remove = async (snapshot: Snapshot) => {
    if (busy !== null || activeJob || loading || !statusKnown) return;
    setDeleteTarget(null);
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
          <DisabledAction label="Take snapshot" reason={actionDisabledReason}>
          <Button
            size="sm"
            color="primary"
            className="w-full"
            startContent={<Camera size={14} />}
            onPress={takeSnapshot}
            isLoading={busy === 'create' || creating}
            isDisabled={!!actionDisabledReason}
          >
            Take snapshot
          </Button>
          </DisabledAction>
        </div>

        {error && <div className="text-sm text-rose-300">{error}</div>}
        {startingRestore && <div role="status" className="flex items-center gap-3 text-sm"><Spinner size="sm" /> Starting restore… Checking that the server is stopped.</div>}
        {job && !startingRestore && (
          <div className="space-y-3 rounded-lg border border-white/10 bg-white/5 p-3">
            <div className="flex items-start justify-between gap-3">
              <div role={job.status === 'failed' ? 'alert' : 'status'} className={`text-sm ${job.status === 'failed' ? 'text-rose-300' : job.status === 'completed' ? 'text-emerald-300' : ''}`}>
                <p className="font-medium">{activeJob
                  ? cancelling ? 'Cancelling snapshot…' : jobIsRestore ? 'Restoring snapshot' : 'Creating snapshot'
                  : job.status === 'failed' ? `${jobIsRestore ? 'Restore' : 'Snapshot'} failed: ${job.error}`
                    : job.status === 'cancelled' ? 'Snapshot cancelled' : jobIsRestore ? 'Restore completed' : 'Last snapshot completed'}</p>
                {activeJob && !cancelling && <p className="mt-1 text-xs muted">Step {Math.max(1, currentStageIndex + 1)} of {stages.length} · {currentStage?.label ?? 'Preparing snapshot'}</p>}
                {cancelling && <p className="mt-1 text-xs muted">Finishing the current step, removing the partial archive, and re-enabling autosaves.</p>}
                {job.status === 'cancelled' && <p className="mt-1 text-xs muted">The partial archive was removed. Your server files are unchanged.</p>}
                {jobIsRestore && job.status === 'completed' && <p className="mt-1 text-xs muted">Your server is ready to start.</p>}
              </div>
              {creating && <DisabledAction label="Cancel snapshot" reason={cancelling ? 'Cleaning up the partial snapshot. Please wait.' : null}>
                <Button size="sm" variant="light" className="min-w-0 text-default-500" aria-label="Cancel snapshot"
                  isDisabled={!!cancelling} onPress={cancel}>Cancel</Button>
              </DisabledAction>}
            </div>
            {activeJob && <>
              <Progress aria-label={cancelling ? 'Cancelling snapshot' : currentStage?.label ?? 'Snapshot progress'} size="sm"
                classNames={{ indicator: 'bg-cyan-400' }} isIndeterminate={!jobIsRestore || !job.totalBytes || !!cancelling}
                value={jobIsRestore && job.totalBytes ? Math.min(100, (job.bytesProcessed ?? 0) / job.totalBytes * 100) : undefined} />
              <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs muted">
                <span>Elapsed: {duration(now - Date.parse(job.startedAt))}</span>
                {jobIsRestore && !!job.totalBytes
                  ? <span>{formatBytes(job.bytesProcessed ?? 0)} / {formatBytes(job.totalBytes)} · {Math.min(100, Math.floor((job.bytesProcessed ?? 0) / job.totalBytes * 100))}% of this stage</span>
                  : (job.bytesProcessed ?? 0) > 0 && <span>{job.phase === 'backup' ? 'Safety archive written' : 'Archive written'}: {formatBytes(job.bytesProcessed ?? 0)}</span>}
              </div>
              {!statusKnown && <p className="text-xs text-amber-300">Status unavailable — reconnecting…</p>}
              {!cancelling && job.updatedAt && now - Date.parse(job.updatedAt) > 30000 && <p className="text-xs text-amber-300">{jobIsRestore ? 'No new file activity' : 'No new progress'} for {duration(now - Date.parse(job.updatedAt))}. Waiting for an update.</p>}
            </>}
            {!activeJob && job.finishedAt && <p className="text-xs muted">Duration: {duration(Date.parse(job.finishedAt) - Date.parse(job.startedAt))}{job.status === 'completed' && !jobIsRestore && job.bytesProcessed ? ` · Archive size: ${formatBytes(job.bytesProcessed)}` : ''}</p>}
            <details key={job.startedAt} className="text-xs muted">
              <summary className="w-fit cursor-pointer rounded py-1 hover:text-foreground focus-visible:outline-2 focus-visible:outline-cyan-400">Details</summary>
              <div className="mt-2 space-y-3">
                {activeJob && <>
                  <p>{currentStage?.detail}</p>
                  <ol aria-label={jobIsRestore ? 'Restore stages' : 'Snapshot stages'} className="space-y-1">
                    {stages.map((item, index) => <li key={item.id} aria-current={index === currentStageIndex ? 'step' : undefined}
                      className={index === currentStageIndex ? 'font-medium text-cyan-300' : ''}>
                      {index < currentStageIndex ? '✓' : `${index + 1}.`} {item.label}
                    </li>)}
                  </ol>
                  {statusKnown && <p>Status checked {duration(now - checkedAt)} ago</p>}
                  {jobIsRestore && !!job.totalBytes && (job.bytesProcessed ?? 0) >= job.totalBytes && <p>Archive read. Finishing disk work…</p>}
                  <p>You can leave this page; {jobIsRestore ? 'the restore' : 'creation'} continues on the server.</p>
                </>}
                <p>Started {formatDate(job.startedAt)}{job.finishedAt ? ` · Finished ${formatDate(job.finishedAt)}` : ''}</p>
                {job.safetySnapshotId && <p>Your automatic safety backup is available in the snapshot list.</p>}
              </div>
            </details>
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
                  <DisabledAction label="Download" reason={busy !== null ? 'Wait for the current snapshot action to finish.' : null}>
                  <Button
                    size="sm"
                    variant="bordered"
                    startContent={<Download size={14} />}
                    onPress={() => download(snap)}
                    isDisabled={busy !== null}
                  >
                    Download
                  </Button>
                  </DisabledAction>
                  <DisabledAction label="Restore" reason={restoreDisabledReason}>
                  <Button
                    size="sm"
                    variant="flat"
                    aria-label="Restore"
                    startContent={<RotateCcw size={14} />}
                    onPress={() => { setCreateSafetySnapshot(true); setRestoreTarget(snap); }}
                    isLoading={busy === `restore:${snap.id}` || (restoring && job.snapshotId === snap.id)}
                    isDisabled={!!restoreDisabledReason}
                  >
                    Restore
                  </Button>
                  </DisabledAction>
                  <DisabledAction label="Delete snapshot" reason={actionDisabledReason}>
                  <Button
                    size="sm"
                    color="danger"
                    variant="flat"
                    isIconOnly
                    aria-label="Delete snapshot"
                    onPress={() => setDeleteTarget(snap)}
                    isDisabled={!!actionDisabledReason}
                  >
                    <Trash2 size={14} />
                  </Button>
                  </DisabledAction>
                </div>
              </li>
            ))}
          </ul>
        )}

      </CardBody>
      <Modal isOpen={deleteTarget !== null} onClose={() => setDeleteTarget(null)} placement="center">
        <ModalContent>
          <ModalHeader>Delete snapshot?</ModalHeader>
          <ModalBody className="gap-4">
            {deleteTarget && <div className="rounded-lg border border-white/10 bg-white/5 p-3">
              <p className="break-words font-medium">{deleteTarget.label || 'Snapshot'}</p>
              <p className="mt-1 text-xs muted">{formatDate(deleteTarget.createdAt)} · {formatBytes(deleteTarget.sizeBytes)}</p>
            </div>}
            <p className="text-sm muted">This permanently deletes the snapshot archive. This cannot be undone.</p>
          </ModalBody>
          <ModalFooter>
            <Button ref={focusDeleteCancel} variant="flat" onPress={() => setDeleteTarget(null)}>Cancel</Button>
            <DisabledAction label="Delete snapshot" reason={actionDisabledReason}>
            <Button color="danger" isDisabled={!!actionDisabledReason}
              onPress={() => { if (deleteTarget) void remove(deleteTarget); }}>
              Delete snapshot
            </Button>
            </DisabledAction>
          </ModalFooter>
        </ModalContent>
      </Modal>
      <Modal isOpen={restoreTarget !== null} onClose={() => setRestoreTarget(null)} placement="center">
        <ModalContent>
          <ModalHeader>Restore snapshot</ModalHeader>
          <ModalBody className="gap-4">
            <p className="text-sm muted">Replace the current server files with this snapshot:</p>
            {restoreTarget && <div className="rounded-lg border border-white/10 bg-white/5 p-3">
              <p className="break-words font-medium">{restoreTarget.label || 'Snapshot'}</p>
              <p className="mt-1 text-xs muted">{formatDate(restoreTarget.createdAt)} · {formatBytes(restoreTarget.sizeBytes)}</p>
            </div>}
            <div className="rounded-lg border border-white/10 p-3">
              <Checkbox isSelected={createSafetySnapshot} onValueChange={setCreateSafetySnapshot} classNames={{ label: 'text-sm' }}>
                Back up the current state first
              </Checkbox>
              <p className="mt-2 text-xs muted">Recommended. Creates a snapshot you can restore to undo this change. This adds time for large servers.</p>
            </div>
            {!createSafetySnapshot && <p role="alert" className="text-sm text-amber-300">The current state will be overwritten without a new backup. Changes since the selected snapshot may be lost.</p>}
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={() => setRestoreTarget(null)}>Cancel</Button>
            <DisabledAction label="Restore" reason={restoreDisabledReason}>
            <Button color={createSafetySnapshot ? 'primary' : 'danger'} isDisabled={!!restoreDisabledReason}
              onPress={() => { if (restoreTarget) void restore(restoreTarget); }}>
              {createSafetySnapshot ? 'Back up and restore' : 'Restore without backup'}
            </Button>
            </DisabledAction>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Card>
  );
}
