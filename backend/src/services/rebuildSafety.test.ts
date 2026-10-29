import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rebuild-safe-'));
process.env.DATA_ROOT = root;
process.env.SQLITE_PATH = path.join(root, 'test.sqlite');
const { prepareServer } = require('./prepareService');
const { dockerService } = require('./dockerService');
const { db } = require('../db');
const AdmZip = require('adm-zip');
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
function fixture(t: any, id: string, entries: Record<string, string>) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) zip.addFile(name, Buffer.from(content));
  const archive = path.join(root, `${id}.zip`); zip.writeZip(archive);
  t.mock.method(dockerService, 'ensureRunnableImage', async () => 'test:java');
  t.mock.method(dockerService, 'createOrReplaceContainer', async () => 'test-container');
  const pack = path.join(root, 'servers', id, 'pack');
  const write = (name: string, content: string) => {
    const file = path.join(pack, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
  };
  const read = (name: string) => fs.readFileSync(path.join(pack, name), 'utf8');
  const server = { id, name: id, serverPackUrl: archive, serverPort: 25566, resources: { minRamMb: 512, maxRamMb: 2048 }, game: {} };
  return { server, pack, write, read, archive };
}

test('nested custom worlds and separate dimensions survive a change in pack layout', async t => {
  const f = fixture(t, 'nested', { 'new/start.sh': 'echo updated', 'new/server.properties': 'level-name=world', 'new/myworld/level.dat': 'bundled stale world' });
  f.write('old/start.sh', 'echo old');
  f.write('old/server.properties', 'level-name=myworld');
  f.write('old/myworld/level.dat', 'current progress');
  f.write('old/myworld_nether/region/r.0.0.mca', 'nether');
  f.write('old/extra-world/level.dat', 'plugin world');
  await prepareServer(f.server);
  assert.equal(f.read('new/myworld/level.dat'), 'current progress');
  assert.equal(f.read('new/myworld_nether/region/r.0.0.mca'), 'nether');
  assert.equal(f.read('new/extra-world/level.dat'), 'plugin world');
  assert.match(f.read('new/server.properties'), /level-name=myworld/);
  const options = dockerService.createOrReplaceContainer.mock.calls[0].arguments[1];
  assert.equal(options.workdir, '/server/pack/new');
});

test('bundled saves cannot overwrite existing progress or merge obsolete chunks into it', async t => {
  const f = fixture(t, 'bundled', { 'start.sh': 'echo new', 'world/level.dat': 'stale', 'world/region/obsolete.mca': 'stale chunk' });
  f.write('start.sh', 'echo old'); f.write('world/level.dat', 'progress');
  await prepareServer(f.server);
  assert.equal(f.read('world/level.dat'), 'progress');
  assert.equal(fs.existsSync(path.join(f.pack, 'world/region/obsolete.mca')), false);
});

for (const failure of ['corrupt-zip', 'missing-launcher', 'image', 'world-copy', 'container']) {
  test(`failed rebuild preserves the complete old installation: ${failure}`, async t => {
    const f = fixture(t, failure, failure === 'missing-launcher' ? { 'notes.txt': 'no launcher' } : { 'start.sh': 'echo new' });
    f.write('start.sh', 'echo old'); f.write('custom/level.dat', 'progress'); f.write('server.properties', 'level-name=custom');
    if (failure === 'corrupt-zip') fs.writeFileSync(f.archive, 'bad zip');
    if (failure === 'image') t.mock.method(dockerService, 'ensureRunnableImage', async () => { throw Error('pull failed'); });
    if (failure === 'world-copy') t.mock.method(fsp, 'cp', async () => { throw Object.assign(Error('disk full'), { code: 'ENOSPC' }); });
    if (failure === 'container') t.mock.method(dockerService, 'createOrReplaceContainer', async () => { throw Error('Docker failed'); });
    await assert.rejects(prepareServer(f.server));
    assert.equal(f.read('start.sh'), 'echo old');
    assert.equal(f.read('custom/level.dat'), 'progress');
    assert.equal(f.read('server.properties'), 'level-name=custom');
    assert.deepEqual(fs.readdirSync(path.dirname(f.pack)).sort(), ['downloads', 'pack']);
  });
}

test('interrupted publication retains the previous pack and blocks another rebuild', async t => {
  const f = fixture(t, 'interrupted', { 'start.sh': 'echo new' });
  f.write('world/level.dat', 'progress');
  fs.renameSync(f.pack, path.join(path.dirname(f.pack), '.pack-before-rebuild'));
  await assert.rejects(prepareServer(f.server), /interrupted rebuild/);
  assert.equal(fs.readFileSync(path.join(path.dirname(f.pack), '.pack-before-rebuild/world/level.dat'), 'utf8'), 'progress');
});
