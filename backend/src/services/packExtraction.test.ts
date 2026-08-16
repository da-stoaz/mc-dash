import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';

// prepareService pulls in config.ts, whose import ensures the data dir exists.
// Point it at a throwaway dir before requiring so it can't create a stray
// ./data folder next to the source.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdash-zip-'));
process.env.DATA_ROOT = TMP;
process.env.SQLITE_PATH = path.join(TMP, 'test.sqlite');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ensureZipExtracted } = require('./prepareService');

function writeZip(name: string, entries: Record<string, string>): string {
  const zip = new AdmZip();
  for (const [entryPath, content] of Object.entries(entries)) {
    zip.addFile(entryPath, Buffer.from(content, 'utf8'));
  }
  const zipPath = path.join(TMP, name);
  zip.writeZip(zipPath);
  return zipPath;
}

test('extracts a server pack zip, nested directories included', async () => {
  // adm-zip 0.6.0 is a semver-major bump taken for GHSA-xcpc-8h2w-3j85. MC Dash
  // uses exactly two of its calls; this pins both against a silent API change.
  const zipPath = writeZip('pack.zip', {
    'start.sh': '#!/bin/sh\necho hi\n',
    'config/server.properties': 'level-seed=42\n',
    'mods/example.jar': 'not-really-a-jar',
  });
  const packDir = path.join(TMP, 'extracted');

  const result = await ensureZipExtracted(zipPath, packDir);

  assert.equal(result, packDir);
  assert.equal(fs.readFileSync(path.join(packDir, 'start.sh'), 'utf8'), '#!/bin/sh\necho hi\n');
  assert.equal(fs.readFileSync(path.join(packDir, 'config/server.properties'), 'utf8'), 'level-seed=42\n');
  assert.ok(fs.existsSync(path.join(packDir, 'mods/example.jar')));
});

test('re-extracting over an existing pack overwrites in place', async () => {
  // extractAllTo's second argument is `overwrite`. A regression here would leave
  // stale pack files behind on a modpack upgrade rather than replacing them.
  const packDir = path.join(TMP, 'overwritten');
  await ensureZipExtracted(writeZip('v1.zip', { 'version.txt': 'v1' }), packDir);
  assert.equal(fs.readFileSync(path.join(packDir, 'version.txt'), 'utf8'), 'v1');

  await ensureZipExtracted(writeZip('v2.zip', { 'version.txt': 'v2' }), packDir);
  assert.equal(fs.readFileSync(path.join(packDir, 'version.txt'), 'utf8'), 'v2');
});

test('a corrupt archive throws instead of silently extracting nothing', async () => {
  const bogus = path.join(TMP, 'bogus.zip');
  fs.writeFileSync(bogus, 'this is not a zip file');

  await assert.rejects(() => ensureZipExtracted(bogus, path.join(TMP, 'bogus-out')));
});
