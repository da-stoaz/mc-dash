// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { appVersion, isNewerVersion, parseVersion } from './version';

test('the backend reports the version from its package.json', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(appVersion, manifest.version);
  assert.ok(parseVersion(appVersion), `"${appVersion}" is a plain release version`);
});

test('release tags compare numerically and ignore a leading v', () => {
  assert.deepEqual(parseVersion('v1.12.3'), [1, 12, 3]);
  assert.equal(parseVersion('1.2.3-beta'), null);
  assert.equal(parseVersion('latest'), null);
  assert.ok(isNewerVersion('1.10.0', '1.9.9'));
  assert.ok(isNewerVersion('v2.0.0', '1.99.99'));
  assert.ok(!isNewerVersion('1.2.3', '1.2.3'));
  assert.ok(!isNewerVersion('1.2.2', '1.2.3'));
  assert.ok(!isNewerVersion(null, '1.2.3'));
  assert.ok(!isNewerVersion('1.2.4', 'unknown'));
});
