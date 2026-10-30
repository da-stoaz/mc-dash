import type { ServerRecord } from '../types';
import { runServerRcon } from './rconService';

export type TpsReading = { tps: number; source: 'spark' | 'forge'; window: string };
export type TpsPoint = { t: number; tps: number | null };
export type TpsHistory = {
  state: 'available' | 'stopped' | 'unavailable' | 'unsupported';
  current: TpsReading | null;
  points: TpsPoint[];
  sampledAt: number;
};

export function parseTps(raw: string, source: TpsReading['source']): TpsReading | null {
  const text = raw.replace(/\u001b\[[0-9;]*m/g, '').replace(/§[0-9a-fk-or]/gi, '');
  const match = source === 'spark'
    ? /TPS from last (5s|1m)[^:]*:\s*(?:\[spark\]\s*)?\*?(\d+(?:\.\d+)?)(?=\s|,|$)/i.exec(text)
    : /Overall\s*:\s*Mean tick time:\s*[\d.]+\s*ms\.?\s*Mean TPS:\s*(\d+(?:\.\d+)?)(?=\s|$)/i.exec(text);
  if (!match) return null;
  const tps = Number(match[source === 'spark' ? 2 : 1]);
  if (!Number.isFinite(tps) || tps < 0) return null;
  return { tps, source, window: source === 'spark' ? match[1] : 'overall mean' };
}

const INTERVAL = 5_000;
const RETENTION = 10 * 60_000;
type Entry = { value?: TpsHistory; pending?: Promise<TpsHistory>; touched: number; containerId?: string | null };

/** Shared polling cache: multiple browser tabs don't multiply RCON traffic. */
export class TpsService {
  private entries = new Map<string, Entry>();
  constructor(private run = runServerRcon, private now = Date.now) {}

  async read(server: ServerRecord): Promise<TpsHistory> {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (!entry.pending && now - entry.touched > RETENTION) this.entries.delete(id);
    }
    let entry = this.entries.get(server.id);
    if (!entry || entry.containerId !== server.containerId) {
      entry = { touched: now, containerId: server.containerId };
      this.entries.set(server.id, entry);
    }
    entry.touched = now;
    if (server.status !== 'running') {
      const value: TpsHistory = { state: 'stopped', current: null, points: [], sampledAt: now };
      // Invalidate any running read so it cannot repopulate stopped history.
      this.entries.set(server.id, { touched: now, containerId: server.containerId, value });
      return value;
    }
    if (entry.pending) return entry.pending;
    if (entry.value && entry.value.state !== 'stopped' && now - entry.value.sampledAt < INTERVAL) return entry.value;

    const target = entry;
    target.pending = this.sample(server, target.value?.points ?? []).then(value => {
      target.value = value;
      return value;
    }).finally(() => { target.pending = undefined; });
    return target.pending;
  }

  private async sample(server: ServerRecord, history: TpsPoint[]): Promise<TpsHistory> {
    let current: TpsReading | null = null;
    let state: TpsHistory['state'] = 'unavailable';
    let unsupportedCommands = 0;
    try {
      for (const source of ['spark', 'forge'] as const) {
        const output = await this.run(server, [`${source} tps`], { timeoutMs: 3000 });
        if (!output) { state = 'unavailable'; break; }
        current = parseTps(output[0] ?? '', source);
        if (current) { state = 'available'; break; }
        if (/unknown (?:or incomplete )?command|command not found/i.test(output[0] ?? '')) unsupportedCommands++;
      }
      if (unsupportedCommands === 2) state = 'unsupported';
    } catch {
      state = 'unavailable';
    }
    const sampledAt = this.now();
    const points = [...history.filter(point => sampledAt - point.t < RETENTION), { t: sampledAt, tps: current?.tps ?? null }].slice(-RETENTION / INTERVAL);
    return { state, current, points, sampledAt };
  }
}

export const tpsService = new TpsService();
