import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { logger } from './logger';
import { config } from './config';
import { GameConfig, ResourceConfig, ServerCreateInput, ServerRecord, ServerStatus, ServerUpdateInput } from './types';

const db = new Database(config.sqlitePath);
db.pragma('journal_mode = WAL');

db.prepare(
  `CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    serverPackUrl TEXT,
    javaImage TEXT,
    containerId TEXT,
    whitelist TEXT,
    blacklist TEXT,
    ipBlacklist TEXT,
    whitelistEnabled INTEGER NOT NULL DEFAULT 0,
    blacklistEnabled INTEGER NOT NULL DEFAULT 0,
    ipBlacklistEnabled INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    resources TEXT NOT NULL,
    game TEXT NOT NULL,
    notes TEXT,
    restartRequired INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )`
).run();

const columns = db.prepare(`PRAGMA table_info(servers)`).all() as { name: string }[];
if (!columns.find((col) => col.name === 'restartRequired')) {
  db.prepare(`ALTER TABLE servers ADD COLUMN restartRequired INTEGER NOT NULL DEFAULT 0`).run();
}
if (!columns.find((col) => col.name === 'javaImage')) {
  db.prepare(`ALTER TABLE servers ADD COLUMN javaImage TEXT`).run();
}
if (!columns.find((col) => col.name === 'whitelist')) {
  db.prepare(`ALTER TABLE servers ADD COLUMN whitelist TEXT`).run();
}
if (!columns.find((col) => col.name === 'blacklist')) {
  db.prepare(`ALTER TABLE servers ADD COLUMN blacklist TEXT`).run();
}
if (!columns.find((col) => col.name === 'ipBlacklist')) {
  db.prepare(`ALTER TABLE servers ADD COLUMN ipBlacklist TEXT`).run();
}
if (!columns.find((col) => col.name === 'whitelistEnabled')) {
  db.prepare(`ALTER TABLE servers ADD COLUMN whitelistEnabled INTEGER NOT NULL DEFAULT 0`).run();
}
if (!columns.find((col) => col.name === 'blacklistEnabled')) {
  db.prepare(`ALTER TABLE servers ADD COLUMN blacklistEnabled INTEGER NOT NULL DEFAULT 0`).run();
}
if (!columns.find((col) => col.name === 'ipBlacklistEnabled')) {
  db.prepare(`ALTER TABLE servers ADD COLUMN ipBlacklistEnabled INTEGER NOT NULL DEFAULT 0`).run();
}

type ServerRow = {
  id: string;
  name: string;
  serverPackUrl?: string;
  javaImage?: string | null;
  containerId?: string | null;
  whitelist?: string | null;
  blacklist?: string | null;
  ipBlacklist?: string | null;
  whitelistEnabled?: number | null;
  blacklistEnabled?: number | null;
  ipBlacklistEnabled?: number | null;
  status: ServerStatus;
  resources: string;
  game: string;
  notes?: string;
  restartRequired?: number;
  createdAt: string;
  updatedAt: string;
};

function parseJsonField<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    logger.error({ err }, 'Failed to parse JSON column');
    return {} as T;
  }
}

function parseStringList(value?: string | null): string[] | undefined {
  if (value == null) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((entry) => typeof entry === 'string') as string[];
    }
  } catch (err) {
    logger.error({ err }, 'Failed to parse string list column');
  }
  return [];
}

function mapRow(row: ServerRow): ServerRecord {
  const whitelist = parseStringList(row.whitelist);
  const blacklist = parseStringList(row.blacklist);
  const ipBlacklist = parseStringList(row.ipBlacklist);
  return {
    id: row.id,
    name: row.name,
    serverPackUrl: row.serverPackUrl,
    javaImage: row.javaImage ?? undefined,
    containerId: row.containerId ?? undefined,
    whitelist,
    blacklist,
    ipBlacklist,
    whitelistEnabled: row.whitelistEnabled != null ? row.whitelistEnabled === 1 : (whitelist?.length ?? 0) > 0,
    blacklistEnabled: row.blacklistEnabled != null ? row.blacklistEnabled === 1 : (blacklist?.length ?? 0) > 0,
    ipBlacklistEnabled: row.ipBlacklistEnabled != null ? row.ipBlacklistEnabled === 1 : (ipBlacklist?.length ?? 0) > 0,
    status: row.status,
    resources: parseJsonField<ResourceConfig>(row.resources),
    game: parseJsonField<GameConfig>(row.game),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    notes: row.notes ?? undefined,
    restartRequired: row.restartRequired === 1,
  };
}

export class ServerStore {
  list(): ServerRecord[] {
    const stmt = db.prepare<[]>(`SELECT * FROM servers ORDER BY createdAt DESC`);
    const rows = stmt.all() as ServerRow[];
    return rows.map(mapRow);
  }

