import { config } from '../config';
import { logger } from '../logger';
import { serverStore } from '../serverStore';
import { preparing, lifecycleBusy } from '../state';
import { ServerRecord } from '../types';
import { dockerService } from './dockerService';
import { getPlayerCount } from './playerService';
import { gracefulSleep } from './gracefulSleep';
import { db } from '../db';
import { SleepListener } from './sleepGateway';
import { refreshServerStatus } from './serverStatus';

// ---------------------------------------------------------------------------
// Hibernation
//
// Elastic heap makes an idle server smaller. Hibernation makes it free.
//
// Stopping releases process memory and CPU. File cache can remain charged to
// the pool until Linux reclaims it; the dashboard reports that separately.
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
const LISTENER_ERROR = 'Wake listener unavailable. Start this server from MC Dash; the listener will retry shortly.';

// Statuses where asking about players makes sense at all.
const RUNNABLE = new Set(['running']);

type Tracker = {
  /** When this server was first seen with zero players, or null while occupied. */
  emptySince: number | null;
  /** Last player count we managed to read; null means "couldn't ask". */
  lastCount: number | null;
};

db.exec('CREATE TABLE IF NOT EXISTS sleep_intents (serverId TEXT PRIMARY KEY, containerId TEXT NOT NULL)');

export class HibernationService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly trackers = new Map<string, Tracker>();
  private readonly listeners = new Map<string, SleepListener>();
  /** Ids currently being slept or woken, so a slow Docker call can't double-fire. */
  private readonly busy = lifecycleBusy;

  start() {
    if (this.timer) return;
    // Existing sleeping servers still need wake listeners, even when automatic
    // sleep has since been disabled. Retry failed binds on every poll.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    if (!config.hibernationEnabled) {
      logger.info('Automatic sleep disabled (MC_DASH_HIBERNATE=false); existing sleepers can still wake');
      return;
    }
    logger.info(
      `Hibernation enabled: servers sleep after ${Math.round(config.hibernationIdleMs / 60000)} min with no players`
    );
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
      await this.reconcile();
      // Readiness must advance even with the shared manager disabled and no
      // dashboard open, so normal play-time RAM is not learned as boot demand.
      const servers = await Promise.all(serverStore.list().map(refreshServerStatus));
      if (!config.hibernationEnabled) {
        this.trackers.clear();
        return;
      }
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
   * Save and stop, then take over the port so a join can bring it back.
   * Occupied servers require a completed warning from the pressure controller.
   */
  async hibernate(server: ServerRecord, opts: { allowOccupied?: boolean; beforeStop?: () => Promise<boolean> } = {}): Promise<boolean> {
    if (!config.hibernationEnabled || this.busy.has(server.id)) return false;
    this.busy.add(server.id);
    try {
      const fresh = serverStore.get(server.id);
      if (!fresh || fresh.status !== 'running' || fresh.containerId !== server.containerId || preparing.has(server.id)) return false;
      if (!opts.allowOccupied && (await getPlayerCount(fresh).catch(() => null))?.online !== 0) return false;
      logger.info({ serverId: server.id, name: server.name }, 'Saving server for automatic sleep');
      await gracefulSleep(fresh, async () => {
        if (!config.hibernationEnabled) return false;
        if (!opts.allowOccupied && (await getPlayerCount(fresh).catch(() => null))?.online !== 0) return false;
        const current = serverStore.get(server.id);
        if (!current || current.status !== 'running' || current.containerId !== fresh.containerId || preparing.has(server.id)) return false;
        if (opts.beforeStop && !await opts.beforeStop()) return false;
        db.prepare('INSERT OR REPLACE INTO sleep_intents VALUES (?, ?)').run(server.id, fresh.containerId);
        serverStore.update(server.id, { status: 'stopping', lastError: null });
        return true;
      });
      const updated = serverStore.update(server.id, { status: 'stopped', hibernated: true, lastError: null }) ?? server;
      this.trackers.delete(server.id);
      await this.armListener(updated);
      db.prepare('DELETE FROM sleep_intents WHERE serverId = ?').run(server.id);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Automatic sleep failed.';
      logger.error({ err, serverId: server.id }, 'Automatic sleep failed; no forced stop sent');
      // Preserve observed state. A slow shutdown may still finish after our wait.
      const current = serverStore.get(server.id);
      if (current?.containerId === server.containerId) serverStore.update(server.id, { lastError: message });
      return false;
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
      onWake: () => this.wake(server.id, 'player'),
    });

    try {
      await listener.listen();
      this.listeners.set(server.id, listener);
      if (serverStore.get(server.id)?.lastError === LISTENER_ERROR) serverStore.update(server.id, { lastError: null });
      logger.info({ serverId: server.id, port: server.serverPort }, 'Sleep listener armed');
    } catch (err) {
      if (!serverStore.get(server.id)?.lastError) serverStore.update(server.id, { lastError: LISTENER_ERROR });
      logger.warn(
        { err, serverId: server.id, port: server.serverPort },
        'Could not bind the sleep listener; will retry on the next poll'
      );
    }
  }

  /**
   * Hand the port back. Must complete before the container starts, or Docker
   * fails to bind with "port is already allocated".
   */
  async reconcile() {
    const intents = db.prepare('SELECT serverId, containerId FROM sleep_intents').all() as {serverId:string;containerId:string}[];
    for (const intent of intents) {
      if (lifecycleBusy.has(intent.serverId)) continue;
      const server = serverStore.get(intent.serverId);
      if (!server || server.containerId !== intent.containerId) {
        db.prepare('DELETE FROM sleep_intents WHERE serverId = ?').run(intent.serverId);
        continue;
      }
      lifecycleBusy.add(server.id);
      try {
        const state = await dockerService.statusDetails(server);
        if (!['stopped', 'exited'].includes(state.status)) continue;
        if (await dockerService.waitForExit(server, 100, {requireClean:true})) await this.restoreSleep(server.id);
        db.prepare('DELETE FROM sleep_intents WHERE serverId = ?').run(server.id);
      } finally { lifecycleBusy.delete(server.id); }
    }
    for (const [id] of this.listeners) {
      if (this.busy.has(id)) continue;
      const server = serverStore.get(id);
      // An inspection error is not evidence that the sleeping JVM restarted.
      // Keep its working listener available through transient Docker outages.
      if (!server?.hibernated || !config.hibernationWakeOnConnect) {
        this.busy.add(id);
        try { await this.releasePort(id); }
        finally { this.busy.delete(id); }
      }
    }
    for (const server of serverStore.list()) {
      if (this.busy.has(server.id) || !server.hibernated || server.status !== 'stopped') continue;
      this.busy.add(server.id);
      try { await this.armListener(server); }
      finally { this.busy.delete(server.id); }
    }
  }

  async restoreSleep(serverId: string) {
    const sleeping = serverStore.update(serverId, {status:'stopped', hibernated:true});
    if (sleeping) await this.armListener(sleeping);
  }

  async releasePort(serverId: string): Promise<void> {
    db.prepare('DELETE FROM sleep_intents WHERE serverId = ?').run(serverId);
    const listener = this.listeners.get(serverId);
    if (!listener) return;
    this.listeners.delete(serverId);
    await listener.close();
  }

  /** Clear the flag and drop the listener, without starting anything. */
  async clear(serverId: string): Promise<void> {
    db.prepare('DELETE FROM sleep_intents WHERE serverId = ?').run(serverId);
    await this.releasePort(serverId);
    const server = serverStore.get(serverId);
    if (server?.hibernated) serverStore.update(serverId, { hibernated: false });
  }

  /**
   * Wake a sleeping server. Safe to call from a socket handler: it never throws
   * and resolves to the start result for the player's disconnect message.
   */
  async wake(serverId: string, trigger: 'player' | 'manual'): Promise<string> {
    if (trigger === 'player' && !config.hibernationWakeOnConnect) return 'Automatic wake is disabled. Start this server from MC Dash.';
    if (this.busy.has(serverId)) return 'A server operation is already in progress. Please reconnect shortly.';
    const server = serverStore.get(serverId);
    if (!server || !server.hibernated) return 'This server is no longer asleep. Please reconnect.';

    this.busy.add(serverId);
    try {
      logger.info({ serverId, trigger }, 'Waking hibernated server');
      await this.releasePort(serverId);
      // Clear restartRequired for the same reason the manual start route does:
      // the process coming up reads the current files, so whatever was pending
      // is applied by this start. Without it, a server that slept with a config
      // change pending would wake up still claiming it needed a restart.
      serverStore.update(serverId, { status: 'starting', hibernated: false });
      const containerId = await dockerService.start(server);
      serverStore.update(serverId, { status: 'starting', containerId, restartRequired: false, lastError: null });
      return config.hibernationWakeMessage;
    } catch (err) {
      logger.error({ err, serverId }, 'Wake failed');
      const message = err instanceof Error ? err.message : 'The server could not be started.';
      const reason = (err as { reason?: string })?.reason;
      const sleeping = serverStore.update(serverId, { status: 'stopped', hibernated: true, lastError: reason ? `${message}. ${reason}` : message });
      if (sleeping) await this.armListener(sleeping);
      return `Could not wake this server: ${message}${reason ? `\n${reason}` : ''}`;
    } finally {
      this.busy.delete(serverId);
    }
  }
}

export const hibernationService = new HibernationService();
