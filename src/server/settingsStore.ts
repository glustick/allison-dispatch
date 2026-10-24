import type { Db } from './db.js'
import { normalizeDispatcharrUrl } from './config.js'

// Persisted settings override the env-provided defaults — the Settings UI writes here, and
// every Dispatcharr-facing feature resolves its base URL through resolveDispatcharrUrl.
export const SETTING_KEYS = {
  dispatcharrUrl: 'dispatcharr.url',
  dispatcharrUsername: 'dispatcharr.username',
  dispatcharrPassword: 'dispatcharr.password'
} as const

export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row ? row.value : null
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
}

export function setDispatcharrUrl(db: Db, rawUrl: string): string {
  const normalized = normalizeDispatcharrUrl(rawUrl)
  setSetting(db, SETTING_KEYS.dispatcharrUrl, normalized)
  return normalized
}

export function clearDispatcharrUrl(db: Db): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(SETTING_KEYS.dispatcharrUrl)
}

// Settings override wins over the env fallback (env is what the compose file provides; the
// UI override exists so the URL can be fixed without recreating the container).
export function resolveDispatcharrUrl(db: Db, envFallback: string | null): string | null {
  return getSetting(db, SETTING_KEYS.dispatcharrUrl) ?? envFallback
}

// The Dispatcharr REST account (catch-up) resolves the same way: UI override, then env.
// The password is stored plaintext in the settings table — it must be replayable to
// Dispatcharr's token endpoint, and this box is already trusted with bigger secrets.
export function resolveDispatcharrAccount(
  db: Db,
  envUsername: string | null,
  envPassword: string | null
): { username: string; password: string } | null {
  const username = getSetting(db, SETTING_KEYS.dispatcharrUsername) ?? envUsername
  const password = getSetting(db, SETTING_KEYS.dispatcharrPassword) ?? envPassword
  if (username === null || password === null) return null
  return { username, password }
}
