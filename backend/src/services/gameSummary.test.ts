import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdash-game-summary-'));
process.env.DATA_ROOT = root;
process.env.SQLITE_PATH = path.join(root, 'test.sqlite');
const { getGameSummary } = require('./gameSettingsService');
const { db } = require('../db');
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
const dir = path.join(root, 'servers', 'imported', 'pack');
fs.mkdirSync(dir, { recursive: true });
const propsPath = path.join(dir, 'server.properties');
const server = { id: 'imported', game: {}, status: 'stopped' };

test('imported game settings are visible both stopped and running without modifying files or stored config', async () => {
  const properties = 'gamemode=survival\nview-distance=12\n';
  fs.writeFileSync(propsPath, properties);
  for (const status of ['stopped', 'running', 'starting']) {
    assert.deepEqual(await getGameSummary({ ...server, status }), { gameMode: 'survival', renderDistance: 12 });
  }
  assert.deepEqual(server.game, {});
  assert.equal(fs.readFileSync(propsPath, 'utf8'), properties);
});

test('stored settings take precedence and older numeric game modes are understood', async () => {
  fs.writeFileSync(propsPath, 'gamemode=1\nview-distance=8\n');
  assert.deepEqual(await getGameSummary(server), { gameMode: 'creative', renderDistance: 8 });
  assert.deepEqual(await getGameSummary({ ...server, game: { gameMode: 'survival' } }), { gameMode: 'survival', renderDistance: 8 });
});

test('missing or invalid properties do not invent settings', async () => {
  fs.writeFileSync(propsPath, 'gamemode=unknown\nview-distance=NaN\n');
  assert.deepEqual(await getGameSummary(server), {});
  assert.deepEqual(await getGameSummary({ ...server, id: 'missing' }), {});
});
