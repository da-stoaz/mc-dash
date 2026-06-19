import path from 'path';
import fs from 'fs/promises';
import { spawn } from 'child_process';
import { config } from '../config';
import { logger } from '../logger';
import { serverStore } from '../serverStore';
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

// GNU tar (Linux prod and the MSYS build used in dev) accepts forward slashes;
// normalize so Windows backslash paths don't confuse its filename parsing. No-op
// on POSIX paths.
function toTarPath(p: string): string {
  return p.replace(/\\/g, '/');
}

// Run `tar` with explicit args (no shell) and reject on a non-zero exit.
function runTar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * Archive a server's entire data folder into a gzipped tarball under its
 * snapshots/ directory and record it. Streams through `tar` so large modpack
 * worlds don't have to fit in memory. The snapshots/ folder itself is excluded.
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

  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.tar.gz`;
  const archivePath = path.join(dir, fileName);

  // -C root + "." archives the folder contents with relative paths; excluding
  // ./snapshots keeps the archive (and prior snapshots) out of the tarball.
  // --force-local: treat an archive path containing ':' as a local file (e.g. a
  // Windows drive letter) rather than a remote host. No-op for Linux paths.
  await runTar(['--force-local', '-czf', toTarPath(archivePath), '-C', toTarPath(root), `--exclude=./${SNAPSHOTS_DIRNAME}`, '.']);

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

  await runTar(['--force-local', '-xzf', toTarPath(archivePath), '-C', toTarPath(root)]);
  logger.info({ serverId: server.id, snapshotId, safetySnapshotId: safetySnapshot.id }, 'Restored snapshot');
  return { restored: record, safetySnapshot };
}

export async function deleteSnapshot(server: ServerRecord, snapshotId: string): Promise<boolean> {
  const record = serverStore.getSnapshot(snapshotId);
  if (!record || record.serverId !== server.id) return false;
  await fs.rm(snapshotFilePath(server.id, record.fileName), { force: true });
  return serverStore.deleteSnapshot(snapshotId);
}
