import net from 'net';
import { config } from '../config';
import { logger } from '../logger';
import { serverStore } from '../serverStore';
import type { ServerRecord } from '../types';

const MAX_HANDSHAKE_BYTES = 8 * 1024;
const HANDSHAKE_TIMEOUT_MS = 5000;

type VarIntResult = { value: number; size: number };

function readVarInt(buffer: Buffer, offset: number): VarIntResult | null {
  let result = 0;
  let shift = 0;
  let size = 0;

  while (size < 5) {
    if (offset + size >= buffer.length) return null;
    const byte = buffer[offset + size];
    result |= (byte & 0x7f) << shift;
    size += 1;
    if ((byte & 0x80) !== 0x80) {
      return { value: result, size };
    }
    shift += 7;
  }

  return null;
}

function parseHandshakeHostname(buffer: Buffer): string | null {
  if (buffer.length === 0) return null;
  if (buffer[0] === 0xfe) {
    throw new Error('Legacy ping packet');
  }

  const packetLength = readVarInt(buffer, 0);
  if (!packetLength) return null;
  const packetEnd = packetLength.size + packetLength.value;
  if (buffer.length < packetEnd) return null;

  let offset = packetLength.size;
  const packetId = readVarInt(buffer, offset);
  if (!packetId) return null;
  if (packetId.value !== 0x00) {
    throw new Error('Not a handshake packet');
  }
  offset += packetId.size;

  const protocolVersion = readVarInt(buffer, offset);
  if (!protocolVersion) return null;
  offset += protocolVersion.size;

  const hostLength = readVarInt(buffer, offset);
  if (!hostLength) return null;
  offset += hostLength.size;
  if (offset + hostLength.value > buffer.length) return null;

  const hostname = buffer.slice(offset, offset + hostLength.value).toString('utf8');
  return hostname;
}

function normalizeHostname(value: string | null): string | undefined {
  if (!value) return undefined;
  const base = value.split('\0')[0];
  const withoutPort = base.split(':')[0];
  const trimmed = withoutPort.trim().replace(/\.$/, '').toLowerCase();
  return trimmed.length ? trimmed : undefined;
}

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

export class RouterService {
  private server: net.Server | null = null;

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
    socket.setNoDelay(true);

    let buffered = Buffer.alloc(0);
    let upstream: net.Socket | null = null;
    let resolved = false;

    const cleanup = () => {
      if (upstream) {
        upstream.removeAllListeners();
        upstream.destroy();
        upstream = null;
      }
      socket.removeAllListeners();
    };

    const timeout = setTimeout(() => {
      if (!resolved) {
        const fallback = findServerBySubdomain(config.routerDefaultSubdomain);
        if (fallback) {
          resolved = true;
          upstream = this.connectUpstream(socket, buffered, fallback);
        } else {
          socket.end();
          cleanup();
        }
      }
    }, HANDSHAKE_TIMEOUT_MS);

    socket.on('data', (chunk) => {
      if (upstream) return;
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffered = Buffer.concat([buffered, next]);
      if (buffered.length > MAX_HANDSHAKE_BYTES) {
        socket.end();
        cleanup();
        return;
      }

      try {
        const hostnameRaw = parseHandshakeHostname(buffered);
        if (!hostnameRaw) return;
        resolved = true;
        clearTimeout(timeout);

        const hostname = normalizeHostname(hostnameRaw);
        const subdomain = extractSubdomain(hostname);
        const target = findServerBySubdomain(subdomain);

        logger.info(
          { remoteAddress: socket.remoteAddress, remotePort: socket.remotePort, hostname, subdomain, targetId: target?.id },
          'Router parsed handshake'
        );

        if (!target) {
          logger.warn({ hostname, subdomain }, 'Router could not resolve target subdomain');
          socket.end();
          cleanup();
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
        socket.end();
        cleanup();
      }
    });

    socket.on('error', () => {
      clearTimeout(timeout);
      cleanup();
    });

    socket.on('close', () => {
      clearTimeout(timeout);
      cleanup();
    });
  }

  private connectUpstream(client: net.Socket, buffered: Buffer, server: ServerRecord): net.Socket {
    const upstream = net.connect(server.serverPort, config.routerTargetHost, () => {
      upstream.write(buffered);
      client.pipe(upstream);
      upstream.pipe(client);
    });

    upstream.on('error', (err) => {
      logger.warn({ err }, 'Router upstream error');
      client.end();
    });
    return upstream;
  }
}

export const routerService = new RouterService();
