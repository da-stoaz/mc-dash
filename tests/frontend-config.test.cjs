const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const frontendRequire = createRequire(path.join(__dirname, '../frontend/package.json'));
const ts = frontendRequire('typescript');
const source = fs.readFileSync(path.join(__dirname, '../frontend/next.config.ts'), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

test('frontend roots and same-origin proxy are explicit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-next-config-'));
  const previous = process.env.MC_DASH_BACKEND_URL;
  const load = () => {
    const module = { exports: {} };
    new Function('require', 'module', 'exports', '__dirname', code)(require, module, module.exports, dir);
    return module.exports.default;
  };
  try {
    delete process.env.MC_DASH_BACKEND_URL;
    const dev = load();
    assert.equal(dev.turbopack.root, dir);
    assert.equal(dev.outputFileTracingRoot, dir);
    assert.equal((await dev.rewrites())[0].destination, 'http://127.0.0.1:4000/:path*');
    process.env.MC_DASH_BACKEND_URL = 'http://127.0.0.1:3301';
    const prod = load();
    assert.equal((await prod.rewrites())[0].destination, 'http://127.0.0.1:3301/:path*');
    assert.equal(prod.env, undefined, 'server config must not enter client bundles');
    for (const value of ['http://user:pass@host', 'http://host/private', 'ftp://host', 'http://host?secret=1']) {
      process.env.MC_DASH_BACKEND_URL = value;
      assert.throws(load, /origin/);
    }
  } finally {
    if (previous === undefined) delete process.env.MC_DASH_BACKEND_URL;
    else process.env.MC_DASH_BACKEND_URL = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
