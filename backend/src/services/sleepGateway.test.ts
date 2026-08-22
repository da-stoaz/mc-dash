import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import os from 'os';
import path from 'path';
import fs from 'fs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdash-gateway-'));
process.env.DATA_ROOT = TMP;
process.env.SQLITE_PATH = path.join(TMP, 'test.sqlite');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SleepListener } = require('./sleepGateway');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const proto = require('./minecraftProtocol');

const OPTIONS = {
  versionName: 'Sleeping',
  motd: 'zzz',
  wakeMessage: 'starting, reconnect shortly',
};

function handshake(port: number, nextState: number): Buffer {
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  return proto.packet(
    0x00,
    Buffer.concat([proto.writeVarInt(763), proto.writeString('localhost'), portBytes, proto.writeVarInt(nextState)])
  );
}

function talk(port: number, payloads: Buffer[], waitMs = 150): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const sock = net.connect(port, '127.0.0.1', () => {
      for (const p of payloads) sock.write(p);
      setTimeout(() => sock.end(), waitMs);
    });
    sock.on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    sock.on('error', () => resolve(Buffer.alloc(0)));
    sock.on('close', () => resolve(Buffer.concat(chunks)));
  });
}

function decodeJson(buf: Buffer): any {
  if (!buf.length) return null;
  const len = proto.readVarInt(buf, 0);
  const id = proto.readVarInt(buf, len.size);
  const strLen = proto.readVarInt(buf, len.size + id.size);
  const start = len.size + id.size + strLen.size;
  try {
    return JSON.parse(buf.subarray(start, start + strLen.value).toString('utf8'));
  } catch {
    return null;
  }
}

// Port 0 lets the OS pick, so the suite can't collide with anything running.
async function withListener(fn: (port: number, wakes: () => number) => Promise<void>) {
  let wakes = 0;
  const listener = new SleepListener(0, { ...OPTIONS, onWake: () => { wakes += 1; } });
  await listener.listen();
  try {
    await fn(listener.boundPort(), () => wakes);
  } finally {
    await listener.close();
  }
}

test('a server-list ping is answered and does not wake anything', async () => {
  await withListener(async (port, wakes) => {
    const reply = decodeJson(await talk(port, [handshake(port, 1), proto.packet(0x00)]));
    assert.equal(reply.description.text, 'zzz');
    // Echoing the client's protocol is what stops the entry showing a red
    // "outdated" cross instead of the sleep message.
    assert.equal(reply.version.protocol, 763);
    assert.equal(wakes(), 0, 'browsing a server list must never start a server');
  });
});

test('a join attempt wakes the server and tells the player why they bounced', async () => {
  await withListener(async (port, wakes) => {
    const reply = decodeJson(await talk(port, [handshake(port, 2)]));
    assert.equal(reply.text, 'starting, reconnect shortly');
    assert.equal(wakes(), 1);
  });
});

test('the disconnect reaches the client even though waking closes the port', async () => {
  // Regression: waking releases the listener, which closes this very socket.
  // Waking before writing lost that race and the player saw a bare dropped
  // connection with no explanation, while the server started anyway.
  await withListener(async (port) => {
    const raw = await talk(port, [handshake(port, 2)]);
    assert.ok(raw.length > 0, 'player must receive the disconnect, not an empty close');
  });
});

test('port scanners and HTTP probes cannot wake a sleeping server', async () => {
  // On a public address, waking on unparseable input hands anyone a way to keep
  // every server permanently awake, which defeats hibernation silently.
  await withListener(async (port, wakes) => {
    await talk(port, [Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n')]);
    await talk(port, [Buffer.from([0xfe, 0x01])]); // pre-1.7 legacy ping
    await talk(port, [Buffer.alloc(64, 0xff)]);
    assert.equal(wakes(), 0, 'junk traffic must never trigger a container start');
  });
});

test('the listener survives junk and still serves real clients afterwards', async () => {
  await withListener(async (port) => {
    await talk(port, [Buffer.alloc(64, 0xff)]);
    const reply = decodeJson(await talk(port, [handshake(port, 1), proto.packet(0x00)]));
    assert.equal(reply.description.text, 'zzz');
  });
});

test('a ping is echoed so the client can show a latency', async () => {
  await withListener(async (port) => {
    const payload = Buffer.alloc(8);
    payload.writeBigInt64BE(42n);
    const raw = await talk(port, [handshake(port, 1), proto.packet(0x00), proto.packet(0x01, payload)]);
    assert.equal(raw.subarray(raw.length - 8).readBigInt64BE(), 42n);
  });
});

test('closing hands the port back fast enough for a container to take it', async () => {
  // The wake path releases the port and then starts the container. If close()
  // waited on open sockets, a start would intermittently hit "port already
  // allocated" behind whoever happened to be mid-ping.
  let wakes = 0;
  const listener = new SleepListener(0, { ...OPTIONS, onWake: () => { wakes += 1; } });
  await listener.listen();
  const port = listener.boundPort();

  // Leave a client connected and idle, mid-handshake.
  const lingering = net.connect(port, '127.0.0.1');
  await new Promise((r) => lingering.on('connect', r));

  const started = Date.now();
  await listener.close();
  const elapsed = Date.now() - started;
  lingering.destroy();

  assert.ok(elapsed < 1000, `close took ${elapsed}ms; a container start would stall behind it`);

  const rebindable = await new Promise<boolean>((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, () => probe.close(() => resolve(true)));
  });
  assert.ok(rebindable, 'Docker must be able to bind the port immediately after');
});
