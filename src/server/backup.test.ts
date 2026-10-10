import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { gunzipSync } from 'zlib'
import { openDb, type Db } from './db.js'
import { runBackup } from './backup.js'

// Backups: the online snapshot must round-trip (restore opens and holds the written data)
// and pruning keeps exactly N. Timestamps are injected so same-second runs get distinct names.

describe('db backups', () => {
  let db: Db
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'allison-dispatch-backup-'))
    db = openDb(path.join(dir, 'allison-dispatch.db'))
    db.prepare(
      "INSERT INTO users (username, password_hash, is_admin) VALUES ('chris', 'hash', 1)"
    ).run()
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes a gzipped snapshot that restores with the data intact', async () => {
    const result = await runBackup(db, {
      dir,
      keep: 7,
      now: () => new Date('2026-10-11T10:00:00Z')
    })
    expect(existsSync(result.file)).toBe(true)
    expect(result.file).toMatch(/allison-dispatch-20261011-100000\.db\.gz$/)
    expect(result.pruned).toEqual([])

    // Restore: gunzip → open as SQLite → the seeded user is inside. (openDb wants a data
    // directory, so the raw better-sqlite3 handle it wraps is used directly here.)
    const restored = path.join(dir, 'restored.db')
    writeFileSync(restored, gunzipSync(readFileSync(result.file)))
    const { default: Database } = await import('better-sqlite3')
    const restoredDb = new Database(restored)
    const row = restoredDb.prepare('SELECT username FROM users WHERE username = ?').get('chris') as
      | { username: string }
      | undefined
    restoredDb.close()
    expect(row?.username).toBe('chris')
  })

  it('a snapshot taken while the db has rows in flight is still a valid SQLite file', async () => {
    db.prepare(
      "INSERT INTO users (username, password_hash, is_admin) VALUES ('second', 'hash', 0)"
    ).run()
    const result = await runBackup(db, { dir, keep: 7, now: () => new Date('2026-10-11T10:01:00Z') })
    const raw = gunzipSync(readFileSync(result.file))
    expect(raw.subarray(0, 16).toString('utf8')).toBe('SQLite format 3\u0000')
  })

  it('prunes to the newest N backups', async () => {
    for (let i = 0; i < 4; i++) {
      await runBackup(db, { dir, keep: 2, now: () => new Date(`2026-10-11T10:0${i}:00Z`) })
    }
    const files = readdirSync(dir).filter((f) => f.endsWith('.db.gz'))
    expect(files).toHaveLength(2)
    // The two newest survive (10:02 and 10:03); 10:00 and 10:01 were pruned.
    expect(files.some((f) => f.includes('100200'))).toBe(true)
    expect(files.some((f) => f.includes('100300'))).toBe(true)
    expect(files.some((f) => f.includes('100000'))).toBe(false)
  })
})
