const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const source = fs.readFileSync(path.join(__dirname, '../docker-compose.yml'), 'utf8');
const buildSource = fs.readFileSync(path.join(__dirname, '../docker-compose.build.yml'), 'utf8');

test('Compose uses one configuration, matching paths/ports, and no frontend secrets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdash-compose-'));
  try {
    fs.writeFileSync(path.join(dir, 'docker-compose.yml'), source);
    fs.writeFileSync(path.join(dir, '.env'), [
      'DATA_ROOT=/srv/existing-mc-data',
      'MC_CONTAINER_USER=1234:5678',
      'MC_DASH_BACKEND_PORT=3301',
      'MC_DASH_FRONTEND_PORT=3300',
      "MC_DASH_PASSWORD='test$literal#password'",
      'MC_DASH_UPLOAD_CHUNK_MB=16',
      '',
    ].join('\n'));
    const run = () => JSON.parse(execFileSync('docker', ['compose', 'config', '--format', 'json'], {
      cwd: dir, env: { PATH: process.env.PATH, HOME: process.env.HOME },
      encoding: 'utf8', stdio: 'pipe',
    }));
    const { services: { backend, frontend } } = run();
    assert.equal(backend.environment.PORT, '3301');
    assert.equal(frontend.environment.PORT, '3300');
    // `config` escapes dollars so its output can be used as another Compose file.
    // The runtime test also logs in with the literal (single-dollar) password.
    assert.equal(backend.environment.MC_DASH_PASSWORD, 'test$$literal#password');
    assert.equal(backend.environment.MC_DASH_UPLOAD_CHUNK_MB, '16');
    assert.equal(frontend.environment.MC_DASH_PASSWORD, undefined);
    // Images are pulled, never built on the host; the frontend proxy target is runtime config.
    assert.equal(backend.image, 'ghcr.io/da-stoaz/mc-dash-backend:latest');
    assert.equal(frontend.image, 'ghcr.io/da-stoaz/mc-dash-frontend:latest');
    assert.equal(backend.build, undefined);
    assert.equal(frontend.build, undefined);
    assert.equal(frontend.environment.MC_DASH_BACKEND_URL, 'http://127.0.0.1:3301');
    assert.equal(frontend.environment.HOSTNAME, '127.0.0.1');
    assert.equal(frontend.command ?? null, null, 'the image runs Next\'s own server.js');
    assert.equal(backend.environment.MC_DASH_BIND_HOST, '127.0.0.1');
    assert.equal(backend.environment.MC_DASH_MEMORY_POOL, 'true');
    assert.equal(backend.network_mode, 'host');
    assert.equal(frontend.network_mode, 'host');
    const data = backend.volumes.find(v => v.source === '/srv/existing-mc-data');
    assert.equal(data.target, data.source);
    // Older Compose omits false from `config` output; absent means false there.
    assert.equal(data.bind?.create_host_path ?? false, false);
    assert.match(source, /create_host_path: false/);
    assert.equal(backend.cgroup_parent, undefined);
    assert.equal(frontend.cgroup_parent, undefined);
    fs.appendFileSync(path.join(dir, '.env'), 'MC_DASH_VERSION=sha-abc1234\n');
    const pinned = run().services;
    assert.equal(pinned.backend.image, 'ghcr.io/da-stoaz/mc-dash-backend:sha-abc1234');
    assert.equal(pinned.frontend.image, 'ghcr.io/da-stoaz/mc-dash-frontend:sha-abc1234');
    fs.writeFileSync(path.join(dir, '.env'), 'MC_CONTAINER_USER=1234:5678\n');
    assert.throws(run, /DATA_ROOT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Build override builds both images from the checkout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdash-compose-build-'));
  try {
    fs.writeFileSync(path.join(dir, 'docker-compose.yml'), source);
    fs.writeFileSync(path.join(dir, 'docker-compose.build.yml'), buildSource);
    fs.writeFileSync(path.join(dir, '.env'), 'DATA_ROOT=/srv/data\nMC_CONTAINER_USER=1:1\n');
    const { services: { backend, frontend } } = JSON.parse(execFileSync('docker', [
      'compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.build.yml', 'config', '--format', 'json',
    ], { cwd: dir, env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: 'utf8', stdio: 'pipe' }));
    assert.equal(backend.build.context, path.join(fs.realpathSync(dir), 'backend'));
    assert.equal(frontend.build.context, path.join(fs.realpathSync(dir), 'frontend'));
    assert.equal(frontend.build.args.NEXT_PUBLIC_API_BASE_URL, '/api');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
