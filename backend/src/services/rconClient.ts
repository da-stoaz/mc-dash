import net from 'net';

// Minimal Source RCON client (the protocol Minecraft's enable-rcon speaks).
// Packets are little-endian: [int32 length][int32 id][int32 type][body NUL][NUL].
// We avoid a third-party dependency because the surface we need is tiny: connect,
// authenticate, run a handful of console commands, disconnect.
//
// Minecraft's server is much stricter than a Source server about how packets
// arrive: it does one read() per packet and drops the connection unless the
// declared length matches that read exactly. So we must never have two requests
// in flight — writing a second packet before the first is answered lets TCP
// coalesce them into one segment, and the server hangs up on the pair.

const TYPE_AUTH = 3; // client -> server: authenticate
const TYPE_EXEC = 2; // client -> server: run a command
const TYPE_AUTH_RESPONSE = 2; // server -> client: result of authentication
const TYPE_RESPONSE_VALUE = 0; // server -> client: command output

const AUTH_ID = 1;
const BASE_CMD_ID = 100;

// Minecraft splits a response into packets of exactly this many bytes, so a
// short one is the last one. Nothing else marks the end of a response.
const CHUNK_BYTES = 4096;
// A response whose length is an exact multiple of CHUNK_BYTES ends on a full
// packet with no remainder to follow, which is indistinguishable from "more is
// coming" until it doesn't. Wait this long for the rest before calling it done.
const CHUNK_GRACE_MS = 300;

function buildPacket(id: number, type: number, body: string): Buffer {
  const bodyBuf = Buffer.from(body, 'utf8');
  const length = 4 + 4 + bodyBuf.length + 2; // id + type + body + two trailing NULs
  const packet = Buffer.alloc(4 + length);
  packet.writeInt32LE(length, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  bodyBuf.copy(packet, 12);
  // last two bytes are already zero from Buffer.alloc
  return packet;
}

export type RconOptions = {
  host: string;
  port: number;
  password: string;
  commands: string[];
  timeoutMs?: number;
};

/**
 * Connect, authenticate, run the given commands in order, and return each
 * command's console output. Rejects on connection failure, auth failure, or
 * timeout. Always closes the socket.
 */
export async function sendRconCommands(opts: RconOptions): Promise<string[]> {
  const { host, port, password, commands } = opts;
  const timeoutMs = opts.timeoutMs ?? 5000;

  if (commands.length === 0) return [];

  return new Promise<string[]>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let buffer = Buffer.alloc(0);
    const responses: string[] = [];
    let authed = false;
    // Index of the command awaiting a response, or -1 when nothing is in flight.
    let inFlight = -1;
    let nextToSend = 0;
    let settled = false;
    let chunkTimer: NodeJS.Timeout | null = null;

    const clearChunkTimer = () => {
      if (chunkTimer) {
        clearTimeout(chunkTimer);
        chunkTimer = null;
      }
    };

    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearChunkTimer();
      socket.removeAllListeners();
      socket.destroy();
      if (err) reject(err);
      else resolve(responses);
    };

    const timer = setTimeout(() => finish(new Error(`RCON timeout after ${timeoutMs}ms`)), timeoutMs);

    const sendNext = () => {
      clearChunkTimer();
      if (nextToSend >= commands.length) {
        inFlight = -1;
        finish(null);
        return;
      }
      const index = nextToSend;
      nextToSend += 1;
      inFlight = index;
      // One packet, on its own, with nothing else pending. See the note above.
      socket.write(buildPacket(BASE_CMD_ID + index, TYPE_EXEC, commands[index]));
    };

    socket.on('connect', () => {
      socket.write(buildPacket(AUTH_ID, TYPE_AUTH, password));
    });

    socket.on('error', (err) => finish(err));
    socket.on('close', () => finish(new Error('RCON connection closed before completing')));

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 12) {
        const size = buffer.readInt32LE(0);
        if (buffer.length < 4 + size) break; // wait for the rest of the packet
        const id = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        const body = buffer.toString('utf8', 12, 4 + size - 2);
        // id + type + body + two trailing NULs, so the body is what's left.
        const bodyBytes = size - 10;
        buffer = buffer.subarray(4 + size);

        if (!authed) {
          // The empty RESPONSE_VALUE that some servers send before the auth
          // result is ignored; only the AUTH_RESPONSE decides success.
          if (type === TYPE_AUTH_RESPONSE) {
            if (id === -1) {
              finish(new Error('RCON authentication failed (wrong password)'));
              return;
            }
            authed = true;
            sendNext();
            if (settled) return;
          }
          continue;
        }

        if (type !== TYPE_RESPONSE_VALUE || id < BASE_CMD_ID) continue;

        const index = id - BASE_CMD_ID;
        responses[index] = (responses[index] ?? '') + body;

        // Only the command we are waiting on can advance the queue.
        if (index !== inFlight) continue;

        if (bodyBytes < CHUNK_BYTES) {
          sendNext();
          if (settled) return;
          continue;
        }

        // A full-size packet means the response is probably split; give the
        // remainder a moment to arrive before moving on.
        clearChunkTimer();
        chunkTimer = setTimeout(() => {
          chunkTimer = null;
          if (!settled) sendNext();
        }, CHUNK_GRACE_MS);
      }
    });
  });
}
