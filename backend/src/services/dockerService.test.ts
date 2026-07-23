import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Importing dockerService pulls in config.ts, whose import ensures the data dir
// exists. Point it at a throwaway dir before requiring so it can't create a
// stray ./data folder next to the source.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdash-docker-'));
process.env.DATA_ROOT = TMP;
process.env.SQLITE_PATH = path.join(TMP, 'test.sqlite');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { shouldRecreateForUser } = require('./dockerService');

test('migrates a stopped root container to the non-root backend user', () => {
  // Empty User means the image default (root); "0"/"0:0" are root spelled out.
  assert.equal(shouldRecreateForUser('1000:1000', '', false), true);
  assert.equal(shouldRecreateForUser('1000:1000', '0:0', false), true);
  assert.equal(shouldRecreateForUser('1000:1000', '0', false), true);
});

test('no migration when the container already runs as the desired user', () => {
  assert.equal(shouldRecreateForUser('1000:1000', '1000:1000', false), false);
  assert.equal(shouldRecreateForUser('1000:1000', '1000', false), false);
});

test('never migrates a running container (it is done on the next clean start)', () => {
  assert.equal(shouldRecreateForUser('1000:1000', '0:0', true), false);
});

test('root backend needs no migration — it can read any file already', () => {
  assert.equal(shouldRecreateForUser('0:0', '', false), false);
});

test('no enforcement when no container user is configured (e.g. Windows dev)', () => {
  assert.equal(shouldRecreateForUser(undefined, '0:0', false), false);
});

test('migrates when the backend uid changed since the container was built', () => {
  assert.equal(shouldRecreateForUser('1000:1000', '1500:1500', false), true);
});
