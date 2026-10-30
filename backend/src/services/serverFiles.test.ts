import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-file-access-'));
fs.chmodSync(root, 0o755);
const uid = process.getuid!() === 0 ? 2345 : process.getuid!();
const gid = process.getuid!() === 0 ? 3456 : process.getgid!();
process.env.DATA_ROOT = root;
process.env.SQLITE_PATH = path.join(root, 'test.sqlite');
process.env.MC_CONTAINER_USER = `${uid}:${gid}`;
const { prepareServerFiles, writeServerFile } = require('./serverFiles');
const { prepareServer, recreateContainer, applyConfigFiles, ensurePreparedModDependencies } = require('./prepareService');
const { dockerService } = require('./dockerService');
const { createSnapshot, restoreSnapshot, importSnapshotArchive } = require('./snapshotService');
const { config } = require('../config');
const { db } = require('../db');
const AdmZip = require('adm-zip');
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

function file(id: string, relative: string, content = 'original') {
  const dest = path.join(root, 'servers', id, relative);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
  return dest;
}
function assertOwned(dir: string) {
  const stat = fs.lstatSync(dir);
  assert.equal(stat.uid, uid, dir); assert.equal(stat.gid, gid, dir);
  assert.equal(stat.mode & (stat.isDirectory() ? 0o700 : 0o600), stat.isDirectory() ? 0o700 : 0o600);
  if (stat.isDirectory()) for (const name of fs.readdirSync(dir)) assertOwned(path.join(dir, name));
}
function assertModCanWrite(dir: string) {
  execFileSync(process.execPath, ['-e',
    'const fs=require("fs");fs.writeFileSync(process.argv[1]+"/armor.json.tmp","saved");fs.renameSync(process.argv[1]+"/armor.json.tmp",process.argv[1]+"/armor.json");', dir,
  ], { uid, gid });
}

test('prepare, update, recreate and start preparation leave Minecraft-writable files', async t => {
  const zip = new AdmZip();
  zip.addFile('start.sh', Buffer.from('#!/bin/sh\njava @user_jvm_args.txt -jar server.jar\n'));
  zip.addFile('user_jvm_args.txt', Buffer.from('-Xmx2000M'));
  zip.addFile('config/attributefix/minecraft/armor.json', Buffer.from('{}'));
  const archive = path.join(root, 'pack.zip'); zip.writeZip(archive);
  const server = { id: 'permissions', serverPackUrl: archive, serverPort: 25565, resources: { minRamMb: 512, maxRamMb: 10000 }, game: {} };
  const pack = path.join(root, 'servers', server.id, 'pack');
  t.mock.method(dockerService, 'ensureRunnableImage', async () => 'test:java');
  t.mock.method(dockerService, 'createOrReplaceContainer', async () => {
    assertOwned(pack);
    assertModCanWrite(path.join(pack, 'config/attributefix/minecraft'));
    return 'test-container';
  });
  await prepareServer(server);
  assert.match(fs.readFileSync(path.join(pack, 'user_jvm_args.txt'), 'utf8'), /-Xmx8696M/);
  file(server.id, 'pack/world/level.dat', 'world to preserve');
  await prepareServer(server); // pack update re-extracts root-owned files
  assert.equal(fs.readFileSync(path.join(pack, 'world/level.dat'), 'utf8'), 'world to preserve');
  fs.unlinkSync(path.join(pack, 'eula.txt'));
  await recreateContainer(server);
  fs.unlinkSync(path.join(pack, 'server.properties'));
  await applyConfigFiles(server); // settings edits can also create files
  file(server.id, 'pack/config/new-mod/settings.json');
  await ensurePreparedModDependencies(server); // repairs pre-existing root files
  assertOwned(pack);
});

test('snapshot import and restore normalize archive ownership and preserve world data', async () => {
  const server = { id: 'snapshot-access', name: 'Snapshot', status: 'stopped' };
  const world = file(server.id, 'pack/world/level.dat', 'saved world');
  const snapshot = await createSnapshot(server);
  fs.writeFileSync(world, 'changed world');
  await restoreSnapshot(server, snapshot.id);
  assert.equal(fs.readFileSync(world, 'utf8'), 'saved world');
  assertOwned(path.dirname(world));
  const archive = path.join(root, 'servers', server.id, 'snapshots', snapshot.fileName);
  await importSnapshotArchive('import-access', archive);
  assertOwned(path.join(root, 'servers/import-access/pack'));
});

