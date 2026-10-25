const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

// Build the :deployment-check images first (see DEPLOY.md). This uses disposable
// storage and no Docker socket. Shared networking exercises the same loopback
// proxy as production without requiring Docker Desktop's host networking option.
test('built panel images serve the UI and authenticate through /api', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-compose-runtime-'));
  const password = 'runtime$literal#password';
  const compose = (...args) => execFileSync('docker', [
    'compose', '--project-name', `mc-deploy-test-${process.pid}`,
    '-f', 'docker-compose.yml', '-f', 'test.yml', ...args,
  ], { cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 90_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: process.env.DOCKER_HOST } });
  try {
    fs.copyFileSync(path.join(__dirname, '../docker-compose.yml'), path.join(dir, 'docker-compose.yml'));
    fs.writeFileSync(path.join(dir, '.env'), [
      'DATA_ROOT=/tmp/mcdash-test-data',
      'MC_CONTAINER_USER=1234:5678',
      'MC_DASH_BACKEND_PORT=3301',
      'MC_DASH_FRONTEND_PORT=3000',
      `MC_DASH_PASSWORD='${password}'`,
      'MC_DASH_SESSION_SECRET=disposable-integration-test-session-secret',
      'MC_DASH_COOKIE_SECURE=false',
      'MC_ROUTER_ENABLED=false',
      'MC_DASH_MEMORY_POOL=false',
      'MC_DASH_UPLOAD_DISK_MIN_FREE_MB=128',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'test.yml'), `services:
  backend:
    image: mc-dash-backend:deployment-check
    restart: "no"
    network_mode: bridge
    ports: ["127.0.0.1::3000"]
    volumes: !reset []
    tmpfs: [/tmp/mcdash-test-data]
  frontend:
    image: mc-dash-frontend:deployment-check
    restart: "no"
    network_mode: service:backend
    command: ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0"]
`);
    compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '60');
    const base = `http://${compose('port', 'backend', '3000').trim()}`;
    const request = (url, init = {}) => fetch(`${base}${url}`, {
      ...init, signal: AbortSignal.timeout(10_000),
    });
    const page = await request('/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/);
    assert.deepEqual(await (await request('/api/health')).json(), { ok: true });
    assert.equal((await request('/api/servers')).status, 401);
    const login = await request('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /mcdash_session=/);
    assert.match(cookie, /HttpOnly/i);
    const headers = { cookie: cookie.split(';')[0] };
    const me = await request('/api/auth/me', { headers });
    assert.equal((await me.json()).authenticated, true);
    const servers = await request('/api/servers', { headers });
    assert.equal(servers.status, 200);
    assert.deepEqual(await servers.json(), []);
    // Large upload chunks must survive Next's proxy without truncation.
    const bytes = 64 * 1024 * 1024;
    const begin = await request('/api/servers/uploads', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'proxy-test.zip', size: bytes }),
    });
    assert.equal(begin.status, 201);
    const { id } = await begin.json();
    const chunk = await request(`/api/servers/uploads/${id}/0`, {
      method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(bytes, 7),
    });
    assert.equal(chunk.status, 200);
    assert.equal((await chunk.json()).received, bytes);
    const complete = await request(`/api/servers/uploads/${id}/complete`, { method: 'POST', headers });
    assert.equal((await complete.json()).size, bytes);
    assert.equal((await request(`/api/servers/uploads/${id}`, { method: 'DELETE', headers })).status, 204);
    const logout = await request('/api/auth/logout', { method: 'POST', headers });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  } catch (error) {
    let logs = '';
    try { logs = compose('logs', '--no-color', '--tail', '40'); } catch {}
    throw new Error(`${error.message}\n${logs}`, { cause: error });
  } finally {
    try { compose('down', '--volumes', '--remove-orphans'); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