  get(id: string): ServerRecord | null {
    const stmt = db.prepare<[string]>(`SELECT * FROM servers WHERE id = ?`);
    const row = stmt.get(id) as ServerRow | undefined;
    return row ? mapRow(row) : null;
  }

  create(input: ServerCreateInput): ServerRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    const defaultStatus: ServerStatus = 'stopped';
    const restartRequired = 0;

    const stmt = db.prepare(
      `INSERT INTO servers (
        id, name, serverPackUrl, javaImage, containerId, whitelist, blacklist, ipBlacklist, whitelistEnabled, blacklistEnabled, ipBlacklistEnabled, status, resources, game, notes, restartRequired, createdAt, updatedAt
      ) VALUES (
        @id, @name, @serverPackUrl, @javaImage, NULL, @whitelist, @blacklist, @ipBlacklist, @whitelistEnabled, @blacklistEnabled, @ipBlacklistEnabled, @status, @resources, @game, NULL, @restartRequired, @createdAt, @updatedAt
      )`
    );

    const whitelistEnabled = input.whitelistEnabled ?? (input.whitelist?.length ?? 0) > 0;
    const blacklistEnabled = input.blacklistEnabled ?? (input.blacklist?.length ?? 0) > 0;
    const ipBlacklistEnabled = input.ipBlacklistEnabled ?? (input.ipBlacklist?.length ?? 0) > 0;

    stmt.run({
      id,
      name: input.name,
      serverPackUrl: null,
      javaImage: input.javaImage ?? null,
      whitelist: input.whitelist !== undefined ? JSON.stringify(input.whitelist) : null,
      blacklist: input.blacklist !== undefined ? JSON.stringify(input.blacklist) : null,
      ipBlacklist: input.ipBlacklist !== undefined ? JSON.stringify(input.ipBlacklist) : null,
      whitelistEnabled: whitelistEnabled ? 1 : 0,
      blacklistEnabled: blacklistEnabled ? 1 : 0,
      ipBlacklistEnabled: ipBlacklistEnabled ? 1 : 0,
      status: defaultStatus,
      resources: JSON.stringify(input.resources),
      game: JSON.stringify(input.game),
      restartRequired,
      createdAt: now,
      updatedAt: now,
    });

    const created = this.get(id);
    if (!created) {
      throw new Error('Failed to fetch created server');
    }
    return created;
  }

  update(id: string, updates: ServerUpdateInput): ServerRecord | null {
    const existing = this.get(id);
    if (!existing) return null;

    const next: Partial<ServerRow> = {};

    if (updates.resources) {
      next.resources = JSON.stringify(updates.resources);
    }
    if (updates.game) {
      next.game = JSON.stringify(updates.game);
    }
    if (typeof updates.status === 'string') {
      next.status = updates.status;
    }
    if (updates.containerId !== undefined) {
      next.containerId = updates.containerId ?? null;
    }
    if (updates.serverPackUrl !== undefined) {
      next.serverPackUrl = updates.serverPackUrl;
    }
    if (updates.javaImage !== undefined) {
      next.javaImage = updates.javaImage ?? null;
    }
    if (updates.whitelist !== undefined) {
      next.whitelist = JSON.stringify(updates.whitelist);
    }
    if (updates.blacklist !== undefined) {
      next.blacklist = JSON.stringify(updates.blacklist);
    }
    if (updates.ipBlacklist !== undefined) {
      next.ipBlacklist = JSON.stringify(updates.ipBlacklist);
    }
    if (updates.whitelistEnabled !== undefined) {
      next.whitelistEnabled = updates.whitelistEnabled ? 1 : 0;
    }
    if (updates.blacklistEnabled !== undefined) {
      next.blacklistEnabled = updates.blacklistEnabled ? 1 : 0;
    }
    if (updates.ipBlacklistEnabled !== undefined) {
      next.ipBlacklistEnabled = updates.ipBlacklistEnabled ? 1 : 0;
    }
    if (updates.restartRequired !== undefined) {
      next.restartRequired = updates.restartRequired ? 1 : 0;
    }

    if (Object.keys(next).length === 0) {
      return existing;
    }

    const setClauses: string[] = [];
    const params: Record<string, unknown> = { id, updatedAt: new Date().toISOString() };

    Object.entries(next).forEach(([key, value]) => {
      setClauses.push(`${key} = @${key}`);
      params[key] = value;
    });
    setClauses.push('updatedAt = @updatedAt');

    const stmt = db.prepare(
      `UPDATE servers SET ${setClauses.join(', ')} WHERE id = @id`
    );
    stmt.run(params);

    return this.get(id);
  }

  delete(id: string): boolean {
    const stmt = db.prepare(`DELETE FROM servers WHERE id = ?`);
    const result = stmt.run(id);
    return result.changes > 0;
  }
}

export const serverStore = new ServerStore();
