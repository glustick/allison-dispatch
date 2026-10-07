import type { Db } from './db.js'
import type { ChannelRow } from './queries.js'

// Per-user favorites and watch history. Channels vanish and reappear with M3U syncs — both
// surfaces JOIN against channels so stale rows (a favorite whose uuid left the lineup) are
// simply not shown; the rows themselves are harmless and come back if the channel returns.

export function listFavorites(db: Db, userId: number): ChannelRow[] {
  return db
    .prepare(
      `SELECT c.uuid, c.name, c.channel_number, c.tvg_id, c.tvg_name, c.logo_url, c.group_name
       FROM favorites f JOIN channels c ON c.uuid = f.channel_uuid
       WHERE f.user_id = ?
       ORDER BY f.created_at, c.channel_number IS NULL, c.channel_number, c.name`
    )
    .all(userId) as ChannelRow[]
}

export function isFavorite(db: Db, userId: number, uuid: string): boolean {
  return db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND channel_uuid = ?').get(userId, uuid) !== undefined
}

export function addFavorite(db: Db, userId: number, uuid: string): void {
  db.prepare('INSERT OR IGNORE INTO favorites (user_id, channel_uuid) VALUES (?, ?)').run(userId, uuid)
}

export function removeFavorite(db: Db, userId: number, uuid: string): void {
  db.prepare('DELETE FROM favorites WHERE user_id = ? AND channel_uuid = ?').run(userId, uuid)
}

export interface RecentChannel extends ChannelRow {
  watched_at_utc: number
}

// Most-recently-watched first — the first entry is what the player resumes.
export function listRecents(db: Db, userId: number, limit = 12): RecentChannel[] {
  return db
    .prepare(
      `SELECT c.uuid, c.name, c.channel_number, c.tvg_id, c.tvg_name, c.logo_url, c.group_name, h.watched_at_utc
       FROM watch_history h JOIN channels c ON c.uuid = h.channel_uuid
       WHERE h.user_id = ?
       ORDER BY h.watched_at_utc DESC
       LIMIT ?`
    )
    .all(userId, limit) as RecentChannel[]
}

// Upsert: one row per (user, channel) carrying the latest watch time.
export function recordWatch(db: Db, userId: number, uuid: string, now = Date.now()): void {
  db.prepare(
    `INSERT INTO watch_history (user_id, channel_uuid, watched_at_utc) VALUES (?, ?, ?)
     ON CONFLICT(user_id, channel_uuid) DO UPDATE SET watched_at_utc = excluded.watched_at_utc`
  ).run(userId, uuid, now)
}
