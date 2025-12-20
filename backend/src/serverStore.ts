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
    packId INTEGER,
    packFileId INTEGER,
    packVersion TEXT,
    serverPackUrl TEXT,
    containerId TEXT,
    status TEXT NOT NULL,
    resources TEXT NOT NULL,
    game TEXT NOT NULL,
    notes TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )`
).run();

type ServerRow = {
  id: string;
  name: string;
  packId?: number;
  packFileId?: number;
  packVersion?: string;
  serverPackUrl?: string;
  containerId?: string | null;
  status: ServerStatus;
  resources: string;
  game: string;
  notes?: string;
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

function mapRow(row: ServerRow): ServerRecord {
  return {
    id: row.id,
    name: row.name,
    packId: row.packId,
    packFileId: row.packFileId,
    packVersion: row.packVersion,
    serverPackUrl: row.serverPackUrl,
    containerId: row.containerId ?? undefined,
    status: row.status,
    resources: parseJsonField<ResourceConfig>(row.resources),
    game: parseJsonField<GameConfig>(row.game),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    notes: row.notes ?? undefined,
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
    const defaultStatus: ServerStatus = 'pending';

    const stmt = db.prepare(
      `INSERT INTO servers (
        id, name, packId, packFileId, packVersion, serverPackUrl, containerId, status, resources, game, notes, createdAt, updatedAt
      ) VALUES (
        @id, @name, @packId, @packFileId, @packVersion, @serverPackUrl, NULL, @status, @resources, @game, NULL, @createdAt, @updatedAt
      )`
    );

    stmt.run({
      id,
      name: input.name,
      packId: input.packId ?? null,
      packFileId: input.packFileId ?? null,
      packVersion: input.packVersion ?? null,
      serverPackUrl: input.serverPackUrl ?? null,
      status: defaultStatus,
      resources: JSON.stringify(input.resources),
      game: JSON.stringify(input.game),
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
}

export const serverStore = new ServerStore();
