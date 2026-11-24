import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { MIDLIFE_PROMPTS } from './prompts.js';

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), '..', 'data'));
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
export const THUMBS_DIR = path.join(DATA_DIR, 'thumbs');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(THUMBS_DIR, { recursive: true });

const LEGACY_DB_PATH = path.join(DATA_DIR, 'meridian.db');
export const DB_PATH = path.join(DATA_DIR, 'midline.db');
if (!fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB_PATH)) {
  fs.renameSync(LEGACY_DB_PATH, DB_PATH);
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(LEGACY_DB_PATH + ext)) {
      fs.renameSync(LEGACY_DB_PATH + ext, DB_PATH + ext);
    }
  }
}

function openDatabase(): Database.Database {
  const instance = new Database(DB_PATH);
  instance.pragma('journal_mode = WAL');
  instance.pragma('foreign_keys = ON');
  return instance;
}

export let db: Database.Database = openDatabase();

let restoring = false;

export function isDbRestoring(): boolean {
  return restoring;
}

export function setDbRestoring(value: boolean): void {
  restoring = value;
}

export function closeDb(): void {
  if (db.open) {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // ignore checkpoint errors if DB is already closing or read-only
    }
    db.close();
  }
}

export function reopenDb(): Database.Database {
  if (db.open) {
    db.close();
  }
  db = openDatabase();
  return db;
}

export function initDb(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      device_type TEXT,
      backed_up INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      question TEXT NOT NULL UNIQUE,
      is_custom INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      entry_date TEXT NOT NULL,      -- YYYY-MM-DD (local date chosen by user)
      entry_time TEXT NOT NULL,      -- HH:MM (24h local time)
      entry_timestamp TEXT NOT NULL, -- ISO-like local timestamp YYYY-MM-DDTHH:MM:SS for sorting
      mood TEXT,
      energy INTEGER,                -- 1-5 optional
      prompt_id INTEGER REFERENCES prompts(id) ON DELETE SET NULL,
      prompt_text TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(entry_date DESC, entry_time DESC);
    CREATE INDEX IF NOT EXISTS idx_entries_mmdd ON entries(substr(entry_date, 6, 5));

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS entry_tags (
      entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (entry_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      thumb_filename TEXT,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      caption TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_photos_entry ON photos(entry_id, sort_order);
  `);

  // Seed default midlife prompts if prompts table is empty
  const countRow = db.prepare('SELECT COUNT(*) as count FROM prompts').get() as { count: number };
  if (countRow.count === 0) {
    const insert = db.prepare(
      'INSERT OR IGNORE INTO prompts (category, question, is_custom) VALUES (?, ?, 0)'
    );
    const seedMany = db.transaction((items: typeof MIDLIFE_PROMPTS) => {
      for (const item of items) {
        insert.run(item.category, item.question);
      }
    });
    seedMany(MIDLIFE_PROMPTS);
  }
}

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

export { DATA_DIR };
