import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdash-players-'));
process.env.DATA_ROOT = root;
process.env.SQLITE_PATH = path.join(root, 'test.sqlite');
process.env.MC_DASH_HIBERNATE = 'false';
const { getPlayerSummary } = require('./playerService');
const { toServerViews } = require('./serverView');
const rcon = require('./rconService');
const { db } = require('../db');
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
const server = { id: 'players', status: 'running', resources: {}, game: {} };
const dir = path.join(root, 'servers', server.id, 'pack');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'server.properties'), 'max-players=30\n');

test('list reads live current/maximum players even with hibernation disabled', async t => {
  t.mock.method(rcon, 'runServerRcon', async () => ['There are 3 of a max of 20 players online: A, B, C']);
  const [view] = await toServerViews([server]);
  assert.equal(view.players, 3);
  assert.equal(view.maxPlayers, 20); // file has a different, unapplied value
});

test('stopped servers show zero and configured maximum without querying RCON', async t => {
  t.mock.method(rcon, 'runServerRcon', async () => assert.fail('stopped server must not be queried'));
  assert.deepEqual(await getPlayerSummary({ ...server, status: 'stopped' }), { players: 0, maxPlayers: 30 });
});

test('failed live readings remain unknown, never falsely zero or a stale live count', async t => {
  t.mock.method(rcon, 'runServerRcon', async () => null);
  assert.deepEqual(await getPlayerSummary(server), { players: null, maxPlayers: 30 });
  assert.deepEqual(await getPlayerSummary({ ...server, status: 'starting' }), { players: null, maxPlayers: 30 });
});

test('missing or invalid limits are unknown instead of an invented default', async () => {
  assert.deepEqual(await getPlayerSummary({ ...server, id: 'missing', status: 'stopped' }), { players: 0, maxPlayers: null });
  fs.writeFileSync(path.join(dir, 'server.properties'), 'max-players=not-a-number\n');
  assert.deepEqual(await getPlayerSummary({ ...server, status: 'stopped' }), { players: 0, maxPlayers: null });
});
