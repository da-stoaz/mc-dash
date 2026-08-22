import { config } from '../config';
import { logger } from '../logger';
import { serverStore } from '../serverStore';
import { preparing } from '../state';
import { ServerRecord } from '../types';
import { dockerService } from './dockerService';
import { getPlayerCount } from './playerService';
import { runServerRcon } from './rconService';
import { SleepListener } from './sleepGateway';

// ---------------------------------------------------------------------------
// Hibernation
//
// Elastic heap makes an idle server smaller. Hibernation makes it free.
//
// A stopped server returns 100% of its memory, its CPU and its container
// overhead, which is a different order of saving from persuading a JVM to
// uncommit some regions — and on a host where the real pattern is "four servers
// exist, one is being played on", it is the only thing that actually fixes the
// arithmetic.
//
// The cost is a cold start, so the whole design is about making that cost
// visible and small rather than pretending it isn't there:
//
//   - Sleep only on evidence. A server sleeps after a continuous stretch with
//     zero players, counted from RCON, never from CPU or traffic. Guessing
//     idleness from metrics would eventually stop a server with someone
//     standing in it, and one such incident costs more trust than hibernation
//     saves in memory.
//   - Unknown is not idle. If RCON can't be reached the count is null, and null
//     resets the timer instead of counting as zero. A server we cannot ask is
//     never one we put to sleep.
//   - Waking is somebody's job. A sleeping server keeps answering on its port
//     (see sleepGateway), so a player who pings sees "sleeping" and a player who
//     joins triggers the start. Hibernation without that is just an outage.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 30_000;

// Statuses where asking about players makes sense at all.
const RUNNABLE = new Set(['running']);

type Tracker = {
  /** When this server was first seen with zero players, or null while occupied. */
  emptySince: number | null;
  /** Last player count we managed to read; null means "couldn't ask". */
  lastCount: number | null;
};

