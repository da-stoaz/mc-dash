// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config';
import { UpdateCheck } from './updateCheck';

type Reply = { status: number; body?: unknown } | Error;

/** An UpdateCheck whose GitHub answers with `replies`, one per request. */
function checker(replies: Reply[]) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    const reply = replies.shift();
    if (!reply) throw new Error('unexpected request');
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
  }) as typeof fetch;
  const check = new UpdateCheck(fake);
  return { check, requests };
}

const release = { tag_name: 'v1.4.0', html_url: 'https://github.com/da-stoaz/mc-dash/releases/tag/v1.4.0' };

test('the latest release is read from GitHub without identifying the installation', async (t) => {
  const { check, requests } = checker([{ status: 200, body: release }]);
  t.after(() => check.stop());
  assert.deepEqual(await check.refresh(), { version: '1.4.0', url: release.html_url });
  assert.deepEqual(check.latestRelease(), { version: '1.4.0', url: release.html_url });
  assert.equal(requests[0].url, 'https://api.github.com/repos/da-stoaz/mc-dash/releases/latest');
  const headers = requests[0].init?.headers as Record<string, string>;
  assert.match(headers['User-Agent'], /^mc-dash\/\d+\.\d+\.\d+$/);
});

test('a failed check keeps the last known release and never throws', async (t) => {
  const { check } = checker([{ status: 200, body: release }, new Error('offline'), { status: 503 }]);
  t.after(() => check.stop());
  await check.refresh();
  assert.equal((await check.refresh())?.version, '1.4.0');
  assert.equal((await check.refresh())?.version, '1.4.0');
});

test('no release yet, or a release without a usable version, offers nothing', async (t) => {
  const missing = checker([{ status: 404 }]);
  t.after(() => missing.check.stop());
  assert.equal(await missing.check.refresh(), null);

  const odd = checker([
    { status: 200, body: { tag_name: 'nightly', html_url: release.html_url } },
    { status: 200, body: { tag_name: 'v1.5.0', html_url: 'https://evil.example/download' } },
  ]);
  t.after(() => odd.check.stop());
  assert.equal(await odd.check.refresh(), null);
  assert.equal(await odd.check.refresh(), null, 'release links only ever point at github.com');
});

test('MC_DASH_UPDATE_CHECK=false sends nothing and reports nothing', async (t) => {
  const original = config.updateCheckEnabled;
  config.updateCheckEnabled = false;
  t.after(() => { config.updateCheckEnabled = original; });
  const { check, requests } = checker([{ status: 200, body: release }]);
  check.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 0);
  assert.equal(check.latestRelease(), null);
});
