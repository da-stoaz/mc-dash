// SPDX-License-Identifier: AGPL-3.0-only

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-dash-router-'));
process.env.DATA_ROOT = root;
process.env.SQLITE_PATH = path.join(root, 'test.sqlite');
process.env.MC_DASH_HIBERNATE = 'false';
process.env.LOG_LEVEL = 'silent';
const { config } = require('../config');
const { db } = require('../db');
const { serverStore } = require('../serverStore');
const { RouterService } = require('./routerService');
const proto = require('./minecraftProtocol');

const saved = {
  routerDomain: config.routerDomain,
  routerDefaultSubdomain: config.routerDefaultSubdomain,
  routerTargetHost: config.routerTargetHost,
};
config.routerDomain = 'mc.test';
config.routerDefaultSubdomain = undefined;
config.routerTargetHost = '127.0.0.1';

after(() => {
  Object.assign(config, saved);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function handshake(hostname: string): Buffer {
  const port = Buffer.alloc(2);
  port.writeUInt16BE(25565);
  return proto.packet(0, Buffer.concat([proto.writeVarInt(767), proto.writeString(hostname), port, proto.writeVarInt(2)]));
}

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return (server.address() as net.AddressInfo).port;
}

async function close(server: net.Server): Promise<void> {
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** A router on an ephemeral port, plus the router-side end of every connection it accepted. */
async function startRouter(t: { after: (fn: () => Promise<void>) => void }) {
  const router = new RouterService({ handshakeTimeoutMs: 100 });
  const accepted: net.Socket[] = [];
  const proxy = net.createServer((socket) => {
    accepted.push(socket);
    (router as any).handleConnection(socket);
  });
  const port = await listen(proxy);
  t.after(async () => {
    for (const socket of accepted) socket.destroy();
    await close(proxy);
  });
  return { port, accepted };
}

/**
 * Behave like an attacker: send `payload`, keep our side half-open when the
 * router lets go, then reset the connection. Before the fix the router had
 * already stripped the socket's 'error' listener at that point, so the reset
 * surfaced as an uncaught ECONNRESET and took the whole backend down.
 */
function resetAfterRejection(port: number, payload: Buffer | null, accepted: net.Socket[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true }, () => {
      if (payload) client.write(payload);
    });
    client.setTimeout(2000, () => {
      client.destroy();
      reject(new Error('Router never rejected the connection'));
    });
    client.on('end', () => {
      try {
        // A rejected socket must be released at once, not left half-closed
        // waiting for the peer to finish.
        assert.ok(accepted.length > 0 && accepted.every((socket) => socket.destroyed), 'router-side socket was not destroyed');
      } catch (err) {
        client.destroy();
        reject(err);
        return;
      }
      client.resetAndDestroy();
    });
    client.on('error', () => {});
    // Give a reset that is still in flight time to reach the router before the
    // test ends — an uncaught exception there must fail this test.
    client.on('close', () => setTimeout(() => {
      if (accepted.every((socket) => socket.destroyed)) resolve();
      else reject(new Error('router-side socket outlived the connection'));
    }, 50));
  });
}

const rejections: Array<[string, Buffer | null]> = [
  ['unknown hostname', handshake('nobody.mc.test')],
  ['hostname outside the router domain', handshake('example.org')],
  ['unparseable bytes', Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n'.padEnd(200, 'x'))],
  ['oversized handshake', Buffer.concat([Buffer.from([0xff, 0xff, 0x03]), Buffer.alloc(9 * 1024, 1)])],
  ['silence past the handshake timeout', null],
];

for (const [name, payload] of rejections) {
  test(`a client reset after rejection (${name}) does not crash the process`, async (t) => {
    t.mock.method(serverStore, 'list', () => []);
    const { port, accepted } = await startRouter(t);
    await resetAfterRejection(port, payload, accepted);
  });
}

test('a refused upstream drops the client without crashing', async (t) => {
  const gone = net.createServer();
  const deadPort = await listen(gone);
  await close(gone);
  t.mock.method(serverStore, 'list', () => [{ id: 'world', subdomain: 'world', serverPort: deadPort, hibernated: false }]);
  const { port, accepted } = await startRouter(t);
  await resetAfterRejection(port, handshake('world.mc.test'), accepted);
});

test('a valid handshake is still forwarded to its server, bytes intact', async (t) => {
  let received = Buffer.alloc(0);
  const game = net.createServer((socket) => {
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      socket.write('pong');
    });
    socket.on('error', () => {});
  });
  const gamePort = await listen(game);
  t.after(() => close(game));
  t.mock.method(serverStore, 'list', () => [{ id: 'world', subdomain: 'world', serverPort: gamePort, hibernated: false }]);
  const { port } = await startRouter(t);

  const sent = Buffer.concat([handshake('World.MC.test'), proto.packet(0, proto.writeString('Steve'))]);
  const reply = await new Promise<string>((resolve, reject) => {
    const client = net.connect(port, '127.0.0.1', () => client.write(sent));
    client.setTimeout(2000, () => client.destroy(new Error('No reply through the router')));
    client.on('data', (chunk) => {
      resolve(chunk.toString());
      client.destroy();
    });
    client.on('error', reject);
  });

  assert.equal(reply, 'pong');
  assert.deepEqual(received, sent);
});
