const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const source = fs.readFileSync(path.join(__dirname, '../docker-compose.yml'), 'utf8');

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
    assert.equal(frontend.build.args.NEXT_PUBLIC_API_BASE_URL, '/api');
    assert.equal(frontend.build.args.MC_DASH_BACKEND_URL, 'http://127.0.0.1:3301');
    assert.equal(backend.environment.MC_DASH_BIND_HOST, '127.0.0.1');
    assert.equal(backend.environment.MC_DASH_MEMORY_POOL, 'true');
    assert.equal(backend.network_mode, 'host');
    assert.equal(frontend.network_mode, 'host');
    const data = backend.volumes.find(v => v.source === '/srv/existing-mc-data');
    assert.equal(data.target, data.source);
    assert.equal(data.bind.create_host_path, false);
    assert.equal(backend.cgroup_parent, undefined);
    assert.equal(frontend.cgroup_parent, undefined);
    fs.writeFileSync(path.join(dir, '.env'), 'MC_CONTAINER_USER=1234:5678\n');
    assert.throws(run, /DATA_ROOT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
