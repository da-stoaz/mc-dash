import fs from 'fs/promises';
import path from 'path';
import { config } from '../config';
import { UserFacingError } from '../apiErrors';

export const POOL_SLICE = 'minecraft.slice';
const MB = 1024 ** 2;
export type MemoryPoolReport = {
  enabled: boolean;
  enforced: boolean;
  limitMb: number;
  usedMb: number | null;
  pressure: boolean;
  /** Charged memory excluding inactive file cache that the kernel can reclaim. */
  workingSetMb?: number;
  reclaimableMb?: number;
  automaticSleepEnabled?: boolean;
  reason: string | null;
  oomKills: number;
  lastAction?: string | null;
};

export function parseCounter(value: string): number {
  if (!/^\d+$/.test(value.trim())) throw new Error('Invalid cgroup reading');
  const number = Number(value.trim());
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Invalid cgroup reading');
  return number;
}

let lastAction: { message: string; at: number } | null = null;
export function setMemoryPoolAction(message: string) { lastAction = { message, at: Date.now() }; }

/** Read the host controller, never infer enforcement from configuration alone. */
export async function readMemoryPool(
  root = config.memoryPoolRoot,
  membershipFile = '/proc/self/cgroup',
): Promise<MemoryPoolReport> {
  const result: MemoryPoolReport = {
    enabled: config.memoryPoolEnabled, enforced: false, limitMb: 0,
    usedMb: null, pressure: false, reason: null, oomKills: 0,
    automaticSleepEnabled: config.hibernationEnabled && config.memoryPoolEnabled,
    lastAction: lastAction && Date.now() - lastAction.at < 300_000 ? lastAction.message : null,
  };
  if (!result.enabled) return { ...result, reason: 'Shared RAM limit is disabled.' };
  try {
    const pool = path.join(root, POOL_SLICE);
    const [max, swap, current, membership, events, stat] = await Promise.all([
      fs.readFile(path.join(pool, 'memory.max'), 'utf8'),
      fs.readFile(path.join(pool, 'memory.swap.max'), 'utf8'),
      fs.readFile(path.join(pool, 'memory.current'), 'utf8'),
      fs.readFile(membershipFile, 'utf8'),
      fs.readFile(path.join(pool, 'memory.events'), 'utf8'),
      fs.readFile(path.join(pool, 'memory.stat'), 'utf8').catch(() => ''),
    ]);
    // The installed controller is the single source of truth. No second env
    // value to drift from the OS limit, and "max" is never accepted as a cap.
    const limitBytes = parseCounter(max);
    if (limitBytes < 512 * MB) throw new Error('The Minecraft pool needs a finite limit of at least 512 MB.');
    result.limitMb = limitBytes / MB;
    result.usedMb = parseCounter(current) / MB;
    const inactiveFile = Number(stat.match(/^inactive_file (\d+)$/m)?.[1] ?? 0) / MB;
    result.reclaimableMb = Math.min(result.usedMb, inactiveFile);
    result.workingSetMb = result.usedMb - result.reclaimableMb;
    result.pressure = result.workingSetMb >= result.limitMb * 0.97;
    result.oomKills = Number(events.match(/^oom_kill (\d+)$/m)?.[1] ?? 0);
    if (parseCounter(swap) !== 0) throw new Error('Minecraft pool swap must be disabled.');
    const controlPath = membership.split('\n').find(line => line.startsWith('0::'))?.slice(3);
    // A private namespace reports "/" and cannot prove host separation.
    if (!controlPath?.startsWith('/') || controlPath === '/') {
      throw new Error('Cannot verify backend separation; the backend needs the host cgroup namespace.');
    }
    if (controlPath.split('/').some(part => part === POOL_SLICE || part === 'mcdash.slice')) {
      throw new Error('MC Dash must run outside the Minecraft memory pool. Remove the old shared service assignment.');
    }
    result.enforced = true;
    return result;
  } catch (error) {
    return { ...result, reason: error instanceof Error && !('code' in error) ? error.message : 'Shared RAM protection is not installed or cannot be verified on this host.' };
  }
}

export function requireMemoryPool(report: MemoryPoolReport): void {
  if (report.enabled && !report.enforced) throw new UserFacingError({
    error: 'Shared RAM protection is not ready', code: 'MEMORY_POOL_UNVERIFIED', status: 409,
    reason: report.reason ?? undefined,
    details: 'Apply the host setup in docs/memory-pool.md before starting servers. Existing containers must be rebuilt into minecraft.slice. Keep MC Dash itself outside that slice.',
  });
}

// Starts are serialized through Docker.start. Hold boot headroom until the JVM
// is ready; actual usage is subtracted to avoid double booking. Docker auditing
// reconstructs these allowances after a backend restart.
export class StartupReservations {
  private entries = new Map<string, { mb: number }>();
  reserve(id: string, mb: number, _now = Date.now()) { this.entries.set(id, { mb: Math.max(mb, this.entries.get(id)?.mb ?? 0) }); }
  release(id: string) { this.entries.delete(id); }
  retain(ids: Set<string>) { for (const id of this.entries.keys()) if (!ids.has(id)) this.release(id); }
  pending(usage: Map<string, number>, now = Date.now()): number {
    let pending = 0;
    for (const [id, entry] of this.entries) {
      pending += Math.max(0, entry.mb - (usage.get(id) ?? 0));
    }
    return pending;
  }
}
export const startupReservations = new StartupReservations();

export function requireStartRoom(report: MemoryPoolReport, requestMb: number, pendingMb: number): void {
  requireMemoryPool(report);
  if (!report.enabled) return;
  const usedMb = report.workingSetMb ?? report.usedMb;
  const availableMb = Math.max(0, report.limitMb * 0.95 - (usedMb ?? 0) - pendingMb);
  if (usedMb === null || !Number.isFinite(usedMb) || !Number.isFinite(requestMb) || !Number.isFinite(pendingMb) || requestMb > availableMb) {
    throw new UserFacingError({ error: 'Not enough shared RAM to start', code: 'MEMORY_POOL_PRESSURE', status: 409,
      reason: usedMb === null ? 'Current pool usage is unavailable.' : `This start needs ${Math.ceil(requestMb)} MiB; ${Math.floor(availableMb)} MiB is available for starts.`,
      details: `${Math.ceil(usedMb ?? 0)} MiB in use, ${Math.ceil(pendingMb)} MiB reserved for other starts, ${Math.ceil(report.limitMb * 0.05)} MiB headroom. Reclaimable file cache is excluded. Pool limit: ${Math.round(report.limitMb)} MiB.` });
  }
}

/** Common verification used by the dashboard and automatic pressure decisions. */
export async function readVerifiedMemoryPool(): Promise<MemoryPoolReport> {
  let pool = await readMemoryPool();
  if (!pool.enforced) return pool;
  try {
    const { dockerService } = await import('./dockerService');
    await dockerService.verifyMemoryPoolContainers();
    pool = await readMemoryPool();
  } catch {
    pool.enforced = false;
    pool.reason = 'Some running containers are outside the shared RAM pool, or Docker could not be verified.';
  }
  return pool;
}
