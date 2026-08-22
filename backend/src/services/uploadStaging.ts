import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../logger';

/**
 * Server packs are 200 MB+ and MC Dash is usually reached through a proxy that
 * caps request bodies: Cloudflare documents 100 MB on Free and Pro, and nginx
 * defaults to a mere 1 MB. Worse, the failure is often silent — the proxy stops
 * reading the socket while the connection stays open, so the browser's progress
 * bar parks a couple of megabytes in and no error event ever fires.
 *
 * So a big file never travels as one request. The browser slices it, sends each
 * slice as its own small request, and this module appends them back into a
 * single file on disk. Every hop stays far below any proxy's ceiling, and the
 * ceiling here is disk rather than memory: chunks are written straight through,
 * never accumulated.
 *
 * The finished file is then handed to whichever route asked for it, in the same
 * shape multer would have produced, so the create/import/replace-pack handlers
 * don't care which path a file arrived by.
 */

const stagingDir = path.join(config.dataRoot, 'uploads', '.staging');

// An abandoned upload (browser tab closed mid-transfer) leaves a part file
// behind. Sweep anything untouched for this long; a chunk arriving resets it.
const STALE_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

interface StagedUpload {
  id: string;
  filename: string;
  size: number;
  received: number;
  nextIndex: number;
  filePath: string;
  complete: boolean;
  touchedAt: number;
  // Appends are serialised onto this chain. Node won't interleave the
  // synchronous parts, but two overlapping requests would both await their own
  // write and could land out of order — a retry that fires while the original
  // is still in flight is exactly that case.
  chain: Promise<void>;
}

export interface StagedFile {
  path: string;
  originalname: string;
}

const uploads = new Map<string, StagedUpload>();

export class UploadError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// Same sanitising the multer paths apply: the name is only ever used as a
// display label and as a suffix on a path we build ourselves, but it arrives
// from the browser, so strip anything that could be read as a path.
function safeFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
  return cleaned.replace(/^\.+/, '_') || 'upload.bin';
}

function ensureStagingDir(): void {
  if (!fs.existsSync(stagingDir)) {
    fs.mkdirSync(stagingDir, { recursive: true });
  }
}

// Chunks are sent strictly in order, so request count is latency the user waits
// through. Aim for a roughly fixed number of them however big the file is: small
// packs stay at the floor (a 240 MB pack is 30 requests of 8 MB), and only files
// large enough to need it grow their slices, up to a ceiling that stays well
// under any proxy's body limit.
const TARGET_CHUNK_COUNT = 200;

export function chunkSizeFor(size: number): number {
  const wanted = Math.ceil(size / TARGET_CHUNK_COUNT);
  return Math.min(config.uploadChunkMaxBytes, Math.max(config.uploadChunkBytes, wanted));
}

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

/**
 * The real ceiling on a 20 GB snapshot is the disk, not a configured number, and
 * finding out halfway through is expensive for everyone — the client has already
 * spent minutes uploading, and a full disk takes the running servers down with
 * it. So refuse up front, while the file is still only a declared size.
 *
 * Split out from the statfs call so the arithmetic can be tested without needing
 * a disk of a particular size.
 */
export function assertRoomFor(size: number, availableBytes: number): void {
  const needed = size + config.uploadDiskMarginBytes;
  if (needed <= availableBytes) return;
  throw new UploadError(
    `Not enough disk space: ${mb(size)} MB upload needs ${mb(needed)} MB free (including a ` +
      `${mb(config.uploadDiskMarginBytes)} MB reserve) but only ${mb(availableBytes)} MB is available`,
    507
  );
}

