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
const {
  shouldRecreateForUser,
  derivedImageTag,
  downloaderDockerfile,
  downloaderUnavailableError,
} = require('./dockerService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildStartCommand } = require('./prepareService');

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

test('derived image tag is a valid, base-specific docker reference', () => {
  // Repository must stay lowercase and the tag may only hold [A-Za-z0-9_.-].
  assert.equal(derivedImageTag('eclipse-temurin:25-jre'), 'mc-dash/java:eclipse-temurin-25-jre');
  assert.equal(derivedImageTag('mc-dash/java-curl:local'), 'mc-dash/java:mc-dash-java-curl-local');
  assert.match(derivedImageTag('ghcr.io/Some/Repo:1.2_3'), /^mc-dash\/java:[a-z0-9][a-z0-9._-]*$/);
});

test('different bases never collide on one derived tag', () => {
  // Folding the whole reference in (not just the major) keeps a Java 17 image
  // from being reused as a Java 25 one.
  assert.notEqual(derivedImageTag('eclipse-temurin:17-jre'), derivedImageTag('eclipse-temurin:25-jre'));
});

test('dockerfile no-ops when the base already ships a downloader', () => {
  const dockerfile = downloaderDockerfile('eclipse-temurin:25-jre');
  assert.match(dockerfile, /^FROM eclipse-temurin:25-jre$/m);
  // Exit 0 before any package manager runs, so curl-bearing bases cost nothing.
  assert.match(dockerfile, /command -v curl .*\|\| command -v wget .*then exit 0/);
});

test('dockerfile builds as root and fails loudly with no package manager', () => {
  const dockerfile = downloaderDockerfile('eclipse-temurin:25-jre');
  // apt-get would fail on a base defaulting to a non-root user.
  assert.match(dockerfile, /^USER root$/m);
  // A silent warning here is what produced the misleading "Fabric is not
  // available" failure; the build must fail instead so we can name the cause.
  assert.match(dockerfile, /exit 1; fi/);
  for (const manager of ['apt-get', 'apk', 'microdnf', 'dnf', 'yum']) {
    assert.ok(dockerfile.includes(manager), `expected ${manager} branch`);
  }
});

test('start command no longer installs packages at container runtime', () => {
  const cmd = buildStartCommand('start.sh');
  assert.equal(cmd, "exec bash './start.sh'");
  // Installing at runtime needs root, which containers no longer have.
  for (const manager of ['apt-get', 'apk', 'microdnf', 'dnf', 'yum']) {
    assert.ok(!cmd.includes(manager), `${manager} must not run at container runtime`);
  }
});

test('start command escapes quotes in the script name', () => {
  assert.equal(buildStartCommand("od'd.sh"), "exec bash './od'\\''d.sh'");
});

test('downloader error names the real cause, not the modloader symptom', () => {
  const err = downloaderUnavailableError('eclipse-temurin:25-jre', 'no package manager');
  assert.match(err.message, /eclipse-temurin:25-jre/);
  assert.match(err.message, /no curl or wget/);
  assert.match(err.message, /no package manager/);
  // The whole point: say why the pack's own error would have lied.
  assert.match(err.message, /Fabric is not available/);
});
