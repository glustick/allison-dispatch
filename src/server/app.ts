import { existsSync } from 'fs'
import path from 'path'
import express, { type Express, type Request, type Response, type NextFunction } from 'express'
import type { Db } from './db.js'
import type { AppConfig } from './config.js'
import { normalizeDispatcharrUrl } from './config.js'
import { readAppVersion } from './version.js'
import { listChannels, nowNext, guideWindow, guideGrid, searchProgrammes, getSyncStates } from './queries.js'
import { getSetting, setSetting, setDispatcharrUrl, clearDispatcharrUrl, resolveDispatcharrUrl, resolveDispatcharrAccount, SETTING_KEYS } from './settingsStore.js'
import { runSync, SyncFailure, type SyncSummary } from './sync.js'
import { relayStream, buildStreamUrl, validateOutputFormat, validateMaxHeight, parseFixAudio } from './relay.js'
import { addFavorite, removeFavorite, listFavorites, listRecents, recordWatch } from './userData.js'
import { listReminders, addReminder, removeReminder, type ReminderRow } from './reminders.js'
import { proxiedLogoUrl, proxyLogo } from './logoProxy.js'
import { createDispatcharrAuth } from './dispatcharrAuth.js'
import { createCatchupSession, CatchupFailure } from './catchup.js'
import {
  createAuthContext,
  requireAuth,
  requireAdmin,
  issueSessionToken,
  setSessionCookie,
  clearSessionCookie,
  clearLoginFailures,
  loginBlockedFor,
  recordLoginFailure,
  validateUsername,
  validatePassword,
  hashPassword,
  verifyPassword,
  type AuthContext
} from './auth.js'

const BOOT_TIME = Date.now()

export interface ConnectionTestResult {
  ok: boolean
  version?: string
  error?: string
}

export interface AppServices {
  /** Presence of a database enables the M1 surfaces (channels, EPG, sync, settings). */
  db?: Db
  runSyncFn?: (db: Db, kinds: Array<'m3u' | 'epg'>) => Promise<SyncSummary>
  testConnectionFn?: (base: string) => Promise<ConnectionTestResult>
  clock?: () => number
  /** Test seam; production builds its own from the db + SESSION_SECRET env. */
  auth?: AuthContext
}

