import type { Db } from './db.js'

export interface ChannelRow {
  uuid: string
  name: string
  channel_number: number | null
  tvg_id: string | null
  tvg_name: string | null
  logo_url: string | null
  group_name: string | null
}

export interface ProgrammeRow {
  channel_id: string
  title: string
  description: string | null
  category: string | null
  start_utc: number
  stop_utc: number
}

export interface NowNext {
  now: ProgrammeRow | null
  next: ProgrammeRow | null
}

export function listChannels(db: Db): ChannelRow[] {
  return db
  .prepare(
    `SELECT uuid, name, channel_number, tvg_id, tvg_name, logo_url, group_name
     FROM channels
     ORDER BY channel_number IS NULL, channel_number, position, name`
  )
  .all() as ChannelRow[]
}

// now/next for one channel. "now" is the programme strictly containing the given instant;
// boundary programmes that ended exactly at `nowMs` belong to the past.
export function nowNext(db: Db, uuid: string, nowMs: number): NowNext | null {
  const channel = db.prepare('SELECT tvg_id FROM channels WHERE uuid = ?').get(uuid) as
    | { tvg_id: string | null }
    | undefined
  if (!channel || channel.tvg_id === null) return null
  const stmt = db.prepare(
    `SELECT channel_id, title, description, category, start_utc, stop_utc
     FROM epg_programs
     WHERE channel_id = ? AND start_utc <= ? AND stop_utc > ?
     ORDER BY start_utc`
  )
  const now = stmt.get(channel.tvg_id, nowMs, nowMs) as ProgrammeRow | undefined
  const next = db
    .prepare(
      `SELECT channel_id, title, description, category, start_utc, stop_utc
       FROM epg_programs
       WHERE channel_id = ? AND start_utc > ?
       ORDER BY start_utc
       LIMIT 1`
    )
    .get(channel.tvg_id, nowMs) as ProgrammeRow | undefined
  return { now: now ?? null, next: next ?? null }
}

// Guide window: programmes overlapping [startMs, endMs) for one channel (uuid) — the Guide
// (M3) fetches one window per visible channel slice. Overlap uses the standard half-open
// interval test: programme starts before window end AND stops after window start.
export function guideWindow(db: Db, uuid: string, startMs: number, endMs: number): ProgrammeRow[] {
  const channel = db.prepare('SELECT tvg_id FROM channels WHERE uuid = ?').get(uuid) as
    | { tvg_id: string | null }
    | undefined
  if (!channel || channel.tvg_id === null) return []
  return db
    .prepare(
      `SELECT channel_id, title, description, category, start_utc, stop_utc
       FROM epg_programs
       WHERE channel_id = ? AND start_utc < ? AND stop_utc > ?
       ORDER BY start_utc`
    )
    .all(channel.tvg_id, endMs, startMs) as ProgrammeRow[]
}

export interface GuideGridChannel {
  uuid: string
  name: string
  channel_number: number | null
  logo_url: string | null
  group_name: string | null
  programmes: ProgrammeRow[]
}

// The whole guide grid in one query: every channel with its programmes overlapping the
// window, LEFT JOINed so guide-less channels still appear (their rows render "No guide
// data", like the sibling's grid).
export function guideGrid(db: Db, startMs: number, endMs: number): GuideGridChannel[] {
  const rows = db
    .prepare(
      `SELECT c.uuid, c.name, c.channel_number, c.logo_url, c.group_name,
              p.title, p.description, p.category, p.start_utc, p.stop_utc
       FROM channels c
       LEFT JOIN epg_programs p
         ON p.channel_id = c.tvg_id AND p.start_utc < ? AND p.stop_utc > ?
       ORDER BY c.channel_number IS NULL, c.channel_number, c.position, c.name, p.start_utc`
    )
    .all(endMs, startMs) as Array<{
    uuid: string
    name: string
    channel_number: number | null
    logo_url: string | null
    group_name: string | null
    title: string | null
    description: string | null
    category: string | null
    start_utc: number | null
    stop_utc: number | null
  }>
  const out: GuideGridChannel[] = []
  let current: GuideGridChannel | null = null
  for (const row of rows) {
    if (current === null || current.uuid !== row.uuid) {
      current = {
        uuid: row.uuid,
        name: row.name,
        channel_number: row.channel_number,
        logo_url: row.logo_url,
        group_name: row.group_name,
        programmes: []
      }
      out.push(current)
    }
    if (row.title !== null && row.start_utc !== null && row.stop_utc !== null) {
      current.programmes.push({
        channel_id: '',
        title: row.title,
        description: row.description,
        category: row.category,
        start_utc: row.start_utc,
        stop_utc: row.stop_utc
      })
    }
  }
  return out
}

export interface SyncStateRow {
  kind: string
  last_run_utc: number | null
  status: string
  item_count: number | null
  error: string | null
}

export function getSyncStates(db: Db): Record<string, SyncStateRow> {
  const rows = db.prepare('SELECT kind, last_run_utc, status, item_count, error FROM sync_state').all() as SyncStateRow[]
  const out: Record<string, SyncStateRow> = {}
  for (const row of rows) out[row.kind] = row
  return out
}
