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
  `,
  // v2 — accounts: the app is exposed to the public internet via the reverse proxy, so
  // playback and APIs sit behind a login. Users live in SQLite on the /data volume, which
  // the compose file mounts from the host — accounts, sessions' signing secret and all
  // state survive image upgrades by construction.
  `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  `,
  // v3 — per-user favorites + watch history (the M4 round), and a not-before timestamp on
  // users so a password change invalidates existing sessions (tokens carry their issue time;
  // verify rejects tokens issued before the user's not-before).
  `
  ALTER TABLE users ADD COLUMN sessions_not_before_utc INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE IF NOT EXISTS favorites (
    user_id INTEGER NOT NULL,
    channel_uuid TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (user_id, channel_uuid)
  );

  CREATE TABLE IF NOT EXISTS watch_history (
    user_id INTEGER NOT NULL,
    channel_uuid TEXT NOT NULL,
    watched_at_utc INTEGER NOT NULL,
    PRIMARY KEY (user_id, channel_uuid)
  );
  CREATE INDEX IF NOT EXISTS idx_watch_history_recent ON watch_history (user_id, watched_at_utc DESC);
  `,
  // v4 — programme reminders ("Remind me" in the guide). A reminder is one programme:
  // identity is (tvg_id, start_utc), the same key the EPG uses. channel_uuid rides along so
  // the toast can tune without a lookup; rows whose programme has ended simply stop being
  // served and are pruned lazily.
  `
  CREATE TABLE IF NOT EXISTS reminders (
    user_id INTEGER NOT NULL,
    tvg_id TEXT NOT NULL,
    channel_uuid TEXT NOT NULL,
    title TEXT NOT NULL,
    start_utc INTEGER NOT NULL,
    stop_utc INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (user_id, tvg_id, start_utc)
  );
  CREATE INDEX IF NOT EXISTS idx_reminders_start ON reminders (user_id, start_utc);
  `,
  // v5 — VOD movie library (synced from Dispatcharr's REST: /api/vod/movies/, 26k titles on
  // the live instance). `id` is Dispatcharr's own stable id; logo_path is the PATH of
  // Dispatcharr's logo-cache URL (host-independent, rewritten to the proxy at emission).
  // Series are deliberately not synced yet: the live provider carries 9k series with zero
  // ingested episodes — /api/vod/episodes/ is empty — so the v1 VOD surface is movies only.
  `
  CREATE TABLE IF NOT EXISTS vod_movies (
    id INTEGER PRIMARY KEY,
    uuid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    year INTEGER,
    rating TEXT,
    genre TEXT,
    description TEXT,
    duration_secs INTEGER,
    logo_path TEXT,
    is_adult INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_vod_movies_name ON vod_movies (name);
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
