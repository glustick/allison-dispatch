import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import path from 'path'

// Schema migrations run by ascending version; each entry transforms the DB from version N
// to N+1 and user_version is bumped inside the same transaction. Append-only: never edit an
// already-shipped migration, add a new one.
const MIGRATIONS: string[] = [
  // v1 — initial schema (M1: channels + EPG + sync bookkeeping).
  `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS channels (
    uuid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    channel_number INTEGER,
    tvg_id TEXT,
    tvg_name TEXT,
    logo_url TEXT,
    group_name TEXT,
    position INTEGER,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_channels_number ON channels (channel_number);
  CREATE INDEX IF NOT EXISTS idx_channels_group ON channels (group_name);

  CREATE TABLE IF NOT EXISTS epg_programs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT,
    start_utc INTEGER NOT NULL,
    stop_utc INTEGER NOT NULL,
    UNIQUE (channel_id, start_utc)
  );
  CREATE INDEX IF NOT EXISTS idx_epg_channel_start ON epg_programs (channel_id, start_utc);
  CREATE INDEX IF NOT EXISTS idx_epg_stop ON epg_programs (stop_utc);

  CREATE TABLE IF NOT EXISTS sync_state (
    kind TEXT PRIMARY KEY,
    last_run_utc INTEGER,
    status TEXT NOT NULL,
    item_count INTEGER,
    error TEXT
  );
  `
]

export type Db = Database.Database

export function openDb(dataDir: string): Db {
  let db: Db
  if (dataDir === ':memory:') {
    db = new Database(':memory:')
  } else {
    mkdirSync(dataDir, { recursive: true })
    db = new Database(path.join(dataDir, 'allison-dispatch.db'))
  }
  db.pragma('journal_mode = WAL')
  migrate(db)
  return db
}

function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v])
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
}
