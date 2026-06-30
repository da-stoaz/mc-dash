import net from 'net';

// Minimal Source RCON client (the protocol Minecraft's enable-rcon speaks).
// Packets are little-endian: [int32 length][int32 id][int32 type][body NUL][NUL].
// We avoid a third-party dependency because the surface we need is tiny: connect,
// authenticate, run a handful of console commands, disconnect.

const TYPE_AUTH = 3; // client -> server: authenticate
const TYPE_EXEC = 2; // client -> server: run a command
const TYPE_AUTH_RESPONSE = 2; // server -> client: result of authentication
const TYPE_RESPONSE_VALUE = 0; // server -> client: command output

const AUTH_ID = 1;
const BASE_CMD_ID = 100;

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
    let nextToSend = 0;
    let settled = false;

    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (err) reject(err);
      else resolve(responses);
    };

    const timer = setTimeout(() => finish(new Error(`RCON timeout after ${timeoutMs}ms`)), timeoutMs);

    const sendNext = () => {
      if (nextToSend >= commands.length) {
        finish(null);
        return;
      }
      socket.write(buildPacket(BASE_CMD_ID + nextToSend, TYPE_EXEC, commands[nextToSend]));
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
          }
          continue;
        }

        if (type === TYPE_RESPONSE_VALUE && id >= BASE_CMD_ID) {
          const index = id - BASE_CMD_ID;
          responses[index] = (responses[index] ?? '') + body;
          nextToSend = index + 1;
          sendNext();
        }
      }
    });
  });
}