async function defaultTestConnection(base: string): Promise<ConnectionTestResult> {
  try {
    // /api/core/version/ is public on Dispatcharr (verified against v0.31.0) — the cheapest
    // honest reachability check that also proves it IS a Dispatcharr.
    const res = await fetch(`${base}/api/core/version/`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return { ok: false, error: `Dispatcharr answered HTTP ${res.status}` }
    const body = (await res.json()) as { version?: unknown }
    return { ok: true, version: typeof body.version === 'string' ? body.version : 'unknown' }
  } catch (err) {
    if (err instanceof Error) {
      return { ok: false, error: err.name === 'TimeoutError' ? 'timed out after 5s' : err.message }
    }
    return { ok: false, error: String(err) }
  }
}

// A reminder body is only usable if every field has the shape the table and the toast need:
// identity strings, and an integer epoch-ms window whose end is after its start.
function validateReminder(body: Partial<ReminderRow> | undefined): ReminderRow | null {
  if (body === undefined) return null
  const { channel_uuid, tvg_id, title, start_utc, stop_utc } = body
  if (typeof channel_uuid !== 'string' || channel_uuid === '') return null
  if (typeof tvg_id !== 'string' || tvg_id === '') return null
  if (typeof title !== 'string' || title === '') return null
  if (typeof start_utc !== 'number' || typeof stop_utc !== 'number') return null
  if (!Number.isInteger(start_utc) || !Number.isInteger(stop_utc) || stop_utc <= start_utc) return null
  return { channel_uuid, tvg_id, title, start_utc, stop_utc }
}

// Logos ride a same-origin proxy: the browser must never load Dispatcharr's http:// URLs
// directly (mixed content on the https hostname, unreachable off-LAN). Applied at every
// logo_url emission point; the bytes flow through GET /api/logo.
function withProxiedLogos<T extends { logo_url: string | null }>(db: Db, cfg: AppConfig, rows: T[]): T[] {
  const base = resolveDispatcharrUrl(db, cfg.dispatcharrUrl)
  return rows.map((row) => ({ ...row, logo_url: proxiedLogoUrl(base, row.logo_url) }))
}

// App factory instead of one giant bootstrap file (the sibling's index.ts grew organically
// into a single 1000+ line module — the clean rebuild starts factories from day one so every
// route group is testable against an ephemeral port without booting config from the env).
export function createApp(cfg: AppConfig, services: AppServices = {}): Express {
  const app = express()
  app.disable('x-powered-by')
  // Behind the reverse proxy (NPM) so req.secure/req.ip honor X-Forwarded-* — needed for
  // Secure cookie decisions and per-IP login throttling.
  app.set('trust proxy', true)
  // Baseline hardening for a hostname that is reachable from the internet. Deliberately no
  // Content-Security-Policy yet: the player needs blob: media sources and Vite emits module
  // scripts, and a policy guessed without a real-browser check is how a TV night breaks. These
  // four are safe unconditionally; HSTS only makes sense once the request actually arrived on
  // HTTPS (the app is also served over plain LAN HTTP, where HSTS would poison the browser).
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    const forwardedProto = req.headers['x-forwarded-proto']
    const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto
    if (req.secure || proto === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }
    next()
  })
  app.use(express.json({ limit: '1mb' }))
  // Live count of relayed streams served by THIS app instance. Each one holds an upstream
  // provider session open and — in fix-audio mode — a running ffmpeg; without a cap a few
  // forgotten tabs can fork the host into CPU oblivion. The route answers 429 past the cap
  // (0 disables it — operator escape hatch).
  let activeRelays = 0

  // Dispatcharr REST auth (catch-up), cached per resolved credentials so the token cache
  // survives across requests; changing the account or base starts a fresh cache.
  let dispatcharrAuthCache: {
    key: string
    auth: ReturnType<typeof createDispatcharrAuth>
  } | null = null
  function getDispatcharrAuth(base: string, account: { username: string; password: string }): ReturnType<typeof createDispatcharrAuth> {
    const key = `${base}|${account.username}|${account.password}`
    if (dispatcharrAuthCache === null || dispatcharrAuthCache.key !== key) {
      dispatcharrAuthCache = {
        key,
        auth: createDispatcharrAuth({ baseUrl: base, username: account.username, password: account.password })
      }
    }
    return dispatcharrAuthCache.auth
  }

  // Unauthenticated — this is what a deploy verification hits (same pattern the sibling
  // uses on the NAS via Dockhand).
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - BOOT_TIME) / 1000),
      timestamp: new Date().toISOString()
    })
  })

  app.get('/api/version', (_req: Request, res: Response) => {
    res.json({ name: 'allison-dispatch', version: readAppVersion() })
  })

  app.get('/api/config', (_req: Request, res: Response) => {
    res.json({
      dispatcharrConfigured: services.db ? resolveDispatcharrUrl(services.db, cfg.dispatcharrUrl) !== null : cfg.dispatcharrUrl !== null
    })
  })

  // Readiness, as distinct from the liveness above: the process being up says nothing about
  // whether it can serve. A static "ok" is exactly how a container reports healthy while the
  // database is gone or Dispatcharr has stopped answering. The DB check is cheap and real;
  // Dispatcharr is reported as configured/not, and `?deep=1` adds the same 3s reachability
  // probe the Settings screen uses for operators chasing "the guide stopped updating".
  const testConnectionFn = services.testConnectionFn ?? defaultTestConnection
  app.get('/api/ready', (req: Request, res: Response) => {
    const checks: Record<string, string> = {}
    let ready = true
    // The URL lives in the settings table, so a dead db means the URL is unknowable — one
    // try block covers both reads, or the readiness probe would 500 on its own outage.
    let base: string | null = cfg.dispatcharrUrl
    if (services.db !== undefined) {
      try {
        services.db.prepare('SELECT 1').get()
        checks.db = 'ok'
        base = resolveDispatcharrUrl(services.db, cfg.dispatcharrUrl)
      } catch (err) {
        checks.db = `failed: ${err instanceof Error ? err.message : String(err)}`
        ready = false
        base = null
      }
    } else {
      checks.db = 'disabled'
    }
    const respond = (): void => {
      res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable', checks })
    }
    if (base === null) {
      checks.dispatcharr = ready ? 'not configured' : 'unknown (database unavailable)'
      respond()
      return
    }
    if (req.query.deep !== '1') {
      checks.dispatcharr = 'configured'
      respond()
      return
    }
    // A deep probe that cannot reach Dispatcharr reports the fault but does NOT mark the app
    // unready: the player still serves the lineup and guide already in SQLite.
    testConnectionFn(base)
      .then((result) => {
        checks.dispatcharr = result.ok ? `ok (v${result.version ?? 'unknown'})` : `unreachable: ${result.error ?? 'unknown error'}`
        respond()
      })
      .catch((err: unknown) => {
        checks.dispatcharr = `unreachable: ${err instanceof Error ? err.message : String(err)}`
        respond()
      })
  })

  // ---- Authentication ----
  // Public: health, version, config, login. Everything else below the gate requires a
  // session — including the stream relay, which is the resource worth protecting on a
  // public hostname.
  const { db } = services
  const clock = services.clock ?? (() => Date.now())
  if (db) {
    const authCtx = services.auth ?? createAuthContext(db, process.env.SESSION_SECRET)

    app.post('/api/auth/login', (req: Request, res: Response) => {
      const ip = req.ip ?? 'unknown'
      if (loginBlockedFor(ip)) {
        res.status(429).json({ error: 'Too many failed attempts — try again in 15 minutes' })
        return
      }
      const body = req.body as { username?: unknown; password?: unknown } | undefined
      try {
        const username = validateUsername(body?.username)
        const password = validatePassword(body?.password)
        const row = db.prepare('SELECT id, username, password_hash, is_admin FROM users WHERE username = ?').get(username) as
          | { id: number; username: string; password_hash: string; is_admin: number }
          | undefined
        if (row === undefined || !verifyPassword(password, row.password_hash)) {
          recordLoginFailure(ip)
          res.status(401).json({ error: 'Invalid username or password' })
          return
        }
        clearLoginFailures(ip)
        setSessionCookie(res, req, issueSessionToken(authCtx.secret, row.id))
        res.json({ ok: true, user: { id: row.id, username: row.username, isAdmin: row.is_admin === 1 } })
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
      }
    })

    app.use('/api', requireAuth(authCtx))

    app.get('/api/auth/me', (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: { id: number; username: string; isAdmin: boolean } }).sessionUser
      res.json({ user })
    })

    app.post('/api/auth/logout', (req: Request, res: Response) => {
      clearSessionCookie(res, req)
      res.json({ ok: true })
    })

    // Any signed-in user can change their own password (current one required). The change
    // invalidates every OTHER session of this user (not-before bumps to now) and a fresh
    // cookie is issued here, so the current session survives seamlessly.
    app.put('/api/auth/password', (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: { id: number } }).sessionUser
      const body = req.body as { currentPassword?: unknown; newPassword?: unknown } | undefined
      const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user?.id) as
        | { password_hash: string }
        | undefined
      if (row === undefined || typeof body?.currentPassword !== 'string' || !verifyPassword(body.currentPassword, row.password_hash)) {
        res.status(401).json({ error: 'Current password is incorrect' })
        return
      }
      try {
        const newPassword = validatePassword(body?.newPassword)
        // Security boundaries run on the wall clock, not the (test-injectable) app clock —
        // a frozen clock could never separate "before" from "after" a password change.
        db.prepare('UPDATE users SET password_hash = ?, sessions_not_before_utc = ? WHERE id = ?').run(
          hashPassword(newPassword),
          Date.now(),
          user?.id
        )
        setSessionCookie(res, req, issueSessionToken(authCtx.secret, user?.id ?? 0))
        res.json({ ok: true })
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
      }
    })

    // ---- Per-user favorites and watch history ----
    app.get('/api/favorites', (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: { id: number } }).sessionUser
      res.json({ favorites: withProxiedLogos(db, cfg, listFavorites(db, user?.id ?? 0)) })
    })

    app.put('/api/favorites/:uuid', (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: { id: number } }).sessionUser
      const known = db.prepare('SELECT 1 FROM channels WHERE uuid = ?').get(req.params.uuid)
      if (!known) {
        res.status(404).json({ error: 'channel not found' })
        return
      }
      addFavorite(db, user?.id ?? 0, req.params.uuid)
      res.json({ ok: true, favorite: true })
    })

    app.delete('/api/favorites/:uuid', (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: { id: number } }).sessionUser
      removeFavorite(db, user?.id ?? 0, req.params.uuid)
      res.json({ ok: true, favorite: false })
    })

    app.get('/api/history/recents', (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: { id: number } }).sessionUser
      res.json({ recents: withProxiedLogos(db, cfg, listRecents(db, user?.id ?? 0)) })
    })

    // ---- Programme reminders ("Remind me" in the guide) ----
    app.get('/api/reminders', (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: { id: number } }).sessionUser
      res.json({ reminders: listReminders(db, user?.id ?? 0, clock()) })
    })

    app.put('/api/reminders', (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: { id: number } }).sessionUser
      const body = req.body as Partial<ReminderRow> | undefined
      const reminder: ReminderRow | null = validateReminder(body)
      if (reminder === null) {
        res.status(400).json({ error: 'reminder needs channel_uuid, tvg_id, title (strings), start_utc and stop_utc (epoch ms ints, stop > start)' })
        return
      }
      // The channel must exist, and the reminder's tvg_id must be that channel's — a
      // reminder for an unknown channel would fire a toast that can never be watched.
      const channel = db.prepare('SELECT tvg_id FROM channels WHERE uuid = ?').get(reminder.channel_uuid) as
        | { tvg_id: string | null }
        | undefined
      if (channel === undefined || channel.tvg_id !== reminder.tvg_id) {
        res.status(404).json({ error: 'channel not found (or tvg_id mismatch)' })
        return
      }
      addReminder(db, user?.id ?? 0, reminder)
      res.status(201).json({ ok: true })
    })

    app.delete('/api/reminders/:tvgId/:startUtc', (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: { id: number } }).sessionUser
      const startUtc = Number(req.params.startUtc)
      if (!Number.isFinite(startUtc)) {
        res.status(400).json({ error: 'startUtc must be a number' })
        return
      }
      removeReminder(db, user?.id ?? 0, req.params.tvgId, startUtc)
      res.json({ ok: true })
    })

    // The logo bytes themselves — see logoProxy.ts for the same-origin/SSRF guard.
    app.get('/api/logo', (req: Request, res: Response) => {
      const base = resolveDispatcharrUrl(db, cfg.dispatcharrUrl)
      if (base === null) {
        res.status(503).json({ error: 'Dispatcharr URL is not configured' })
        return
      }
      const src = typeof req.query.u === 'string' ? req.query.u : ''
      proxyLogo({ dispatcharrBase: base }, src, res)
        .then((result) => {
          // proxyLogo writes the response itself on success; error results must still
          // answer HTTP or the browser's <img> would hang forever.
          if (!result.ok && !res.headersSent) {
            res.status(result.status).json({ error: result.error })
          }
        })
        .catch(() => {
          if (!res.headersSent) res.status(502).json({ error: 'logo proxy failed' })
        })
    })

    // ---- User management (admin) ----
    app.get('/api/users', requireAdmin, (_req: Request, res: Response) => {
      const rows = db.prepare('SELECT id, username, is_admin, created_at FROM users ORDER BY id').all() as Array<{
        id: number
        username: string
        is_admin: number
        created_at: string
      }>
      res.json({ users: rows.map((r) => ({ id: r.id, username: r.username, isAdmin: r.is_admin === 1, createdAt: r.created_at })) })
    })

    app.post('/api/users', requireAdmin, (req: Request, res: Response) => {
      const body = req.body as { username?: unknown; password?: unknown; isAdmin?: unknown } | undefined
      try {
        const username = validateUsername(body?.username)
        const password = validatePassword(body?.password)
        const isAdmin = body?.isAdmin === true
        const existing = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)
        if (existing !== undefined) {
          res.status(409).json({ error: `User '${username}' already exists` })
          return
        }
        const result = db
          .prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)')
          .run(username, hashPassword(password), isAdmin ? 1 : 0)
        res.status(201).json({ ok: true, user: { id: Number(result.lastInsertRowid), username, isAdmin } })
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
      }
    })

    app.put('/api/users/:id/password', requireAdmin, (req: Request, res: Response) => {
      try {
        const password = validatePassword((req.body as { password?: unknown } | undefined)?.password)
        const id = Number(req.params.id)
        const existing = db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)
        if (existing === undefined) {
          res.status(404).json({ error: 'User not found' })
          return
        }
        db.prepare('UPDATE users SET password_hash = ?, sessions_not_before_utc = ? WHERE id = ?').run(
          hashPassword(password),
          Date.now(),
          id
        )
        res.json({ ok: true })
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
      }
    })

    app.delete('/api/users/:id', requireAdmin, (req: Request, res: Response) => {
      const me = (req as Request & { sessionUser?: { id: number } }).sessionUser
      const id = Number(req.params.id)
      if (me?.id === id) {
        res.status(400).json({ error: 'You cannot delete your own account' })
        return
      }
      const existing = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(id) as { is_admin: number } | undefined
      if (existing === undefined) {
        res.status(404).json({ error: 'User not found' })
        return
      }
      if (existing.is_admin === 1) {
        const admins = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get() as { n: number }
        if (admins.n <= 1) {
          res.status(400).json({ error: 'Cannot delete the last admin' })
          return
        }
      }
      db.prepare('DELETE FROM users WHERE id = ?').run(id)
      res.json({ ok: true })
    })
  }

  // ---- M1/M2 surfaces (behind the auth gate above) ----
  if (db) {
    const runSyncFn = services.runSyncFn ?? ((d: Db, kinds: Array<'m3u' | 'epg'>) => {
      const base = resolveDispatcharrUrl(d, cfg.dispatcharrUrl)
      if (base === null) return Promise.reject(new SyncFailure('m3u', 'Dispatcharr URL is not configured'))
      // Thread the app clock through: EPG retention must judge "old" against the same clock
      // the tests inject, not the wall (a suite run days after fixture data would wipe it).
      // prev_days=2: the guide carries two days of ENDED programmes so "Watch from start"
      // can replay anything inside the provider's catch-up windows.
      return runSync({ db: d, dispatcharrUrl: base, now: clock, prevDays: 2 }, kinds)
    })

    app.get('/api/channels', (_req: Request, res: Response) => {
      const channels = withProxiedLogos(db, cfg, listChannels(db))
      res.json({ count: channels.length, channels })
    })

    app.get('/api/epg/now-next', (req: Request, res: Response) => {
      const uuid = req.query.uuid
      if (typeof uuid !== 'string' || uuid === '') {
        res.status(400).json({ error: 'uuid query parameter is required' })
        return
      }
      const result = nowNext(db, uuid, clock())
      if (result === null) {
        res.status(404).json({ error: 'channel not found' })
        return
      }
      res.json(result)
    })

    app.get('/api/epg/window', (req: Request, res: Response) => {
      const uuid = req.query.uuid
      const start = Number(req.query.start)
      const end = Number(req.query.end)
      if (typeof uuid !== 'string' || uuid === '' || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        res.status(400).json({ error: 'uuid, start and end (epoch ms, end > start) are required' })
        return
      }
      res.json({ programmes: guideWindow(db, uuid, start, end) })
    })

    // The whole guide grid in one request — every channel with its programmes overlapping the
    // window. Capped at 24h so a fat-fingered span can't turn into an unbounded query.
    app.get('/api/epg/grid', (req: Request, res: Response) => {
      const start = Number(req.query.start)
      const end = Number(req.query.end)
      const MAX_SPAN_MS = 24 * 60 * 60 * 1000
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > MAX_SPAN_MS) {
        res.status(400).json({ error: 'start and end (epoch ms, end > start, span ≤ 24h) are required' })
        return
      }
      const channels = withProxiedLogos(db, cfg, guideGrid(db, start, end))
      res.json({ count: channels.length, window: { start, end }, channels })
    })

    // Programme search across the guide (M4): on-air/upcoming only, capped result count so a
    // one-letter query can't flood the response.
    app.get('/api/epg/search', (req: Request, res: Response) => {
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
      if (q === '') {
        res.status(400).json({ error: 'q query parameter is required' })
        return
      }
      const limitRaw = Number(req.query.limit)
      const limit = Number.isFinite(limitRaw) && limitRaw >= 1 ? Math.min(Math.floor(limitRaw), 500) : 100
      const programmes = withProxiedLogos(db, cfg, searchProgrammes(db, q, clock(), limit))
      res.json({ count: programmes.length, programmes })
    })

    app.get('/api/sync/status', (_req: Request, res: Response) => {
      res.json({ kinds: getSyncStates(db) })
    })

    // Play info: the server builds both playback URLs from the configured base — the browser
    // never needs to know Dispatcharr's origin, and format/quality handling stays in one place.
    app.get('/api/channels/:uuid/play', (req: Request, res: Response) => {
      let format: 'mpegts' | 'fmp4' | null
      let maxHeight: number | null
      try {
        format = validateOutputFormat(req.query.output_format)
        maxHeight = validateMaxHeight(req.query.max_height)
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
        return
      }
      const base = resolveDispatcharrUrl(db, cfg.dispatcharrUrl)
      if (base === null) {
        res.status(400).json({ error: 'Dispatcharr URL is not configured' })
        return
      }
      const channel = db.prepare('SELECT uuid, name FROM channels WHERE uuid = ?').get(req.params.uuid) as
        | { uuid: string; name: string }
        | undefined
      if (!channel) {
        res.status(404).json({ error: 'channel not found' })
        return
      }
      const relayParams: string[] = []
      if (format !== null) relayParams.push(`output_format=${format}`)
      if (maxHeight !== null) relayParams.push(`max_height=${maxHeight}`)
      // A start query switches to catch-up: create a Dispatcharr session for that instant and
      // hand back the catch-up relay path instead of the live one. The playback URL shape is
      // deterministic (/proxy/catchup/<uuid>?session_id=<sid>), so nothing session-shaped
      // needs server-side state.
      const startRaw = typeof req.query.start === 'string' ? Number(req.query.start) : undefined
      if (startRaw !== undefined) {
        if (!Number.isInteger(startRaw) || startRaw <= 0 || startRaw > clock() + 60_000) {
          res.status(400).json({ error: 'start must be an epoch-ms instant, not in the future' })
          return
        }
        const account = resolveDispatcharrAccount(db, cfg.dispatcharrUsername, cfg.dispatcharrPassword)
        if (account === null) {
          res.status(400).json({ error: 'No Dispatcharr account configured — set it in Settings to use catch-up' })
          return
        }
        const auth = getDispatcharrAuth(base, account)
        createCatchupSession({ baseUrl: base, auth }, channel.uuid, startRaw)
          .then((session) => {
            res.json({
              uuid: channel.uuid,
              name: channel.name,
              format,
              max_height: maxHeight,
              direct: `${base}${session.playbackUrl}`,
              relay: `/api/relay/catchup/${channel.uuid}?session_id=${encodeURIComponent(session.sessionId)}`
            })
          })
          .catch((err: unknown) => {
            const status = err instanceof CatchupFailure ? err.status : 502
            const message = err instanceof Error ? err.message : 'catch-up session failed'
            if (status === 401) {
              auth.reset() // stale/invalid credentials — force a clean login next time
            }
            res.status(status === 400 ? 400 : 502).json({ error: message })
          })
        return
      }
      const relayQuery = relayParams.length > 0 ? `?${relayParams.join('&')}` : ''
      res.json({
        uuid: channel.uuid,
        name: channel.name,
        format,
        max_height: maxHeight,
        direct: buildStreamUrl(base, channel.uuid, format),
        relay: `/api/relay/stream/${channel.uuid}${relayQuery}`
      })
    })

    // Catch-up relay: pipes a Dispatcharr catch-up session (the playback URL Dispatcharr
    // returned for it) through the same audio-fix relay as live. The uuid must still be a
    // known channel and the session id must be present; Dispatcharr enforces expiry itself.
    app.get('/api/relay/catchup/:uuid', (req: Request, res: Response) => {
      const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : ''
      if (sessionId === '') {
        res.status(400).json({ error: 'session_id query parameter is required' })
        return
      }
      const base = resolveDispatcharrUrl(db, cfg.dispatcharrUrl)
      if (base === null) {
        res.status(400).json({ error: 'Dispatcharr URL is not configured' })
        return
      }
      const fixAudio = parseFixAudio(req.query.fixaudio)
      const watcher = (req as Request & { sessionUser?: { id: number } }).sessionUser
      if (cfg.relayMaxStreams > 0 && activeRelays >= cfg.relayMaxStreams) {
        res.status(429).json({ error: `Too many active streams (limit ${cfg.relayMaxStreams}) — stop one and try again` })
        return
      }
      activeRelays++
      relayStream(
        { db, dispatcharrUrl: base, onStreamStart: (uuid) => recordWatch(db, watcher?.id ?? 0, uuid, Date.now()) },
        req.params.uuid,
        null,
        res,
        req,
        fixAudio,
        null,
        `${base}/proxy/catchup/${req.params.uuid}?session_id=${encodeURIComponent(sessionId)}`
      ).then((result) => {
        if (!result.ok) {
          if (!res.headersSent) res.status(result.status).json({ error: result.error })
          else res.destroy()
        }
      }).catch(() => {
        if (!res.headersSent) res.status(502).json({ error: 'relay failed' })
        else res.destroy()
      }).finally(() => {
        activeRelays--
      })
    })

    // Relay mode: BFF pipes the stream (for mixed-content / debugging cases). Restricted to
    // known channel uuids — see relay.ts. An optional max_height turns the audio-fix ffmpeg
    // into a capped video re-encode.
    app.get('/api/relay/stream/:uuid', (req: Request, res: Response) => {
      let format: 'mpegts' | 'fmp4' | null
      let maxHeight: number | null
      try {
        format = validateOutputFormat(req.query.output_format)
        maxHeight = validateMaxHeight(req.query.max_height)
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
        return
      }
      const base = resolveDispatcharrUrl(db, cfg.dispatcharrUrl)
      if (base === null) {
        res.status(400).json({ error: 'Dispatcharr URL is not configured' })
        return
      }
      const fixAudio = parseFixAudio(req.query.fixaudio)
      const watcher = (req as Request & { sessionUser?: { id: number } }).sessionUser
      if (cfg.relayMaxStreams > 0 && activeRelays >= cfg.relayMaxStreams) {
        res.status(429).json({ error: `Too many active streams (limit ${cfg.relayMaxStreams}) — stop one and try again` })
        return
      }
      activeRelays++
      relayStream(
        // Wall clock for history: the ordering of "what did I watch last" must be real even
        // in suites that freeze the app clock for guide data.
        { db, dispatcharrUrl: base, onStreamStart: (uuid) => recordWatch(db, watcher?.id ?? 0, uuid, Date.now()) },
        req.params.uuid,
        format,
        res,
        req,
        fixAudio,
        maxHeight
      ).then((result) => {
        if (!result.ok) {
          // relayStream only fails before headers are written, so a JSON error is still valid.
          if (!res.headersSent) res.status(result.status).json({ error: result.error })
          else res.destroy()
        }
      }).catch(() => {
        if (!res.headersSent) res.status(502).json({ error: 'relay failed' })
        else res.destroy()
      }).finally(() => {
        // relayStream settles when the stream ends: upstream done, client gone, or the
        // pre-header failure paths — every exit releases its slot.
        activeRelays--
      })
    })

    app.post('/api/sync/run', (req: Request, res: Response) => {
      const requested = (req.body as { kinds?: unknown } | undefined)?.kinds
      const kinds: Array<'m3u' | 'epg'> = Array.isArray(requested)
        ? requested.filter((k): k is 'm3u' | 'epg' => k === 'm3u' || k === 'epg')
        : ['m3u', 'epg']
      if (kinds.length === 0) {
        res.status(400).json({ error: 'kinds must contain m3u and/or epg' })
        return
      }
      if (resolveDispatcharrUrl(db, cfg.dispatcharrUrl) === null) {
        res.status(400).json({ error: 'Dispatcharr URL is not configured — set it in Settings first' })
        return
      }
      runSyncFn(db, kinds)
        .then((summary) => {
          res.json({ ok: true, summary })
        })
        .catch((err: unknown) => {
          if (err instanceof SyncFailure && /already running/.test(err.message)) {
            res.status(409).json({ ok: false, error: err.message })
            return
          }
          const message = err instanceof Error ? err.message : String(err)
          res.status(502).json({ ok: false, error: message })
        })
    })

    app.get('/api/settings', (_req: Request, res: Response) => {
      const fromSettings = getSetting(db, SETTING_KEYS.dispatcharrUrl)
      const account = resolveDispatcharrAccount(db, cfg.dispatcharrUsername, cfg.dispatcharrPassword)
      const accountFromSettings = getSetting(db, SETTING_KEYS.dispatcharrUsername) !== null
      res.json({
        dispatcharrUrl: resolveDispatcharrUrl(db, cfg.dispatcharrUrl),
        source: fromSettings !== null ? 'settings' : cfg.dispatcharrUrl !== null ? 'env' : null,
        // The password itself never leaves the server — the UI only learns whether it is set.
        account: account !== null ? { username: account.username, passwordSet: true, source: accountFromSettings ? 'settings' : 'env' } : null
      })
    })

    // The Dispatcharr REST account powers catch-up. Admin-only: it is a credential.
    app.put('/api/settings/account', requireAdmin, (req: Request, res: Response) => {
      const body = req.body as { username?: unknown; password?: unknown } | undefined
      if (body === undefined || typeof body.username !== 'string' || body.username.trim() === '' || typeof body.password !== 'string' || body.password === '') {
        res.status(400).json({ error: 'username and password are required' })
        return
      }
      setSetting(db, SETTING_KEYS.dispatcharrUsername, body.username.trim())
      setSetting(db, SETTING_KEYS.dispatcharrPassword, body.password)
      dispatcharrAuthCache = null // force fresh logins under the new credentials
      res.json({ ok: true })
    })

    app.delete('/api/settings/account', requireAdmin, (_req: Request, res: Response) => {
      db.prepare('DELETE FROM settings WHERE key = ? OR key = ?').run(SETTING_KEYS.dispatcharrUsername, SETTING_KEYS.dispatcharrPassword)
      dispatcharrAuthCache = null
      res.json({ ok: true })
    })

    app.put('/api/settings', (req: Request, res: Response) => {
      const body = req.body as { dispatcharrUrl?: unknown } | undefined
      if (body?.dispatcharrUrl === null || body?.dispatcharrUrl === '') {
        clearDispatcharrUrl(db)
        res.json({ ok: true, dispatcharrUrl: cfg.dispatcharrUrl })
        return
      }
      if (typeof body?.dispatcharrUrl !== 'string') {
        res.status(400).json({ error: 'dispatcharrUrl must be a string (or null to clear the override)' })
        return
      }
      try {
        const normalized = setDispatcharrUrl(db, body.dispatcharrUrl)
        res.json({ ok: true, dispatcharrUrl: normalized })
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
      }
    })

    app.post('/api/settings/test', (req: Request, res: Response) => {
      const body = req.body as { url?: unknown } | undefined
      let target: string | null = null
      if (typeof body?.url === 'string' && body.url.trim() !== '') {
        try {
          target = normalizeDispatcharrUrl(body.url)
        } catch (err) {
          res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
          return
        }
      } else {
        target = resolveDispatcharrUrl(db, cfg.dispatcharrUrl)
      }
      if (target === null) {
        res.status(400).json({ ok: false, error: 'no Dispatcharr URL configured or supplied' })
        return
      }
      testConnectionFn(target)
        .then((result) => {
          res.json({ ...result, url: target })
        })
        .catch((err: unknown) => {
          res.json({ ok: false, error: err instanceof Error ? err.message : String(err), url: target })
        })
    })
  }

  // Unknown API paths 404 with JSON — deliberately NOT Dispatcharr's behavior (its SPA
  // catch-all answers 200 for anything), because this app's own clients probe by status code.
  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' })
  })

  // Static client build + SPA fallback, served only when the build exists (npm run dev:client
  // doesn't need it; the Docker image always has it).
  const indexHtml = path.join(cfg.publicDir, 'index.html')
  if (existsSync(indexHtml)) {
    app.use(express.static(cfg.publicDir))
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(indexHtml)
    })
  }

  return app
}
