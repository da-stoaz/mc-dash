import net from 'net';
import { logger } from '../logger';
import {
  Handshake,
  loginDisconnect,
  packet,
  parseHandshake,
  readVarInt,
  sleepingStatusResponse,
} from './minecraftProtocol';

// ---------------------------------------------------------------------------
// What players talk to while a server is asleep.
//
// The naive version of hibernation — stop the container, start it again when
// someone connects — fails on timing. A modpack takes 30-90 seconds to boot and
// a Minecraft client gives up long before that, so holding the TCP connection
// open until the server is ready just produces a timeout and a player who
// concludes the server is dead.
//
// So we do what lazymc does, and answer honestly instead:
//
//   Server list ping (next state 1) -> a real status response saying the server
//     is asleep. The entry shows up in the client's list with a readable
//     message instead of a red "can't connect" cross.
//
//   Join attempt (next state 2)     -> start the server, then disconnect the
//     player with the reason. Their client shows the message on the
//     disconnect screen, they wait a few seconds, and reconnect into a server
//     that is now booting or already up.
//
// One deliberate consequence: the first join after a sleep always costs one
// bounced connection. That is the price of hibernation, it is visible and
// self-explanatory to the player, and it beats both a timeout and a server that
// never sleeps at all.
// ---------------------------------------------------------------------------

const HANDSHAKE_TIMEOUT_MS = 5000;
const MAX_HANDSHAKE_BYTES = 8 * 1024;

export type SleepGatewayOptions = {
  /** Shown in the client's server list while asleep. */
  motd: string;
  /** Shown on the disconnect screen after a join attempt wakes the server. */
  wakeMessage: string;
  /** Server-list version label, e.g. "Sleeping". */
  versionName: string;
  /** Called on a join attempt. Errors are logged, never surfaced to the client. */
  onWake: () => void;
};

/**
 * Serve one client that has connected to a sleeping server, given the bytes
 * already read from it.
 *
 * Takes ownership of the socket: it will be ended by this function, never
 * handed back. Safe to call with a partial handshake — more data is awaited.
 */
export function serveSleepingClient(socket: net.Socket, initial: Buffer, opts: SleepGatewayOptions): void {
  let buffered = initial;
  let handshake: Handshake | null = null;
  let woken = false;

  const finish = () => {
    clearTimeout(timer);
    socket.removeAllListeners('data');
    socket.end();
  };

  const timer = setTimeout(finish, HANDSHAKE_TIMEOUT_MS);

  const wake = () => {
    if (woken) return;
    woken = true;
    try {
      opts.onWake();
    } catch (err) {
      logger.warn({ err }, 'Sleep gateway wake callback failed');
    }
  };

  const consume = () => {
    if (!handshake) {
      let parsed: Handshake | null;
      try {
        parsed = parseHandshake(buffered);
      } catch (err) {
        // A legacy (pre-1.7) ping, an HTTP probe, or a port scanner. Do *not*
        // wake on any of it.
        //
        // Waking here is tempting — an old client trying to join is still a
        // player — but on a public address it hands anyone a way to keep every
        // server permanently awake by spraying 0xFE at the port, which defeats
        // hibernation entirely and silently. Pre-1.7 clients have been obsolete
        // since 2013; scanners have not. The server can still be started from
        // the dashboard.
        logger.debug({ err }, 'Sleep gateway ignoring an unparseable handshake');
        finish();
        return;
      }
      if (!parsed) return; // need more bytes
      handshake = parsed;
      buffered = buffered.subarray(parsed.size);

      if (handshake.nextState === 2) {
        // Joining. Queue the disconnect *before* waking: waking releases this
        // listener's port, which closes the very socket we are replying on, so
        // waking first is a race the reply loses — the server starts but the
        // player sees a bare dropped connection and no reason for it. No need to
        // wait for Login Start; a disconnect is valid as soon as the client is
        // in the login state.
        socket.write(loginDisconnect(opts.wakeMessage));
        socket.end();
        clearTimeout(timer);
        socket.removeAllListeners('data');
        wake();
        return;
      }

      if (handshake.nextState !== 1) {
        finish();
        return;
      }
      // Status: fall through and wait for the Status Request packet.
    }

    // Status flow: Status Request (0x00) then optionally Ping (0x01, 8 bytes).
    while (buffered.length > 0) {
      const length = readVarInt(buffered, 0);
      if (!length) return;
      const end = length.size + length.value;
      if (buffered.length < end) return;

      const body = buffered.subarray(length.size, end);
      buffered = buffered.subarray(end);

      const id = readVarInt(body, 0);
      if (!id) continue;

      if (id.value === 0x00) {
        socket.write(
          sleepingStatusResponse({
            protocolVersion: handshake.protocolVersion,
            versionName: opts.versionName,
            description: opts.motd,
          })
        );
      } else if (id.value === 0x01) {
        // Ping: echo the payload back verbatim so the client can show a latency.
        socket.write(packet(0x01, body.subarray(id.size)));
        finish();
        return;
      }
    }
  };

  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    if (buffered.length > MAX_HANDSHAKE_BYTES) {
      finish();
      return;
    }
    consume();
  });
  socket.on('error', () => clearTimeout(timer));
  socket.on('close', () => clearTimeout(timer));

  // The caller may already have buffered a complete handshake.
  consume();
}

