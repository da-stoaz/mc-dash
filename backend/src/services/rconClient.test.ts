import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import { sendRconCommands } from './rconClient';

const TYPE_AUTH = 3;
const TYPE_EXEC = 2;
const TYPE_AUTH_RESPONSE = 2;
const TYPE_RESPONSE_VALUE = 0;

function encode(id: number, type: number, body: string): Buffer {
  const b = Buffer.from(body, 'utf8');
  const len = 4 + 4 + b.length + 2;
  const p = Buffer.alloc(4 + len);
  p.writeInt32LE(len, 0);
  p.writeInt32LE(id, 4);
  p.writeInt32LE(type, 8);
  b.copy(p, 12);
  return p;
}

type Received = { id: number; type: number; body: string };

/**
 * Minimal mock of a Minecraft RCON server. Speaks the same framing the client
 * uses so we exercise the real auth handshake + command round-trips on loopback.
 */
function startMockRcon(opts: { password: string; respondTo?: (cmd: string) => string }) {
  const received: Received[] = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let authed = false;
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 12) {
        const size = buffer.readInt32LE(0);
        if (buffer.length < 4 + size) break;
        const id = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        const body = buffer.toString('utf8', 12, 4 + size - 2);
        buffer = buffer.subarray(4 + size);
        received.push({ id, type, body });

        if (type === TYPE_AUTH) {
          const ok = body === opts.password;
          // Real servers send an empty RESPONSE_VALUE before the auth result.
          socket.write(encode(id, TYPE_RESPONSE_VALUE, ''));
          socket.write(encode(ok ? id : -1, TYPE_AUTH_RESPONSE, ''));
          authed = ok;
        } else if (type === TYPE_EXEC && authed) {
          const reply = opts.respondTo ? opts.respondTo(body) : `ran: ${body}`;
          socket.write(encode(id, TYPE_RESPONSE_VALUE, reply));
        }
      }
    });
  });
  return new Promise<{ port: number; received: Received[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        received,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

test('authenticates and runs commands in order, returning their output', async () => {
  const mock = await startMockRcon({ password: 'secret', respondTo: (cmd) => `OK ${cmd}` });
  try {
    const responses = await sendRconCommands({
      host: '127.0.0.1',
      port: mock.port,
      password: 'secret',
      commands: ['ban Rino0609 Banned via MC Dash', 'pardon SomeoneElse'],
    });

    assert.deepEqual(responses, ['OK ban Rino0609 Banned via MC Dash', 'OK pardon SomeoneElse']);

    const auths = mock.received.filter((p) => p.type === TYPE_AUTH);
    assert.equal(auths.length, 1);
    assert.equal(auths[0].body, 'secret');

    const execs = mock.received.filter((p) => p.type === TYPE_EXEC);
    assert.deepEqual(execs.map((p) => p.body), ['ban Rino0609 Banned via MC Dash', 'pardon SomeoneElse']);
  } finally {
    await mock.close();
  }
});

test('rejects on wrong password', async () => {
  const mock = await startMockRcon({ password: 'right' });
  try {
    await assert.rejects(
      sendRconCommands({ host: '127.0.0.1', port: mock.port, password: 'wrong', commands: ['ban X'] }),
      /authentication failed/i
    );
    // The command must never be sent when auth fails.
    assert.equal(mock.received.filter((p) => p.type === TYPE_EXEC).length, 0);
  } finally {
    await mock.close();
  }
});

test('times out when the server never responds', async () => {
  // A raw socket server that accepts but never replies.
  const sockets: net.Socket[] = [];
  const dead = net.createServer((s) => sockets.push(s));
  await new Promise<void>((r) => dead.listen(0, '127.0.0.1', () => r()));
  const port = (dead.address() as net.AddressInfo).port;
  try {
    await assert.rejects(
      sendRconCommands({ host: '127.0.0.1', port, password: 'x', commands: ['ban X'], timeoutMs: 300 }),
      /timeout/i
    );
  } finally {
    sockets.forEach((s) => s.destroy());
    await new Promise<void>((r) => dead.close(() => r()));
  }
});

test('handles a command response split across TCP packets', async () => {
  // Server that sends the response one byte at a time to exercise the client's
  // length-prefixed reassembly.
  const password = 'pw';
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let authed = false;
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 12) {
        const size = buffer.readInt32LE(0);
        if (buffer.length < 4 + size) break;
        const id = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        const body = buffer.toString('utf8', 12, 4 + size - 2);
        buffer = buffer.subarray(4 + size);
        if (type === TYPE_AUTH) {
          authed = body === password;
          socket.write(encode(authed ? id : -1, TYPE_AUTH_RESPONSE, ''));
        } else if (type === TYPE_EXEC && authed) {
          const packet = encode(id, TYPE_RESPONSE_VALUE, `echo:${body}`);
          for (const byte of packet) socket.write(Buffer.from([byte]));
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  try {
    const responses = await sendRconCommands({ host: '127.0.0.1', port, password, commands: ['list'] });
    assert.deepEqual(responses, ['echo:list']);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});


/**
 * Mock that reads the way Minecraft's own RCON server does: one read() is one
 * packet, and anything else drops the connection. This is what makes pipelining
 * requests unsafe, so it is the mock that has to catch it.
 */
function startStrictRcon(opts: { password: string; respondTo: (cmd: string) => string[] }) {
  const server = net.createServer((socket) => {
    let authed = false;
    socket.on('data', (chunk: Buffer) => {
      // Vanilla checks the declared length against the whole read and hangs up
      // when they disagree, which is exactly what two coalesced packets do.
      const size = chunk.length >= 4 ? chunk.readInt32LE(0) : -1;
      if (size !== chunk.length - 4) {
        socket.destroy();
        return;
      }
      const id = chunk.readInt32LE(4);
      const type = chunk.readInt32LE(8);
      const body = chunk.toString('utf8', 12, chunk.length - 2);
      if (type === TYPE_AUTH) {
        authed = body === opts.password;
        socket.write(encode(authed ? id : -1, TYPE_AUTH_RESPONSE, ''));
      } else if (type === TYPE_EXEC && authed) {
        for (const part of opts.respondTo(body)) socket.write(encode(id, TYPE_RESPONSE_VALUE, part));
      }
    });
  });
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

test('never pipelines requests, which a real Minecraft server hangs up on', async () => {
  const mock = await startStrictRcon({ password: 'pw', respondTo: (cmd) => [`ok:${cmd}`] });
  try {
    const responses = await sendRconCommands({
      host: '127.0.0.1',
      port: mock.port,
      password: 'pw',
      commands: ['time set night', 'give DaStoaz minecraft:diamond 12'],
      timeoutMs: 2000,
    });
    assert.deepEqual(responses, ['ok:time set night', 'ok:give DaStoaz minecraft:diamond 12']);
  } finally {
    await mock.close();
  }
});

test('reassembles a response Minecraft split at its 4096-byte boundary', async () => {
  // `help` on a modded server runs well past one packet. Vanilla emits full
  // 4096-byte packets until a short one ends the response.
  const head = 'a'.repeat(4096);
  const tail = 'the-end';
  const mock = await startStrictRcon({
    password: 'pw',
    respondTo: (cmd) => (cmd === 'help' ? [head, tail] : ['']),
  });
  try {
    const responses = await sendRconCommands({
      host: '127.0.0.1',
      port: mock.port,
      password: 'pw',
      commands: ['help', 'list'],
      timeoutMs: 3000,
    });
    assert.deepEqual(responses, [head + tail, '']);
  } finally {
    await mock.close();
  }
});

test('a response landing exactly on the boundary still completes', async () => {
  // Nothing follows a final full-size packet, so only the grace window tells us
  // the response is over. It must end, not hang until the overall timeout.
  const exact = 'b'.repeat(4096);
  const mock = await startStrictRcon({ password: 'pw', respondTo: () => [exact] });
  try {
    const responses = await sendRconCommands({
      host: '127.0.0.1',
      port: mock.port,
      password: 'pw',
      commands: ['help'],
      timeoutMs: 3000,
    });
    assert.deepEqual(responses, [exact]);
  } finally {
    await mock.close();
  }
});
