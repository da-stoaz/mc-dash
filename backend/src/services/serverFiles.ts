import fs from 'fs/promises';
import { spawn } from 'child_process';
import path from 'path';
import { config } from '../config';

function owner(): { uid: number; gid: number } | undefined {
  if (!config.containerUser) return undefined;
  const match = /^(\d+):(\d+)$/.exec(config.containerUser);
  if (!match) throw new Error('Minecraft file ownership requires MC_CONTAINER_USER in numeric uid:gid format.');
  const [uid, gid] = match.slice(1).map(Number);
  if (![uid, gid].every(n => Number.isSafeInteger(n) && n >= 0 && n < 4294967295)) {
    throw new Error('Invalid Minecraft uid:gid.');
  }
  return { uid, gid };
}

export function serverDirectory(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid server directory.');
  return path.join(config.dataRoot, 'servers', id);
}

/** The worker uses openat/renameat through Python's dir_fd APIs on both Linux
 * and macOS. O_NOFOLLOW on a Node pathname only protects its final component.
 * Never fall back to pathname writes if the worker is unavailable.
 */
async function operate(file: string, operation: 'write' | 'repair' | 'validate' | 'storage', content?: string) {
  const base = path.resolve(config.dataRoot);
  const relative = path.relative(base, path.resolve(file));
  const parts = relative.split(path.sep);
  if (parts[0] !== 'servers' || parts.length < 2 || parts.some(p => p === '..' || !p)) {
    throw new Error('File is outside a managed server directory.');
  }
  const target = owner();
  // DATA_ROOT is administrator-controlled. Resolve its OS aliases (e.g. macOS
  // /var -> /private/var) once; all Minecraft-controlled components use dir_fd.
  const root = await fs.realpath(base);
  return new Promise<string>((resolve, reject) => {
    const child = spawn('python3', [path.join(__dirname, 'serverFileWorker.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let error = '', output = '';
    const timeout = operation === 'storage' ? setTimeout(() => child.kill('SIGKILL'), 60000) : null;
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-8192); });
    child.stderr.on('data', chunk => { error = (error + chunk).slice(-8192); });
    child.on('error', err => reject(new Error(`Cannot run secure server file worker: ${err.message}. Python 3 is required.`)));
    child.stdin.on('error', () => { /* close/error below reports the worker failure */ });
    child.on('close', code => {
      if (timeout) clearTimeout(timeout);
      code === 0 ? resolve(output) : reject(new Error(error.trim() || 'Secure server file operation failed or timed out'));
    });
    child.stdin.end(JSON.stringify({ root, parts, operation, owner: target ?? null, content }));
  });
}

/** Repair working files while stopped. Snapshot archives remain backend-owned. */
export async function prepareServerFiles(id: string, repair = true): Promise<void> {
  await operate(serverDirectory(id), repair ? 'repair' : 'validate');
}

/** Atomically replace configuration through a pinned parent directory. */
export async function writeServerFile(file: string, content: string): Promise<void> {
  await operate(file, 'write', content);
}

/** A crash between pack publication steps must not start the replacement or
 * create a fresh world while the complete previous installation awaits recovery.
 */
export async function assertNoInterruptedRebuild(id: string): Promise<void> {
  const previous = path.join(serverDirectory(id), '.pack-before-rebuild');
  try { await fs.lstat(previous); }
  catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(`A previous pack is retained at ${previous}. Resolve the interrupted rebuild before starting or recreating this server.`);
}

export type StorageUsage = { filesBytes: number; snapshotsBytes: number; totalBytes: number; checkedAt: number };
const storageCache = new Map<string, StorageUsage>();
const storagePending = new Map<string, Promise<StorageUsage>>();
let storageQueue: Promise<unknown> = Promise.resolve();

/** On-demand, cached and serialized: never scan large worlds in the metrics loop. */
export function serverStorageUsage(id: string): Promise<StorageUsage> {
  const now = Date.now();
  for (const [key, entry] of storageCache) if (now - entry.checkedAt > 30000) storageCache.delete(key);
  const cached = storageCache.get(id);
  if (cached) return Promise.resolve(cached);
  const pending = storagePending.get(id);
  if (pending) return pending;
  const task = storageQueue.then(async () => {
    const result: StorageUsage = { ...JSON.parse(await operate(serverDirectory(id), 'storage')), checkedAt: Date.now() };
    storageCache.set(id, result);
    return result;
  }).finally(() => storagePending.delete(id));
  storageQueue = task.catch(() => undefined);
  storagePending.set(id, task);
  return task;
}
