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

export const config = {
  port: Number(process.env.PORT ?? 4000),
  sqlitePath: process.env.SQLITE_PATH ? path.resolve(process.cwd(), process.env.SQLITE_PATH) : defaultSqlitePath,
  curseforgeApiKey: process.env.CURSEFORGE_API_KEY ?? '',
  dockerSocketPath: defaultDockerSocketPath,
  dockerHost: process.env.DOCKER_HOST,
  dockerTlsVerify: process.env.DOCKER_TLS_VERIFY,
  dockerApiVersion: process.env.DOCKER_API_VERSION,
  dataRoot,
  javaImage: process.env.JAVA_IMAGE ?? 'eclipse-temurin:17-jre',
  serverPort: Number(process.env.MC_SERVER_PORT ?? 25565),
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
