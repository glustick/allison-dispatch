import type { Db } from './db.js'
import { parseM3u, entryToChannel } from './m3u.js'
import { createXmltvScanner, type XmltvProgramme } from './xmltvStream.js'
import { getSyncStates } from './queries.js'

// The sync service: pulls Dispatcharr's generated M3U (lineup) and XMLTV (guide) into
// SQLite. Both outputs are unauthenticated on Dispatcharr's side (gated by the M3U_EPG
// network ACL — default LAN), so v1 needs no credentials. See PLAN.md for the verified
// endpoint surface.

export class SyncFailure extends Error {
  readonly kind: 'm3u' | 'epg'
  constructor(kind: 'm3u' | 'epg', message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.kind = kind
    this.name = 'SyncFailure'
  }
}

export interface SyncDeps {
  db: Db
  dispatcharrUrl: string
  /** EPG window in days — bounds the transfer size. Default 7. */
  days?: number
  now?: () => number
}

export interface SyncSummary {
  m3u: { channels: number; skipped: number } | null
  epg: { programmes: number; channels: number } | null
}

const M3U_TIMEOUT_MS = 30_000
// Bulk guide downloads legitimately pause mid-body on a busy NAS (the sibling saw this on a
// ~97MB guide and gives EPG fetches a long stall window) — 2 minutes, not the snappy default.
const EPG_TIMEOUT_MS = 120_000
const EPG_BATCH_SIZE = 1000
// Programmes that stopped more than 6h ago are housekept out of the DB after each sync.
const EPG_RETENTION_MS = 6 * 60 * 60 * 1000

interface StateRow {
  kind: string
  status: string
  item_count: number | null
  error: string | null
}

function markRunning(db: Db, kind: 'm3u' | 'epg'): void {
  db.prepare(
    `INSERT INTO sync_state (kind, status, last_run_utc) VALUES (?, 'running', ?)
     ON CONFLICT(kind) DO UPDATE SET status = 'running', last_run_utc = excluded.last_run_utc, error = NULL`
  ).run(kind, Date.now())
}

function markOk(db: Db, kind: 'm3u' | 'epg', count: number): void {
  db.prepare(
    `UPDATE sync_state SET status = 'ok', item_count = ?, error = NULL, last_run_utc = ? WHERE kind = ?`
  ).run(count, Date.now(), kind)
}

function markError(db: Db, kind: 'm3u' | 'epg', error: string): void {
  db.prepare(
    `UPDATE sync_state SET status = 'error', error = ?, last_run_utc = ? WHERE kind = ?`
  ).run(error, Date.now(), kind)
}

// In-flight guards so a manual sync and the scheduler can't double-run the same kind.
const inFlight = { m3u: false, epg: false }

export function syncStateIsRunning(db: Db, kind: 'm3u' | 'epg'): boolean {
  return getSyncStates(db)[kind]?.status === 'running' || inFlight[kind]
}

