import { config } from '../config';
import { logger } from '../logger';
import { serverStore } from '../serverStore';
import { preparing, lifecycleBusy } from '../state';
import { getPlayerCount } from './playerService';
import { runServerRcon } from './rconService';
import { refreshServerStatus } from './serverStatus';
import { hibernationService } from './hibernationService';
import { metricsCollector } from './metricsCollector';
import { readVerifiedMemoryPool, MemoryPoolReport, setMemoryPoolAction } from './memoryPool';
import { MemoryForecast } from './memoryForecast';
import { recordPressureSleep, shutdownHorizonMs } from './memoryRecovery';
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
  risks?: (pool:MemoryPoolReport) => Promise<{global:boolean; critical:boolean; targets:Set<string>; reason:string}>;
  recordSleep?: (id:string, demandMb:number, durationMs:number) => void;
};

type Pending = { server: ServerRecord; deadline: number; reminded: boolean };

/** The kernel cap is the emergency boundary. This controller sheds load earlier,
 * preferring empty servers and warning players before any occupied-server sleep. */
export class MemoryPressureService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private intervention: Promise<void> | null = null;
  private emptySince = new Map<string, number>();
  private retryAfter = new Map<string, number>();
  private pending: Pending | null = null;
  private lastSleep = -Infinity;
  private globalRisk = true;
  private targets = new Set<string>();
  private critical = false;
  private reason = "Shared RAM is nearly full";
  constructor(private deps: Dependencies) {}

  start() {
    if (!config.memoryPoolEnabled || this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(error => logger.warn({ error }, 'RAM pressure check failed')), 10_000);
    this.timer.unref();
  }

  private current(server: ServerRecord) {
    return this.deps.servers().find(item => item.id === server.id && item.containerId === server.containerId
      && item.status === 'running' && !preparing.has(item.id) && !lifecycleBusy.has(item.id));
  }

  private async cancel(message: string) {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    const current = this.current(pending.server);
    if (current) await this.deps.warn(current, message).catch(() => false);
    setMemoryPoolAction(message);
  }

  private async assess(): Promise<MemoryPoolReport> {
    const pool=await this.deps.pool();
    if (!this.deps.risks || !pool.enforced) return pool;
    const risk=await this.deps.risks(pool);
    this.globalRisk=pool.pressure || risk.global;
    this.targets=risk.targets;
    this.critical=risk.critical;
    this.reason=risk.reason;
    return {...pool, pressure:this.globalRisk || this.targets.size>0};
  }

  private relevant(id:string) { return this.globalRisk || this.targets.has(id); }

  private async sleep(server: ServerRecord, allowOccupied: boolean) {
    const began=this.deps.now();
    const demandMb=this.deps.usage(server.id)/1024**2;
    this.pending = null;
    setMemoryPoolAction(`Saving and sleeping ${server.name} to release RAM.`);
    const result = await this.deps.sleep(server, { allowOccupied, beforeStop: async () => {
      const latest = await this.assess();
      const proceed=config.memoryPoolEnabled && config.hibernationEnabled && latest.enforced && latest.pressure && this.relevant(server.id);
      if(proceed) this.deps.recordSleep?.(server.id,demandMb,0);
      return proceed;
    } }).catch(error => {
      logger.warn({ error, serverId: server.id }, 'RAM pressure sleep failed');
      return false;
    });
    this.retryAfter.set(server.id, this.deps.now() + RETRY_MS);
    this.emptySince.delete(server.id);
    const slept = result === true || (result !== false && this.deps.servers().find(s => s.id === server.id)?.hibernated);
    if (slept) {
      this.lastSleep = this.deps.now();
      this.deps.recordSleep?.(server.id,demandMb,this.deps.now()-began);
      setMemoryPoolAction(`${server.name} was put to sleep to release RAM. It can wake when there is enough room.`);
    } else {
      setMemoryPoolAction(`Could not safely sleep ${server.name}. No forced stop was sent. Check its console.`);
      await this.deps.warn(server, 'Automatic shutdown could not finish safely. Please check MC Dash; RAM is still high.').catch(() => false);
    }
  }

  private beginSleep(server: ServerRecord, occupied: boolean) {
    this.intervention = this.sleep(server, occupied).catch(error => {
      logger.warn({error, serverId:server.id}, 'RAM intervention failed');
    }).finally(() => { this.intervention = null; });
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      // Readiness/status refresh must continue when automatic sleep is off.
      // Otherwise an unwatched ready server stays "starting" in the store and
      // its ordinary play-time growth is learned as boot demand indefinitely.
      await this.deps.refresh?.();
      if (!config.memoryPoolEnabled || !config.hibernationEnabled) {
        this.emptySince.clear();
        await this.cancel('Automatic sleep is disabled. The automatic shutdown is cancelled.');
        return;
      }
      const pool = await this.assess();
      if (!pool.enforced || !pool.pressure) {
        this.emptySince.clear();
        await this.cancel(pool.enforced
          ? 'RAM recovered. The automatic shutdown is cancelled.'
          : 'RAM protection cannot be verified. The automatic shutdown is cancelled; check MC Dash.');
        return;
      }
      const now = this.deps.now();
      const refreshed = await this.assess();
      if (!refreshed.enforced || !refreshed.pressure) {
        await this.cancel("RAM recovered or protection is unverified. The automatic shutdown is cancelled.");
        return;
      }
      if (this.intervention) return;
      if (this.pending) {
        const pending = this.pending;
        const fresh = this.current(pending.server);
        if (!fresh || !this.relevant(fresh.id)) { await this.cancel('Server changed. The automatic shutdown is cancelled.'); return; }
        const seconds = Math.max(0, Math.ceil((pending.deadline - now) / 1000));
        setMemoryPoolAction(`${fresh.name} will save and sleep in ${seconds}s to release RAM.`);
        if (seconds === 0) { this.beginSleep(fresh, true); return; }
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
      if (now - this.lastSleep < 60_000 && !this.critical) return;
      const eligible = readings.filter(({server}) => this.relevant(server.id) && now >= (this.retryAfter.get(server.id) ?? 0));
      const empty = eligible.filter(({server, count}) => count === 0 && now - this.emptySince.get(server.id)! >= 60_000)
        .sort((a, b) => this.deps.usage(b.server.id) - this.deps.usage(a.server.id));
      for (const { server } of empty) {
        const fresh = this.current(server);
        if (!fresh) continue;
        if (await this.deps.players(fresh).catch(() => null) !== 0) { this.emptySince.delete(server.id); continue; }
        const latest = await this.assess();
        if (!latest.enforced || !latest.pressure || !this.relevant(fresh.id)) return;
        this.beginSleep(fresh, false);
        return;
      }
      // Start admission reserves headroom separately. Shutdown requires actual
      // exhaustion risk or sustained growth toward the hard boundary.
      const latest = await this.assess();
      if (!latest.enforced || latest.usedMb === null || ((latest.workingSetMb ?? latest.usedMb) < latest.limitMb * 0.97 && !this.critical)) return;
      eligible.sort((a, b) => (a.count ?? Infinity) - (b.count ?? Infinity)
        || this.deps.usage(b.server.id) - this.deps.usage(a.server.id));
      for (const { server } of eligible) {
        const fresh = this.current(server);
        if (!fresh) continue;
        const warned = await this.deps.warn(fresh,
          `${this.reason}. This server will save and sleep in 60 seconds unless RAM recovers. Reconnect when capacity is available.`).catch(() => false);
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
  pool: readVerifiedMemoryPool,
  risks: assessRuntimeRisks,
  recordSleep: (id,demand,duration)=>recordPressureSleep(id,demand,Date.now(),duration),
  servers: () => serverStore.list(),
  players: async server => (await getPlayerCount(server))?.online ?? null,
  usage: id => { const live = metricsCollector.liveFor(id); return live?.memoryWorkingSetBytes ?? live?.memoryBytes ?? 0; },
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
  await hibernationService.reconcile();
  await Promise.all(serverStore.list().map(refreshServerStatus));
}


const forecast=new MemoryForecast();
export async function assessRuntimeRisks(pool:MemoryPoolReport) {
  const now=Date.now(), horizon=shutdownHorizonMs(), targets=new Set<string>();
  const keys=new Set(['pool','host']);
  const workingSet = pool.workingSetMb ?? pool.usedMb;
  const predicted=workingSet!==null && forecast.approaching('pool',workingSet,pool.limitMb * 0.97,now,horizon);
  let global=predicted, critical=predicted || (workingSet!==null && workingSet>=pool.limitMb*0.97), reason='Shared RAM is nearly full';
  if(predicted) reason='Shared RAM is growing too quickly';
  const {readHostMemory}=await import('./hostCapacityService');
  const host=await readHostMemory();
  if(host.availableKnown) {
    const floor=config.hostFreeFloorMb;
    const hostRisk=host.availableMb<floor || forecast.approaching('host',host.totalMb-host.availableMb,host.totalMb-floor,now,horizon);
    if(hostRisk) {global=true;critical=true;reason='The host is running low on RAM';}
  }
  for(const server of serverStore.list()) {
    const live=metricsCollector.liveFor(server.id);
    if(!live || server.status!=='running' || live.memoryLimitBytes<=0) continue;
    const key=`server:${server.id}:${server.containerId}`;keys.add(key);
    const used = live.memoryWorkingSetBytes ?? live.memoryBytes;
    const prediction=forecast.approaching(key,used,live.memoryLimitBytes * 0.97,live.at,horizon);
    if(used>=live.memoryLimitBytes*0.97 || prediction) targets.add(server.id);
    if(used>=live.memoryLimitBytes*0.97 || prediction) critical=true;
  }
  forecast.retain(keys);
  if(!global && !pool.pressure && targets.size) reason='This server is approaching its RAM limit';
  return {global,critical,targets,reason};
}
