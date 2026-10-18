import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
import { ensureModDependencies } from './modDependencyService';
import { Artifact, DependencySources } from './modDependencySources';
import { detectModRuntime, matches, Mod, readMods, Requirement, Runtime } from './modMetadata';

function forge(id: string, version: string, deps: Record<string, string> = {}, extras: Record<string, Buffer | string> = {}) {
  const zip = new AdmZip();
  zip.addFile('META-INF/mods.toml', Buffer.from(`modLoader="javafml"\nloaderVersion="[47,)"\nlicense="test"\n[[mods]]\nmodId="${id}"\nversion="${version}"\n` + Object.entries(deps).map(([id2, range]) => `[[dependencies.${id}]]\nmodId="${id2}"\nmandatory=true\nversionRange="${range}"\nside="BOTH"\n`).join('')));
  for (const [name, data] of Object.entries(extras)) zip.addFile(name, Buffer.from(data));
  return zip.toBuffer();
}
function fabric(id: string, version: string, deps: Record<string, any> = {}, extra: Record<string, any> = {}, files: Record<string, Buffer> = {}) {
  const zip = new AdmZip();
  zip.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ schemaVersion: 1, id, version, depends: deps, ...extra })));
  for (const [name, data] of Object.entries(files)) zip.addFile(name, data);
  return zip.toBuffer();
}
async function pack(t: any, jars: Record<string, Buffer>, vars = 'MINECRAFT_VERSION=1.20.1\nMODLOADER=Forge\nMODLOADER_VERSION=47.4.18\n') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-dash-deps-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'mods'));
  if (vars) await fs.writeFile(path.join(root, 'variables.txt'), vars);
  for (const [name, data] of Object.entries(jars)) await fs.writeFile(path.join(root, 'mods', name), data);
  return root;
}
class Fixtures extends DependencySources {
  requested: string[] = [];
  constructor(private jars: Record<string, Buffer[]>) { super(); }
  override async *candidates(req: Requirement, _runtime: Runtime, _parents: Mod[]) {
    this.requested.push(req.id);
    for (let i = 0; i < (this.jars[req.id]?.length ?? 0); i++) yield { filename: `${req.id}-${i}.jar`, url: `https://cdn.modrinth.com/${req.id}/${i}`, hashes: {}, source: 'fixture' };
  }
  override async download(a: Artifact) {
    const [id, index] = new URL(a.url).pathname.slice(1).split('/');
    return this.jars[id][Number(index)];
  }
}

test('Maven ranges respect inclusive/exclusive bounds, exact versions, unions and numeric components', () => {
  for (const [version, range, expected] of [
    ['1.3.0', '[1.3.0,)', true], ['1.2.9', '[1.3.0,)', false], ['2.0', '[1.3,2.0)', false],
    ['1.20.1', '[1.20.1]', true], ['1.20.2', '[1.20.1]', false], ['1.3', '(,1.2],[1.3,)', true],
    ['1.2.3.10', '[1.2.3.9,)', true], ['1.3.0-beta', '[1.3.0,)', undefined], ['1.3.0-beta', '[1.3.0]', undefined],
    ['1.0', '(, 1.1)', true],
  ] as const) assert.equal(matches(version, range, 'maven'), expected, `${version} ${range}`);
  assert.equal(matches('1.4.0', ['>=1.3.0 <2', '>=3'], 'fabric'), true);
  assert.equal(matches('2.1.0', ['>=1.3.0 <2', '>=3'], 'fabric'), false);
  assert.equal(matches('0.9.0', '^0.1.0', 'fabric'), true);
  assert.equal(matches('1.0.0-beta', '^0.1.0', 'fabric'), false);
  assert.equal(matches('1.2.1', '1.2', 'fabric'), false);
  assert.equal(matches('1.2.0', '1.2', 'fabric'), true);
  assert.equal(matches('1.2.3.4', '>=1.2.3.3', 'fabric'), true);
  assert.equal(matches('1.3.0-rc1', '>=1.2.0', 'fabric'), true);
  assert.equal(matches('1.3.0-rc1', '~1.2.0', 'fabric'), false);
  assert.equal(matches('1.2.0-alpha.1', '1.2.x', 'fabric'), true);
  assert.equal(matches('release-string', '=release-string', 'fabric'), true);
});

