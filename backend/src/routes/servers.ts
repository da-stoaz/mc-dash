import { Router } from 'express';
import multer from 'multer';
import net from 'net';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import { dockerService } from '../services/dockerService';
import { serverStore } from '../serverStore';
import { ServerRecord, ServerStatus } from '../types';
import { logger } from '../logger';
import { applyConfigFiles, prepareServer, recreateContainer } from '../services/prepareService';
import { config } from '../config';
import { toApiError } from '../apiErrors';
import { preparing } from '../state';
import { addStatusClient, addDetailClient } from '../services/serverEvents';

const resourceSchema = z.object({
  minRamMb: z.number().int().positive(),
  maxRamMb: z.number().int().positive(),
  cpuLimit: z.number().positive().optional(),
});

const gameSchema = z.object({
  renderDistance: z.number().int().min(2).max(32).optional(),
  gameMode: z.enum(['survival', 'creative', 'adventure', 'spectator']).optional(),
  seed: z.string().optional(),
});

const emptyToUndefined = (value: unknown) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
};

const parseNumber = (value: unknown) => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    return Number(value);
  }
  return undefined;
};

const parseList = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const items = value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return items.length ? items : [];
};

const portSchema = z.preprocess(parseNumber, z.number().int().min(1024).max(65535));
const subdomainRegex = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const subdomainSchema = z.preprocess(
  emptyToUndefined,
  z.string().max(63).regex(subdomainRegex, 'Invalid subdomain').optional()
);

const createServerSchema = z.object({
  name: z.string().min(1),
  subdomain: subdomainSchema,
  javaImage: z.preprocess(emptyToUndefined, z.string().optional()),
  serverPort: portSchema.optional(),
  minRamMb: z.preprocess(parseNumber, z.number().int().positive()),
  maxRamMb: z.preprocess(parseNumber, z.number().int().positive()),
  cpuLimit: z.preprocess(parseNumber, z.number().positive()).optional(),
  renderDistance: z.preprocess(parseNumber, z.number().int().min(2).max(32)).optional(),
  gameMode: z.preprocess(emptyToUndefined, z.enum(['survival', 'creative', 'adventure', 'spectator']).optional()),
  seed: z.preprocess(emptyToUndefined, z.string().optional()),
  whitelist: z.preprocess(parseList, z.array(z.string()).optional()),
  blacklist: z.preprocess(parseList, z.array(z.string()).optional()),
  ipBlacklist: z.preprocess(parseList, z.array(z.string()).optional()),
  whitelistEnabled: z.preprocess(parseNumber, z.number().int().min(0).max(1)).optional(),
  blacklistEnabled: z.preprocess(parseNumber, z.number().int().min(0).max(1)).optional(),
  ipBlacklistEnabled: z.preprocess(parseNumber, z.number().int().min(0).max(1)).optional(),
});

const updateServerSchema = z.object({
  resources: resourceSchema.optional(),
  game: gameSchema.optional(),
  status: z.enum(['creating', 'stopped', 'running', 'starting', 'stopping', 'restarting', 'exited', 'error']).optional(),
  javaImage: z.string().optional().nullable(),
  serverPort: portSchema.optional(),
  subdomain: subdomainSchema,
  whitelist: z.array(z.string()).optional(),
  blacklist: z.array(z.string()).optional(),
  ipBlacklist: z.array(z.string()).optional(),
  whitelistEnabled: z.boolean().optional(),
  blacklistEnabled: z.boolean().optional(),
  ipBlacklistEnabled: z.boolean().optional(),
});

const router = Router();
const uploadDir = path.join(config.dataRoot, 'uploads');
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

function normalizeSubdomain(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length ? trimmed : undefined;
}

function slugifyName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, 63);
}

