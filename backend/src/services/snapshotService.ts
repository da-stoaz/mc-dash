import path from 'path';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Worker } from 'worker_threads';
import { prepareServerFiles } from './serverFiles';
import * as tar from 'tar';
import { config } from '../config';
import { logger } from '../logger';
import { serverStore } from '../serverStore';
import { runServerRcon } from './rconService';
import { ServerRecord, SnapshotKind, SnapshotRecord } from '../types';
import { beginSnapshotJob, finishSnapshotJob, updateSnapshotProgress, setSafetySnapshot, SnapshotJob, getSnapshotJob, requestSnapshotCancellation } from './snapshotJobStore';

export class SnapshotCancelledError extends Error {
  constructor() { super('Snapshot cancelled'); }
}

const snapshotControllers = new Map<string, AbortController>();

/** Match the job the user saw so a delayed request cannot cancel a newer job. */
export function cancelSnapshot(serverId: string, startedAt: string): SnapshotJob | null {
  const job = getSnapshotJob(serverId);
  if (!job || job.startedAt !== startedAt || job.operation !== 'create') return null;
  if (job.status === 'cancelled') return job;
  const controller = snapshotControllers.get(serverId);
  if (job.status !== 'running' || !controller) return null;
  requestSnapshotCancellation(serverId);
  controller.abort(new SnapshotCancelledError());
  return getSnapshotJob(serverId);
}

type Progress = (bytes: number, finished?: boolean) => void;
type ArchiveProgress = {
  onBytes: Progress;
  onPhase?: (phase: SnapshotJob['phase'], bytes: number) => void;
};

// Persist at most twice per second, not once per chunk of a large archive.
function progressReporter(serverId: string, phase: SnapshotJob['phase'], total: number | null = null, initialize = true): Progress {
  if (initialize) updateSnapshotProgress(serverId, phase, 0, total);
  let lastUpdate = 0;
  let lastBytes = -1;
  return (bytes, finished = false) => {
    if (!finished && bytes === lastBytes) return;
    if (!finished && Date.now() - lastUpdate < 500 && bytes !== total) return;
    updateSnapshotProgress(serverId, phase, bytes, total);
    lastUpdate = Date.now();
    lastBytes = bytes;
  };
}

async function readArchive(file: string, destination: NodeJS.WritableStream, progress?: Progress): Promise<void> {
  const input = createReadStream(file);
  input.on('data', () => progress?.(input.bytesRead));
  await pipeline(input, destination);
  progress?.(input.bytesRead);
}

/** Terminating the worker also closes tar's pending file readers and zlib
 * handles. Wait for exit before deleting the partial archive or unlocking. */
async function writeArchive(root: string, entries: string[], archivePath: string, progress: Progress, signal?: AbortSignal): Promise<number> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'snapshotArchiveWorker.cjs'), {
      workerData: { root, entries, archivePath }, trackUnmanagedFds: true,
    });
    let completed = false;
    let bytes = 0;
    let failure: Error | undefined;
    const terminate = () => { void worker.terminate().catch(err => { failure ??= err; }); };
    const abort = () => {
      failure ??= signal?.reason;
      terminate();
    };
    signal?.addEventListener('abort', abort, { once: true });
    worker.on('message', message => {
      if (failure || signal?.aborted) return;
      if (message.error) {
        failure = Object.assign(new Error(message.error), { code: message.code, path: message.path });
        terminate();
        return;
      }
      bytes = message.bytes;
      completed = message.done === true;
      try { progress(bytes, completed); }
      catch (err) { failure = err instanceof Error ? err : new Error(String(err)); terminate(); }
    });
    worker.on('error', err => { failure ??= err instanceof Error ? err : new Error(String(err)); });
    worker.on('exit', code => {
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (!completed || code !== 0) reject(new Error('Snapshot archive worker stopped unexpectedly'));
      else resolve(bytes);
    });
    if (signal?.aborted) abort();
  });
}

