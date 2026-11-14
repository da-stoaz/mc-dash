// SPDX-License-Identifier: AGPL-3.0-only

import { serverStore } from '../serverStore';
import { logger } from '../logger';
import { dockerService } from './dockerService';
import { refreshServerStatus } from './serverStatus';
import { pushServerChange } from './serverEvents';

const TAIL_LINES = 20;
const RECONNECT_MS = 5000;

type DockerEvent = { Action: string; time?: number; Actor?: { ID?: string; Attributes?: Record<string, string> } };

/** Why a server died, in words the failure banner can show as-is. */
export function crashReason(exitCode: number | null, oomKilled: boolean, tail: string): string {
  const code = exitCode == null ? 'unknown' : exitCode > 128 ? `${exitCode}, signal ${exitCode - 128}` : String(exitCode);
  const cause = oomKilled
    ? `Killed by the kernel for running out of memory (exit ${code}): the container or shared memory pool limit was hit.`
    : `Server crashed (exit ${code}).`;
  return tail ? `${cause}\n\nLast log lines:\n${tail}` : cause;
}

// Docker sends `oom` just before the matching `die`; remember it per container.
const oomContainers = new Set<string>();

export async function handleContainerEvent(event: DockerEvent) {
  const attrs = event.Actor?.Attributes ?? {};
  const server = attrs['io.mc-dash.server-id'] ? serverStore.get(attrs['io.mc-dash.server-id']) : null;
  if (!server || !event.Actor?.ID) return;

  if (event.Action === 'oom') {
    oomContainers.add(event.Actor.ID);
    logger.warn({ serverId: server.id }, 'Minecraft container hit its memory limit (OOM)');
    return;
  }
  if (event.Action === 'die') {
    const oom = oomContainers.delete(event.Actor.ID);
    // Reuses the poller's rules: lifecycle locks, clean exits and managed
    // shutdowns all come back as something other than 'exited'.
    const current = await refreshServerStatus(server);
    if (current.status === 'exited') {
      const tail = await dockerService.logTail(current, TAIL_LINES).catch(() => '');
      const exitCode = Number.isFinite(Number(attrs.exitCode)) ? Number(attrs.exitCode) : current.exitCode ?? null;
      serverStore.update(server.id, { lastError: crashReason(exitCode, oom, tail) });
    }
  }
  pushServerChange(server.id);
}

export function startContainerEvents() {
  let since: number | undefined;
  const reconnect = () => setTimeout(connect, RECONNECT_MS).unref();
  function connect() {
    dockerService.containerEvents(since).then((stream) => {
      let buffer = '';
      stream.on('data', (chunk: Buffer) => {
        const lines = (buffer + chunk.toString('utf8')).split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as DockerEvent;
            if (event.time) since = event.time + 1; // resume after this event if the stream drops
            handleContainerEvent(event).catch((err) => logger.warn({ err }, 'container event handling failed'));
          } catch (err) { logger.warn({ err }, 'unparseable Docker event'); }
        }
      });
      stream.on('error', (err) => logger.warn({ err }, 'Docker event stream error'));
      stream.once('close', reconnect);
    }, (err) => { logger.warn({ err }, 'Docker event stream unavailable'); reconnect(); });
  }
  connect();
}