/**
 * A listener bound to a hibernated server's own port.
 *
 * Needed because the subdomain router is optional and off by default. Without
 * this, hibernation on a direct-port setup would mean the port simply stops
 * answering — players get "connection refused" and no way to wake anything.
 * While the container is stopped its port is free, so MC Dash holds it and
 * hands it back the moment the server is asked to start.
 */
export class SleepListener {
  private server: net.Server | null = null;
  // Tracked so close() can cut them loose. net.Server.close() only stops new
  // connections and then waits for open ones — with a 5s handshake window that
  // would stall the container start behind whatever client happens to be
  // mid-ping, and show up as a start that sometimes takes five seconds.
  private readonly sockets = new Set<net.Socket>();

  constructor(
    private readonly port: number,
    private readonly options: SleepGatewayOptions
  ) {}

  /** The port actually bound, so a caller that passed 0 can find out. */
  boundPort(): number | null {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : null;
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server) return resolve();
      const server = net.createServer((socket) => {
        socket.setNoDelay(true);
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
        serveSleepingClient(socket, Buffer.alloc(0), this.options);
      });
      server.once('error', (err) => {
        this.server = null;
        reject(err);
      });
      server.listen(this.port, () => {
        this.server = server;
        // Replace the bind-time handler with a lasting one, so a later error
        // can't reject an already-settled promise or crash the process.
        server.removeAllListeners('error');
        server.on('error', (err) => logger.warn({ err, port: this.port }, 'Sleep listener error'));
        resolve();
      });
    });
  }

  /**
   * Release the port. Resolves only once it is actually free, because the
   * container start that follows needs to bind the very same port — returning
   * early here turns hibernation into an intermittent "port already allocated".
   */
  close(): Promise<void> {
    return new Promise((resolve) => {
      const server = this.server;
      if (!server) return resolve();
      this.server = null;
      server.close(() => resolve());

      // Half-close rather than destroy: the socket that triggered this wake is
      // usually still flushing the "server is starting, reconnect" disconnect,
      // and destroying it drops that reply on the floor. end() sends what is
      // queued and then FINs.
      for (const socket of this.sockets) socket.end();

      // A client that never acknowledges must not hold the port hostage — the
      // container start is waiting on this. Cut anything still open shortly
      // after, and resolve regardless so a stuck socket can't stall a start.
      const cutoff = setTimeout(() => {
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        resolve();
      }, 250);
      cutoff.unref();
    });
  }
}
