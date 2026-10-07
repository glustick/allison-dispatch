import { existsSync } from 'fs'
import path from 'path'
import express, { type Express, type Request, type Response } from 'express'
import type { Db } from './db.js'
import type { AppConfig } from './config.js'
import { normalizeDispatcharrUrl } from './config.js'
import { readAppVersion } from './version.js'
import { listChannels, nowNext, guideWindow, guideGrid, getSyncStates } from './queries.js'
import { getSetting, setDispatcharrUrl, clearDispatcharrUrl, resolveDispatcharrUrl, SETTING_KEYS } from './settingsStore.js'
import { runSync, SyncFailure, type SyncSummary } from './sync.js'
import { relayStream, buildStreamUrl, validateOutputFormat, parseFixAudio } from './relay.js'
import { addFavorite, removeFavorite, listFavorites, listRecents, recordWatch } from './userData.js'
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

// App factory instead of one giant bootstrap file (the sibling's index.ts grew organically
// into a single 1000+ line module — the clean rebuild starts factories from day one so every
// route group is testable against an ephemeral port without booting config from the env).
export function createApp(cfg: AppConfig, services: AppServices = {}): Express {
  const app = express()
  app.disable('x-powered-by')
  // Behind the reverse proxy (NPM) so req.secure/req.ip honor X-Forwarded-* — needed for
  // Secure cookie decisions and per-IP login throttling.
  app.set('trust proxy', true)
  app.use(express.json({ limit: '1mb' }))

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
      res.json({ favorites: listFavorites(db, user?.id ?? 0) })
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
      res.json({ recents: listRecents(db, user?.id ?? 0) })
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
      return runSync({ db: d, dispatcharrUrl: base, now: clock }, kinds)
    })
    const testConnectionFn = services.testConnectionFn ?? defaultTestConnection

    app.get('/api/channels', (_req: Request, res: Response) => {
      const channels = listChannels(db)
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
      const channels = guideGrid(db, start, end)
      res.json({ count: channels.length, window: { start, end }, channels })
    })

    app.get('/api/sync/status', (_req: Request, res: Response) => {
      res.json({ kinds: getSyncStates(db) })
    })

    // Play info: the server builds both playback URLs from the configured base — the browser
    // never needs to know Dispatcharr's origin, and format handling stays in one place.
    app.get('/api/channels/:uuid/play', (req: Request, res: Response) => {
      let format: 'mpegts' | 'fmp4' | null
      try {
        format = validateOutputFormat(req.query.output_format)
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
      const relayQuery = format !== null ? `?output_format=${format}` : ''
      res.json({
        uuid: channel.uuid,
        name: channel.name,
        format,
        direct: buildStreamUrl(base, channel.uuid, format),
        relay: `/api/relay/stream/${channel.uuid}${relayQuery}`
      })
    })

    // Relay mode: BFF pipes the stream (for mixed-content / debugging cases). Restricted to
    // known channel uuids — see relay.ts.
    app.get('/api/relay/stream/:uuid', (req: Request, res: Response) => {
      let format: 'mpegts' | 'fmp4' | null
      try {
        format = validateOutputFormat(req.query.output_format)
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
      relayStream(
        // Wall clock for history: the ordering of "what did I watch last" must be real even
        // in suites that freeze the app clock for guide data.
        { db, dispatcharrUrl: base, onStreamStart: (uuid) => recordWatch(db, watcher?.id ?? 0, uuid, Date.now()) },
        req.params.uuid,
        format,
        res,
        req,
        fixAudio
      ).then((result) => {
        if (!result.ok) {
          // relayStream only fails before headers are written, so a JSON error is still valid.
          if (!res.headersSent) res.status(result.status).json({ error: result.error })
          else res.destroy()
        }
      }).catch(() => {
        if (!res.headersSent) res.status(502).json({ error: 'relay failed' })
        else res.destroy()
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
      res.json({
        dispatcharrUrl: resolveDispatcharrUrl(db, cfg.dispatcharrUrl),
        source: fromSettings !== null ? 'settings' : cfg.dispatcharrUrl !== null ? 'env' : null
      })
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
