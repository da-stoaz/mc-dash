import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config';
import { logger } from './logger';

export const COOKIE_NAME = 'mcdash_session';
export const authEnabled = !!config.authPassword;

// A stable secret keeps sessions valid across restarts; without one we fall
// back to a per-boot random secret (sessions reset when the server restarts).
const sessionSecret = config.sessionSecret || crypto.randomBytes(32).toString('hex');

const MIN_PASSWORD_LENGTH = 12;
// The values our own docs and .env.example ship with. A deploy that still uses
// one of these has not been configured, whatever its length.
const PLACEHOLDER_PASSWORDS = new Set(['change-me', 'changeme', 'password', 'admin', 'minecraft']);

function describeAuthProblem(): string | null {
  if (!config.authPassword) {
    return (
      'MC_DASH_PASSWORD is not set. MC Dash drives the host Docker socket, so it refuses to start without a login. ' +
      'Set MC_DASH_PASSWORD, or set MC_DASH_ALLOW_NO_AUTH=true to run unauthenticated on a trusted LAN.'
    );
  }
  if (PLACEHOLDER_PASSWORDS.has(config.authPassword.toLowerCase())) {
    return 'MC_DASH_PASSWORD is still an example placeholder. Set a real one, e.g. `openssl rand -base64 24`.';
  }
  if (config.authPassword.length < MIN_PASSWORD_LENGTH) {
    // Report the length we actually received: when it disagrees with what's in
    // .env the cause is almost always an unquoted `#`, which dotenv reads as the
    // start of a comment and silently drops the rest of the value.
    return (
      `MC_DASH_PASSWORD is ${config.authPassword.length} characters; the minimum is ${MIN_PASSWORD_LENGTH}. ` +
      'If your .env value looks longer than that, it contains a `#` — dotenv treats it as a comment and ' +
      'truncates the value. Wrap the whole value in double quotes to keep it intact.'
    );
  }
  return null;
}

/**
 * Validated once at boot (see index.ts) so a misconfigured deploy dies with a
 * readable message instead of coming up unauthenticated. Throws rather than
 * exiting so the caller decides how to report it.
 */
export function assertAuthConfig(): void {
  const problem = describeAuthProblem();
  if (problem) {
    // MC_DASH_ALLOW_NO_AUTH is the operator saying "this environment doesn't
    // need a real login" — honour that for a weak password too, not just a
    // missing one, so local dev is never blocked by a hardening check.
    if (!config.allowNoAuth) throw new Error(problem);
    logger.warn(
      `${problem} Starting anyway because MC_DASH_ALLOW_NO_AUTH=true — never do this on an internet-facing host, ` +
        'this API can run containers on the host.'
    );
  }
  if (config.authPassword && !config.sessionSecret) {
    logger.warn('MC_DASH_SESSION_SECRET is not set — using a random secret; sessions reset on restart.');
  }
}

function sign(data: string): string {
  return crypto.createHmac('sha256', sessionSecret).update(data).digest('base64url');
}

function timingSafeEqualStr(a: string, b: string): boolean {
  // Compare fixed-width digests rather than the raw strings: timingSafeEqual
  // throws on unequal lengths, and the early length return that works around
  // that leaks how long the configured password is.
  const bufA = crypto.createHash('sha256').update(a).digest();
  const bufB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(bufA, bufB);
}

export function createSessionToken(ttlMs = config.sessionTtlMs): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + ttlMs })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token?: string): boolean {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!timingSafeEqualStr(sig, sign(payload))) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number };
    return typeof decoded.exp === 'number' && Date.now() < decoded.exp;
  } catch {
    return false;
  }
}

export function checkPassword(input: string): boolean {
  if (!config.authPassword) return false;
  return timingSafeEqualStr(input, config.authPassword);
}

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function isAuthenticated(req: Request): boolean {
  const cookies = parseCookies(req.headers.cookie);
  return verifySessionToken(cookies[COOKIE_NAME]);
}

export function setSessionCookie(res: Response): void {
  res.cookie(COOKIE_NAME, createSessionToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: config.sessionTtlMs,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!authEnabled || isAuthenticated(req)) {
    next();
    return;
  }
  res.status(401).json({ error: 'Authentication required' });
}
