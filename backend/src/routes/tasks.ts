// SPDX-License-Identifier: AGPL-3.0-only

import { Router } from 'express';
import { serverStore } from '../serverStore';
import { plannedBackups } from '../services/backupScheduler';
import { listRunningSnapshotJobs, snapshotTaskKind } from '../services/snapshotJobStore';
import { dismissAllTasks, dismissTask, listTaskHistory } from '../services/taskHistory';

const router = Router();

/** Running, finished (until dismissed) and planned background tasks, for the dashboard's task list. */
router.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const names = new Map(serverStore.list().map(server => [server.id, server.name]));
  const serverName = (id: string) => names.get(id) ?? null;
  res.json({
    running: listRunningSnapshotJobs().map(job => ({
      id: `${job.serverId}:${job.startedAt}`,
      kind: snapshotTaskKind(job),
      serverId: job.serverId,
      serverName: serverName(job.serverId),
      startedAt: job.startedAt,
      phase: job.phase,
      bytesProcessed: job.bytesProcessed,
      totalBytes: job.totalBytes,
      cancelRequested: job.cancelRequested,
    })),
    history: listTaskHistory().map(task => ({ ...task, serverName: serverName(task.serverId) })),
    planned: plannedBackups().map(plan => ({ ...plan, kind: 'scheduled-backup', serverName: serverName(plan.serverId) })),
  });
});

router.delete('/history/:id', (req, res) => {
  if (!dismissTask(String(req.params.id))) return res.status(404).json({ error: 'Task not found' });
  res.json({ ok: true });
});

router.delete('/history', (_req, res) => {
  res.json({ dismissed: dismissAllTasks() });
});

export default router;
