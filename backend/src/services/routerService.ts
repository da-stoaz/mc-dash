// SPDX-License-Identifier: AGPL-3.0-only

import net from 'net';
import { config } from '../config';
import { logger } from '../logger';
import { serverStore } from '../serverStore';
import type { ServerRecord } from '../types';
import { normalizeHostname, parseHandshake } from './minecraftProtocol';
import { serveSleepingClient } from './sleepGateway';
import { hibernationService } from './hibernationService';

const MAX_HANDSHAKE_BYTES = 8 * 1024;
const HANDSHAKE_TIMEOUT_MS = 5000;

function extractSubdomain(hostname: string | undefined): string | undefined {
  const domain = config.routerDomain;
  const fallback = config.routerDefaultSubdomain;
  if (!hostname || !domain) return fallback;

  if (hostname === domain) {
    return fallback;
  }

  if (!hostname.endsWith(`.${domain}`)) {
    return undefined;
  }

  const subdomain = hostname.slice(0, -(domain.length + 1));
  if (!subdomain || subdomain.includes('.')) return undefined;
  return subdomain;
}

function findServerBySubdomain(subdomain: string | undefined): ServerRecord | null {
  if (!subdomain) return null;
  const target = subdomain.toLowerCase();
  const servers = serverStore.list();
  return servers.find((server) => server.subdomain?.toLowerCase() === target) ?? null;
}

export type RouterOptions = {
  /** How long a client gets to send a complete handshake. */
  handshakeTimeoutMs?: number;
};

export class RouterService {
  private server: net.Server | null = null;
  private readonly handshakeTimeoutMs: number;

  constructor(options: RouterOptions = {}) {
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  }

  start() {
    if (!config.routerEnabled) {
      logger.info('Router disabled. Set MC_ROUTER_ENABLED=true to enable subdomain routing.');
      return;
    }
    if (!config.routerDomain) {
      logger.warn('Router enabled but MC_ROUTER_DOMAIN is not set. Router will not start.');
      return;
    }
    if (this.server) return;

    this.server = net.createServer((socket) => this.handleConnection(socket));
    this.server.on('error', (err) => {
      logger.error({ err }, 'Router failed');
    });
    this.server.listen(config.routerPort, () => {
      logger.info(`Router listening on port ${config.routerPort} for *.${config.routerDomain}`);
    });
  }

  private handleConnection(socket: net.Socket) {
    // This socket comes straight from the internet. Its 'error' listener must
    // stay attached for the socket's whole life: an 'error' with no listener is
    // an uncaught exception, and the router shares its process with the API.
    // A client could trigger one at will by resetting the connection after we
    // gave up on it — one packet, whole backend down. So nothing below ever
    // calls removeAllListeners() on the client socket; only our own 'data'
    // handler is detached, by reference.
    socket.on('error', () => teardown());
    socket.on('close', () => teardown());
    socket.setNoDelay(true);

    let buffered = Buffer.alloc(0);
    let upstream: net.Socket | null = null;
    let resolved = false;

    const teardown = () => {
      clearTimeout(timeout);
      socket.removeListener('data', onData);
      if (upstream) {
        // destroy() without an error emits no 'error', so the upstream's own
        // listener can stay too.
        upstream.destroy();
        upstream = null;
      }
    };

    // Destroy rather than end(): there is nothing left to say to this client,
    // and a half-closed socket would wait on the peer — which can stall it, or
    // reset it, as it pleases.
    const reject = () => {
      teardown();
      socket.destroy();
    };

    const timeout = setTimeout(() => {
      if (!resolved) {
        const fallback = findServerBySubdomain(config.routerDefaultSubdomain);
        if (fallback) {
          resolved = true;
          upstream = this.connectUpstream(socket, buffered, fallback);
        } else {
          reject();
        }
      }
    }, this.handshakeTimeoutMs);

    const onData = (chunk: Buffer | string) => {
      if (upstream) return;
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffered = Buffer.concat([buffered, next]);
      if (buffered.length > MAX_HANDSHAKE_BYTES) {
        reject();
        return;
      }

      try {
        const handshake = parseHandshake(buffered);
        if (!handshake) return;
        resolved = true;
        clearTimeout(timeout);

        const hostname = normalizeHostname(handshake.hostname);
        const subdomain = extractSubdomain(hostname);
        const target = findServerBySubdomain(subdomain);

        logger.info(
          { remoteAddress: socket.remoteAddress, remotePort: socket.remotePort, hostname, subdomain, targetId: target?.id },
          'Router parsed handshake'
        );

        if (!target) {
          logger.warn({ hostname, subdomain }, 'Router could not resolve target subdomain');
          reject();
          return;
        }

        if (target.hibernated) {
          // Nothing is listening upstream — the container is stopped. Answer in
          // process so the player sees "sleeping" rather than a refused
          // connection, and so a join attempt starts the server.
          socket.removeListener('data', onData);
          serveSleepingClient(socket, buffered, {
            versionName: 'Sleeping',
            motd: config.hibernationWakeOnConnect ? config.hibernationMotd : 'Sleeping — start this server from MC Dash',
            wakeMessage: config.hibernationWakeMessage,
            onWake: () => hibernationService.wake(target.id, 'player'),
          });
          return;
        }

        upstream = this.connectUpstream(socket, buffered, target);
      } catch (err) {
        logger.warn({ err }, 'Router failed to parse handshake');
        const fallback = findServerBySubdomain(config.routerDefaultSubdomain);
        if (fallback) {
          resolved = true;
          clearTimeout(timeout);
          logger.info({ fallbackId: fallback.id }, 'Router using default fallback subdomain');
          upstream = this.connectUpstream(socket, buffered, fallback);
          return;
        }
        reject();
      }
    };

    socket.on('data', onData);
  }

  private connectUpstream(client: net.Socket, buffered: Buffer, server: ServerRecord): net.Socket {
    const upstream = net.connect(server.serverPort, config.routerTargetHost, () => {
      upstream.write(buffered);
      client.pipe(upstream);
      upstream.pipe(client);
    });

    upstream.on('error', (err) => {
      logger.warn({ err }, 'Router upstream error');
      client.destroy();
    });
    return upstream;
  }
}

export const routerService = new RouterService();
