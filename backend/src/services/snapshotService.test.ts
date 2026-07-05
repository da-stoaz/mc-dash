import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import * as tar from 'tar';

// Point the app's data root at a throwaway dir BEFORE loading config/store, then
// require the modules so they read this env. (require runs here, after the env
// is set, unlike hoisted imports.)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdash-snap-'));
process.env.DATA_ROOT = TMP;
// Pin the SQLite DB inside the temp dir too, so a fixed SQLITE_PATH in a local
// .env can't leak state between test runs.
process.env.SQLITE_PATH = path.join(TMP, 'test.sqlite');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createSnapshot, restoreSnapshot, deleteSnapshot, importSnapshotArchive } = require('./snapshotService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { purgeServerData } = require('./prepareService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { serverStore } = require('../serverStore');

after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

function serverRoot(id: string): string {
  return path.join(TMP, 'servers', id);
}

function writeFile(id: string, rel: string, content: string): void {
  const p = path.join(serverRoot(id), rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const fakeServer = (id: string) => ({ id, name: 'Test', status: 'stopped' }) as any;

test('snapshot + restore round-trips full server data and preserves history', async () => {
  const id = 'srv-roundtrip';
  writeFile(id, 'server.properties', 'online-mode=true\n');
  writeFile(id, 'world/level.dat', 'ORIGINAL');
  writeFile(id, 'mods/cool.jar', 'JARDATA');

  const snap = await createSnapshot(fakeServer(id), { label: 'v1' });
  assert.ok(snap.sizeBytes > 0);
  assert.ok(fs.existsSync(path.join(serverRoot(id), 'snapshots', snap.fileName)));

  // Mutate the live data after taking the snapshot.
  writeFile(id, 'world/level.dat', 'CHANGED');
  fs.rmSync(path.join(serverRoot(id), 'mods/cool.jar'));
  writeFile(id, 'world/junk.dat', 'JUNK');

  const result = await restoreSnapshot(fakeServer(id), snap.id);
  assert.equal(result.safetySnapshot.kind, 'auto-pre-restore');

  // Original content is restored exactly...
  assert.equal(fs.readFileSync(path.join(serverRoot(id), 'world/level.dat'), 'utf8'), 'ORIGINAL');
  assert.equal(fs.readFileSync(path.join(serverRoot(id), 'mods/cool.jar'), 'utf8'), 'JARDATA');
  // ...and files created after the snapshot are gone.
  assert.ok(!fs.existsSync(path.join(serverRoot(id), 'world/junk.dat')));

  // History is preserved: the original snapshot + the pre-restore safety backup.
  assert.equal(serverStore.listSnapshots(id).length, 2);
});

test('snapshot excludes the snapshots/ directory (no self-inclusion)', async () => {
  const id = 'srv-exclude';
  writeFile(id, 'world/level.dat', 'W');
  await createSnapshot(fakeServer(id), { label: 'first' });
  const second = await createSnapshot(fakeServer(id), { label: 'second' });

  const archive = path.join(serverRoot(id), 'snapshots', second.fileName);
  const paths: string[] = [];
  await tar.list({ file: archive, onentry: (entry) => paths.push(entry.path) });
  assert.ok(
    !paths.some((p) => p.replace(/^\.\//, '').split('/')[0] === 'snapshots'),
    `archive must not contain snapshots/:\n${paths.join('\n')}`
  );
});

test('import extracts a snapshot archive into a fresh server root', async () => {
  const source = 'srv-import-src';
  writeFile(source, 'pack/server.properties', 'level-seed=42\n');
  writeFile(source, 'pack/world/level.dat', 'WORLD');
  const snap = await createSnapshot(fakeServer(source), { label: 'export' });
  const archive = path.join(serverRoot(source), 'snapshots', snap.fileName);

  const target = 'srv-import-dst';
  await importSnapshotArchive(target, archive);

  // World + config land under the new server root, ready for recreateContainer.
  assert.equal(fs.readFileSync(path.join(serverRoot(target), 'pack/world/level.dat'), 'utf8'), 'WORLD');
  assert.equal(fs.readFileSync(path.join(serverRoot(target), 'pack/server.properties'), 'utf8'), 'level-seed=42\n');
});

test('import rejects an archive that is not a server snapshot (no pack/)', async () => {
  const bogus = path.join(TMP, 'bogus.tar.gz');
  const stray = fs.mkdtempSync(path.join(TMP, 'stray-'));
  fs.writeFileSync(path.join(stray, 'notes.txt'), 'hello');
  await tar.create({ gzip: true, file: bogus, cwd: stray, portable: true }, ['notes.txt']);

  await assert.rejects(() => importSnapshotArchive('srv-import-bad', bogus), /not a valid MC Dash server snapshot/);
});

test('purgeServerData removes the server root and the uploaded pack', async () => {
  const id = 'srv-purge';
  writeFile(id, 'pack/world/level.dat', 'W');
  const upload = path.join(TMP, 'uploads', `${id}-pack.zip`);
  fs.mkdirSync(path.dirname(upload), { recursive: true });
  fs.writeFileSync(upload, 'ZIP');

  await purgeServerData({ id, serverPackUrl: upload } as any);

  assert.ok(!fs.existsSync(serverRoot(id)), 'server root should be gone');
  assert.ok(!fs.existsSync(upload), 'uploaded pack should be gone');
});

test('delete removes both the DB row and the archive file', async () => {
  const id = 'srv-delete';
  writeFile(id, 'world/level.dat', 'W');
  const snap = await createSnapshot(fakeServer(id));
  const archive = path.join(serverRoot(id), 'snapshots', snap.fileName);
  assert.ok(fs.existsSync(archive));

  assert.ok(await deleteSnapshot(fakeServer(id), snap.id));
  assert.ok(!fs.existsSync(archive));
  assert.equal(serverStore.getSnapshot(snap.id), null);
});
