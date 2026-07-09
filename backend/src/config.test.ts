import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Importing config.ts has side effects (ensures the data dir exists). Point it
// at a throwaway dir before requiring so it can't create a stray ./data folder.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdash-config-'));
process.env.DATA_ROOT = TMP;
process.env.SQLITE_PATH = path.join(TMP, 'test.sqlite');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveContainerUser } = require('./config');

const uid = () => 1000;
const gid = () => 1000;

test('defaults to the host process uid:gid when no override is set', () => {
  assert.equal(resolveContainerUser(undefined, uid, gid), '1000:1000');
});

test('root backend resolves to 0:0 (matches the current root-container behaviour)', () => {
  assert.equal(
    resolveContainerUser(undefined, () => 0, () => 0),
    '0:0'
  );
});

test('an explicit uid:gid override is used verbatim', () => {
  assert.equal(resolveContainerUser('1500:1500', uid, gid), '1500:1500');
  assert.equal(resolveContainerUser('  2000:2000  ', uid, gid), '2000:2000');
});

test('"root" opts back out to the container default root user', () => {
  assert.equal(resolveContainerUser('root', uid, gid), '0:0');
  assert.equal(resolveContainerUser('ROOT', uid, gid), '0:0');
});

test('undefined when the platform has no getuid (e.g. Windows) and no override', () => {
  assert.equal(resolveContainerUser(undefined, undefined, undefined), undefined);
});

test('an override still wins on a platform without getuid', () => {
  assert.equal(resolveContainerUser('1000:1000', undefined, undefined), '1000:1000');
});

test('falls back to uid for gid when getgid is unavailable', () => {
  assert.equal(resolveContainerUser(undefined, uid, undefined), '1000:1000');
});
