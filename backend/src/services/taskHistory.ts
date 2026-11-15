// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'crypto';
import { db } from '../db';

// Finished background tasks for the dashboard's task list. Entries stay until
// the user dismisses them; only the oldest beyond MAX_ENTRIES are dropped.
const MAX_ENTRIES = 200;

db.exec(`CREATE TABLE IF NOT EXISTS task_history (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  serverId TEXT NOT NULL,
  status TEXT NOT NULL,
  startedAt TEXT NOT NULL,
  finishedAt TEXT NOT NULL,
  bytes INTEGER,
  detail TEXT,
  error TEXT
)`);

export type TaskKind = 'snapshot' | 'scheduled-backup' | 'restore';
export type TaskStatus = 'completed' | 'failed' | 'cancelled';

export type TaskRecord = {
  id: string;
  kind: TaskKind;
  serverId: string;
  status: TaskStatus;
  startedAt: string;
  finishedAt: string;
  /** Archive size for a finished snapshot. */
  bytes: number | null;
  detail: string | null;
  error: string | null;
};

export function recordTask(task: Omit<TaskRecord, 'id' | 'finishedAt' | 'bytes' | 'detail' | 'error'> &
  Partial<Pick<TaskRecord, 'finishedAt' | 'bytes' | 'detail' | 'error'>>): void {
  db.prepare(`INSERT INTO task_history (id, kind, serverId, status, startedAt, finishedAt, bytes, detail, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), task.kind, task.serverId, task.status, task.startedAt,
    task.finishedAt ?? new Date().toISOString(), task.bytes ?? null, task.detail ?? null, task.error ?? null);
  db.prepare(`DELETE FROM task_history WHERE id NOT IN (SELECT id FROM task_history ORDER BY finishedAt DESC, rowid DESC LIMIT ?)`)
    .run(MAX_ENTRIES);
}

export function listTaskHistory(): TaskRecord[] {
  return db.prepare('SELECT * FROM task_history ORDER BY finishedAt DESC, rowid DESC').all() as TaskRecord[];
}

export function dismissTask(id: string): boolean {
  return db.prepare('DELETE FROM task_history WHERE id = ?').run(id).changes > 0;
}

export function dismissAllTasks(): number {
  return db.prepare('DELETE FROM task_history').run().changes;
}