// Subdirectory (relative to the server root) that holds the snapshot archives.
// It is excluded from snapshots and preserved across restores so a server's
// history is never archived into itself or wiped by a restore.
const SNAPSHOTS_DIRNAME = 'snapshots';

function serverRootDir(serverId: string): string {
  return path.join(config.dataRoot, 'servers', serverId);
}

function snapshotsDir(serverId: string): string {
  return path.join(serverRootDir(serverId), SNAPSHOTS_DIRNAME);
}

export function snapshotFilePath(serverId: string, fileName: string): string {
  return path.join(snapshotsDir(serverId), fileName);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function isPermissionError(err: unknown): err is NodeJS.ErrnoException {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'EACCES' || code === 'EPERM';
}

// Turn a raw filesystem EACCES/EPERM (root-owned server files the backend user
// can't read) into an actionable message instead of a cryptic errno. Happens on
// servers whose containers ran as root before the container-user fix; the files
// need a one-time chown to the user MC Dash runs as, after which starting the
// server rebuilds its container as that user so the fix sticks.
function toPermissionError(err: NodeJS.ErrnoException, serverRoot: string): Error {
  const badPath = err.path ?? '(unknown path)';
  return new Error(
    `Permission denied reading server files (${badPath}). These files were written by a ` +
      `Minecraft container running as a different user than MC Dash, so they can't be read to ` +
      `snapshot them. Stop the server and run once: sudo chown -R "$(id -u)":"$(id -g)" ` +
      `"${serverRoot}" — then start it again. Starting now rebuilds the container to run as the ` +
      `MC Dash user, so the world stays readable instead of re-breaking on the next save (see ` +
      `MC_CONTAINER_USER in DEPLOY.md).`
  );
}

/**
 * Archive a server's entire data folder into a gzipped tarball under its
 * snapshots/ directory and record it. Uses the pure-JS `tar` (gzip via Node's
 * zlib) so it needs no system tar/gzip and streams large modpack worlds without
 * loading them into memory. The snapshots/ folder itself is excluded, and a file
 * changing mid-read (e.g. on a running server) does not abort the archive.
 */
export async function createSnapshot(
  server: ServerRecord,
  options: { label?: string | null; kind?: SnapshotKind } = {}
): Promise<SnapshotRecord> {
  beginSnapshotJob(server.id);
  const controller = new AbortController();
  snapshotControllers.set(server.id, controller);
  try {
    const snapshot = await archiveSnapshot(server, options, {
      onBytes: progressReporter(server.id, 'archiving', null, false),
      onPhase: (phase, bytes) => updateSnapshotProgress(server.id, phase, bytes),
    }, controller.signal);
    finishSnapshotJob(server.id, snapshot.id, null);
    return snapshot;
  } catch (err) {
    const cancelled = err instanceof SnapshotCancelledError ||
      (controller.signal.aborted && (err as Error)?.name === 'AbortError');
    finishSnapshotJob(server.id, null, cancelled ? null : err instanceof Error ? err.message : String(err), cancelled);
    if (cancelled) throw new SnapshotCancelledError();
    throw err;
  } finally {
    snapshotControllers.delete(server.id);
  }
}

async function archiveSnapshot(
  server: ServerRecord,
  options: { label?: string | null; kind?: SnapshotKind },
  progress: ArchiveProgress,
  signal?: AbortSignal
): Promise<SnapshotRecord> {
  const root = serverRootDir(server.id);
  signal?.throwIfAborted();
  if (!(await pathExists(root))) {
    throw new Error('Server has no data on disk to snapshot yet');
  }

  // The importer deliberately rejects links/special files. Refuse to produce
  // an archive that cannot be restored, before disabling Minecraft autosaves.
  await prepareServerFiles(server.id, false, signal);
  signal?.throwIfAborted();
  const dir = snapshotsDir(server.id);
  await fs.mkdir(dir, { recursive: true });

  // Archive every top-level entry except the snapshots/ history itself.
  const entries = (await fs.readdir(root)).filter((entry) => entry !== SNAPSHOTS_DIRNAME);
  if (entries.length === 0) {
    throw new Error('Server folder is empty; nothing to snapshot yet');
  }

  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.tar.gz`;
  const archivePath = path.join(dir, fileName);

  // Minecraft keeps recent play (block edits, movement, inventories) in memory
  // and only writes to disk on autosave or shutdown. For a *hot* snapshot we
  // must force a flush over RCON first, or the archive captures a stale world.
  // save-off pauses autosave so files don't change mid-archive; the save-all
  // flush RCON reply only returns once the write to disk has completed. Skipped
  // (null) for a stopped/unreachable server, whose disk is already consistent.
  let flushed: string[] | null = null;
  let saveAttempted = false;
  let bytes = 0;
  const live = ['running', 'starting', 'restarting', 'stopping'].includes(server.status);
  try {
    try {
      signal?.throwIfAborted();
      progress.onPhase?.('flushing', bytes);
      saveAttempted = true;
      flushed = await runServerRcon(server, ['save-off', 'save-all flush']);
      signal?.throwIfAborted();
      if (!flushed && live) {
        throw new Error('Could not flush the running server. Snapshot cancelled; retry when RCON is available or stop the server first.');
      }
      progress.onPhase?.('archiving', bytes);
      bytes = await writeArchive(root, entries, archivePath, (written, finished) => {
        bytes = written;
        progress.onBytes(written, finished);
      }, signal);
    } finally {
      // The server may have executed save-off even if the flush timed out or
      // disconnected. Never infer that nothing happened from a null response.
      if (saveAttempted) try {
        progress.onPhase?.('resuming', bytes);
      } finally {
        // A failed progress write (for example a full disk) must not prevent
        // the save-on command from reaching Minecraft.
        const resumed = await runServerRcon(server, ['save-on']);
        if (!resumed && (flushed || live)) {
          throw new Error('Could not confirm autosaving was re-enabled. Run save-on in the Minecraft console immediately; snapshot did not complete safely.');
        }
      }
    }
    signal?.throwIfAborted();
    progress.onPhase?.('finalizing', bytes);
    const stat = await fs.stat(archivePath);
    signal?.throwIfAborted();
    const record = serverStore.createSnapshot({
      serverId: server.id,
      label: options.label ?? null,
      fileName,
      sizeBytes: stat.size,
      kind: options.kind ?? 'manual',
    });
    logger.info({ serverId: server.id, snapshotId: record.id, sizeBytes: record.sizeBytes }, 'Created snapshot');
    return record;
  } catch (err) {
    try { await fs.rm(archivePath, { force: true }); }
    catch (cleanupError) {
      throw new Error(`Could not remove the partial snapshot archive ${archivePath}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
    if (isPermissionError(err)) throw toPermissionError(err, root);
    throw err;
  }
}

