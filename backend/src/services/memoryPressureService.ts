import { config } from '../config';
import { logger } from '../logger';
import { serverStore } from '../serverStore';
import { preparing } from '../state';
import { getPlayerCount } from './playerService';
import { runServerRcon } from './rconService';
import { dockerService } from './dockerService';
import { hibernationService } from './hibernationService';
import { metricsCollector } from './metricsCollector';
import { readMemoryPool, MemoryPoolReport, setMemoryPoolAction } from './memoryPool';
import type { ServerRecord } from '../types';

const WARNING_MS = 60_000;
const RETRY_MS = 60_000;

type Dependencies = {
  pool: () => Promise<MemoryPoolReport>;
  servers: () => ServerRecord[];
  players: (server: ServerRecord) => Promise<number | null>;
  usage: (id: string) => number;
  sleep: (server: ServerRecord, options: { allowOccupied: boolean; beforeStop: () => Promise<boolean> }) => Promise<boolean | void>;
  warn: (server: ServerRecord, message: string) => Promise<boolean>;
  now: () => number;
  refresh?: () => Promise<void>;
};

type Pending = { server: ServerRecord; deadline: number; reminded: boolean };

/** The kernel cap is the emergency boundary. This controller sheds load earlier,
 * preferring empty servers and warning players before any occupied-server sleep. */
