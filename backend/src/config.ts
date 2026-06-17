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

const SESSION_TTL_DAYS = Number(process.env.MC_DASH_SESSION_TTL_DAYS ?? 7);
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
  sessionSecret: process.env.MC_DASH_SESSION_SECRET || undefined,
  sessionTtlMs: (Number.isFinite(SESSION_TTL_DAYS) ? SESSION_TTL_DAYS : 7) * 24 * 60 * 60 * 1000,
  cookieSecure: String(process.env.MC_DASH_COOKIE_SECURE ?? '').toLowerCase() === 'true',
  frontendOrigins,
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
