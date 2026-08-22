import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Point the app's data root at a throwaway dir BEFORE loading config/store, then
// require the modules so they read this env. (require runs here, after the env
// is set, unlike hoisted imports.)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdash-store-'));
process.env.DATA_ROOT = TMP;
process.env.SQLITE_PATH = path.join(TMP, 'test.sqlite');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { serverStore } = require('./serverStore');

after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

function makeServer(name: string) {
  return serverStore.create({
    name,
    resources: { minRamMb: 1024, maxRamMb: 2048 },
    game: {},
  });
}

test('a stopped server never reports that it needs a restart', () => {
  // "Restart required" is about a running process being out of date with the
  // files on disk. Stopped, the next start reads them fresh, so the flag would
  // only be telling the operator to do what they were going to do anyway.
  const server = makeServer('stopped-server');
  serverStore.update(server.id, { status: 'running', restartRequired: true });
  assert.equal(serverStore.get(server.id).restartRequired, true);

  serverStore.update(server.id, { status: 'stopped' });
  assert.equal(serverStore.get(server.id).restartRequired, false);

  // And it comes back if the same server is running again with the flag still
  // set — stopping hides it, it does not silently discard a real pending change.
  serverStore.update(server.id, { status: 'running' });
  assert.equal(serverStore.get(server.id).restartRequired, true);
});

test('only a live process can be out of date', () => {
  const server = makeServer('status-sweep');
  serverStore.update(server.id, { restartRequired: true });

  for (const status of ['running', 'starting', 'restarting']) {
    serverStore.update(server.id, { status });
    assert.equal(serverStore.get(server.id).restartRequired, true, `${status} should report it`);
  }

  for (const status of ['stopped', 'exited', 'error', 'creating', 'stopping']) {
    serverStore.update(server.id, { status });
    assert.equal(serverStore.get(server.id).restartRequired, false, `${status} should not report it`);
  }
});

test('the list agrees with the individual record', () => {
  const server = makeServer('list-agreement');
  serverStore.update(server.id, { status: 'stopped', restartRequired: true });
  const listed = serverStore.list().find((entry: { id: string }) => entry.id === server.id);
  assert.equal(listed.restartRequired, false);
  assert.equal(serverStore.get(server.id).restartRequired, false);
});
