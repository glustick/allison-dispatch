import { mkdirSync, readdirSync, unlinkSync, existsSync, writeFileSync, readFileSync } from 'fs'
import { gzipSync } from 'zlib'
import path from 'path'
import type { Db } from './db.js'

// Database backups (hardening round): the SQLite file on /data carries users, favorites,
// history and settings — the only state that survives redeploys. Insurance is cheap:
// better-sqlite3's online `backup()` takes a consistent snapshot while the server runs
// (WAL-safe), we gzip it, and prune to the newest N. Started at boot and re-run daily by
// index.ts; this module stays pure enough to test against a tmpdir.

export interface BackupOptions {
  dir: string
  keep: number
  now?: () => Date
}

export interface BackupResult {
  file: string
  bytes: number
  pruned: string[]
}

const FILE_PATTERN = /^allison-dispatch-(\d{8}-\d{6})\.db\.gz$/

export function runBackup(db: Db, opts: BackupOptions): Promise<BackupResult> {
  const now = opts.now ?? (() => new Date())
  mkdirSync(opts.dir, { recursive: true })
  const d = now()
  const pad = (n: number): string => String(n).padStart(2, '0')
  // UTC YYYYMMDD-HHMMSS — lexicographically sortable, which is what prune sorts on.
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  const plain = path.join(opts.dir, `allison-dispatch-${stamp}.db`)
  const file = `${plain}.gz`
  // The online backup writes a consistent snapshot even while connections are active; it
  // returns a promise, so await it before compressing.
  return db.backup(plain).then(() => {
    const gz = gzipSync(readFileSync(plain))
    writeFileSync(file, gz)
    unlinkSync(plain)
    const pruned = pruneBackups(opts.dir, opts.keep)
    return { file, bytes: gz.byteLength, pruned }
  })
}

function pruneBackups(dir: string, keep: number): string[] {
  if (!existsSync(dir)) return []
  const backups = readdirSync(dir)
    .map((name) => ({ name, match: FILE_PATTERN.exec(name) }))
    .filter((f): f is { name: string; match: RegExpExecArray } => f.match !== null)
    .sort((a, b) => (a.match[1] < b.match[1] ? 1 : -1)) // newest stamp first
  const pruned: string[] = []
  for (const stale of backups.slice(Math.max(keep, 0))) {
    unlinkSync(path.join(dir, stale.name))
    pruned.push(stale.name)
  }
  return pruned
}

export function startBackupLoop(db: Db, dir: string, keep: number, log: (line: string) => void = console.log): void {
  const run = (): void => {
    runBackup(db, { dir, keep })
      .then((r) => log(`[backup] wrote ${path.basename(r.file)} (${Math.round(r.bytes / 1024)} KiB), keeping ${keep}`))
      .catch((err: unknown) => log(`[backup] failed: ${err instanceof Error ? err.message : String(err)}`))
  }
  const DAY_MS = 24 * 60 * 60 * 1000
  const boot = setTimeout(run, 3_000)
  boot.unref()
  const timer = setInterval(run, DAY_MS)
  timer.unref()
}