/**
 * Restore a snapshot over the server's data folder. By default takes an automatic
 * safety snapshot of the current state first, then wipes everything except the
 * snapshots/ history and extracts the chosen archive. The caller must ensure the
 * server is stopped.
 */
export async function restoreSnapshot(
  server: ServerRecord,
  snapshotId: string,
  options: { createSafetySnapshot?: boolean } = {}
): Promise<{ restored: SnapshotRecord; safetySnapshot: SnapshotRecord | null }> {
  const createSafetySnapshot = options.createSafetySnapshot !== false;
  beginSnapshotJob(server.id, 'restore', snapshotId, createSafetySnapshot);
  let replacingData = false;
  let safetySnapshot: SnapshotRecord | null = null;
  try {
    const record = serverStore.getSnapshot(snapshotId);
    if (!record || record.serverId !== server.id) {
      throw new Error('Snapshot not found');
    }
    const archivePath = snapshotFilePath(server.id, record.fileName);
    if (!(await pathExists(archivePath))) {
      throw new Error('Snapshot archive is missing on disk');
    }
    const { size } = await fs.stat(archivePath);
    await validateSnapshot(archivePath, serverRootDir(server.id), progressReporter(server.id, 'validating', size));

    // Safety net first, so a restore can itself be undone.
    if (createSafetySnapshot) {
      safetySnapshot = await archiveSnapshot(server, {
        label: `Auto-backup before restoring "${record.label ?? record.createdAt}"`,
        kind: 'auto-pre-restore',
      }, { onBytes: progressReporter(server.id, 'backup') });
      setSafetySnapshot(server.id, safetySnapshot.id);
    }

    const root = serverRootDir(server.id);
    const entries = await fs.readdir(root);
    await prepareServerFiles(server.id, false);
    updateSnapshotProgress(server.id, 'clearing');
    replacingData = true;
    await Promise.all(
      entries
        .filter((entry) => entry !== SNAPSHOTS_DIRNAME)
        .map((entry) => fs.rm(path.join(root, entry), { recursive: true, force: true }))
    );

    // This archive was fully validated before any data was removed. Do not
    // decompress it a second time just to repeat the same validation.
    await readArchive(archivePath, tar.extract({ cwd: root, preserveOwner: false, strict: true }),
      progressReporter(server.id, 'extracting', size));
    updateSnapshotProgress(server.id, 'permissions');
    await prepareServerFiles(server.id);
    finishSnapshotJob(server.id, snapshotId, null);
    logger.info({ serverId: server.id, snapshotId, safetySnapshotId: safetySnapshot?.id ?? null }, 'Restored snapshot');
    return { restored: record, safetySnapshot };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const recovery = replacingData
      ? ' Server data may be incomplete. Keep the server stopped and retry the restore.' + (safetySnapshot ? ' You can also restore the automatic safety backup from the snapshot list.' : ' No safety backup was created.')
      : ' Existing server data has not been replaced.';
    finishSnapshotJob(server.id, snapshotId, message + recovery);
    throw err;
  }
}