test('bundled dependencies, provides aliases and client-only declarations are respected', () => {
  const nested = fabric('lib', '1.3.0', {}, { provides: ['lib_alias'] });
  const jar = fabric('root', '1.0.0', { lib_alias: '>=1.3.0' }, { jars: [{ file: 'META-INF/jars/lib.jar' }] }, { 'META-INF/jars/lib.jar': nested });
  assert.deepEqual(readMods(jar, 'a.jar').map(m => [m.id, m.embedded]), [['root', false], ['lib', true], ['lib_alias', true]]);
  assert.deepEqual(readMods(fabric('client', '1', { unavailable: '*' }, { environment: 'client' }), 'client.jar'), []);
  const root = forge('root', '${file.jarVersion}', {}, {
    'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\r\nImplementation-Version: 2.3.4\r\n',
    'META-INF/jarjar/metadata.json': JSON.stringify({ jars: [{ path: 'META-INF/jarjar/lib.jar' }] }),
    'META-INF/jarjar/lib.jar': forge('lib', '1.0'),
  });
  assert.deepEqual(readMods(root, 'f.jar').map(m => [m.id, m.version, m.embedded]), [['root', '2.3.4', false], ['lib', '1.0', true]]);
});

test('repairs the reported NightLib failure including Architectury, then works offline on the next start', async t => {
  const root = await pack(t, { 'portals.jar': forge('customnetherportals', '3.0.0', { nightlib: '[1.3.0,)' }) });
  const sources = new Fixtures({
    nightlib: [forge('nightlib', '1.3.0', { architectury: '[9.2.14,)', forge: '[47,)', minecraft: '[1.20.1,)' })],
    architectury: [forge('architectury', '9.2.14')],
  });
  assert.deepEqual((await ensureModDependencies(root, sources)).installed, ['nightlib-0.jar', 'architectury-0.jar']);
  assert.deepEqual(sources.requested, ['nightlib', 'architectury']);
  const offline = new Fixtures({});
  assert.deepEqual(await ensureModDependencies(root, offline), { installed: [] });
  assert.deepEqual(offline.requested, []);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, '.mc-dash-dependencies.json'), 'utf8')).installed.length, 2);
});

test('backtracks when a newer candidate introduces a transitive version conflict', async t => {
  const root = await pack(t, { 'root.jar': forge('root', '1', { lib: '[1,)', shared: '[1,2)' }), 'shared.jar': forge('shared', '1.5') });
  const sources = new Fixtures({ lib: [forge('lib', '2', { shared: '[2,)' }), forge('lib', '1', { shared: '[1,2)' })] });
  assert.deepEqual((await ensureModDependencies(root, sources)).installed, ['lib-1.jar']);
  assert.equal((await fs.readdir(path.join(root, 'mods'))).includes('lib-0.jar'), false);
});

test('skips wrong IDs, versions, Minecraft versions and loaders before choosing a compatible JAR', async t => {
  const root = await pack(t, { 'root.jar': forge('root', '1', { lib: '[2,3)' }) });
  const sources = new Fixtures({ lib: [forge('other', '2'), forge('lib', '1'), fabric('lib', '2'), forge('lib', '2', { minecraft: '[1.21,)' }), forge('lib', '2')] });
  assert.deepEqual((await ensureModDependencies(root, sources)).installed, ['lib-4.jar']);
});

