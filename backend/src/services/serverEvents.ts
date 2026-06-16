import type { Response } from 'express';
import { dockerService } from './dockerService';
import { serverStore } from '../serverStore';
import { preparing } from '../state';
import { logger } from '../logger';

// How often the shared loops poll Docker. One loop serves every connected
// client, so Docker load is O(servers) regardless of how many tabs are open.
const STATUS_INTERVAL_MS = 2000;
const METRICS_INTERVAL_MS = 2000;
const HEARTBEAT_MS = 25000;

function initSse(res: Response) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Disable proxy buffering (nginx etc.) so events flush immediately.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
}

function send(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ---------------------------------------------------------------------------
// Status stream: broadcasts the full server list with refreshed statuses.
// ---------------------------------------------------------------------------
const statusClients = new Set<Response>();
let statusTimer: NodeJS.Timeout | null = null;
let statusRunning = false;

async function refreshStatuses() {
  // Guard against overlapping ticks when Docker is slow.
  if (statusRunning) return;
  statusRunning = true;
  try {
    const servers = serverStore.list();
    const refreshed = await Promise.all(
      servers.map(async (server) => {
        if (preparing.has(server.id)) return server;
        try {
          const status = await dockerService.status(server);
          if (status === server.status) return server;
          return serverStore.update(server.id, { status }) ?? server;
        } catch {
          return server;
        }
      })
    );
    for (const res of statusClients) send(res, 'servers', refreshed);
  } catch (err) {
    logger.warn({ err }, 'status stream tick failed');
  } finally {
    statusRunning = false;
  }
}

export function addStatusClient(res: Response) {
  initSse(res);
  // Paint immediately from the store, then let the shared loop push updates.
  send(res, 'servers', serverStore.list());
  statusClients.add(res);
  if (!statusTimer) statusTimer = setInterval(refreshStatuses, STATUS_INTERVAL_MS);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  res.on('close', () => {
    clearInterval(heartbeat);
    statusClients.delete(res);
    if (statusClients.size === 0 && statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
  });
}

// ---------------------------------------------------------------------------
// Detail stream: per-server room broadcasting the record + live metrics.
// ---------------------------------------------------------------------------
type DetailRoom = { clients: Set<Response>; timer: NodeJS.Timeout | null; running: boolean };
const detailRooms = new Map<string, DetailRoom>();

async function refreshDetail(id: string) {
  const room = detailRooms.get(id);
  if (!room || room.running) return;
  room.running = true;
  try {
    const server = serverStore.get(id);
    if (!server) {
      for (const res of room.clients) send(res, 'server', null);
      return;
    }

    let current = server;
    if (!preparing.has(id)) {
      try {
        const status = await dockerService.status(server);
        if (status !== server.status) current = serverStore.update(id, { status }) ?? server;
      } catch {
        // keep last known status
      }
    }
    for (const res of room.clients) send(res, 'server', current);

    let metrics: Awaited<ReturnType<typeof dockerService.metrics>> | null = null;
    try {
      metrics = await dockerService.metrics(current);
    } catch {
      metrics = null;
    }
    for (const res of room.clients) send(res, 'metrics', metrics);
  } catch (err) {
    logger.warn({ err, id }, 'detail stream tick failed');
  } finally {
    room.running = false;
  }
}

export function addDetailClient(id: string, res: Response) {
  initSse(res);
  let room = detailRooms.get(id);
  if (!room) {
    room = { clients: new Set(), timer: null, running: false };
    detailRooms.set(id, room);
  }
  // Immediate snapshot from the store.
  const existing = serverStore.get(id);
  send(res, 'server', existing);
  room.clients.add(res);
  if (!room.timer) room.timer = setInterval(() => refreshDetail(id), METRICS_INTERVAL_MS);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  res.on('close', () => {
    clearInterval(heartbeat);
    const current = detailRooms.get(id);
    if (!current) return;
    current.clients.delete(res);
    if (current.clients.size === 0) {
      if (current.timer) clearInterval(current.timer);
      detailRooms.delete(id);
    }
  });
}
