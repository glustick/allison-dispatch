import type { Db } from './db.js'
import { parseM3u, entryToChannel } from './m3u.js'
import { createXmltvScanner, type XmltvProgramme } from './xmltvStream.js'
import { getSyncStates } from './queries.js'

// The sync service: pulls Dispatcharr's generated M3U (lineup) and XMLTV (guide) into
// SQLite. Both outputs are unauthenticated on Dispatcharr's side (gated by the M3U_EPG
// network ACL — default LAN), so v1 needs no credentials. See PLAN.md for the verified
// endpoint surface.

export class SyncFailure extends Error {
  readonly kind: SyncKind
  constructor(kind: SyncKind, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.kind = kind
    this.name = 'SyncFailure'
  }
}

export type SyncKind = 'm3u' | 'epg' | 'vod'

export interface VodAuth {
  getAccessToken: () => Promise<string>
}

export interface SyncDeps {
  db: Db
  dispatcharrUrl: string
  /** EPG window in days — bounds the transfer size. Default 7. */
  days?: number
  /**
   * Days of PAST guide to request (Dispatcharr's prev_days). Default 0 — no backward data,
   * exactly the pre-catch-up behavior (and the 6h retention housekeeping below). The app
   * wiring passes 2 so the guide covers the provider's catch-up windows: ended programmes
   * appear in the grid and "Watch from start" can replay them.
   */
  prevDays?: number
  /**
   * Bearer-token source for authed REST surfaces (VOD library sync). Absent → syncVod
   * fails with a clear "account not configured" SyncFailure.
   */
  vodAuth?: VodAuth
  /** Page size for the paged VOD library fetch. Default 500. */
  vodPageSize?: number
  now?: () => number
}