function makeUniqueSubdomain(base: string, reserved: Set<string>): string {
  const fallbackBase = base || 'server';
  let candidate = fallbackBase;
  let suffix = 2;
  while (reserved.has(candidate)) {
    const suffixStr = `-${suffix}`;
    const trimmedBase = fallbackBase.slice(0, Math.max(1, 63 - suffixStr.length));
    candidate = `${trimmedBase}${suffixStr}`;
    suffix += 1;
  }
  reserved.add(candidate);
  return candidate;
}

function collectReservedSubdomains(excludeId?: string): Set<string> {
  const servers = serverStore.list();
  const reserved = new Set<string>();
  servers.forEach((server) => {
    if (excludeId && server.id === excludeId) return;
    if (server.subdomain) reserved.add(server.subdomain.toLowerCase());
  });
  return reserved;
}

function resolveServerSubdomain(requested: string | undefined, name: string, excludeId?: string): string {
  const reserved = collectReservedSubdomains(excludeId);
  const normalized = normalizeSubdomain(requested);
  if (normalized) {
    if (reserved.has(normalized)) {
      throw new Error(`Subdomain "${normalized}" is already assigned to another server.`);
    }
    reserved.add(normalized);
    return normalized;
  }
  const base = slugifyName(name);
  return makeUniqueSubdomain(base, reserved);
}

function collectReservedPorts(excludeId?: string): Set<number> {
  const servers = serverStore.list();
  const ports = servers
    .filter((server) => server.id !== excludeId)
    .map((server) => server.serverPort ?? config.serverPort);
  if (config.routerEnabled) {
    ports.push(config.routerPort);
  }
  return new Set(ports);
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    const cleanup = (available: boolean) => {
      tester.removeAllListeners();
      resolve(available);
    };
    tester.once('error', () => cleanup(false));
    tester.once('listening', () => {
      tester.close(() => cleanup(true));
    });
    tester.listen(port, '0.0.0.0');
  });
}