test('all owners must agree on a dependency version and existing incompatible mods are preserved', async t => {
  const old = forge('lib', '1.0');
  const root = await pack(t, { 'root.jar': forge('root', '1', { lib: '[2,)' }), 'lib.jar': old });
  await assert.rejects(ensureModDependencies(root, new Fixtures({ lib: [forge('lib', '2')] })), /Mod dependency check failed/);
  assert.deepEqual(await fs.readFile(path.join(root, 'mods/lib.jar')), old);
  const other = await pack(t, { 'a.jar': forge('a', '1', { lib: '[1,2)' }), 'b.jar': forge('b', '1', { lib: '[2,3)' }) });
  await assert.rejects(ensureModDependencies(other, new Fixtures({ lib: [forge('lib', '1.5'), forge('lib', '2.5')] })));
  assert.deepEqual(await fs.readdir(path.join(other, 'mods')), ['a.jar', 'b.jar']);
});

test('failed recursive resolution rolls back every new JAR and cleans staging files', async t => {
  const original = forge('root', '1', { lib: '[1,)' });
  const root = await pack(t, { 'root.jar': original });
  await assert.rejects(ensureModDependencies(root, new Fixtures({ lib: [forge('lib', '1', { unavailable: '[1,)' })] })));
  assert.deepEqual(await fs.readdir(root), ['mods', 'variables.txt']);
  assert.deepEqual(await fs.readdir(path.join(root, 'mods')), ['root.jar']);
  assert.deepEqual(await fs.readFile(path.join(root, 'mods/root.jar')), original);
});

test('new transitive constraints cannot approve an unknown downloaded version comparison', async t => {
  const root = await pack(t, { 'root.jar': forge('root', '1', { lib: '*' }) });
  const sources = new Fixtures({ lib: [forge('lib', '1.0-beta', { child: '*' })], child: [forge('child', '1', { lib: '[1.0,)' })] });
  await assert.rejects(ensureModDependencies(root, sources));
  assert.deepEqual(await fs.readdir(path.join(root, 'mods')), ['root.jar']);
});

test('Fabric optional dependencies and client-only mods do not trigger downloads; cycles terminate', async t => {
  const root = await pack(t, {
    'a.jar': fabric('a', '1.0.0', { b: '>=1.0.0' }, { recommends: { absent: '*' } }),
    'client.jar': fabric('client', '1.0.0', { absent: '*' }, { environment: 'client' }),
  }, 'MINECRAFT_VERSION=1.20.1\nMODLOADER=Fabric\nMODLOADER_VERSION=0.16.0\n');
  const source = new Fixtures({ b: [fabric('b', '1.0.0', { a: '>=1.0.0' })] });
  assert.deepEqual((await ensureModDependencies(root, source)).installed, ['b-0.jar']);
  assert.deepEqual(source.requested, ['b']);
});

test('Forge embedded dependencies satisfy missing-mod checks without network', async t => {
  const root = await pack(t, { 'root.jar': forge('root', '1', { lib: '[1,)' }, {
    'META-INF/jarjar/metadata.json': JSON.stringify({ jars: [{ path: 'META-INF/jarjar/lib.jar' }] }),
    'META-INF/jarjar/lib.jar': forge('lib', '1'),
  }) });
  const sources = new Fixtures({});
  assert.deepEqual(await ensureModDependencies(root, sources), { installed: [] });
  assert.deepEqual(sources.requested, []);
});

test('missing runtime information and corrupt JARs produce actionable errors', async t => {
  const root = await pack(t, { 'root.jar': forge('root', '1', { missing: '[1,)' }) }, '');
  await assert.rejects(ensureModDependencies(root, new Fixtures({})), (err: any) => err.code === 'MOD_DEPENDENCY_UNRESOLVED' && /could not be determined/.test(err.reason));
  await fs.writeFile(path.join(root, 'mods/broken.jar'), 'not a jar');
  await assert.rejects(ensureModDependencies(root, new Fixtures({})), (err: any) => /Cannot inspect broken.jar/.test(err.reason));
});

