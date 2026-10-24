import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdash-auth-'));
process.env.DATA_ROOT = tmp;
process.env.SQLITE_PATH = path.join(tmp, 'test.sqlite');
process.env.MC_DASH_PASSWORD = 'test-login-password';
process.env.MC_DASH_SESSION_SECRET = 'test-session-secret';
process.env.MC_DASH_COOKIE_SECURE = 'true';

const { config } = require('./config') as typeof import('./config');
const authRouter = (require('./routes/auth') as typeof import('./routes/auth')).default;
const app = express();
app.use(express.json());
app.use('/auth', authRouter);
let server: Server;
let base: string;

before(async () => {
  server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', err => err ? reject(err) : resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function login(headers: Record<string, string> = {}, password = process.env.MC_DASH_PASSWORD) {
  return fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ password }),
  });
}

test('LAN HTTP login establishes a session with the deployed COOKIE_SECURE=true setting', async () => {
  const response = await login({ Origin: 'http://192.168.20.2:3300' });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')!;
  assert.ok(cookie);
  assert.doesNotMatch(cookie, /; Secure(?:;|$)/);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; SameSite=Lax/);
  assert.match(cookie, /; Path=\//);
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const session = await fetch(`${base}/auth/me`, { headers: { Cookie: cookie.split(';')[0] } });
  assert.deepEqual(await session.json(), { authRequired: true, authenticated: true });
  const anonymous = await fetch(`${base}/auth/me`);
  assert.deepEqual(await anonymous.json(), { authRequired: true, authenticated: false });
});

for (const origin of [
  'http://10.0.0.2:3300', 'http://172.16.0.1', 'http://172.31.255.254',
  'http://169.254.1.2', 'http://localhost:3000', 'http://127.0.0.1:3000',
  'http://[::1]:3000', 'http://[fd00::2]:3300', 'http://[fe80::2]:3300',
]) {
  test(`local HTTP cookie works for ${origin}`, async () => {
    const response = await login({ Origin: origin });
    assert.equal(response.status, 200);
    assert.doesNotMatch(response.headers.get('set-cookie')!, /; Secure(?:;|$)/);
  });
}

for (const origin of [
  undefined, 'null', 'invalid', 'http://dash.example.com', 'http://172.15.0.1',
  'http://172.32.0.1', 'http://192.169.0.1', 'http://192.168.20.2.example.com',
  'http://[2001:db8::2]', 'http://192.168.20.2/path',
]) {
  test(`configured Secure policy is retained for origin ${origin}`, async () => {
    const response = await login(origin ? { Origin: origin } : {});
    assert.match(response.headers.get('set-cookie')!, /; Secure(?:;|$)/);
  });
}

test('HTTPS browser origins use Secure cookies even over an HTTP proxy upstream', async () => {
  config.cookieSecure = false;
  try {
    for (const origin of ['https://dash.example.com', 'https://192.168.20.2:3300']) {
      const response = await login({ Origin: origin });
      assert.match(response.headers.get('set-cookie')!, /; Secure(?:;|$)/);
    }
  } finally {
    config.cookieSecure = true;
  }
});

test('trusted HTTPS proxy takes precedence over an HTTP Origin', async () => {
  app.set('trust proxy', 'loopback');
  try {
    const response = await login({ Origin: 'http://192.168.20.2:3300', 'X-Forwarded-Proto': 'https' });
    assert.match(response.headers.get('set-cookie')!, /; Secure(?:;|$)/);
  } finally {
    app.set('trust proxy', false);
  }
});

test('untrusted forwarding headers cannot change cookie policy', async () => {
  const response = await login({ 'X-Forwarded-Proto': 'http', 'X-Forwarded-Host': '192.168.20.2' });
  assert.match(response.headers.get('set-cookie')!, /; Secure(?:;|$)/);
  const local = await login({ Origin: 'http://192.168.20.2:3300', 'X-Forwarded-Proto': 'https' });
  assert.doesNotMatch(local.headers.get('set-cookie')!, /; Secure(?:;|$)/);
});

test('incorrect passwords still fail without issuing a cookie', async () => {
  const response = await login({ Origin: 'http://192.168.20.2:3300' }, 'wrong-password');
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('logout clears the local session cookie', async () => {
  const response = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { Origin: 'http://192.168.20.2:3300' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie')!, /^mcdash_session=;.*Expires=Thu, 01 Jan 1970/);
});
