import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const dataRoot = process.env.DATA_ROOT
  ? path.resolve(process.cwd(), process.env.DATA_ROOT)
  : path.resolve(__dirname, '..', 'data');
const defaultSqlitePath = path.join(dataRoot, 'mc-dash.sqlite');

const homeSocket = process.env.HOME ? path.join(process.env.HOME, '.docker', 'run', 'docker.sock') : null;
const defaultDockerSocketPath = (() => {
  if (process.env.DOCKER_SOCKET_PATH) return process.env.DOCKER_SOCKET_PATH;
  const varRun = '/var/run/docker.sock';
  if (fs.existsSync(varRun)) return varRun;
  if (homeSocket && fs.existsSync(homeSocket)) return homeSocket;
  return varRun;
})();

const defaultServerPort = Number(process.env.MC_SERVER_PORT ?? 25565);
const serverPortMin = Number(process.env.MC_SERVER_PORT_MIN ?? defaultServerPort);
const serverPortMax = Number(process.env.MC_SERVER_PORT_MAX ?? defaultServerPort + 100);
const routerEnabled = String(process.env.MC_ROUTER_ENABLED ?? '').toLowerCase() === 'true';
const routerDomain = process.env.MC_ROUTER_DOMAIN ? process.env.MC_ROUTER_DOMAIN.trim().toLowerCase() : undefined;
const routerPort = Number(process.env.MC_ROUTER_PORT ?? 25565);
const routerTargetHost = process.env.MC_ROUTER_TARGET_HOST ?? '127.0.0.1';
const routerDefaultSubdomain = process.env.MC_ROUTER_DEFAULT_SUBDOMAIN
  ? process.env.MC_ROUTER_DEFAULT_SUBDOMAIN.trim().toLowerCase()
  : undefined;

// The uid:gid the per-server Minecraft containers should run as. By default we
// mirror the backend process's own uid/gid so every file a server writes into
// its bind-mounted data folder is owned by the same user that runs MC Dash.
// Without this, containers run as root and the (often non-root) backend can't
// read the world files back — snapshots, restores and deletes fail with EACCES.
//   - unset            -> host uid:gid of this process (0:0 when backend is root)
//   - "1000:1000"/"1000"-> used verbatim as Docker's `User`
//   - "root"           -> force root (opt-out; e.g. packs that apt-get install at
//                          runtime, which needs root inside the container)
// On platforms without getuid (Windows dev) this is undefined and we let Docker
// Desktop handle ownership.
export function resolveContainerUser(
  raw: string | undefined = process.env.MC_CONTAINER_USER,
  getuid: (() => number) | undefined = typeof process.getuid === 'function' ? process.getuid.bind(process) : undefined,
  getgid: (() => number) | undefined = typeof process.getgid === 'function' ? process.getgid.bind(process) : undefined
): string | undefined {
  const trimmed = raw?.trim();
  if (trimmed) {
    if (trimmed.toLowerCase() === 'root') return '0:0';
    return trimmed;
  }
  if (!getuid) return undefined;
  const uid = getuid();
  const gid = getgid ? getgid() : uid;
  return `${uid}:${gid}`;
}

const SESSION_TTL_DAYS = Number(process.env.MC_DASH_SESSION_TTL_DAYS ?? 7);

function envNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Server packs and snapshot archives are uploaded in chunks (see
// services/uploadStaging), so this ceiling is disk, not memory — nothing here
// is ever held in RAM whole. A snapshot of a long-lived server carries its whole
// world and can reach tens of gigabytes, so this is deliberately loose: the
// check that actually protects the host is free space (below), which knows what
// the disk can take. This is only a backstop against an absurd declared size.
const maxUploadMb = Math.max(1, envNumber(process.env.MC_DASH_MAX_UPLOAD_MB, 32768));
// Never let an upload take the last of the disk: the extracted pack, the world
// and the logs all have to live somewhere after it lands. Refuse an upload that
// would leave less than this free.
const uploadDiskMarginMb = Math.max(0, envNumber(process.env.MC_DASH_UPLOAD_DISK_MARGIN_MB, 2048));
// Smallest slice a request will carry. The point of chunking is to stay under
// whatever the proxy in front allows, and the tightest common ceiling is
// Cloudflare's 100 MB — 8 MB leaves a wide margin and costs ~30 requests for a
// 240 MB pack.
const uploadChunkMb = Math.min(64, Math.max(1, envNumber(process.env.MC_DASH_UPLOAD_CHUNK_MB, 8)));
// Slices grow with the file rather than staying at the floor, because chunks are
// sent one after another: a 10 GB upload at 8 MB is 1280 sequential round trips,
// and on a fast link the waiting costs more than the bytes. 64 MB still sits
// comfortably under the 100 MB ceiling, and caps a retry's wasted work.
const uploadChunkMaxMb = Math.max(uploadChunkMb, Math.min(90, envNumber(process.env.MC_DASH_UPLOAD_CHUNK_MAX_MB, 64)));

// Fail closed. Anyone who gets past the login can upload a server pack and have
// the backend run it through the host's Docker socket, so an unset
// MC_DASH_PASSWORD must stop the boot rather than quietly serve an open API —
// the failure mode of a typo'd env file should be "won't start", not "the
// internet can spawn containers on my host". Opt out only on a trusted LAN.
const allowNoAuth = String(process.env.MC_DASH_ALLOW_NO_AUTH ?? '').toLowerCase() === 'true';
const frontendOrigins = (process.env.MC_DASH_FRONTEND_ORIGIN ?? 'http://localhost:3000,http://localhost:3001')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

export const config = {
  port: Number(process.env.PORT ?? 4000),
  sqlitePath: process.env.SQLITE_PATH ? path.resolve(process.cwd(), process.env.SQLITE_PATH) : defaultSqlitePath,
  dockerSocketPath: defaultDockerSocketPath,
  dockerHost: process.env.DOCKER_HOST,
  dockerTlsVerify: process.env.DOCKER_TLS_VERIFY,
  dockerApiVersion: process.env.DOCKER_API_VERSION,
  dataRoot,
  maxUploadBytes: maxUploadMb * 1024 * 1024,
  uploadDiskMarginBytes: uploadDiskMarginMb * 1024 * 1024,
  uploadChunkBytes: uploadChunkMb * 1024 * 1024,
  uploadChunkMaxBytes: uploadChunkMaxMb * 1024 * 1024,
  containerUser: resolveContainerUser(),
  javaImage: process.env.JAVA_IMAGE ?? 'eclipse-temurin:17-jre',
  serverPort: Number.isFinite(defaultServerPort) ? defaultServerPort : 25565,
  serverPortMin: Number.isFinite(serverPortMin) ? serverPortMin : 25565,
  serverPortMax: Number.isFinite(serverPortMax) ? serverPortMax : 25565,
  routerEnabled,
  routerDomain,
  routerPort: Number.isFinite(routerPort) ? routerPort : 25565,
  routerTargetHost,
  routerDefaultSubdomain,
  // Auth: when MC_DASH_PASSWORD is set, the API requires a login session.
  authPassword: process.env.MC_DASH_PASSWORD || undefined,
  allowNoAuth,
  sessionSecret: process.env.MC_DASH_SESSION_SECRET || undefined,
  sessionTtlMs: (Number.isFinite(SESSION_TTL_DAYS) ? SESSION_TTL_DAYS : 7) * 24 * 60 * 60 * 1000,
  cookieSecure: String(process.env.MC_DASH_COOKIE_SECURE ?? '').toLowerCase() === 'true',
  frontendOrigins,
  // Behind a reverse proxy / Cloudflare tunnel every request arrives from
  // 127.0.0.1, which would make req.ip useless for the login throttle and the
  // failed-login log. Set to "loopback" (or a hop count) so Express reads
  // X-Forwarded-For instead. Only safe when the port is not directly reachable,
  // otherwise anyone can forge the header — hence off by default.
  trustProxy: process.env.MC_DASH_TRUST_PROXY || undefined,
  // Bind 127.0.0.1 when a tunnel/proxy fronts the API, so the port can't be hit
  // directly and bypass whatever gating sits in front of it.
  bindHost: process.env.MC_DASH_BIND_HOST || '0.0.0.0',
};

// Ensure the data directory exists for SQLite
const sqliteDir = path.dirname(config.sqlitePath);
if (!fs.existsSync(sqliteDir)) {
  fs.mkdirSync(sqliteDir, { recursive: true });
}

// Ensure data root exists for server files
if (!fs.existsSync(config.dataRoot)) {
  fs.mkdirSync(config.dataRoot, { recursive: true });
}