test('installed Forge arguments override stale variables and manifest detection supports a fresh pack', async t => {
  const root = await pack(t, {});
  const lib = path.join(root, 'libraries/net/minecraftforge/forge/1.20.1-47.4.18');
  await fs.mkdir(lib, { recursive: true });
  await fs.writeFile(path.join(root, 'variables.txt'), 'MINECRAFT_VERSION=1.21\nMODLOADER=Fabric\n');
  await fs.writeFile(path.join(lib, 'unix_args.txt'), '--fml.mcVersion\n1.20.1\n');
  assert.deepEqual(await detectModRuntime(root), { minecraft: '1.20.1', loader: 'forge', loaderVersion: '47.4.18' });
  await fs.rm(path.join(root, 'libraries'), { recursive: true });
  await fs.rm(path.join(root, 'variables.txt'));
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({ minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.4.18', primary: true }] } }));
  assert.deepEqual(await detectModRuntime(root), { minecraft: '1.20.1', loader: 'forge', loaderVersion: '47.4.18' });
});

test('download verifies checksums, sizes and trusted paths before writing anything', async () => {
  const bytes = forge('lib', '1');
  const hash = crypto.createHash('sha512').update(bytes).digest('hex');
  const fetcher = (async () => new Response(bytes)) as typeof fetch;
  const source = new DependencySources(fetcher);
  const artifact: Artifact = { filename: 'lib.jar', url: 'https://cdn.modrinth.com/data/lib.jar', hashes: { sha512: hash }, source: 'test' };
  assert.deepEqual(await source.download(artifact), bytes);
  await assert.rejects(source.download({ ...artifact, hashes: { sha512: '0'.repeat(128) } }), /Checksum mismatch/);
  await assert.rejects(source.download({ ...artifact, size: 1 }), /Size mismatch/);
  await assert.rejects(source.download({ ...artifact, filename: '../lib.jar' }), /Unsafe/);
  await assert.rejects(source.download({ ...artifact, url: 'http://127.0.0.1/lib.jar' }), /Untrusted/);
  await assert.rejects(source.download({ ...artifact, hashes: {} }), /verifiable checksum/);
});

test('HTTP retries transient failures but not forbidden responses', async () => {
  const bytes = Buffer.from('jar');
  const artifact: Artifact = { filename: 'lib.jar', url: 'https://cdn.modrinth.com/a.jar', hashes: { sha1: crypto.createHash('sha1').update(bytes).digest('hex') }, source: 'test' };
  let calls = 0;
  const source = new DependencySources((async () => ++calls === 1 ? new Response('', { status: 503 }) : new Response(bytes)) as typeof fetch);
  assert.deepEqual(await source.download(artifact), bytes);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(new DependencySources((async () => { calls++; return new Response('', { status: 403 }); }) as typeof fetch).download(artifact), /HTTP 403/);
  assert.equal(calls, 1);
});

test('CDN redirects are supported and every redirect target is checked', async () => {
  const bytes = Buffer.from('jar');
  const artifact: Artifact = { filename: 'lib.jar', url: 'https://edge.forgecdn.net/a.jar', hashes: { sha1: crypto.createHash('sha1').update(bytes).digest('hex') }, source: 'test' };
  const urls: string[] = [];
  const fetcher = (async (url: string) => {
    urls.push(url);
    return url.includes('edge.') ? new Response('', { status: 302, headers: { location: 'https://mediafilez.forgecdn.net/a.jar' } }) : new Response(bytes);
  }) as typeof fetch;
  assert.deepEqual(await new DependencySources(fetcher).download(artifact), bytes);
  assert.deepEqual(urls, ['https://edge.forgecdn.net/a.jar', 'https://mediafilez.forgecdn.net/a.jar']);
  let calls = 0;
  const unsafe = (async () => { calls++; return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/secrets.jar' } }); }) as typeof fetch;
  await assert.rejects(new DependencySources(unsafe).download(artifact), /Untrusted/);
  assert.equal(calls, 1);
});

test('Modrinth uses parent file hashes to discover dependencies whose project slug differs from the mod ID', async t => {
  const parentJar = forge('parent', '1', { internal_id: '[1,)' });
  const root = await pack(t, { 'parent.jar': parentJar });
  const dependency = forge('internal_id', '1.0');
  const artifact = { filename: 'library.jar', url: 'https://cdn.modrinth.com/library.jar', primary: true, hashes: { sha1: crypto.createHash('sha1').update(dependency).digest('hex') } };
  const hash = crypto.createHash('sha1').update(parentJar).digest('hex');
  const urls: string[] = [];
  const fetcher = (async (url: string) => {
    urls.push(url);
    if (url.includes(`/version_file/${hash}`)) return new Response(JSON.stringify({ dependencies: [{ dependency_type: 'required', version_id: 'PINNED', project_id: 'different-slug' }] }));
    if (url.endsWith('/version/PINNED')) return new Response(JSON.stringify({ id: 'PINNED', project_id: 'different-slug', game_versions: ['1.20.1'], loaders: ['forge'], version_type: 'release', files: [artifact] }));
    if (url === artifact.url) return new Response(dependency);
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  const sources = new DependencySources(fetcher, '');
  assert.deepEqual((await ensureModDependencies(root, sources)).installed, ['library.jar']);
  assert.equal(urls.length, 3);
});

test('CurseForge-only dependencies use the configured key, loader/version filters, and official checksum', async t => {
  const root = await pack(t, { 'root.jar': forge('root', '1', { curse_lib: '[1,)' }) });
  const jar = forge('curse_lib', '1.2');
  const urls: string[] = [];
  const fetcher = (async (url: string, opts: any) => {
    urls.push(url);
    if (url.startsWith('https://api.modrinth.com')) return new Response('', { status: 404 });
    if (url.startsWith('https://api.curseforge.com')) {
      assert.equal(opts.headers['x-api-key'], 'test-key');
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get('gameVersion'), '1.20.1');
      assert.equal(parsed.searchParams.get('modLoaderType'), '1');
      if (parsed.pathname.endsWith('/mods/search')) return new Response(JSON.stringify({ data: [{ id: 123 }] }));
      return new Response(JSON.stringify({ data: [{ fileName: 'curse.jar', downloadUrl: 'https://mediafilez.forgecdn.net/curse.jar', gameVersions: ['1.20.1', 'Forge'], fileLength: jar.length, hashes: [{ algo: 1, value: crypto.createHash('sha1').update(jar).digest('hex') }], id: 456 }] }));
    }
    assert.equal(opts.headers['x-api-key'], undefined);
    return new Response(jar);
  }) as typeof fetch;
  assert.deepEqual((await ensureModDependencies(root, new DependencySources(fetcher, 'test-key'))).installed, ['curse.jar']);
  assert.ok(urls.some(url => url.includes('/mods/123/files')));
});

test('NeoForge required/incompatible metadata and Forge client-only dependency declarations are understood', () => {
  const zip = new AdmZip();
  zip.addFile('META-INF/neoforge.mods.toml', Buffer.from('modLoader="javafml"\nloaderVersion="[1,)"\n[[mods]]\nmodId="neo"\nversion="1"\n[[dependencies.neo]]\nmodId="required"\ntype="required"\nversionRange="[1,)"\n[[dependencies.neo]]\nmodId="bad"\ntype="incompatible"\nversionRange="[1,)"\n[[dependencies.neo]]\nmodId="client"\ntype="required"\nside="CLIENT"\n'));
  const [mod] = readMods(zip.toBuffer(), 'neo.jar');
  assert.equal(mod.loader, 'neoforge');
  assert.deepEqual(mod.requirements.map(r => r.id), ['required']);
  assert.deepEqual(mod.conflicts.map(r => r.id), ['bad']);
});
