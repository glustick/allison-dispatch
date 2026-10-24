// Reminder due-ness — pure so the timing rules are testable without React.

export interface Reminder {
  tvg_id: string
  channel_uuid: string
  title: string
  start_utc: number
  stop_utc: number
}

// A reminder is due while its programme has JUST started: the start time passed, but not by
// more than two minutes. A tab reopened after hours must not toast a whole evening of stale
// reminders — those simply never fire and are deleted server-side by the client that toasts.
export const REMINDER_DUE_WINDOW_MS = 2 * 60_000

export function isReminderDue(startUtc: number, nowMs: number): boolean {
  return startUtc <= nowMs && nowMs < startUtc + REMINDER_DUE_WINDOW_MS
}

// Reminder identity is the EPG's own programme key.
export function reminderKey(tvgId: string, startUtc: number): string {
  return `${tvgId}:${startUtc}`
}
