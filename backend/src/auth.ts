import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config';
import { logger } from './logger';

export const COOKIE_NAME = 'mcdash_session';
export const authEnabled = !!config.authPassword;

// A stable secret keeps sessions valid across restarts; without one we fall
// back to a per-boot random secret (sessions reset when the server restarts).
const sessionSecret = config.sessionSecret || crypto.randomBytes(32).toString('hex');

if (!authEnabled) {
  logger.warn('MC_DASH_PASSWORD is not set — API authentication is DISABLED. Set it to require a login.');
} else if (!config.sessionSecret) {
  logger.warn('MC_DASH_SESSION_SECRET is not set — using a random secret; sessions reset on restart.');
}

function sign(data: string): string {
  return crypto.createHmac('sha256', sessionSecret).update(data).digest('base64url');
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
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
