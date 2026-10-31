import { db } from '../db';

export type SnapshotJob = {
  serverId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt: string | null;
  snapshotId: string | null;
  error: string | null;
  operation: 'create' | 'restore';
  phase: 'validating' | 'backup' | 'clearing' | 'extracting' | 'permissions'
    | 'checking-files' | 'flushing' | 'archiving' | 'resuming' | 'finalizing' | null;
  bytesProcessed: number;
  totalBytes: number | null;
  updatedAt: string | null;
  safetySnapshotId: string | null;
  createSafetySnapshot: boolean;
  cancelRequested: boolean;
};

db.exec(`CREATE TABLE IF NOT EXISTS snapshot_jobs (
  serverId TEXT PRIMARY KEY, status TEXT NOT NULL, startedAt TEXT NOT NULL,
  finishedAt TEXT, snapshotId TEXT, error TEXT
)`);
// Additive migration for existing installations.
const columns = new Set((db.prepare('PRAGMA table_info(snapshot_jobs)').all() as { name: string }[]).map(column => column.name));
for (const [name, definition] of Object.entries({
  operation: "TEXT NOT NULL DEFAULT 'create'", phase: 'TEXT',
  bytesProcessed: 'INTEGER NOT NULL DEFAULT 0', totalBytes: 'INTEGER',
  updatedAt: 'TEXT', safetySnapshotId: 'TEXT',
  createSafetySnapshot: 'INTEGER NOT NULL DEFAULT 1',
  cancelRequested: 'INTEGER NOT NULL DEFAULT 0',
})) {
  if (!columns.has(name)) db.exec(`ALTER TABLE snapshot_jobs ADD COLUMN ${name} ${definition}`);
}
// This backend owns the archive workers. A new process cannot resume an old
// tar stream; retain an explicit failure rather than an eternal spinner.
db.prepare(`UPDATE snapshot_jobs SET status = 'failed', finishedAt = ?,
  error = CASE WHEN operation = 'restore'
    THEN CASE WHEN phase IN ('validating', 'backup')
      THEN 'Restore interrupted by a backend restart. Existing server data has not been replaced. Keep the server stopped and retry the restore.'
      ELSE 'Restore interrupted by a backend restart. Server data may be incomplete. Keep the server stopped and restore again.' || CASE WHEN safetySnapshotId IS NOT NULL THEN ' The safety backup is retained in the snapshot list.' ELSE ' No safety backup was created.' END END
    ELSE 'Snapshot interrupted by a backend restart. Please create a new snapshot.' END
  WHERE status = 'running'`).run(new Date().toISOString());

export function getSnapshotJob(serverId: string): SnapshotJob | null {
  const row = db.prepare('SELECT * FROM snapshot_jobs WHERE serverId = ?').get(serverId) as (Omit<SnapshotJob, 'createSafetySnapshot' | 'cancelRequested'> & { createSafetySnapshot: number; cancelRequested: number }) | undefined;
  return row ? { ...row, createSafetySnapshot: row.createSafetySnapshot !== 0, cancelRequested: row.cancelRequested !== 0 } : null;
}

export function beginSnapshotJob(serverId: string, operation: SnapshotJob['operation'] = 'create', snapshotId: string | null = null, createSafetySnapshot = true): void {
  if (getSnapshotJob(serverId)?.status === 'running') throw new Error('A snapshot is already being created or restored for this server.');
  db.prepare(`INSERT OR REPLACE INTO snapshot_jobs
    (serverId, status, startedAt, finishedAt, snapshotId, error, operation, phase, updatedAt, createSafetySnapshot)
    VALUES (?, 'running', ?, NULL, ?, NULL, ?, ?, ?, ?)`).run(serverId, new Date().toISOString(), snapshotId, operation,
      operation === 'restore' ? 'validating' : 'checking-files', new Date().toISOString(), Number(createSafetySnapshot));
}

export function updateSnapshotProgress(serverId: string, phase: SnapshotJob['phase'], bytesProcessed = 0, totalBytes: number | null = null): void {
  db.prepare(`UPDATE snapshot_jobs SET phase = ?, bytesProcessed = ?, totalBytes = ?, updatedAt = ? WHERE serverId = ? AND status = 'running'`)
    .run(phase, bytesProcessed, totalBytes, new Date().toISOString(), serverId);
}

export function setSafetySnapshot(serverId: string, snapshotId: string): void {
  db.prepare('UPDATE snapshot_jobs SET safetySnapshotId = ? WHERE serverId = ?').run(snapshotId, serverId);
}

export function requestSnapshotCancellation(serverId: string): void {
  db.prepare("UPDATE snapshot_jobs SET cancelRequested = 1 WHERE serverId = ? AND status = 'running' AND operation = 'create'").run(serverId);
}

export function finishSnapshotJob(serverId: string, snapshotId: string | null, error: string | null, cancelled = false): void {
  db.prepare(`UPDATE snapshot_jobs SET status = ?, finishedAt = ?, snapshotId = ?, error = ? WHERE serverId = ?`)
    .run(error ? 'failed' : cancelled ? 'cancelled' : 'completed', new Date().toISOString(), snapshotId, error, serverId);
}
