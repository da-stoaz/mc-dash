import { ServerRecord } from '../types';
import { metricsCollector } from './metricsCollector';
import { hibernationService } from './hibernationService';

// ---------------------------------------------------------------------------
// The server record as the dashboard needs it.
//
// The stored record describes how a server is *configured*; the list view also
// has to answer "what is it doing right now", which until now lived only on the
// per-server detail page. A dashboard that can only show configured limits
// makes it impossible to tell whether any of the memory management is working —
// which is exactly the complaint that prompted this.
//
// Everything here is read from caches the backend already maintains (the
// metrics collector's latest sample, the hibernation service's last player
// count), so decorating the list costs no extra Docker or RCON calls.
// ---------------------------------------------------------------------------

export type ServerLive = {
  cpuCores: number;
  cpuPercent: number;
  memoryMb: number;
  memoryLimitMb: number;
  memoryPercent: number;
};

export type ServerView = ServerRecord & {
  /** Null when the server isn't running, or its reading has gone stale. */
  live: ServerLive | null;
  /** Players online at the last RCON read; null when unknown or not running. */
  players: number | null;
  /** Milliseconds this server has been empty, for the "sleeps in ..." hint. */
  idleMs: number | null;
};

const MB = 1024 * 1024;

export function toServerView(server: ServerRecord): ServerView {
  const sample = metricsCollector.liveFor(server.id);
  return {
    ...server,
    live: sample
      ? {
          cpuCores: sample.cpuCores,
          cpuPercent: sample.cpuPercent,
          memoryMb: Math.round(sample.memoryBytes / MB),
          memoryLimitMb: Math.round(sample.memoryLimitBytes / MB),
          memoryPercent: sample.memoryPercent,
        }
      : null,
    players: hibernationService.playersFor(server.id),
    idleMs: hibernationService.idleMsFor(server.id),
  };
}

export function toServerViews(servers: ServerRecord[]): ServerView[] {
  return servers.map(toServerView);
}
