import type { Request, Response, NextFunction } from 'express';
import { logger } from './logger';

// Fixed-window throttle for the login endpoint. Without it the single shared
// password is guessable at whatever rate the network allows, which is the whole
// attack surface once MC Dash is reachable from the internet.
//
// Only *failed* attempts count, so a working password never locks anyone out.
// In-memory state is enough: MC Dash is one process, and a restart clearing the
// window is not a useful bypass (an attacker can't trigger restarts, and every
// failure is logged regardless).
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 12;
// Buckets all expire within WINDOW_MS, so sweeping bounds the map to the
// distinct clients that failed a login in the last 15 minutes.
const SWEEP_THRESHOLD = 10_000;

type Bucket = { failures: number; resetAt: number };
const buckets = new Map<string, Bucket>();

// req.ip is only meaningful when `trust proxy` matches the deployment; behind a
// tunnel without it every client collapses onto 127.0.0.1 and shares one bucket.
// That fails safe (stricter, not looser) but makes lockouts collective, so
// MC_DASH_TRUST_PROXY matters here.
function keyFor(req: Request): string {
  return req.ip ?? 'unknown';
}

function bucketFor(key: string, now: number): Bucket {
  const existing = buckets.get(key);
  if (existing && existing.resetAt > now) return existing;
  const fresh: Bucket = { failures: 0, resetAt: now + WINDOW_MS };
  buckets.set(key, fresh);
  return fresh;
}

function sweepExpired(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export function loginRateLimit(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();
  if (buckets.size > SWEEP_THRESHOLD) sweepExpired(now);

  const bucket = bucketFor(keyFor(req), now);
  if (bucket.failures >= MAX_FAILURES) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    logger.warn({ ip: req.ip, retryAfterSec }, 'Login attempts rate limited');
    res.setHeader('Retry-After', String(retryAfterSec));
    res.status(429).json({ error: 'Too many login attempts. Try again later.', retryAfterSec });
    return;
  }
  next();
}

export function recordLoginFailure(req: Request): void {
  bucketFor(keyFor(req), Date.now()).failures += 1;
}

export function clearLoginFailures(req: Request): void {
  buckets.delete(keyFor(req));
}
