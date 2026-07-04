import Database from 'better-sqlite3';
import { config } from './config';

// Single shared SQLite connection for the whole process. Opening one handle
// (rather than one per store) keeps WAL writers serialized and avoids
// SQLITE_BUSY between the server store and the metrics store.
export const db = new Database(config.sqlitePath);
db.pragma('journal_mode = WAL');
