import { randomUUID } from 'crypto';
import { db } from '../db';

// Store the original HTTP result so reconnecting clients can observe completion
// without reissuing a destructive operation. Interrupted work is never replayed.
db.exec(`CREATE TABLE IF NOT EXISTS server_operations (
  id TEXT PRIMARY KEY, serverId TEXT NOT NULL, status TEXT NOT NULL,
  startedAt TEXT NOT NULL, finishedAt TEXT, httpStatus INTEGER, body TEXT
)`);
db.prepare(`UPDATE server_operations SET status='failed', finishedAt=?, httpStatus=503, body=? WHERE status='running'`)
  .run(new Date().toISOString(), JSON.stringify({ error: 'Operation interrupted by a backend restart. Inspect the server before retrying.' }));

export function beginServerOperation(serverId: string): string {
  // Keep completed results for a week, including after a server was deleted.
  db.prepare("DELETE FROM server_operations WHERE status != 'running' AND startedAt < ?")
    .run(new Date(Date.now() - 7 * 86400000).toISOString());
  const id = randomUUID();
  db.prepare("INSERT INTO server_operations (id, serverId, status, startedAt) VALUES (?, ?, 'running', ?)")
    .run(id, serverId, new Date().toISOString());
  return id;
}

export function finishServerOperation(id: string, httpStatus: number, body: unknown): void {
  db.prepare('UPDATE server_operations SET status=?, finishedAt=?, httpStatus=?, body=? WHERE id=?')
    .run(httpStatus < 400 ? 'completed' : 'failed', new Date().toISOString(), httpStatus, JSON.stringify(body ?? null), id);
}

export function getServerOperation(serverId: string, id: string) {
  const row = db.prepare('SELECT status, startedAt, finishedAt, httpStatus, body FROM server_operations WHERE id=? AND serverId=?')
    .get(id, serverId) as { status: string; startedAt: string; finishedAt: string | null; httpStatus: number | null; body: string | null } | undefined;
  return row ? { ...row, body: row.body === null ? null : JSON.parse(row.body) } : null;
}