test('ownership repair and writes refuse links without modifying their targets', async () => {
  const outside = path.join(root, 'outside'); fs.writeFileSync(outside, 'untouched');
  const original = fs.statSync(outside);
  file('links', 'pack/safe.txt');
  const link = path.join(root, 'servers/links/pack/linked');
  for (const hard of [false, true]) {
    if (hard) fs.linkSync(outside, link); else fs.symlinkSync(outside, link);
    await assert.rejects(prepareServerFiles('links'), /Unsafe server file/);
    await assert.rejects(writeServerFile(link, 'changed'), /Unsafe server file/);
    fs.unlinkSync(link);
  }
  fs.symlinkSync(path.dirname(outside), link);
  await assert.rejects(writeServerFile(path.join(link, 'outside'), 'changed'), /Unsafe server file/);
  fs.unlinkSync(link);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
  assert.equal(fs.statSync(outside).uid, original.uid);
  assert.equal(fs.statSync(outside).mode, original.mode);
  await assert.rejects(prepareServerFiles('../outside'), /Invalid server/);
  await assert.rejects(writeServerFile(outside, 'changed'), /outside a managed/);
});

test('invalid ownership configuration fails visibly before Docker creation', async () => {
  const target = file('invalid-owner', 'pack/server.properties');
  const previous = config.containerUser;
  try {
    config.containerUser = 'unresolved-user';
    await assert.rejects(writeServerFile(target, 'modified'), /numeric uid:gid/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  } finally { config.containerUser = previous; }
});

test('a generated launch script follows changes to the total RAM limit', async t => {
  const server = { id: 'generated', serverPort: 25565, resources: { minRamMb: 512, maxRamMb: 10000 }, game: {} };
  file(server.id, 'pack/server.jar', 'jar fixture');
  t.mock.method(dockerService, 'ensureRunnableImage', async () => 'test:java');
  t.mock.method(dockerService, 'createOrReplaceContainer', async () => 'test-container');
  await recreateContainer(server);
  const script = path.join(root, 'servers', server.id, 'pack/start.sh');
  assert.match(fs.readFileSync(script, 'utf8'), /-Xmx8696M/);
  server.resources.maxRamMb = 4096;
  await applyConfigFiles(server);
  assert.match(fs.readFileSync(script, 'utf8'), /-Xmx3562M/);
});

test('snapshot imports reject symbolic and hard links before extracting files', async () => {
  for (const hard of [false, true]) {
    const source = fs.mkdtempSync(path.join(root, 'archive-'));
    fs.mkdirSync(path.join(source, 'pack'));
    fs.writeFileSync(path.join(source, 'pack/target'), 'data');
    if (hard) fs.linkSync(path.join(source, 'pack/target'), path.join(source, 'pack/link'));
    else fs.symlinkSync('/etc/passwd', path.join(source, 'pack/link'));
    const archive = path.join(root, `links-${hard}.tar`);
    // Build hostile link fixtures independently of the snapshot producer.
    // npm tar's async packer can fail internally on hard-link inputs.
    execFileSync('tar', ['-cf', archive, '-C', source, 'pack']);
    await assert.rejects(importSnapshotArchive(`unsafe-${hard}`, archive), /Unsafe snapshot entry/);
    assert.equal(fs.existsSync(path.join(root, 'servers', `unsafe-${hard}`, 'pack/target')), false);
  }
});

test('descriptor-relative operations resist directory races and preserve files on write failure', () => {
  execFileSync('python3', [path.join(__dirname, 'serverFileWorker.test.py')], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
});

test('storage measures allocated server files and snapshots without following links or counting hard links twice', async () => {
  const { serverStorageUsage } = require('./serverFiles');
  const id = 'storage';
  const world = file(id, 'pack/world/region.mca', 'data'.repeat(4096));
  const snapshot = file(id, 'snapshots/backup.zip', 'zip'.repeat(2048));
  const outside = file('outside-storage', 'large', 'outside'.repeat(8192));
  fs.symlinkSync(path.dirname(outside), path.join(root, 'servers', id, 'outside-link'));
  fs.linkSync(world, path.join(root, 'servers', id, 'pack', 'world-hardlink'));
  const sparse = file(id, 'pack/sparse'); fs.truncateSync(sparse, 64 * 1024 ** 2);
  const allocated = (file: string) => fs.lstatSync(file).blocks * 512;
  const pack = path.join(root, 'servers', id, 'pack');
  const expectedFiles = [path.join(root, 'servers', id), pack, path.dirname(world), world, sparse, path.join(root, 'servers', id, 'outside-link')].reduce((sum, f) => sum + allocated(f), 0);
  const usage = await serverStorageUsage(id);
  assert.equal(usage.filesBytes, expectedFiles);
  assert.equal(usage.snapshotsBytes, allocated(path.dirname(snapshot)) + allocated(snapshot));
  assert.equal(usage.totalBytes, usage.filesBytes + usage.snapshotsBytes);
  assert.ok(usage.totalBytes < 64 * 1024 ** 2, 'sparse file size is not allocated disk space');
  assert.equal(await serverStorageUsage(id), usage, 'repeat requests reuse the recent scan');
});
