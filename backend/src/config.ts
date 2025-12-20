import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const defaultSqlitePath = path.resolve(__dirname, '..', 'data', 'mc-dash.sqlite');

export const config = {
  port: Number(process.env.PORT ?? 4000),
  sqlitePath: process.env.SQLITE_PATH ? path.resolve(process.cwd(), process.env.SQLITE_PATH) : defaultSqlitePath,
  curseforgeApiKey: process.env.CURSEFORGE_API_KEY ?? '',
  dockerSocketPath: process.env.DOCKER_SOCKET_PATH,
  dockerHost: process.env.DOCKER_HOST,
  dockerTlsVerify: process.env.DOCKER_TLS_VERIFY,
};

// Ensure the data directory exists for SQLite
const sqliteDir = path.dirname(config.sqlitePath);
if (!fs.existsSync(sqliteDir)) {
  fs.mkdirSync(sqliteDir, { recursive: true });
}