/**
 * Populate a freshly-created server's data folder from an uploaded snapshot
 * archive (the same `.tar.gz` produced by download/createSnapshot). The archive
 * already contains the extracted, configured pack — including the world — so the
 * caller can build a container straight away without re-preparing a zip.
 *
 * Rejects if the archive doesn't look like a server snapshot (no pack/ inside),
 * so a stray tarball can't leave a half-populated server behind.
 */
export async function importSnapshotArchive(serverId: string, archivePath: string): Promise<void> {
  const root = serverRootDir(serverId);
  await prepareServerFiles(serverId, false);
  await fs.mkdir(root, { recursive: true });

  // `tar` strips absolute paths and `..` segments on extract, so a malicious
  // archive can't escape the server root.
  await extractSnapshot(archivePath, root);

  const packDir = path.join(root, 'pack');
  if (!(await pathExists(packDir))) {
    throw new Error('That archive is not a valid MC Dash server snapshot (no pack/ directory inside).');
  }
  await prepareServerFiles(serverId);
}

async function validateSnapshot(file: string, root: string, progress?: Progress): Promise<void> {
  let unsafe: string | undefined;
  await readArchive(file, tar.list({ strict: true, onReadEntry: entry => {
    const relative = path.relative(root, path.resolve(root, entry.path));
    if (path.isAbsolute(entry.path) || relative === '..' || relative.startsWith('..' + path.sep) ||
        relative.split(path.sep)[0] === SNAPSHOTS_DIRNAME ||
        !['File', 'Directory', 'OldFile', 'ContiguousFile'].includes(entry.type)) {
      unsafe = entry.path;
    }
  } }), progress);
  if (unsafe !== undefined) throw new Error(`Unsafe snapshot entry: ${unsafe}`);
}

async function extractSnapshot(file: string, root: string): Promise<void> {
  await validateSnapshot(file, root);
  await tar.extract({ file, cwd: root, preserveOwner: false });
}

export async function deleteSnapshot(server: ServerRecord, snapshotId: string): Promise<boolean> {
  const record = serverStore.getSnapshot(snapshotId);
  if (!record || record.serverId !== server.id) return false;
  await fs.rm(snapshotFilePath(server.id, record.fileName), { force: true });
  return serverStore.deleteSnapshot(snapshotId);
}
