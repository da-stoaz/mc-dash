const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const frontendRequire = createRequire(path.join(__dirname, '../frontend/package.json'));
const ts = frontendRequire('typescript');
const { NextRequest } = frontendRequire('next/server');

function load(file, dirname) {
  const source = fs.readFileSync(path.join(__dirname, '../frontend', file), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', '__dirname', code)(frontendRequire, module, module.exports, dirname);
  return module.exports;
}

function withBackendUrl(value, fn) {
  const previous = process.env.MC_DASH_BACKEND_URL;
  if (value === undefined) delete process.env.MC_DASH_BACKEND_URL;
  else process.env.MC_DASH_BACKEND_URL = value;
  try { return fn(); } finally {
    if (previous === undefined) delete process.env.MC_DASH_BACKEND_URL;
    else process.env.MC_DASH_BACKEND_URL = previous;
  }
}

test('frontend roots are explicit and no server config enters client bundles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-next-config-'));
  try {
    const config = load('next.config.ts', dir).default;
    assert.equal(config.turbopack.root, dir);
    assert.equal(config.outputFileTracingRoot, dir);
    assert.equal(config.output, 'standalone');
    assert.equal(config.rewrites, undefined, 'build-time rewrites would pin the backend port into the image');
    assert.equal(config.env, undefined, 'server config must not enter client bundles');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/api proxy forwards to the backend named at runtime', () => {
  const target = (backendUrl, url) => withBackendUrl(backendUrl, () => {
    const { proxy, config } = load('src/proxy.ts', __dirname);
    assert.equal(config.matcher, '/api/:path*');
    return proxy(new NextRequest(url)).headers.get('x-middleware-rewrite');
  });
  assert.equal(target(undefined, 'http://ui.test/api/health'), 'http://127.0.0.1:4000/health');
  assert.equal(target('http://127.0.0.1:3301', 'http://ui.test/api/servers/a%20b/stream?since=1&x=%2F'),
    'http://127.0.0.1:3301/servers/a%20b/stream?since=1&x=%2F');
  assert.equal(target('http://127.0.0.1:3301', 'http://ui.test/api'), 'http://127.0.0.1:3301/');
  // A crafted path must not change the destination host.
  assert.equal(new URL(target('http://127.0.0.1:3301', 'http://ui.test/api//evil.test/x')).host, '127.0.0.1:3301');
  for (const value of ['http://user:pass@host', 'http://host/private', 'ftp://host', 'http://host?secret=1']) {
    assert.throws(() => withBackendUrl(value, () => load('src/proxy.ts', __dirname)), /origin/);
  }
});
