import { existsSync } from 'fs';
import { db } from '../db';
import { logger } from '../logger';
import { serverStore } from '../serverStore';
import { lifecycleBusy, preparing } from '../state';
import { ServerRecord, SnapshotRecord } from '../types';
import { dockerService } from './dockerService';
import { getSnapshotJob } from './snapshotJobStore';
import { createSnapshot, deleteSnapshot, fingerprintServerFiles, snapshotFilePath } from './snapshotService';

/** Scheduled snapshots kept per server. Manual and pre-restore snapshots are not counted. */
export const SCHEDULED_KEEP = 2;
export const MAX_INTERVAL_DAYS = 7;

const DAY_MS = 24 * 60 * 60_000;
const TICK_MS = 5 * 60_000;
// Don't back up the moment a server stops: it may be a stop-then-start, and the
// backup would hold the start for its whole duration.
const IDLE_SETTLE_MS = 10 * 60_000;
// A server that never stops is backed up while running once it has been due
// this long (the snapshot pauses autosave and flushes the world first).
const RUNNING_GRACE_MS = 12 * 60 * 60_000;
// After a failure (e.g. the backup drive is not mounted), wait before retrying.
const RETRY_MS = 60 * 60_000;

db.exec(`CREATE TABLE IF NOT EXISTS backup_schedules (
  serverId TEXT PRIMARY KEY,
  intervalDays INTEGER NOT NULL,
  enabledAt TEXT NOT NULL
)`);

type ScheduleRow = { serverId: string; intervalDays: number; enabledAt: string };

export type BackupSchedule = {
  /** Days between scheduled backups, or null when automatic backups are off. */
  intervalDays: number | null;
  lastBackupAt: string | null;
  /** When the next backup becomes due; it then waits for the server to be stopped. */
  nextDueAt: string | null;
  keep: number;
};

function scheduledSnapshots(serverId: string): SnapshotRecord[] {
  return serverStore.listSnapshots(serverId).filter(snapshot => snapshot.kind === 'scheduled');
}

function scheduleRow(serverId: string): ScheduleRow | undefined {
  return db.prepare('SELECT * FROM backup_schedules WHERE serverId = ?').get(serverId) as ScheduleRow | undefined;
}

function dueAt(row: ScheduleRow, lastBackupAt: string | null): number {
  return lastBackupAt ? Date.parse(lastBackupAt) + row.intervalDays * DAY_MS : Date.parse(row.enabledAt);
}

export function getBackupSchedule(serverId: string): BackupSchedule {
  const row = scheduleRow(serverId);
  const lastBackupAt = scheduledSnapshots(serverId)[0]?.createdAt ?? null;
  return {
    intervalDays: row?.intervalDays ?? null,
    lastBackupAt,
    nextDueAt: row ? new Date(dueAt(row, lastBackupAt)).toISOString() : null,
    keep: SCHEDULED_KEEP,
  };
}

export function setBackupSchedule(serverId: string, intervalDays: number | null): BackupSchedule {
  if (intervalDays === null) {
    db.prepare('DELETE FROM backup_schedules WHERE serverId = ?').run(serverId);
  } else {
    db.prepare(`INSERT INTO backup_schedules (serverId, intervalDays, enabledAt) VALUES (?, ?, ?)
      ON CONFLICT(serverId) DO UPDATE SET intervalDays = excluded.intervalDays`)
      .run(serverId, intervalDays, new Date().toISOString());
  }
  return getBackupSchedule(serverId);
}

export function forgetBackupSchedule(serverId: string): void {
  db.prepare('DELETE FROM backup_schedules WHERE serverId = ?').run(serverId);
  idleSince.delete(serverId);
  failedAt.delete(serverId);
}

const idleSince = new Map<string, number>();
const failedAt = new Map<string, number>();

async function isStopped(server: ServerRecord): Promise<boolean> {
  if (server.status !== 'stopped' && server.status !== 'exited') return false;
  if (!server.containerId) return true;
  return !(await dockerService.runState(server)).running;
}

/**
 * Take a scheduled snapshot, or, when the server is stopped and no file has
 * changed since the newest scheduled snapshot, mark that one as current again.
 * Then drop scheduled snapshots beyond SCHEDULED_KEEP, oldest first.
 */
export async function runScheduledBackup(server: ServerRecord, stopped: boolean): Promise<'created' | 'unchanged'> {
  const latest = scheduledSnapshots(server.id)[0];
  // A running server keeps unsaved changes in memory, so its files say nothing.
  const fingerprint = stopped ? await fingerprintServerFiles(server.id).catch(() => null) : null;
  if (fingerprint && latest?.fingerprint === fingerprint && existsSync(snapshotFilePath(server.id, latest.fileName))) {
    serverStore.touchSnapshot(latest.id);
    logger.info({ serverId: server.id, snapshotId: latest.id }, 'Scheduled backup: no files changed, kept the existing archive');
    return 'unchanged';
  }
  await createSnapshot(server, { label: 'Scheduled backup', kind: 'scheduled', fingerprint });
  for (const old of scheduledSnapshots(server.id).slice(SCHEDULED_KEEP)) {
    await deleteSnapshot(server, old.id);
  }
  return 'created';
}

let ticking = false;

/**
 * Back up every server whose schedule is due, one at a time. A due server is
 * backed up once it has been stopped (or asleep) for a few minutes; one that
 * keeps running is backed up live after RUNNING_GRACE_MS.
 */
export async function runDueBackups(now = Date.now()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const rows = db.prepare('SELECT * FROM backup_schedules').all() as ScheduleRow[];
    for (const row of rows) {
      const server = serverStore.get(row.serverId);
      if (!server) { forgetBackupSchedule(row.serverId); continue; }
      const id = server.id;
      if (!server.packReady || preparing.has(id) || lifecycleBusy.has(id) || getSnapshotJob(id)?.status === 'running') continue;

      let stopped: boolean;
      try { stopped = await isStopped(server); }
      catch (err) { logger.warn({ err, serverId: id }, 'Scheduled backup: could not read the server state'); continue; }
      if (!stopped) idleSince.delete(id);
      else if (!idleSince.has(id)) idleSince.set(id, now);

      const due = dueAt(row, scheduledSnapshots(id)[0]?.createdAt ?? null);
      if (now < due || now < (failedAt.get(id) ?? 0) + RETRY_MS) continue;
      const settled = stopped && now - idleSince.get(id)! >= IDLE_SETTLE_MS;
      const overdueWhileRunning = server.status === 'running' && now >= due + RUNNING_GRACE_MS;
      if (!settled && !overdueWhileRunning) continue;

      // Re-check: the state may have changed while other servers were backed up.
      if (lifecycleBusy.has(id) || getSnapshotJob(id)?.status === 'running') continue;
      lifecycleBusy.add(id);
      try {
        const result = await runScheduledBackup(server, settled);
        failedAt.delete(id);
        logger.info({ serverId: id, result, live: !settled }, 'Scheduled backup finished');
      } catch (err) {
        failedAt.set(id, Date.now());
        logger.error({ err, serverId: id }, 'Scheduled backup failed; retrying in an hour');
      } finally {
        lifecycleBusy.delete(id);
      }
    }
  } finally {
    ticking = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export const backupScheduler = {
  start(): void {
    if (timer) return;
    const tick = () => void runDueBackups().catch(err => logger.error({ err }, 'Scheduled backup check failed'));
    timer = setInterval(tick, TICK_MS);
    timer.unref();
    setTimeout(tick, 60_000).unref();
  },
};
