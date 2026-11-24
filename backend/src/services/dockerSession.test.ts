// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Dockerode 4 pinned a vulnerable uuid 10, which package.json overrode. Dockerode
// 5 dropped the dependency for Node's crypto.randomUUID(), so the override is
// gone; this keeps the session handshake honest if that ever changes again.
// The dial error stops before any real Docker connection or gRPC server starts.
test('Dockerode session sends a random v4 UUID', () => {
  const withSession = require('dockerode/lib/session');
  const unavailable = new Error('Docker connection intentionally stubbed');
  let completed = false;
  withSession({ modem: { dial(options: any, callback: any) {
    assert.equal(options.path, '/session');
    assert.match(options.headers['X-Docker-Expose-Session-Uuid'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    callback(unavailable);
  } } }, undefined, (err: Error, sessionId: null, done: () => void) => {
    assert.equal(err, unavailable);
    assert.equal(sessionId, null);
    done();
    completed = true;
  });
  assert.equal(completed, true);
});