export interface SyncSummary {
  m3u: { channels: number; skipped: number } | null
  epg: { programmes: number; channels: number } | null
  vod: { movies: number } | null
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

function markRunning(db: Db, kind: SyncKind): void {
  db.prepare(
    `INSERT INTO sync_state (kind, status, last_run_utc) VALUES (?, 'running', ?)
     ON CONFLICT(kind) DO UPDATE SET status = 'running', last_run_utc = excluded.last_run_utc, error = NULL`
  ).run(kind, Date.now())
}

function markOk(db: Db, kind: SyncKind, count: number): void {
  db.prepare(
    `UPDATE sync_state SET status = 'ok', item_count = ?, error = NULL, last_run_utc = ? WHERE kind = ?`
  ).run(count, Date.now(), kind)
}

function markError(db: Db, kind: SyncKind, error: string): void {
  db.prepare(
    `UPDATE sync_state SET status = 'error', error = ?, last_run_utc = ? WHERE kind = ?`
  ).run(error, Date.now(), kind)
}

// In-flight guards so a manual sync and the scheduler can't double-run the same kind.
const inFlight: Record<SyncKind, boolean> = { m3u: false, epg: false, vod: false }

export function syncStateIsRunning(db: Db, kind: SyncKind): boolean {
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
    const prevDays = deps.prevDays ?? 0
    const res = await fetch(`${deps.dispatcharrUrl}/output/epg?days=${days}&prev_days=${prevDays}`, {
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
    // Housekeeping horizon: with backward guide the retention must cover the whole requested
    // past window (plus the same 6h slack), or every sync would delete the programmes the
    // prev_days fetch just brought in — the catch-up guide would never build up.
    const retentionMs = (deps.prevDays ?? 0) * 24 * 60 * 60 * 1000 + EPG_RETENTION_MS
    db.prepare('DELETE FROM epg_programs WHERE stop_utc < ?').run(nowMs - retentionMs)
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

export async function syncVod(deps: SyncDeps): Promise<SyncSummary['vod']> {
  if (deps.vodAuth === undefined) {
    throw new SyncFailure('vod', 'No Dispatcharr account configured — set it in Settings to sync the VOD library')
  }
  if (inFlight.vod) throw new SyncFailure('vod', 'VOD sync already running')
  inFlight.vod = true
  const { db } = deps
  markRunning(db, 'vod')
  try {
    // Paged fetch of the whole library: the live instance carries ~26k movies; at 500 a
    // page that is ~53 requests. Rows accumulate and land in ONE replace-all transaction —
    // the playlist pattern (the list is the whole truth), sized to a few MB of memory.
    const pageSize = deps.vodPageSize ?? 500
    const rows: Array<{
      id: number
      uuid: string
      name: string
      year: number | null
      rating: string | null
      genre: string | null
      description: string | null
      duration_secs: number | null
      logo_path: string | null
      is_adult: boolean
    }> = []
    for (let page = 1; ; page++) {
      const token = await deps.vodAuth.getAccessToken()
      const res = await fetch(`${deps.dispatcharrUrl}/api/vod/movies/?page_size=${pageSize}&page=${page}`, {
        signal: AbortSignal.timeout(EPG_TIMEOUT_MS),
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' }
      })
      if (res.status === 401) {
        throw new SyncFailure('vod', 'Dispatcharr rejected the account credentials for the VOD library')
      }
      if (!res.ok) {
        throw new SyncFailure('vod', `Dispatcharr answered ${res.status} for the VOD library (page ${page})`)
      }
      const body = (await res.json()) as {
        results?: Array<{
          id?: unknown
          uuid?: unknown
          name?: unknown
          year?: unknown
          rating?: unknown
          genre?: unknown
          description?: unknown
          duration_secs?: unknown
          is_adult?: unknown
          logo?: { cache_url?: unknown } | null
        }>
        next?: unknown
      }
      for (const m of body.results ?? []) {
        if (typeof m.id !== 'number' || typeof m.uuid !== 'string' || typeof m.name !== 'string') continue
        const cacheUrl = typeof m.logo?.cache_url === 'string' ? m.logo.cache_url : null
        let logoPath: string | null = null
        if (cacheUrl !== null) {
          try {
            const parsed = new URL(cacheUrl)
            logoPath = parsed.pathname + parsed.search
          } catch {
            logoPath = null
          }
        }
        rows.push({
          id: m.id,
          uuid: m.uuid,
          name: m.name,
          year: typeof m.year === 'number' ? m.year : null,
          rating: typeof m.rating === 'string' ? m.rating : null,
          genre: typeof m.genre === 'string' ? m.genre : null,
          description: typeof m.description === 'string' ? m.description : null,
          duration_secs: typeof m.duration_secs === 'number' ? m.duration_secs : null,
          logo_path: logoPath,
          is_adult: m.is_adult === true
        })
      }
      if (typeof body.next !== 'string' || body.next === '') break
      if (page > 500) throw new SyncFailure('vod', 'VOD library pagination did not terminate')
    }

    const nowIso = new Date(deps.now?.() ?? Date.now()).toISOString()
    const insert = db.prepare(
      `INSERT OR REPLACE INTO vod_movies (id, uuid, name, year, rating, genre, description, duration_secs, logo_path, is_adult, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    db.transaction(() => {
      db.prepare('DELETE FROM vod_movies').run()
      for (const r of rows) {
        insert.run(r.id, r.uuid, r.name, r.year, r.rating, r.genre, r.description, r.duration_secs, r.logo_path, r.is_adult ? 1 : 0, nowIso)
      }
    })()
    markOk(db, 'vod', rows.length)
    return { movies: rows.length }
  } catch (err) {
    const message = err instanceof SyncFailure ? err.message : describeFetchError(err, 'VOD')
    markError(db, 'vod', message)
    throw err instanceof SyncFailure ? err : new SyncFailure('vod', message, { cause: err })
  } finally {
    inFlight.vod = false
  }
}

export async function runSync(deps: SyncDeps, kinds: SyncKind[] = ['m3u', 'epg']): Promise<SyncSummary> {
  const summary: SyncSummary = { m3u: null, epg: null, vod: null }
  if (kinds.includes('m3u')) summary.m3u = await syncM3u(deps)
  if (kinds.includes('epg')) summary.epg = await syncEpg(deps)
  if (kinds.includes('vod')) summary.vod = await syncVod(deps)
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
