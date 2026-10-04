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
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET'
    const reqUrl = new URL(req.url ?? '/', 'http://fake.invalid')
    const host = req.headers.host ?? 'fake-dispatcharr.invalid'
    // Mirror the real instance: generated URLs carry the request's own origin.
    const origin = `http://${host}`
    requests.push({ method, path: reqUrl.pathname })

    if (method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain' })
      res.end('method not allowed')
      return
    }

    if (reqUrl.pathname === '/output/m3u') {
      sendChunked(res, 'audio/x-mpegurl', {}, buildM3u(origin, channels))
      return
    }

    if (reqUrl.pathname === '/output/epg') {
      // Header set mirrors the live probe: application/xml, chunked, attachment, no-cache.
      sendChunked(res, 'application/xml', {
        'Content-Disposition': 'attachment; filename="Dispatcharr.xml"',
        'Cache-Control': 'no-cache'
      }, buildEpgXml(opts.now, channels))
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