export class MemoryPressureService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private emptySince = new Map<string, number>();
  private retryAfter = new Map<string, number>();
  private pending: Pending | null = null;
  private lastSleep = -Infinity;
  constructor(private deps: Dependencies) {}

  start() {
    if (!config.memoryPoolEnabled || this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(error => logger.warn({ error }, 'RAM pressure check failed')), 10_000);
    this.timer.unref();
  }

  private current(server: ServerRecord) {
    return this.deps.servers().find(item => item.id === server.id && item.containerId === server.containerId
      && item.status === 'running' && !preparing.has(item.id));
  }

  private async cancel(message: string) {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    const current = this.current(pending.server);
    if (current) await this.deps.warn(current, message).catch(() => false);
    setMemoryPoolAction(message);
  }

  private async sleep(server: ServerRecord, allowOccupied: boolean) {
    this.pending = null;
    this.retryAfter.set(server.id, this.deps.now() + RETRY_MS);
    setMemoryPoolAction(`Saving and sleeping ${server.name} to release RAM.`);
    const result = await this.deps.sleep(server, { allowOccupied, beforeStop: async () => {
      const latest = await this.deps.pool();
      return latest.enforced && latest.pressure;
    } }).catch(error => {
      logger.warn({ error, serverId: server.id }, 'RAM pressure sleep failed');
      return false;
    });
    this.emptySince.delete(server.id);
    const slept = result === true || (result !== false && this.deps.servers().find(s => s.id === server.id)?.hibernated);
    if (slept) {
      this.lastSleep = this.deps.now();
      setMemoryPoolAction(`${server.name} was put to sleep to release RAM. It can wake when there is enough room.`);
    } else {
      setMemoryPoolAction(`Could not safely sleep ${server.name}. No forced stop was sent. Check its console.`);
      await this.deps.warn(server, 'Automatic shutdown could not finish safely. Please check MC Dash; RAM is still high.').catch(() => false);
    }
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const pool = await this.deps.pool();
      if (!pool.enforced || !pool.pressure) {
        this.emptySince.clear();
        await this.cancel(pool.enforced
          ? 'RAM recovered. The automatic shutdown is cancelled.'
          : 'RAM protection cannot be verified. The automatic shutdown is cancelled; check MC Dash.');
        return;
      }
      const now = this.deps.now();
      await this.deps.refresh?.();
      const refreshed = await this.deps.pool();
      if (!refreshed.enforced || !refreshed.pressure) {
        await this.cancel("RAM recovered or protection is unverified. The automatic shutdown is cancelled.");
        return;
      }
      if (this.pending) {
        const pending = this.pending;
        const fresh = this.current(pending.server);
        if (!fresh) { await this.cancel('Server changed. The automatic shutdown is cancelled.'); return; }
        const seconds = Math.max(0, Math.ceil((pending.deadline - now) / 1000));
        setMemoryPoolAction(`${fresh.name} will save and sleep in ${seconds}s to release RAM.`);
        if (seconds === 0) { await this.sleep(fresh, true); return; }
        if (seconds <= 30 && !pending.reminded) {
          pending.reminded = true;
          await this.deps.warn(fresh, `RAM is still high. This server will save and sleep in ${seconds} seconds.`).catch(() => false);
        }
        return;
      }
      const servers = this.deps.servers().filter(s => this.current(s));
      const ids = new Set(servers.map(s => s.id));
      for (const id of this.emptySince.keys()) if (!ids.has(id)) this.emptySince.delete(id);
      for (const id of this.retryAfter.keys()) if (!ids.has(id)) this.retryAfter.delete(id);
      // RCON timeouts on one server must not delay asking every other server.
      const readings = await Promise.all(servers.map(async server => ({ server,
        count: await this.deps.players(server).catch(() => null),
      })));
      for (const { server, count } of readings) {
        if (count !== 0) this.emptySince.delete(server.id);
        else if (!this.emptySince.has(server.id)) this.emptySince.set(server.id, now);
      }
      if (now - this.lastSleep < 60_000) return;
      const eligible = readings.filter(({server}) => now >= (this.retryAfter.get(server.id) ?? 0));
      const empty = eligible.filter(({server, count}) => count === 0 && now - this.emptySince.get(server.id)! >= 60_000)
        .sort((a, b) => this.deps.usage(b.server.id) - this.deps.usage(a.server.id));
      for (const { server } of empty) {
        const fresh = this.current(server);
        if (!fresh) continue;
        if (await this.deps.players(fresh).catch(() => null) !== 0) { this.emptySince.delete(server.id); continue; }
        const latest = await this.deps.pool();
        if (!latest.enforced || !latest.pressure) return;
        await this.sleep(fresh, false);
        return;
      }
      // 85% blocks starts and sleeps empty servers; 90% initiates player warnings.
      // Once warned, cancel only below 85% to avoid flapping around 90%.
      const latest = await this.deps.pool();
      if (!latest.enforced || latest.usedMb === null || latest.usedMb < latest.limitMb * 0.90) return;
      eligible.sort((a, b) => (a.count ?? Infinity) - (b.count ?? Infinity)
        || this.deps.usage(b.server.id) - this.deps.usage(a.server.id));
      for (const { server } of eligible) {
        const fresh = this.current(server);
        if (!fresh) continue;
        const warned = await this.deps.warn(fresh,
          'Shared RAM is nearly full. This server will save and sleep in 60 seconds unless RAM recovers. Reconnect when capacity is available.').catch(() => false);
        if (!warned) { this.retryAfter.set(server.id, this.deps.now() + RETRY_MS); continue; }
        this.pending = { server: fresh, deadline: this.deps.now() + WARNING_MS, reminded: false };
        setMemoryPoolAction(`${fresh.name} will save and sleep in 60s to release RAM. Players have been warned.`);
        return;
      }
      setMemoryPoolAction('RAM is critical. No server could be warned safely; check the server consoles.');
    } finally { this.busy = false; }
  }
}

export const memoryPressureService = new MemoryPressureService({
  pool: readMemoryPool,
  servers: () => serverStore.list(),
  players: async server => (await getPlayerCount(server))?.online ?? null,
  usage: id => metricsCollector.liveFor(id)?.memoryBytes ?? 0,
  sleep: (server, options) => hibernationService.hibernate(server, options),
  warn: async (server, message) => {
    const output = await runServerRcon(server, [`say [MC Dash] ${message}`]);
    return output !== null && output.some(line => line.includes(message));
  },
  now: Date.now,
  refresh: refreshPressureServers,
});

/** Pressure handling must work with every browser closed. Do not rely on SSE's
 * status refresh to discover that a starting JVM is now ready. */
export async function refreshPressureServers() {
  await Promise.all(serverStore.list().map(async server => {
    if (preparing.has(server.id)) return;
    const status = await dockerService.status(server);
    const current = serverStore.get(server.id);
    if (current && current.status === server.status && current.containerId === server.containerId
      && !preparing.has(server.id) && current.status !== status) {
      serverStore.update(server.id, { status });
    }
  }));
}
