import path from 'path';
import fs from 'fs/promises';
import { prepareServerFiles } from './serverFiles';
import * as tar from 'tar';
import { config } from '../config';
import { logger } from '../logger';
import { serverStore } from '../serverStore';
import { runServerRcon } from './rconService';
import { ServerRecord, SnapshotKind, SnapshotRecord } from '../types';
import { beginSnapshotJob, finishSnapshotJob } from './snapshotJobStore';

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
  try {
    const snapshot = await archiveSnapshot(server, options);
    finishSnapshotJob(server.id, snapshot.id, null);
    return snapshot;
  } catch (err) {
    finishSnapshotJob(server.id, null, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

async function archiveSnapshot(
  server: ServerRecord,
  options: { label?: string | null; kind?: SnapshotKind }
): Promise<SnapshotRecord> {
  const root = serverRootDir(server.id);
  if (!(await pathExists(root))) {
    throw new Error('Server has no data on disk to snapshot yet');
  }

  // The importer deliberately rejects links/special files. Refuse to produce
  // an archive that cannot be restored, before disabling Minecraft autosaves.
  await prepareServerFiles(server.id, false);
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
  const live = ['running', 'starting', 'restarting', 'stopping'].includes(server.status);
  try {
    try {
      flushed = await runServerRcon(server, ['save-off', 'save-all flush']);
      if (!flushed && live) {
        throw new Error('Could not flush the running server. Snapshot cancelled; retry when RCON is available or stop the server first.');
      }
      await tar.create({ gzip: true, file: archivePath, cwd: root, portable: true }, entries);
    } finally {
      // The server may have executed save-off even if the flush timed out or
      // disconnected. Never infer that nothing happened from a null response.
      const resumed = await runServerRcon(server, ['save-on']);
      if (!resumed && (flushed || live)) {
        throw new Error('Could not confirm autosaving was re-enabled. Run save-on in the Minecraft console immediately; snapshot did not complete safely.');
      }
    }
  } catch (err) {
    await fs.rm(archivePath, { force: true }).catch(() => undefined);
    if (isPermissionError(err)) throw toPermissionError(err, root);
    throw err;
  }

  const stat = await fs.stat(archivePath);
  const record = serverStore.createSnapshot({
    serverId: server.id,
    label: options.label ?? null,
    fileName,
    sizeBytes: stat.size,
    kind: options.kind ?? 'manual',
  });
  logger.info({ serverId: server.id, snapshotId: record.id, sizeBytes: record.sizeBytes }, 'Created snapshot');
  return record;
}

/**
 * Restore a snapshot over the server's data folder. Always takes an automatic
 * safety snapshot of the current state first, then wipes everything except the
 * snapshots/ history and extracts the chosen archive. The caller must ensure the
 * server is stopped.
 */
export async function restoreSnapshot(
  server: ServerRecord,
  snapshotId: string
): Promise<{ restored: SnapshotRecord; safetySnapshot: SnapshotRecord }> {
  const record = serverStore.getSnapshot(snapshotId);
  if (!record || record.serverId !== server.id) {
    throw new Error('Snapshot not found');
  }
  const archivePath = snapshotFilePath(server.id, record.fileName);
  if (!(await pathExists(archivePath))) {
    throw new Error('Snapshot archive is missing on disk');
  }
  await validateSnapshot(archivePath, serverRootDir(server.id));

  // Safety net first, so a restore can itself be undone.
  const safetySnapshot = await createSnapshot(server, {
    label: `Auto-backup before restoring "${record.label ?? record.createdAt}"`,
    kind: 'auto-pre-restore',
  });

  const root = serverRootDir(server.id);
  const entries = await fs.readdir(root);
  await prepareServerFiles(server.id, false);
  await Promise.all(
    entries
      .filter((entry) => entry !== SNAPSHOTS_DIRNAME)
      .map((entry) => fs.rm(path.join(root, entry), { recursive: true, force: true }))
  );

  await extractSnapshot(archivePath, root);
  await prepareServerFiles(server.id);
  logger.info({ serverId: server.id, snapshotId, safetySnapshotId: safetySnapshot.id }, 'Restored snapshot');
  return { restored: record, safetySnapshot };
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

async function validateSnapshot(file: string, root: string): Promise<void> {
  let unsafe: string | undefined;
  await tar.list({ file, onReadEntry: entry => {
    const relative = path.relative(root, path.resolve(root, entry.path));
    if (path.isAbsolute(entry.path) || relative === '..' || relative.startsWith('..' + path.sep) ||
        relative.split(path.sep)[0] === SNAPSHOTS_DIRNAME ||
        !['File', 'Directory', 'OldFile', 'ContiguousFile'].includes(entry.type)) {
      unsafe = entry.path;
    }
  } });
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