export async function syncM3u(deps: SyncDeps): Promise<SyncSummary['m3u']> {
  if (inFlight.m3u) throw new SyncFailure('m3u', 'M3U sync already running')
  inFlight.m3u = true
  const { db } = deps
  markRunning(db, 'm3u')
  try {
    const res = await fetch(`${deps.dispatcharrUrl}/output/m3u`, { signal: AbortSignal.timeout(M3U_TIMEOUT_MS) })
    if (!res.ok) {
      throw new SyncFailure('m3u', `Dispatcharr answered ${res.status} for /output/m3u (is the M3U_EPG network ACL allowing this host?)`)
    }
    const text = await res.text()
    const entries = parseM3u(text)
    const insert = db.prepare(
      `INSERT OR REPLACE INTO channels (uuid, name, channel_number, tvg_id, tvg_name, logo_url, group_name, position, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const writeAll = db.transaction((channels: ReturnType<typeof entryToChannel>[]) => {
      // Replace-all: the playlist is the whole truth; channels that vanished from it vanish
      // here too. Playlists are small (KBs–low MBs), so the full rewrite is cheap and avoids
      // incremental diffing bugs.
      db.prepare('DELETE FROM channels').run()
      const nowIso = new Date(deps.now?.() ?? Date.now()).toISOString()
      for (const ch of channels) {
        if (ch === null) continue
        insert.run(ch.uuid, ch.name, ch.channelNumber, ch.tvgId, ch.tvgName, ch.logoUrl, ch.group, ch.position, nowIso)
      }
    })
    const parsed = entries.map((e, i) => entryToChannel(e, deps.dispatcharrUrl, i))
    const kept = parsed.filter((c): c is NonNullable<typeof c> => c !== null)
    writeAll(parsed)
    const skipped = parsed.length - kept.length
    markOk(db, 'm3u', kept.length)
    return { channels: kept.length, skipped }
  } catch (err) {
    const message = err instanceof SyncFailure ? err.message : describeFetchError(err, 'M3U')
    markError(db, 'm3u', message)
    throw err instanceof SyncFailure ? err : new SyncFailure('m3u', message, { cause: err })
  } finally {
    inFlight.m3u = false
  }
}

export async function syncEpg(deps: SyncDeps): Promise<SyncSummary['epg']> {
  if (inFlight.epg) throw new SyncFailure('epg', 'EPG sync already running')
  inFlight.epg = true
  const { db } = deps
  markRunning(db, 'epg')
  try {
    const days = deps.days ?? 7
    const res = await fetch(`${deps.dispatcharrUrl}/output/epg?days=${days}`, {
      signal: AbortSignal.timeout(EPG_TIMEOUT_MS)
    })
    if (!res.ok) {
      throw new SyncFailure('epg', `Dispatcharr answered ${res.status} for /output/epg (is the M3U_EPG network ACL allowing this host?)`)
    }
    if (res.body === null) {
      throw new SyncFailure('epg', 'Dispatcharr returned an empty body for /output/epg')
    }

    const insert = db.prepare(
      `INSERT INTO epg_programs (channel_id, title, description, category, start_utc, stop_utc)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, start_utc) DO UPDATE SET
         title = excluded.title, description = excluded.description,
         category = excluded.category, stop_utc = excluded.stop_utc`
    )
    let batch: XmltvProgramme[] = []
    let total = 0
    const flush = db.transaction((rows: XmltvProgramme[]) => {
      for (const p of rows) {
        insert.run(p.channelId, p.title, p.description, p.category, p.startUtc, p.stopUtc)
      }
    })

    // Stream the body through the scanner — the guide is never materialized as one string,
    // let alone a DOM (the OOM lesson from allison-web-iptv, applied from day one).
    const scanner = createXmltvScanner({
      onChannel: () => {},
      onProgramme: (p) => {
        batch.push(p)
        total++
        if (batch.length >= EPG_BATCH_SIZE) {
          flush(batch)
          batch = []
        }
      }
    })
    const decoder = new TextDecoder()
    for await (const chunk of res.body) {
      scanner.feed(decoder.decode(chunk, { stream: true }))
    }
    scanner.feed(decoder.decode())
    scanner.end()
    flush(batch)

    const nowMs = deps.now?.() ?? Date.now()
    db.prepare('DELETE FROM epg_programs WHERE stop_utc < ?').run(nowMs - EPG_RETENTION_MS)
    const channelCount = db.prepare('SELECT COUNT(DISTINCT channel_id) AS n FROM epg_programs').get() as { n: number }
    markOk(db, 'epg', total)
    return { programmes: total, channels: channelCount.n }
  } catch (err) {
    const message = err instanceof SyncFailure ? err.message : describeFetchError(err, 'EPG')
    markError(db, 'epg', message)
    throw err instanceof SyncFailure ? err : new SyncFailure('epg', message, { cause: err })
  } finally {
    inFlight.epg = false
  }
}

export async function runSync(deps: SyncDeps, kinds: Array<'m3u' | 'epg'> = ['m3u', 'epg']): Promise<SyncSummary> {
  const summary: SyncSummary = { m3u: null, epg: null }
  if (kinds.includes('m3u')) summary.m3u = await syncM3u(deps)
  if (kinds.includes('epg')) summary.epg = await syncEpg(deps)
  return summary
}

function describeFetchError(err: unknown, label: string): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError') return `${label} fetch timed out`
    if (err.cause !== undefined && err.cause instanceof Error) {
      return `${label} fetch failed: ${err.cause.message}`
    }
    return `${label} fetch failed: ${err.message}`
  }
  return `${label} fetch failed`
}
