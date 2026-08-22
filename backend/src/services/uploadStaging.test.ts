import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdash-upload-'));
process.env.DATA_ROOT = TMP;
process.env.SQLITE_PATH = path.join(TMP, 'test.sqlite');
process.env.MC_DASH_MAX_UPLOAD_MB = '1';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { beginUpload, appendChunk, completeUpload, claimUpload, discardUpload, sweep, chunkSizeFor, assertRoomFor, UploadError } =
  require('./uploadStaging');

function chunk(byte: number, size: number): Buffer {
  return Buffer.alloc(size, byte);
}

test('a file split into chunks reassembles byte-for-byte', async () => {
  const parts = [chunk(1, 1000), chunk(2, 1000), chunk(3, 500)];
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const { id } = beginUpload('pack.zip', total);

  for (let i = 0; i < parts.length; i += 1) {
    await appendChunk(id, i, parts[i]);
  }
  completeUpload(id);

  const claimed = claimUpload(id);
  assert.equal(claimed.originalname, 'pack.zip');
  assert.deepEqual(fs.readFileSync(claimed.path), Buffer.concat(parts));
});

test('a retried chunk is ignored rather than appended twice', async () => {
  const { id } = beginUpload('pack.zip', 2000);
  await appendChunk(id, 0, chunk(1, 1000));
  // The response to chunk 0 was lost, so the client sends it again.
  const state = await appendChunk(id, 0, chunk(1, 1000));
  assert.equal(state.received, 1000, 'duplicate must not grow the file');
  assert.equal(state.nextIndex, 1);

  await appendChunk(id, 1, chunk(2, 1000));
  completeUpload(id);
  const claimed = claimUpload(id);
  assert.equal(fs.statSync(claimed.path).size, 2000);
});

test('a gap in the sequence is refused, so a dropped chunk cannot corrupt the file', async () => {
  const { id } = beginUpload('pack.zip', 3000);
  await appendChunk(id, 0, chunk(1, 1000));
  await assert.rejects(() => appendChunk(id, 2, chunk(3, 1000)), (err: any) => {
    assert.ok(err instanceof UploadError);
    assert.equal(err.status, 409);
    return true;
  });
});

test('chunks totalling more than the declared size are refused', async () => {
  const { id } = beginUpload('pack.zip', 1500);
  await appendChunk(id, 0, chunk(1, 1000));
  await assert.rejects(() => appendChunk(id, 1, chunk(2, 1000)), UploadError);
});

test('claiming before every chunk has landed is refused', async () => {
  const { id } = beginUpload('pack.zip', 2000);
  await appendChunk(id, 0, chunk(1, 1000));
  assert.throws(() => completeUpload(id), UploadError);
  assert.throws(() => claimUpload(id), UploadError);
});

test('a size above the configured ceiling is refused up front, before any bytes move', () => {
  // MC_DASH_MAX_UPLOAD_MB is 1 for this suite.
  assert.throws(
    () => beginUpload('huge.zip', 2 * 1024 * 1024),
    (err: any) => {
      assert.equal(err.status, 413, 'must be the status a proxy-size problem deserves');
      return true;
    }
  );
});

test('claiming twice fails — the file belongs to the first caller', async () => {
  const { id } = beginUpload('pack.zip', 10);
  await appendChunk(id, 0, chunk(7, 10));
  completeUpload(id);
  claimUpload(id);
  assert.throws(() => claimUpload(id), UploadError);
});

test('an abandoned upload is swept and its part file deleted', async () => {
  const { id } = beginUpload('pack.zip', 1000);
  await appendChunk(id, 0, chunk(1, 500));
  const partFile = path.join(TMP, 'uploads', '.staging', `${id}.part`);
  assert.ok(fs.existsSync(partFile));

  // Two hours on: past the one-hour staleness window. Earlier tests leave their
  // own abandoned sessions behind, so count that at least this one went.
  assert.ok(sweep(Date.now() + 2 * 60 * 60 * 1000) >= 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(!fs.existsSync(partFile), 'part file should be reclaimed');
  assert.throws(() => claimUpload(id), UploadError);
});

test('cancelling mid-upload reclaims the disk immediately', async () => {
  const { id } = beginUpload('pack.zip', 1000);
  await appendChunk(id, 0, chunk(1, 500));
  const partFile = path.join(TMP, 'uploads', '.staging', `${id}.part`);
  discardUpload(id);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(!fs.existsSync(partFile));
});

test('a traversal-shaped filename cannot escape the uploads directory', async () => {
  const { id } = beginUpload('../../etc/passwd', 4);
  await appendChunk(id, 0, chunk(0, 4));
  completeUpload(id);
  const claimed = claimUpload(id);
  // The separators are what matter: the routes append this name to a path they
  // build themselves, so a name that survives as a single segment cannot climb.
  assert.equal(path.basename(claimed.originalname), claimed.originalname);
  assert.ok(!/[\/]/.test(claimed.originalname));
  assert.equal(path.resolve('/srv/uploads', claimed.originalname), path.resolve('/srv/uploads/' + claimed.originalname));
  // The staged file itself is named from a uuid we generated, never from input.
  assert.equal(path.dirname(claimed.path), path.join(TMP, 'uploads', '.staging'));
});

test('slices grow with the file so a huge upload is not thousands of round trips', () => {
  const MB = 1024 * 1024;
  // Anything that already fits in a sane number of requests stays at the floor.
  assert.equal(chunkSizeFor(50 * MB), 8 * MB, 'a small pack should not get exotic slices');
  assert.equal(chunkSizeFor(236 * MB), 8 * MB, 'a typical modpack: ~30 requests at the floor');

  // Past that, the slice grows rather than the request count.
  assert.ok(chunkSizeFor(4096 * MB) > 8 * MB);
  assert.ok(Math.ceil((4096 * MB) / chunkSizeFor(4096 * MB)) <= 200, '4 GB must stay within the target request count');

  // A 10 GB upload lands at ~51 MB a slice — still 200 requests, not 1280.
  assert.equal(chunkSizeFor(10240 * MB), Math.ceil((10240 * MB) / 200));

  // Past 12.8 GB the ceiling takes over, so no single request ever approaches a
  // proxy's body limit however big the file gets.
  const huge = chunkSizeFor(40960 * MB);
  assert.equal(huge, 64 * MB, 'ceiling holds');
  assert.ok(huge < 100 * MB, 'must stay under the tightest common proxy limit');
});

test('an upload that would fill the disk is refused before a byte moves', () => {
  const GB = 1024 * 1024 * 1024;
  // 20 GB snapshot onto a disk with 30 GB free: fits, with the reserve intact.
  assert.doesNotThrow(() => assertRoomFor(20 * GB, 30 * GB));

  // Same file onto a disk with 21 GB free: it would technically fit, but would
  // leave nothing for the extracted world the import is about to write.
  assert.throws(
    () => assertRoomFor(20 * GB, 21 * GB),
    (err: any) => {
      assert.equal(err.status, 507, 'Insufficient Storage, not a generic 400');
      assert.match(err.message, /Not enough disk space/);
      return true;
    }
  );

  // And the obvious case.
  assert.throws(() => assertRoomFor(20 * GB, 5 * GB), UploadError);
});
