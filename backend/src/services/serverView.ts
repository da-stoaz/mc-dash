import { ServerRecord } from '../types';
import { metricsCollector } from './metricsCollector';
import { hibernationService } from './hibernationService';
import { getPlayerSummary } from './playerService';
import { getGameSummary } from './gameSettingsService';

// ---------------------------------------------------------------------------
// The server record as the dashboard needs it.
//
// The stored record describes how a server is *configured*; the list view also
// has to answer "what is it doing right now", which until now lived only on the
// per-server detail page. A dashboard that can only show configured limits
// makes it impossible to tell whether any of the memory management is working —
// which is exactly the complaint that prompted this.
//
// Metrics come from the collector. Player counts are queried for the shared
// list refresh, independently of whether idle hibernation is enabled.
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
  /** Live player count, zero when stopped, null when unknown. */
  players: number | null;
  maxPlayers: number | null;
  /** Milliseconds this server has been empty, for the "sleeps in ..." hint. */
  idleMs: number | null;
};

const MB = 1024 * 1024;

export async function toServerView(server: ServerRecord): Promise<ServerView> {
  const sample = metricsCollector.liveFor(server.id);
  const [players, game] = await Promise.all([getPlayerSummary(server), getGameSummary(server)]);
  return {
    ...server,
    game,
    live: sample
      ? {
          cpuCores: sample.cpuCores,
          cpuPercent: sample.cpuPercent,
          memoryMb: Math.round(sample.memoryBytes / MB),
          memoryLimitMb: Math.round(sample.memoryLimitBytes / MB),
          memoryPercent: sample.memoryPercent,
        }
      : null,
    ...players,
    idleMs: hibernationService.idleMsFor(server.id),
  };
}

export async function toServerViews(servers: ServerRecord[]): Promise<ServerView[]> {
  return Promise.all(servers.map(toServerView));
}
