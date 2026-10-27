import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { readFileSync } from 'fs'
import { AddressInfo } from 'net'
import {
  DEFAULT_FAKE_CHANNELS,
  FAKE_DISPATCHARR_VERSION,
  FAKE_LOGO_PNG,
  buildEpgXml,
  buildM3u,
  type FakeChannel
} from './fixtures.js'

// Wire-level fake of the Dispatcharr surface this app consumes. "Wire-level" is the lesson
// from the sibling project: fake origins that don't behave like the real host can't catch
// wrong-host bugs, so this replicates the observed behaviors that matter —
//   * M3U/EPG URLs are generated from the REQUEST's Host header (probed live), so the fake
//     does the same and tests can assert origin-rewriting logic against it;
//   * the EPG is served chunked with Content-Disposition attachment (no content-length) —
//     parsers must stream, and tests can prove they do;
//   * unknown paths answer 200 + SPA HTML, NOT 404 (Dispatcharr's catch-all) — any code that
//     probes Dispatcharr by status code must be caught by tests, because the real thing
//     never says 404;
//   * /api/core/version/ is public and answers {"version":...,"timestamp":null}.

export interface FakeDispatcharr {
  url: string
  origin: string
  port: number
  requests: Array<{ method: string; path: string }>
  /** Live counters for the stream endpoint — relay/abort tests assert against these. */
  streams: { opened: number; open: number; closed: number; bytesSent: number }
  close(): Promise<void>
}

export interface FakeDispatcharrOptions {
  now: Date
  channels?: FakeChannel[]
  /** null (default): endless chunked stream, closed when the client disconnects. A number: stream ends itself after that many ms (simulating a source that dies). */
  streamLifetimeMs?: number | null
  /** When set, stream responses loop this file's bytes (a real TS fixture) instead of sync-byte filler — used by the audio-fix tests, which need ffmpeg-parseable input. */
  streamFile?: string
  /** When set, the fake serves the JWT + catch-up REST surface with these credentials (probed live on v0.31.0: /api/accounts/token/, /api/catchup/sessions/, /proxy/catchup/…). */
  account?: { username: string; password: string }
  /** When set (with account), /api/vod/movies/ serves this library paged, and /proxy/vod/movie/<uuid>?token= streams it. */
  vodMovies?: Array<{ id: number; uuid: string; name: string; year?: number | null; logoPath?: string | null }>
}

function sendSpaIndex(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end('<!doctype html><html><body>fake-dispatcharr-spa</body></html>')
}

function sendChunked(res: ServerResponse, contentType: string, extraHeaders: Record<string, string>, body: string): void {
  // No content-length + multiple writes → Node answers chunked, like the real EPG endpoint.
  res.writeHead(200, { 'Content-Type': contentType, ...extraHeaders })
  const mid = Math.floor(body.length / 2)
  res.write(body.slice(0, mid))
  res.write(body.slice(mid))
  res.end()
}

