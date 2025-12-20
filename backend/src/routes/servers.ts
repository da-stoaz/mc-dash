import { Router } from 'express';
import { z } from 'zod';
import { dockerService } from '../services/dockerService';
import { serverStore } from '../serverStore';
import { ServerRecord, ServerStatus } from '../types';
import { logger } from '../logger';

const createServerSchema = z.object({
  name: z.string().min(1),
  packId: z.number().int().optional(),
  packFileId: z.number().int().optional(),
  packVersion: z.string().optional(),
  serverPackUrl: z.string().url().optional(),
  resources: z.object({
    minRamMb: z.number().int().positive(),
    maxRamMb: z.number().int().positive(),
    cpuLimit: z.number().positive().optional(),
  }),
  game: z.object({
    renderDistance: z.number().int().min(2).max(32).optional(),
    gameMode: z.enum(['survival', 'creative', 'adventure', 'spectator']).optional(),
    seed: z.string().optional(),
  }),
});

const updateServerSchema = z.object({
  resources: createServerSchema.shape.resources.optional(),
  game: createServerSchema.shape.game.optional(),
  status: z.enum(['pending', 'creating', 'stopped', 'running', 'starting', 'restarting', 'exited', 'error']).optional(),
});

const router = Router();

function notFound(res: any) {
  return res.status(404).json({ error: 'Server not found' });
}

function safeStatus(server: ServerRecord): ServerStatus {
  if (server.status === 'starting' || server.status === 'restarting' || server.status === 'creating') {
    return server.status;
  }
  return server.status;
}

router.get('/', (_req, res) => {
  res.json(serverStore.list());
});

router.get('/:id', (req, res) => {
  const server = serverStore.get(req.params.id);
  if (!server) return notFound(res);
  res.json(server);
});

router.post('/', (req, res, next) => {
  try {
    const parsed = createServerSchema.parse(req.body);
    const server = serverStore.create(parsed);
    res.status(201).json(server);
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', (req, res, next) => {
  try {
    const parsed = updateServerSchema.parse(req.body);
    const updated = serverStore.update(req.params.id, parsed);
    if (!updated) return notFound(res);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/status', async (req, res) => {
  const server = serverStore.get(req.params.id);
  if (!server) return notFound(res);
  const status = await dockerService.status(server);
  const updated = serverStore.update(server.id, { status });
  res.json({ status: safeStatus(updated ?? server) });
});

router.post('/:id/start', async (req, res) => {
  const server = serverStore.get(req.params.id);
  if (!server) return notFound(res);
  try {
    const containerId = await dockerService.start(server);
    const updated = serverStore.update(server.id, { status: 'running', containerId });
    res.json(updated);
  } catch (err: any) {
    logger.error({ err }, 'Start failed');
    res.status(501).json({ error: 'Container start not wired to a built server pack yet', details: err?.message });
  }
});

router.post('/:id/stop', async (req, res) => {
  const server = serverStore.get(req.params.id);
  if (!server) return notFound(res);
  try {
    await dockerService.stop(server);
    const updated = serverStore.update(server.id, { status: 'stopped' });
    res.json(updated);
  } catch (err: any) {
    logger.error({ err }, 'Stop failed');
    res.status(500).json({ error: 'Failed to stop container', details: err?.message });
  }
});

router.post('/:id/restart', async (req, res) => {
  const server = serverStore.get(req.params.id);
  if (!server) return notFound(res);
  try {
    await dockerService.restart(server);
    const updated = serverStore.update(server.id, { status: 'running' });
    res.json(updated);
  } catch (err: any) {
    logger.error({ err }, 'Restart failed');
    res.status(500).json({ error: 'Failed to restart container', details: err?.message });
  }
});

router.get('/:id/logs', async (req, res) => {
  const server = serverStore.get(req.params.id);
  if (!server) return notFound(res);
  try {
    const logStream = await dockerService.logs(server, { follow: req.query.follow === 'true' });
    res.setHeader('Content-Type', 'text/plain');
    logStream.pipe(res);
  } catch (err: any) {
    logger.error({ err }, 'Logs failed');
    res.status(500).json({ error: 'Failed to stream logs', details: err?.message });
  }
});

export default router;
