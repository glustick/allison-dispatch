import type { Db } from './db.js'

// Per-user programme reminders ("Remind me" in the guide's programme detail). Identity is
// (tvg_id, start_utc) — the same key that identifies a programme in the EPG. Rows live until
// deleted; ended programmes simply stop being served (listReminders filters on stop_utc) so
// the table prunes itself of relevance without a sweep.

export interface ReminderRow {
  tvg_id: string
  channel_uuid: string
  title: string
  start_utc: number
  stop_utc: number
}

// Everything the viewer still cares about: the programme hasn't ended. Chronological so the
// client reads it like a schedule.
export function listReminders(db: Db, userId: number, nowMs: number): ReminderRow[] {
  return db
    .prepare(
      `SELECT tvg_id, channel_uuid, title, start_utc, stop_utc
       FROM reminders
       WHERE user_id = ? AND stop_utc > ?
       ORDER BY start_utc, tvg_id`
    )
    .all(userId, nowMs) as ReminderRow[]
}

export function addReminder(db: Db, userId: number, reminder: ReminderRow): void {
  db.prepare(
    `INSERT OR IGNORE INTO reminders (user_id, tvg_id, channel_uuid, title, start_utc, stop_utc)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, reminder.tvg_id, reminder.channel_uuid, reminder.title, reminder.start_utc, reminder.stop_utc)
}

export function removeReminder(db: Db, userId: number, tvgId: string, startUtc: number): void {
  db.prepare('DELETE FROM reminders WHERE user_id = ? AND tvg_id = ? AND start_utc = ?').run(userId, tvgId, startUtc)
}
