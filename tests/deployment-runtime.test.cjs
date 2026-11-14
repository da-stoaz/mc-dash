const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');

// Build the :deployment-check images first (see DEPLOY.md). This uses disposable
// storage and no Docker socket. Shared networking exercises the same loopback
// proxy as production without requiring Docker Desktop's host networking option.
// The frontend image is built for the default backend port (4000); running the
// backend on 3301 proves src/proxy.ts reads MC_DASH_BACKEND_URL at runtime.
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
      // Reachable through the backend container's published port.
      'MC_DASH_FRONTEND_BIND_HOST=0.0.0.0',
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
    // Live updates must stream through the proxy event by event, not buffered.
    const stream = await request('/api/servers/stream', { headers });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /^text\/event-stream/);
    const reader = stream.body.getReader();
    let events = '';
    while (!/event: servers\ndata: \[\]\n\n/.test(events)) {
      const { done, value } = await reader.read();
      assert.ok(!done, 'stream ended before the first event');
      events += Buffer.from(value).toString();
    }
    await reader.cancel();
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

    // Every page, every asset the pages reference, and every static/public file
    // in the image must be served (catches build output missing from the image).
    const urls = new Set();
    for (const pagePath of ['/', '/servers/example', '/servers/example/settings']) {
      const response = await request(pagePath);
      assert.equal(response.status, 200, pagePath);
      for (const [, url] of (await response.text()).matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
        urls.add(url.replaceAll('&amp;', '&'));
      }
    }
    assert.ok([...urls].some(url => url.startsWith('/_next/static/')), 'pages reference built assets');
    const files = compose('exec', '-T', 'frontend', 'sh', '-c', 'cd /app && find .next/static public -type f')
      .trim().split('\n');
    assert.ok(files.some(file => file.startsWith('.next/static/')), 'image contains built assets');
    for (const file of files) {
      urls.add(file.startsWith('public/') ? file.slice('public'.length) : `/_next/${file.slice('.next/'.length)}`);
    }
    for (const url of urls) {
      const response = await request(url);
      await response.arrayBuffer();
      assert.equal(response.status, 200, url);
    }

    // Both containers must exit on SIGTERM, not by Docker's kill after the timeout,
    // the backend even with a live-update stream open.
    const stop = service => {
      const started = Date.now();
      compose('stop', '--timeout', '20', service);
      const ms = Date.now() - started;
      assert.ok(ms < 10_000, `${service} stop took ${ms} ms`);
      return compose('ps', '--all', '--format', '{{.ExitCode}}', service).trim();
    };
    assert.notEqual(stop('frontend'), '137', 'frontend was killed instead of shutting down');
    // The backend listens on loopback only, so hold a stream open from inside it.
    const holder = spawn('docker', [
      'compose', '--project-name', `mc-deploy-test-${process.pid}`, '-f', 'docker-compose.yml', '-f', 'test.yml',
      'exec', '-T', 'backend', 'node', '-e', `(async () => {
        const base = 'http://127.0.0.1:' + process.env.PORT;
        const login = await fetch(base + '/auth/login', { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: process.env.MC_DASH_PASSWORD }) });
        const open = await fetch(base + '/servers/stream', { headers: { cookie: login.headers.get('set-cookie').split(';')[0] } });
        console.log('open ' + open.status);
        for await (const chunk of open.body) void chunk;
      })()`,
    ], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      holder.stdout.on('data', data => String(data).includes('open 200') && resolve());
      holder.on('exit', () => reject(new Error('could not open a stream inside the backend')));
      setTimeout(() => reject(new Error('timed out opening a stream inside the backend')), 15_000).unref();
    });
    assert.equal(stop('backend'), '0', 'backend did not shut down cleanly');
    holder.kill();
    assert.match(compose('logs', '--no-color', 'backend'), /Shutting down/);
  } catch (error) {
    let logs = '';
    try { logs = compose('logs', '--no-color', '--tail', '40'); } catch {}
    throw new Error(`${error.message}\n${logs}`, { cause: error });
  } finally {
    try { compose('down', '--volumes', '--remove-orphans'); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
