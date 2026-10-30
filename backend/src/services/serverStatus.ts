import { serverStore } from '../serverStore';
import { lifecycleBusy, preparing } from '../state';
import type { ServerRecord } from '../types';
import { dockerService } from './dockerService';

/** A Docker inspection can outlive a start, stop, or container replacement.
 * Only apply it while the record still describes the operation we inspected. */
export async function refreshServerStatus(server: ServerRecord): Promise<ServerRecord & { exitCode?: number | null }> {
  if (preparing.has(server.id) || lifecycleBusy.has(server.id)) return serverStore.get(server.id) ?? server;
  const observed = await dockerService.statusDetails(server);
  const current = serverStore.get(server.id);
  if (!current) return server;
  if (preparing.has(server.id) || lifecycleBusy.has(server.id)
    || current.containerId !== server.containerId || current.status !== server.status
    || current.hibernated !== server.hibernated || current.updatedAt !== server.updatedAt) return current;

  // Docker may have been started outside the panel. A running process must not
  // remain flagged asleep, or the router keeps intercepting its connections.
  const awake = current.hibernated && ['running', 'starting', 'restarting', 'stopping'].includes(observed.status);
  const updated = observed.status !== current.status || awake
    ? serverStore.update(server.id, { status: observed.status, ...(awake ? { hibernated: false } : {}) }) ?? current
    : current;
  return { ...updated, exitCode: observed.exitCode };
}