async function resolveServerPort(requested?: number, excludeId?: string): Promise<number> {
  const reserved = collectReservedPorts(excludeId);
  if (requested !== undefined) {
    if (config.routerEnabled && requested === config.routerPort) {
      throw new Error(`Port ${requested} is reserved for the router.`);
    }
    if (reserved.has(requested)) {
      throw new Error(`Port ${requested} is already assigned to another server.`);
    }
    if (!(await isPortAvailable(requested))) {
      throw new Error(`Port ${requested} is already in use on the host.`);
    }
    return requested;
  }

  const minPort = Math.max(1024, Math.min(65535, config.serverPortMin));
  const maxPort = Math.max(1024, Math.min(65535, config.serverPortMax));
  if (minPort > maxPort) {
    throw new Error(`Invalid port range ${minPort}-${maxPort}.`);
  }

  for (let port = minPort; port <= maxPort; port += 1) {
    if (config.routerEnabled && port === config.routerPort) continue;
    if (reserved.has(port)) continue;
    if (await isPortAvailable(port)) return port;
  }

  throw new Error(`No available ports in range ${minPort}-${maxPort}.`);
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

// SSE: live server list. Registered before '/:id' so it isn't captured as an id.
router.get('/stream', (req, res) => {
  addStatusClient(res);
});

router.get('/:id', (req, res) => {
  const server = serverStore.get(req.params.id);
  if (!server) return notFound(res);
  res.json(server);
});

// SSE: live record + metrics for a single server.
router.get('/:id/stream', (req, res) => {
  addDetailClient(req.params.id, res);
});

router.post('/', upload.single('file'), async (req, res, next) => {
  let createdId: string | null = null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Server pack zip required (field "file")' });
    }

    const parsed = createServerSchema.parse(req.body);
    let serverPort: number;
    try {
      serverPort = await resolveServerPort(parsed.serverPort);
    } catch (err: any) {
      return res.status(409).json({ error: 'Port unavailable', reason: err?.message ?? 'Port unavailable' });
    }
    let subdomain: string;
    try {
      subdomain = resolveServerSubdomain(parsed.subdomain, parsed.name);
    } catch (err: any) {
      return res.status(409).json({ error: 'Subdomain unavailable', reason: err?.message ?? 'Subdomain unavailable' });
    }
    const server = serverStore.create({
      name: parsed.name,
      subdomain,
      javaImage: parsed.javaImage,
      serverPort,
      whitelist: parsed.whitelist,
      blacklist: parsed.blacklist,
      ipBlacklist: parsed.ipBlacklist,
      whitelistEnabled: parsed.whitelistEnabled === undefined ? undefined : parsed.whitelistEnabled === 1,
      blacklistEnabled: parsed.blacklistEnabled === undefined ? undefined : parsed.blacklistEnabled === 1,
      ipBlacklistEnabled: parsed.ipBlacklistEnabled === undefined ? undefined : parsed.ipBlacklistEnabled === 1,
      resources: {
        minRamMb: parsed.minRamMb,
        maxRamMb: parsed.maxRamMb,
        cpuLimit: parsed.cpuLimit,
      },
      game: {
        renderDistance: parsed.renderDistance,
        gameMode: parsed.gameMode,
        seed: parsed.seed,
      },
    });
    createdId = server.id;

    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const target = path.join(uploadDir, `${server.id}-${Date.now()}-${safeName}`);
    await fs.promises.rename(req.file.path, target);

    const updated =
      serverStore.update(server.id, { serverPackUrl: target, effectiveJavaImage: null, effectiveJavaSource: null, packRecommendedJava: null, packRecommendedJavaMajor: null, status: 'stopped' }) ??
      server;
    res.status(201).json(updated);
  } catch (err) {
    if (createdId) {
      serverStore.delete(createdId);
    }
    if (req.file) {
      fs.promises.rm(req.file.path, { force: true }).catch(() => {});
    }
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const parsed = updateServerSchema.parse(req.body);
    const existing = serverStore.get(req.params.id);
    if (!existing) return notFound(res);

    const existingJavaImage = existing.javaImage ?? null;
    const javaImageChanged = parsed.javaImage !== undefined && parsed.javaImage !== existingJavaImage;
    if (javaImageChanged && ['running', 'starting', 'restarting'].includes(existing.status)) {
      return res.status(409).json({ error: 'Stop the server before changing its Java image.' });
    }

    let portChanged = false;
    let resolvedPort: number | undefined;
    if (parsed.serverPort !== undefined && parsed.serverPort !== existing.serverPort) {
      if (['running', 'starting', 'restarting'].includes(existing.status)) {
        return res.status(409).json({ error: 'Stop the server before changing its port.' });
      }
      try {
        resolvedPort = await resolveServerPort(parsed.serverPort, existing.id);
      } catch (err: any) {
        return res.status(409).json({ error: 'Port unavailable', details: err?.message ?? 'Port unavailable' });
      }
      portChanged = true;
    }

    let resolvedSubdomain: string | undefined;
    if (parsed.subdomain !== undefined) {
      const normalized = normalizeSubdomain(parsed.subdomain);
      if (!normalized) {
        return res.status(400).json({ error: 'Invalid subdomain' });
      }
      if (normalized !== existing.subdomain) {
        try {
          resolvedSubdomain = resolveServerSubdomain(normalized, existing.name, existing.id);
        } catch (err: any) {
          return res.status(409).json({ error: 'Subdomain unavailable', details: err?.message ?? 'Subdomain unavailable' });
        }
      } else {
        resolvedSubdomain = normalized;
      }
    }

    const updatePayload = {
      ...parsed,
      serverPort: resolvedPort ?? parsed.serverPort,
      ...(parsed.subdomain !== undefined ? { subdomain: resolvedSubdomain } : {}),
      ...(javaImageChanged ? { effectiveJavaImage: null, effectiveJavaSource: null } : {}),
    };

    let updated = serverStore.update(req.params.id, updatePayload);
    if (!updated) return notFound(res);

    const hasConfigChanges =
      !!parsed.resources ||
      !!parsed.game ||
      parsed.javaImage !== undefined ||
      parsed.serverPort !== undefined ||
      parsed.whitelist !== undefined ||
      parsed.blacklist !== undefined ||
      parsed.ipBlacklist !== undefined ||
      parsed.whitelistEnabled !== undefined ||
      parsed.blacklistEnabled !== undefined ||
      parsed.ipBlacklistEnabled !== undefined;
    const hasResourceChanges = !!parsed.resources;

    let configError: Error | null = null;
    let resourceError: Error | null = null;
    let recreateError: Error | null = null;

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

    if ((portChanged || javaImageChanged) && updated.containerId) {
      try {
        const { containerId, image, javaSource, packRecommendedJava, packRecommendedJavaMajor } = await recreateContainer(updated);
        updated =
          serverStore.update(req.params.id, {
            containerId,
            effectiveJavaImage: image,
            effectiveJavaSource: javaSource,
            packRecommendedJava: packRecommendedJava ?? null,
            packRecommendedJavaMajor: packRecommendedJavaMajor ?? null,
            status: 'stopped',
            restartRequired: false,
          }) ??
          updated;
      } catch (err: any) {
        recreateError = err;
      }
    }

    if (hasConfigChanges && !(portChanged || javaImageChanged)) {
      updated = serverStore.update(req.params.id, { restartRequired: true }) ?? updated;
    }

    if (configError || resourceError || recreateError) {
      return res.status(409).json({
        error: 'Update saved but not fully applied',
        details: {
          config: configError?.message,
          resources: resourceError?.message,
          recreate: recreateError?.message,
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
    const apiErr = toApiError(err, { error: 'Failed to start container', status: 500 });
    res.status(apiErr.status).json(apiErr.body);
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
    const apiErr = toApiError(err, { error: 'Failed to stop container', status: 500 });
    res.status(apiErr.status).json(apiErr.body);
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
    const apiErr = toApiError(err, { error: 'Failed to restart container', status: 500 });
    res.status(apiErr.status).json(apiErr.body);
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
    const apiErr = toApiError(err, { error: 'Failed to stream logs', status: 500 });
    res.status(apiErr.status).json(apiErr.body);
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
    const apiErr = toApiError(err, { error: 'Failed to read metrics', status: statusCode });
    res.status(apiErr.status).json(apiErr.body);
  }
});

router.post('/:id/prepare', async (req, res) => {
  const server = serverStore.get(req.params.id);
  if (!server) return notFound(res);
  if (server.status === 'running' || server.status === 'starting' || server.status === 'restarting') {
    return res.status(409).json({ error: 'Stop the server before preparing a new container' });
  }
  if (!server.serverPackUrl) {
    return res.status(400).json({ error: 'Server entry is missing an uploaded server pack' });
  }

  try {
    preparing.add(server.id);
    serverStore.update(server.id, { status: 'creating' });
    const { containerId, image, javaSource, packRecommendedJava, packRecommendedJavaMajor } = await prepareServer(server);
    const updated = serverStore.update(server.id, {
      status: 'stopped',
      containerId,
      effectiveJavaImage: image,
      effectiveJavaSource: javaSource,
      packRecommendedJava: packRecommendedJava ?? null,
      packRecommendedJavaMajor: packRecommendedJavaMajor ?? null,
      restartRequired: false,
    });
    res.json(updated);
  } catch (err: any) {
    logger.error({ err }, 'Prepare failed');
    serverStore.update(server.id, { status: 'error' });
    const apiErr = toApiError(err, { error: 'Failed to prepare server pack', status: 500 });
    res.status(apiErr.status).json(apiErr.body);
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
    const apiErr = toApiError(err, { error: 'Failed to delete container', status: 500 });
    res.status(apiErr.status).json(apiErr.body);
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

export default router;
