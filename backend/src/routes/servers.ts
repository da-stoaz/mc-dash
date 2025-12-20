import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import { dockerService } from '../services/dockerService';
import { serverStore } from '../serverStore';
import { ServerRecord, ServerStatus } from '../types';
import { logger } from '../logger';
import { applyConfigFiles, prepareServer } from '../services/prepareService';
import { config } from '../config';

const createServerSchema = z.object({
  name: z.string().min(1),
  packId: z.number().int().optional(),
  packFileId: z.number().int().optional(),
  packVersion: z.string().optional(),
  serverPackUrl: z.string().optional(),
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
  status: z.enum(['creating', 'stopped', 'running', 'starting', 'stopping', 'restarting', 'exited', 'error']).optional(),
  serverPackUrl: z.string().optional(),
});

const router = Router();
const uploadDir = path.join(config.dataRoot, 'uploads');
const preparing = new Set<string>();
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const upload = multer({ dest: uploadDir });

function notFound(res: any) {
  return res.status(404).json({ error: 'Server not found' });
}

function safeStatus(server: ServerRecord): ServerStatus {
  return server.status;
}

router.get('/', async (_req, res) => {
  const servers = serverStore.list();
  const refreshed = await Promise.all(
    servers.map(async (server) => {
      if (preparing.has(server.id)) return server;
      const status = await dockerService.status(server);
      if (status === server.status) return server;
      return serverStore.update(server.id, { status }) ?? server;
    })
  );
  res.json(refreshed);
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

router.patch('/:id', async (req, res, next) => {
  try {
    const parsed = updateServerSchema.parse(req.body);
    let updated = serverStore.update(req.params.id, parsed);
    if (!updated) return notFound(res);

    const hasConfigChanges = !!parsed.resources || !!parsed.game;
    const hasResourceChanges = !!parsed.resources;

    let configError: Error | null = null;
    let resourceError: Error | null = null;

    if (hasConfigChanges) {
      try {
        await applyConfigFiles(updated);
      } catch (err: any) {
        configError = err;
      }
    }

    if (hasResourceChanges) {
      try {
        await dockerService.updateResources(updated);
      } catch (err: any) {
        resourceError = err;
      }
    }

    if (hasConfigChanges) {
      updated = serverStore.update(req.params.id, { restartRequired: true }) ?? updated;
    }

    if (configError || resourceError) {
      return res.status(409).json({
        error: 'Update saved but not fully applied',
        details: {
          config: configError?.message,
          resources: resourceError?.message,
        },
        server: updated,
      });
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/status', async (req, res) => {
  const server = serverStore.get(req.params.id);
  if (!server) return notFound(res);
  if (preparing.has(server.id)) {
    return res.json({ status: 'creating' });
  }
  const status = await dockerService.status(server);
  const updated = serverStore.update(server.id, { status });
  res.json({ status: safeStatus(updated ?? server) });
});

router.post('/:id/start', async (req, res) => {
  const server = serverStore.get(req.params.id);
  if (!server) return notFound(res);
  try {
    serverStore.update(server.id, { status: 'starting' });
    const containerId = await dockerService.start(server);
    const updated = serverStore.update(server.id, { status: 'starting', containerId, restartRequired: false });
    res.json(updated);
  } catch (err: any) {
    logger.error({ err }, 'Start failed');
    serverStore.update(server.id, { status: 'error' });
    res.status(501).json({ error: 'Container start not wired to a built server pack yet', details: err?.message });
  }
});

router.post('/:id/stop', async (req, res) => {
  const server = serverStore.get(req.params.id);
  if (!server) return notFound(res);
  try {
    serverStore.update(server.id, { status: 'stopping' });
    await dockerService.stop(server);
    const updated = serverStore.update(server.id, { status: 'stopped' });
    res.json(updated);
  } catch (err: any) {
    logger.error({ err }, 'Stop failed');
    serverStore.update(server.id, { status: 'error' });
    res.status(500).json({ error: 'Failed to stop container', details: err?.message });
  }
});

router.post('/:id/restart', async (req, res) => {
  const server = serverStore.get(req.params.id);
  if (!server) return notFound(res);
  try {
    serverStore.update(server.id, { status: 'restarting' });
    await dockerService.restart(server);
    const updated = serverStore.update(server.id, { status: 'restarting', restartRequired: false });
    res.json(updated);
  } catch (err: any) {
    logger.error({ err }, 'Restart failed');
    serverStore.update(server.id, { status: 'error' });
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

router.get('/:id/metrics', async (req, res) => {
  const server = serverStore.get(req.params.id);
  if (!server) return notFound(res);
  try {
    const metrics = await dockerService.metrics(server);
    res.json(metrics);
  } catch (err: any) {
    logger.error({ err }, 'Metrics failed');
    const statusCode = err?.statusCode === 404 ? 404 : 500;
    res.status(statusCode).json({ error: 'Failed to read metrics', details: err?.message });
  }
});

router.post('/:id/prepare', async (req, res) => {
  const server = serverStore.get(req.params.id);
  if (!server) return notFound(res);
  if (server.status === 'running' || server.status === 'starting' || server.status === 'restarting') {
    return res.status(409).json({ error: 'Stop the server before preparing a new container' });
  }
  if (!server.packId && !server.serverPackUrl) {
    return res.status(400).json({ error: 'Server entry is missing CurseForge pack info (packId or serverPackUrl)' });
  }

  try {
    preparing.add(server.id);
    serverStore.update(server.id, { status: 'creating' });
    const { containerId } = await prepareServer(server);
    const updated = serverStore.update(server.id, { status: 'stopped', containerId, restartRequired: false });
    res.json(updated);
  } catch (err: any) {
    logger.error({ err }, 'Prepare failed');
    serverStore.update(server.id, { status: 'error' });
    res.status(500).json({ error: 'Failed to prepare server pack', details: err?.message });
  } finally {
    preparing.delete(server.id);
  }
});

router.delete('/:id/container', async (req, res) => {
  const server = serverStore.get(req.params.id);
  if (!server) return notFound(res);
  try {
    await dockerService.remove(server);
    const updated = serverStore.update(server.id, { containerId: null, status: 'stopped' });
    res.json(updated);
  } catch (err: any) {
    logger.error({ err }, 'Remove container failed');
    res.status(500).json({ error: 'Failed to delete container', details: err?.message });
  }
});

router.delete('/:id', async (req, res) => {
  const server = serverStore.get(req.params.id);
  if (!server) return notFound(res);
  try {
    if (server.containerId) {
      await dockerService.remove(server);
    }
  } catch (err: any) {
    logger.warn({ err }, 'Failed to remove container during server delete');
  }

  const removed = serverStore.delete(server.id);
  if (!removed) return notFound(res);
  res.json({ ok: true });
});

router.post('/:id/upload-pack', upload.single('file'), (req, res) => {
  const server = serverStore.get(req.params.id);
  if (!server) return notFound(res);
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Use field name "file".' });
  }

  const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
  const target = path.join(uploadDir, `${server.id}-${Date.now()}-${safeName}`);
  fs.rename(req.file.path, target, (err) => {
    if (err) {
      logger.error({ err }, 'Failed to store upload');
      return res.status(500).json({ error: 'Failed to store uploaded file' });
    }
    const updated = serverStore.update(server.id, { serverPackUrl: target, status: 'stopped' });
    res.json(updated);
  });
});

export default router;
