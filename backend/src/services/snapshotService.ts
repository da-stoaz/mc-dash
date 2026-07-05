import path from 'path';
import fs from 'fs/promises';
import * as tar from 'tar';
import { config } from '../config';
import { logger } from '../logger';
import { serverStore } from '../serverStore';
import { runServerRcon } from './rconService';
import { ServerRecord, SnapshotKind, SnapshotRecord } from '../types';

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
  const root = serverRootDir(server.id);
  if (!(await pathExists(root))) {
    throw new Error('Server has no data on disk to snapshot yet');
  }

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
  const flushed = await runServerRcon(server, ['save-off', 'save-all flush']);
  if (!flushed && server.status === 'running') {
    logger.warn(
      { serverId: server.id },
      'Could not flush world over RCON before snapshot; it may miss unsaved in-memory changes'
    );
  }

  try {
    await tar.create({ gzip: true, file: archivePath, cwd: root, portable: true }, entries);
  } finally {
    // Re-enable autosave whether or not the archive succeeded.
    if (flushed) await runServerRcon(server, ['save-on']);
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

  // Safety net first, so a restore can itself be undone.
  const safetySnapshot = await createSnapshot(server, {
    label: `Auto-backup before restoring "${record.label ?? record.createdAt}"`,
    kind: 'auto-pre-restore',
  });

  const root = serverRootDir(server.id);
  const entries = await fs.readdir(root);
  await Promise.all(
    entries
      .filter((entry) => entry !== SNAPSHOTS_DIRNAME)
      .map((entry) => fs.rm(path.join(root, entry), { recursive: true, force: true }))
  );

  await tar.extract({ file: archivePath, cwd: root });
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
  await fs.mkdir(root, { recursive: true });

  // `tar` strips absolute paths and `..` segments on extract, so a malicious
  // archive can't escape the server root.
  await tar.extract({ file: archivePath, cwd: root });

  const packDir = path.join(root, 'pack');
  if (!(await pathExists(packDir))) {
    throw new Error('That archive is not a valid MC Dash server snapshot (no pack/ directory inside).');
  }
}

export async function deleteSnapshot(server: ServerRecord, snapshotId: string): Promise<boolean> {
  const record = serverStore.getSnapshot(snapshotId);
  if (!record || record.serverId !== server.id) return false;
  await fs.rm(snapshotFilePath(server.id, record.fileName), { force: true });
  return serverStore.deleteSnapshot(snapshotId);
}
