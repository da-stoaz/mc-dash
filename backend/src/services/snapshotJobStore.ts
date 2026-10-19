import { db } from '../db';

export type SnapshotJob = {
  serverId: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  snapshotId: string | null;
  error: string | null;
};

db.exec(`CREATE TABLE IF NOT EXISTS snapshot_jobs (
  serverId TEXT PRIMARY KEY, status TEXT NOT NULL, startedAt TEXT NOT NULL,
  finishedAt TEXT, snapshotId TEXT, error TEXT
)`);
// This backend owns the archive workers. A new process cannot resume an old
// tar stream; retain an explicit failure rather than an eternal spinner.
db.prepare(`UPDATE snapshot_jobs SET status = 'failed', finishedAt = ?,
  error = 'Snapshot interrupted by a backend restart. Please create a new snapshot.'
  WHERE status = 'running'`).run(new Date().toISOString());

export function getSnapshotJob(serverId: string): SnapshotJob | null {
  return db.prepare('SELECT * FROM snapshot_jobs WHERE serverId = ?').get(serverId) as SnapshotJob ?? null;
}

export function beginSnapshotJob(serverId: string): void {
  if (getSnapshotJob(serverId)?.status === 'running') throw new Error('A snapshot is already being created for this server.');
  db.prepare(`INSERT OR REPLACE INTO snapshot_jobs
    (serverId, status, startedAt, finishedAt, snapshotId, error)
    VALUES (?, 'running', ?, NULL, NULL, NULL)`).run(serverId, new Date().toISOString());
}

export function finishSnapshotJob(serverId: string, snapshotId: string | null, error: string | null): void {
  db.prepare(`UPDATE snapshot_jobs SET status = ?, finishedAt = ?, snapshotId = ?, error = ? WHERE serverId = ?`)
    .run(error ? 'failed' : 'completed', new Date().toISOString(), snapshotId, error, serverId);
}
