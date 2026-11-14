const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

// Runs the production docker-compose.yml as shipped, with Linux host networking,
// using the :deployment-check images. Only the images, restart policy and data
// storage are overridden (no Docker socket, cgroup mount or real data). Proves
// both panel containers listen on loopback only and the UI reaches the backend
// through /api in the production network topology. Needs a Linux Docker host,
// so it is skipped elsewhere (Docker Desktop host networking is not equivalent).
const linux = process.platform === 'linux';
test('production compose on host networking serves /api on loopback only', { skip: !linux && 'requires a Linux Docker host', timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-compose-host-'));
  const password = 'host$literal#password';
  const [backendPort, frontendPort] = [3311, 3310];
  const compose = (...args) => execFileSync('docker', [
    'compose', '--project-name', `mc-host-test-${process.pid}`,
    '-f', 'docker-compose.yml', '-f', 'test.yml', ...args,
  ], { cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 90_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: process.env.DOCKER_HOST } });
  try {
    fs.copyFileSync(path.join(__dirname, '../docker-compose.yml'), path.join(dir, 'docker-compose.yml'));
    fs.writeFileSync(path.join(dir, '.env'), [
      'DATA_ROOT=/tmp/mcdash-host-test-data',
      'MC_CONTAINER_USER=1234:5678',
      `MC_DASH_BACKEND_PORT=${backendPort}`,
      `MC_DASH_FRONTEND_PORT=${frontendPort}`,
      `MC_DASH_PASSWORD='${password}'`,
      'MC_DASH_SESSION_SECRET=disposable-integration-test-session-secret',
      'MC_DASH_COOKIE_SECURE=false',
      'MC_ROUTER_ENABLED=false',
      'MC_DASH_MEMORY_POOL=false',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'test.yml'), `services:
  backend:
    image: mc-dash-backend:deployment-check
    restart: "no"
    volumes: !reset []
    tmpfs: [/tmp/mcdash-host-test-data]
  frontend:
    image: mc-dash-frontend:deployment-check
    restart: "no"
`);
    compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '60');
    const base = `http://127.0.0.1:${frontendPort}`;
    const request = (url, init = {}) => fetch(`${base}${url}`, { ...init, signal: AbortSignal.timeout(10_000) });
    const page = await request('/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/);
    assert.deepEqual(await (await request('/api/health')).json(), { ok: true });
    const login = await request('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    assert.equal(login.status, 200);
    const headers = { cookie: login.headers.get('set-cookie').split(';')[0] };
    assert.equal((await (await request('/api/auth/me', { headers })).json()).authenticated, true);

    // The default bind address is loopback: no other host address may answer.
    const external = Object.values(os.networkInterfaces()).flat()
      .filter(a => a.family === 'IPv4' && !a.internal).map(a => a.address);
    assert.ok(external.length > 0, 'expected a non-loopback IPv4 address to probe');
    for (const address of external) {
      for (const port of [frontendPort, backendPort]) {
        await assert.rejects(fetch(`http://${address}:${port}/`, { signal: AbortSignal.timeout(5_000) }),
          error => error.cause?.code === 'ECONNREFUSED', `${address}:${port} must not be reachable`);
      }
    }
  } catch (error) {
    let logs = '';
    try { logs = compose('logs', '--no-color', '--tail', '40'); } catch {}
    throw new Error(`${error.message}\n${logs}`, { cause: error });
  } finally {
    try { compose('down', '--volumes', '--remove-orphans'); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