export class HibernationService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly trackers = new Map<string, Tracker>();
  private readonly listeners = new Map<string, SleepListener>();
  /** Ids currently being slept or woken, so a slow Docker call can't double-fire. */
  private readonly busy = new Set<string>();

  start() {
    if (!config.hibernationEnabled) {
      logger.info('Hibernation disabled (MC_DASH_HIBERNATE=false)');
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    logger.info(
      `Hibernation enabled: servers sleep after ${Math.round(config.hibernationIdleMs / 60000)} min with no players`
    );

    // A restart of MC Dash leaves any already-hibernated server with nothing
    // listening on its port. Re-arm those listeners before anyone tries to join.
    void this.restoreListeners();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async restoreListeners() {
    for (const server of serverStore.list()) {
      if (server.hibernated) await this.armListener(server);
    }
  }

  /** Player count for the UI and for the idle timer, without a second RCON round trip. */
  playersFor(serverId: string): number | null {
    return this.trackers.get(serverId)?.lastCount ?? null;
  }

  /** Milliseconds this server has been empty, or null if occupied/unknown. */
  idleMsFor(serverId: string): number | null {
    const emptySince = this.trackers.get(serverId)?.emptySince;
    return emptySince ? Date.now() - emptySince : null;
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const servers = serverStore.list();
      const liveIds = new Set(servers.map((server) => server.id));
      for (const id of this.trackers.keys()) if (!liveIds.has(id)) this.trackers.delete(id);

      for (const server of servers) {
        if (preparing.has(server.id) || this.busy.has(server.id)) continue;
        if (!RUNNABLE.has(server.status)) {
          // Not running: no idle clock to keep.
          this.trackers.delete(server.id);
          continue;
        }
        await this.evaluate(server);
      }
    } catch (err) {
      logger.warn({ err }, 'Hibernation tick failed');
    } finally {
      this.running = false;
    }
  }

  private async evaluate(server: ServerRecord) {
    const players = await getPlayerCount(server).catch(() => null);
    const tracker = this.trackers.get(server.id) ?? { emptySince: null, lastCount: null };
    tracker.lastCount = players?.online ?? null;

    if (players === null) {
      // RCON unreachable — the server may be mid-boot, or have RCON off. Either
      // way we don't know it's empty, so the clock restarts rather than runs.
      tracker.emptySince = null;
      this.trackers.set(server.id, tracker);
      return;
    }

    if (players.online > 0) {
      tracker.emptySince = null;
      this.trackers.set(server.id, tracker);
      return;
    }

    if (tracker.emptySince === null) tracker.emptySince = Date.now();
    this.trackers.set(server.id, tracker);

    if (Date.now() - tracker.emptySince >= config.hibernationIdleMs) {
      await this.hibernate(server);
    }
  }

  /**
   * Put a server to sleep: warn anyone listening, save and stop, then take over
   * its port so a join can bring it back.
   */
  async hibernate(server: ServerRecord) {
    if (this.busy.has(server.id)) return;
    this.busy.add(server.id);
    try {
      logger.info({ serverId: server.id, name: server.name }, 'Hibernating idle server');
      serverStore.update(server.id, { status: 'stopping' });

      // Same graceful path the stop route uses: an RCON `stop` lets the JVM
      // shutdown hook flush every dimension before the process dies. A
      // hibernation that corrupted a world would be indefensible.
      const rconReachable = (await dockerService.rconAddress(server)) !== null;
      let exitedCleanly = false;
      if (rconReachable) {
        await runServerRcon(server, ['save-all']);
        await runServerRcon(server, ['stop']);
        exitedCleanly = await dockerService.waitForExit(server, 20_000);
      }
      if (!exitedCleanly) {
        await dockerService.stop(server, { timeoutSec: rconReachable ? 5 : 30 });
      }

      const updated = serverStore.update(server.id, { status: 'stopped', hibernated: true }) ?? server;
      this.trackers.delete(server.id);
      await this.armListener(updated);
    } catch (err) {
      logger.error({ err, serverId: server.id }, 'Hibernation failed');
      serverStore.update(server.id, { status: 'error' });
    } finally {
      this.busy.delete(server.id);
    }
  }

  /**
   * Bind the sleep listener for a hibernated server.
   *
   * Best-effort on purpose: if the port can't be taken the server is still
   * asleep and still startable from the dashboard — it just won't wake itself.
   * That is worth a warning, not a failed hibernation.
   */
  private async armListener(server: ServerRecord) {
    if (!config.hibernationWakeOnConnect) return;
    if (this.listeners.has(server.id)) return;

    const listener = new SleepListener(server.serverPort, {
      versionName: 'Sleeping',
      motd: config.hibernationMotd,
      wakeMessage: config.hibernationWakeMessage,
      onWake: () => void this.wake(server.id, 'player'),
    });

    try {
      await listener.listen();
      this.listeners.set(server.id, listener);
      logger.info({ serverId: server.id, port: server.serverPort }, 'Sleep listener armed');
    } catch (err) {
      logger.warn(
        { err, serverId: server.id, port: server.serverPort },
        'Could not bind the sleep listener; this server will not wake on connect'
      );
    }
  }

  /**
   * Hand the port back. Must complete before the container starts, or Docker
   * fails to bind with "port is already allocated".
   */
  async releasePort(serverId: string): Promise<void> {
    const listener = this.listeners.get(serverId);
    if (!listener) return;
    this.listeners.delete(serverId);
    await listener.close();
  }

  /** Clear the flag and drop the listener, without starting anything. */
  async clear(serverId: string): Promise<void> {
    await this.releasePort(serverId);
    const server = serverStore.get(serverId);
    if (server?.hibernated) serverStore.update(serverId, { hibernated: false });
  }

  /**
   * Wake a sleeping server. Safe to call from a socket handler: it never throws
   * and never blocks the caller on the container start.
   */
  async wake(serverId: string, trigger: 'player' | 'manual'): Promise<void> {
    if (this.busy.has(serverId)) return;
    const server = serverStore.get(serverId);
    if (!server || !server.hibernated) return;

    this.busy.add(serverId);
    try {
      logger.info({ serverId, trigger }, 'Waking hibernated server');
      await this.releasePort(serverId);
      serverStore.update(serverId, { status: 'starting', hibernated: false });
      const containerId = await dockerService.start(server);
      serverStore.update(serverId, { status: 'starting', containerId });
    } catch (err) {
      logger.error({ err, serverId }, 'Wake failed');
      serverStore.update(serverId, { status: 'error', hibernated: false });
    } finally {
      this.busy.delete(serverId);
    }
  }
}

export const hibernationService = new HibernationService();
