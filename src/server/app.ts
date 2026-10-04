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

  // ---- M1 surfaces (registered only when a database is wired) ----
  const { db } = services
  if (db) {
    const clock = services.clock ?? (() => Date.now())
    const runSyncFn = services.runSyncFn ?? ((d: Db, kinds: Array<'m3u' | 'epg'>) => {
      const base = resolveDispatcharrUrl(d, cfg.dispatcharrUrl)
      if (base === null) return Promise.reject(new SyncFailure('m3u', 'Dispatcharr URL is not configured'))
      return runSync({ db: d, dispatcharrUrl: base }, kinds)
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
      relayStream({ db, dispatcharrUrl: base }, req.params.uuid, format, res, req, fixAudio).then((result) => {
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
