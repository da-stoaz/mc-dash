import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdash-apierr-'));
process.env.DATA_ROOT = TMP;
process.env.SQLITE_PATH = path.join(TMP, 'test.sqlite');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { toApiError } = require('./apiErrors');

test('a full disk during extraction says so, instead of leaking an errno', () => {
  // Extraction is where a big pack lands, so this is the realistic way to run
  // out of room even after the upload itself was admitted.
  const err = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: 'ENOSPC' });
  const mapped = toApiError(err, { error: 'Failed to prepare server pack', status: 500 });

  assert.equal(mapped.status, 507, 'Insufficient Storage, not a blanket 500');
  assert.equal(mapped.body.code, 'DISK_FULL');
  assert.match(mapped.body.reason as string, /disk space/i);
  assert.doesNotMatch(mapped.body.reason as string, /ENOSPC/, 'the errno is for the log, not the user');
});

test('a corrupt zip is reported in words a person can act on', () => {
  // What adm-zip actually throws for a truncated or non-zip upload.
  const err = new Error('ADM-ZIP: Invalid or unsupported zip format. No END header found');
  const mapped = toApiError(err, { error: 'Failed to prepare server pack', status: 500 });

  assert.equal(mapped.status, 400, 'the pack is bad, the server is fine');
  assert.equal(mapped.body.code, 'PACK_CORRUPT');
  assert.doesNotMatch(mapped.body.reason as string, /ADM-ZIP/, 'the library name means nothing to the user');
  assert.match(mapped.body.reason as string, /uploaded incompletely/);
});

test('a truncated snapshot tarball is distinguished from a bad zip', () => {
  const err = new Error('zlib: unexpected end of file');
  const mapped = toApiError(err, { error: 'Failed to import snapshot', status: 500 });

  assert.equal(mapped.body.code, 'ARCHIVE_CORRUPT');
  assert.match(mapped.body.reason as string, /truncated/);
});

test('an unrecognised failure still falls back rather than throwing', () => {
  const mapped = toApiError(new Error('something nobody predicted'), { error: 'Failed to prepare server pack', status: 500 });
  assert.equal(mapped.status, 500);
  assert.ok(mapped.body.error);
});