// statfs landed in Node 18.15. Older runtimes simply skip the check rather than
// refusing every upload over a missing API.
function availableBytes(dir: string): number | null {
  const statfsSync = (fs as unknown as { statfsSync?: (p: string) => { bsize: number; bavail: number } }).statfsSync;
  if (typeof statfsSync !== 'function') return null;
  try {
    const stats = statfsSync(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

export function beginUpload(filename: string, size: number): { id: string; chunkSize: number } {
  if (!Number.isInteger(size) || size <= 0) {
    throw new UploadError('Upload size must be a positive number of bytes');
  }
  if (size > config.maxUploadBytes) {
    throw new UploadError(
      `File is ${mb(size)} MB; the limit is ${mb(config.maxUploadBytes)} MB ` +
        '(raise MC_DASH_MAX_UPLOAD_MB to allow more)',
      413
    );
  }
  ensureStagingDir();
  const free = availableBytes(stagingDir);
  if (free !== null) assertRoomFor(size, free);
  const id = crypto.randomUUID();
  const filePath = path.join(stagingDir, `${id}.part`);
  fs.writeFileSync(filePath, '');
  uploads.set(id, {
    id,
    filename: safeFilename(filename),
    size,
    received: 0,
    nextIndex: 0,
    filePath,
    complete: false,
    touchedAt: Date.now(),
    chain: Promise.resolve(),
  });
  return { id, chunkSize: chunkSizeFor(size) };
}

function get(id: string): StagedUpload {
  const upload = uploads.get(id);
  if (!upload) {
    throw new UploadError('Upload session not found or expired — start the upload again', 404);
  }
  return upload;
}

export async function appendChunk(id: string, index: number, chunk: Buffer): Promise<{ received: number; nextIndex: number }> {
  const upload = get(id);
  if (upload.complete) throw new UploadError('Upload is already complete');
  if (!Number.isInteger(index) || index < 0) throw new UploadError('Chunk index must be a non-negative integer');

  const run = upload.chain.then(async () => {
    // A retry after a lost response re-sends a chunk we already wrote. Treat it
    // as a no-op rather than an error, or a flaky connection corrupts the file
    // by appending the same bytes twice.
    if (index < upload.nextIndex) return;
    if (index > upload.nextIndex) {
      throw new UploadError(`Chunk ${index} arrived out of order; expected ${upload.nextIndex}`, 409);
    }
    if (upload.received + chunk.length > upload.size) {
      throw new UploadError('Chunks exceed the declared upload size');
    }
    await fs.promises.appendFile(upload.filePath, chunk);
    upload.received += chunk.length;
    upload.nextIndex += 1;
    upload.touchedAt = Date.now();
  });

  // Keep the chain alive even when this link rejects, so one bad chunk doesn't
  // poison every later append with the same error.
  upload.chain = run.catch(() => {});
  await run;
  return { received: upload.received, nextIndex: upload.nextIndex };
}

export function completeUpload(id: string): { id: string; size: number } {
  const upload = get(id);
  if (upload.received !== upload.size) {
    throw new UploadError(`Upload is incomplete: received ${upload.received} of ${upload.size} bytes`);
  }
  upload.complete = true;
  upload.touchedAt = Date.now();
  return { id: upload.id, size: upload.size };
}

/**
 * Hand the finished file to a route. Ownership transfers with it: the caller
 * renames or deletes the file, exactly as it would a multer temp file, and the
 * session is dropped so the same upload can't be claimed twice.
 */
export function claimUpload(id: string): StagedFile {
  const upload = get(id);
  if (!upload.complete) {
    throw new UploadError('Upload has not finished — send every chunk and call complete first');
  }
  uploads.delete(id);
  return { path: upload.filePath, originalname: upload.filename };
}

export function discardUpload(id: string): void {
  const upload = uploads.get(id);
  if (!upload) return;
  uploads.delete(id);
  fs.promises.rm(upload.filePath, { force: true }).catch(() => {});
}

export function sweep(now = Date.now()): number {
  let removed = 0;
  for (const upload of [...uploads.values()]) {
    if (now - upload.touchedAt < STALE_MS) continue;
    uploads.delete(upload.id);
    fs.promises.rm(upload.filePath, { force: true }).catch(() => {});
    removed += 1;
  }
  return removed;
}

/**
 * Sessions live in memory, so a restart orphans every part file on disk with
 * nothing left to claim them. Delete them outright rather than ageing them out.
 */
function clearOrphansOnBoot(): void {
  if (!fs.existsSync(stagingDir)) return;
  for (const entry of fs.readdirSync(stagingDir)) {
    if (!entry.endsWith('.part')) continue;
    fs.promises.rm(path.join(stagingDir, entry), { force: true }).catch(() => {});
  }
}

export const uploadStaging = {
  start(): void {
    ensureStagingDir();
    clearOrphansOnBoot();
    const timer = setInterval(() => {
      const removed = sweep();
      if (removed) logger.info(`Swept ${removed} abandoned upload(s)`);
    }, SWEEP_INTERVAL_MS);
    timer.unref();
  },
};