export async function startFakeDispatcharr(opts: FakeDispatcharrOptions): Promise<FakeDispatcharr> {
  const channels = opts.channels ?? DEFAULT_FAKE_CHANNELS
  const requests: FakeDispatcharr['requests'] = []
  const streams: FakeDispatcharr['streams'] = { opened: 0, open: 0, closed: 0, bytesSent: 0 }
  // JWT + catch-up surface state (only active when opts.account is set): issued tokens and
  // live catch-up sessions, so tests can prove the real token/session discipline.
  const issuedAccess = new Set<string>()
  const issuedRefresh = new Set<string>()
  const sessions = new Map<string, string>() // session_id → channel_uuid
  const vodSessions = new Set<string>()
  let tokenSeq = 0

  function fakeJwt(tokenType: 'access' | 'refresh', lifetimeSec: number): string {
    tokenSeq++
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({ token_type: tokenType, exp: Math.floor(opts.now.getTime() / 1000) + lifetimeSec, iat: Math.floor(opts.now.getTime() / 1000), jti: `fake-${tokenSeq}`, user_id: '1' })
    ).toString('base64url')
    return `${header}.${payload}.fake-signature-${tokenSeq}`
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(''))
    })
  }

  function bearerToken(req: IncomingMessage): string | null {
    const header = req.headers.authorization ?? ''
    const match = /^Bearer (.+)$/.exec(header)
    return match === null ? null : match[1]
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET'
    const reqUrl = new URL(req.url ?? '/', 'http://fake.invalid')
    const host = req.headers.host ?? 'fake-dispatcharr.invalid'
    // Mirror the real instance: generated URLs carry the request's own origin.
    const origin = `http://${host}`
    requests.push({ method, path: reqUrl.pathname })

    if (method !== 'GET') {
      // ---- JWT + catch-up POST surface (wire-level mirror of the probed v0.31.0 API) ----
      if (opts.account !== undefined && method === 'POST') {
        if (reqUrl.pathname === '/api/accounts/token/' || reqUrl.pathname === '/api/accounts/token/refresh/') {
          void readBody(req).then((raw) => {
            let body: Record<string, unknown> = {}
            try {
              body = JSON.parse(raw) as Record<string, unknown>
            } catch {
              // malformed body → 400 below
            }
            if (reqUrl.pathname === '/api/accounts/token/') {
              if (body.username !== opts.account?.username || body.password !== opts.account?.password) {
                res.writeHead(401, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ detail: 'No active account found with the given credentials' }))
                return
              }
              const access = fakeJwt('access', 1800)
              const refresh = fakeJwt('refresh', 86_400)
              issuedAccess.add(access)
              issuedRefresh.add(refresh)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ access, refresh }))
              return
            }
            // refresh endpoint
            if (typeof body.refresh !== 'string' || !issuedRefresh.has(body.refresh)) {
              res.writeHead(401, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ detail: 'Token is invalid or expired' }))
              return
            }
            const access = fakeJwt('access', 1800)
            issuedAccess.add(access)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ access }))
          })
          return
        }
        if (reqUrl.pathname === '/api/catchup/sessions/') {
          void readBody(req).then((raw) => {
            const token = bearerToken(req)
            if (token === null || !issuedAccess.has(token)) {
              res.writeHead(401, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ detail: 'Authentication credentials were not provided or were invalid.' }))
              return
            }
            let body: Record<string, unknown> = {}
            try {
              body = JSON.parse(raw) as Record<string, unknown>
            } catch {
              // malformed body → 400 below
            }
            const channel = channels.find((c) => c.uuid === body.channel_uuid)
            if (typeof body.channel_uuid !== 'string' || channel === undefined) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ channel_uuid: ['This field is required.'], start: ['This field is required.'] }))
              return
            }
            if (typeof body.start !== 'string' || Number.isNaN(Date.parse(body.start))) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ start: ['A valid datetime is required.'] }))
              return
            }
            const sessionId = `fake-session-${tokenSeq}-${sessions.size}`
            sessions.set(sessionId, channel.uuid)
            res.writeHead(201, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              session_id: sessionId,
              playback_url: `/proxy/catchup/${channel.uuid}?session_id=${sessionId}`,
              expires_at: Math.floor(opts.now.getTime() / 1000) + 900,
              channel_uuid: channel.uuid,
              start: body.start,
              duration: null
            }))
          })
          return
        }
      }
      res.writeHead(405, { 'Content-Type': 'text/plain' })
      res.end('method not allowed')
      return
    }

    if (reqUrl.pathname === '/output/m3u') {
      sendChunked(res, 'audio/x-mpegurl', {}, buildM3u(origin, channels))
      return
    }

    if (reqUrl.pathname === '/output/epg') {
      // prev_days extends the schedule backward (2h slots), mirroring the live instance.
      const prevDaysRaw = Number(reqUrl.searchParams.get('prev_days') ?? '0')
      const backSlots = Number.isFinite(prevDaysRaw) && prevDaysRaw > 0 ? Math.round(prevDaysRaw * 12) : 0
      // Header set mirrors the live probe: application/xml, chunked, attachment, no-cache.
      sendChunked(res, 'application/xml', {
        'Content-Disposition': 'attachment; filename="Dispatcharr.xml"',
        'Cache-Control': 'no-cache'
      }, buildEpgXml(opts.now, channels, backSlots))
      return
    }

    if (reqUrl.pathname === '/api/core/version/') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ version: FAKE_DISPATCHARR_VERSION, timestamp: null }))
      return
    }

    const logoMatch = /^\/api\/channels\/logos\/(\d+)\/cache\/?$/.exec(reqUrl.pathname)
    if (logoMatch) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': FAKE_LOGO_PNG.length })
      res.end(FAKE_LOGO_PNG)
      return
    }

    if (opts.account !== undefined && opts.vodMovies !== undefined && reqUrl.pathname === '/api/vod/movies/') {
      const token = bearerToken(req)
      if (token === null || !issuedAccess.has(token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ detail: 'Authentication credentials were not provided or were invalid.' }))
        return
      }
      const pageSize = Math.max(1, Number(reqUrl.searchParams.get('page_size') ?? '500'))
      const page = Math.max(1, Number(reqUrl.searchParams.get('page') ?? '1'))
      const startIdx = (page - 1) * pageSize
      const slice = opts.vodMovies.slice(startIdx, startIdx + pageSize)
      const next = startIdx + pageSize < opts.vodMovies.length ? `${origin}/api/vod/movies/?page=${page + 1}&page_size=${pageSize}` : null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        count: opts.vodMovies.length,
        next,
        previous: null,
        results: slice.map((m) => ({
          id: m.id,
          uuid: m.uuid,
          name: m.name,
          year: m.year ?? null,
          rating: null,
          genre: null,
          description: null,
          duration_secs: null,
          is_adult: false,
          logo: m.logoPath !== undefined && m.logoPath !== null ? { cache_url: origin + m.logoPath } : null
        }))
      }))
      return
    }

    if (/^\/proxy\/vod\/movie\/([0-9a-fA-F-]+)\/?$/.test(reqUrl.pathname)) {
      // VOD proxy (probed shape): ?token=<jwt> → 301 to /proxy/vod/movie/<uuid>/<session>;
      // the session path streams with no further auth. (Exact path only — session paths
      // fall through to the route below.)
      if (reqUrl.searchParams.get('token') === null) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
      const token = reqUrl.searchParams.get('token') ?? ''
      if (opts.account === undefined || !issuedAccess.has(token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
      const sessionId = `vod_${Date.now()}_${vodSessions.size}`
      vodSessions.add(sessionId)
      res.writeHead(301, { Location: `/proxy/vod/movie/${reqUrl.pathname.split('/')[4]}/${sessionId}` })
      res.end()
      return
    }

    const vodSessionMatch = /^\/proxy\/vod\/movie\/([0-9a-fA-F-]+)\/(vod_.+)$/.exec(reqUrl.pathname)
    if (vodSessionMatch !== null) {
      if (!vodSessions.has(vodSessionMatch[2])) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'No such VOD session.' }))
        return
      }
      streams.opened++
      streams.open++
      res.writeHead(200, { 'Content-Type': 'video/mp2t' })
      const loopBuf = opts.streamFile !== undefined ? readFileSync(opts.streamFile) : null
      const chunk = loopBuf ?? Buffer.alloc(188 * 4, 0x47)
      let pos = 0
      const timer = setInterval(() => {
        if (loopBuf !== null) {
          const end = Math.min(pos + 188 * 16, loopBuf.length)
          res.write(loopBuf.subarray(pos, end))
          streams.bytesSent += end - pos
          pos = end >= loopBuf.length ? 0 : end
        } else {
          res.write(chunk)
          streams.bytesSent += chunk.length
        }
      }, 20)
      res.on('close', () => {
        clearInterval(timer)
        streams.open--
        streams.closed++
      })
      return
    }

    if (reqUrl.pathname.startsWith('/proxy/catchup/')) {
      // Catch-up playback: the session id is the capability (no auth, like the real thing).
      // Serves the same byte loop as the live stream — the relay path is identical plumbing.
      const match = /^\/proxy\/catchup\/([0-9a-fA-F-]+)$/.exec(reqUrl.pathname)
      const sessionId = reqUrl.searchParams.get('session_id')
      if (match === null || sessionId === null || !sessions.has(sessionId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ detail: 'No such catch-up session.' }))
        return
      }
      streams.opened++
      streams.open++
      res.writeHead(200, { 'Content-Type': 'video/mp2t' })
      const loopBuf = opts.streamFile !== undefined ? readFileSync(opts.streamFile) : null
      const chunk = loopBuf ?? Buffer.alloc(188 * 4, 0x47)
      let pos = 0
      const timer = setInterval(() => {
        if (loopBuf !== null) {
          const end = Math.min(pos + 188 * 16, loopBuf.length)
          res.write(loopBuf.subarray(pos, end))
          streams.bytesSent += end - pos
          pos = end >= loopBuf.length ? 0 : end
        } else {
          res.write(chunk)
          streams.bytesSent += chunk.length
        }
      }, 20)
      res.on('close', () => {
        clearInterval(timer)
        streams.open--
        streams.closed++
      })
      return
    }

    if (reqUrl.pathname.startsWith('/proxy/ts/stream/')) {
      // A real live proxy serves an endless byte stream until the client disconnects — the
      // abort-propagation behavior the BFF relay must respect (a hung relay holds a
      // Dispatcharr provider session open). Default: chunks every 20ms until 'close'.
      const lifetime = opts.streamLifetimeMs ?? null
      streams.opened++
      streams.open++
      res.writeHead(200, { 'Content-Type': 'video/mp2t' })
      const loopBuf = opts.streamFile !== undefined ? readFileSync(opts.streamFile) : null
      const chunk = loopBuf ?? Buffer.alloc(188 * 4, 0x47)
      let pos = 0
      const timer = setInterval(() => {
        if (loopBuf !== null) {
          const end = Math.min(pos + 188 * 16, loopBuf.length)
          res.write(loopBuf.subarray(pos, end))
          streams.bytesSent += end - pos
          pos = end >= loopBuf.length ? 0 : end
        } else {
          res.write(chunk)
          streams.bytesSent += chunk.length
        }
      }, 20)
      const lifetimeTimer = lifetime !== null
        ? setTimeout(() => {
            clearInterval(timer)
            res.end()
          }, lifetime)
        : null
      res.on('close', () => {
        clearInterval(timer)
        if (lifetimeTimer !== null) clearTimeout(lifetimeTimer)
        streams.open--
        streams.closed++
      })
      return
    }

    // The catch-all: every unknown path serves the SPA with 200 — the documented quirk.
    sendSpaIndex(res)
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const addr = server.address() as AddressInfo
  const origin = `http://127.0.0.1:${addr.port}`

  return {
    url: origin,
    origin,
    port: addr.port,
    requests,
    streams,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // closeAllConnections ends any open fake streams so tests never hang on lingering
        // intervals/sockets.
        server.closeAllConnections()
        server.close((err) => (err ? reject(err) : resolve()))
      })
  }
}
