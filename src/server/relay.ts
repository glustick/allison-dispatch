import type { IncomingMessage, ServerResponse } from 'http'
import { spawn, execFileSync, type ChildProcess } from 'child_process'
import { Readable } from 'stream'
import ffmpegPath from 'ffmpeg-static'
import type { Db } from './db.js'

// The BFF relay: pipes one Dispatcharr live stream to the browser. Direct playback (browser →
// Dispatcharr) is the default and needs no relay; relay mode exists for mixed-content
// deployments (HTTPS app page, HTTP Dispatcharr), ACL edge cases, and debugging.
//
// Non-negotiables, both learned on the sibling:
//   * The uuid must be a channel we know — otherwise this endpoint is an open proxy.
//   * A client disconnect MUST abort the upstream fetch. A hung relay holds a Dispatcharr
//     provider session open (the sibling's "session stopped (reset()) to free the provider
//     connection" lesson, applied here at the proxy hop).
//
// fixAudio mode (the "no audio" fix): Dispatcharr passes provider codecs through untouched,
// and UK providers deliver AC-3/E-AC-3 (Dolby) audio, which browser MSE cannot play — the
// audio track just vanishes. Verified live on 2026-10-04: every probed channel carried AC-3.
// So the relay can spawn ffmpeg in the middle: video is COPIED (no transcode cost), audio is
// re-encoded to universally-playable AAC. ffmpeg receives the stream via stdin and emits via
// stdout, so no URL handling and no hostname resolution inside ffmpeg (the sibling's
// static-glibc NSS lesson), and the existing abort path tears the whole chain down.

export const STREAM_CONTENT_TYPE = 'video/mp2t'

export interface RelayDeps {
  db: Db
  dispatcharrUrl: string
  fetchImpl?: typeof fetch
  /** Connect timeout only — once headers arrive, a live stream may run for hours. */
  connectTimeoutMs?: number
  /** Test seam: observe the spawned ffmpeg process (e.g. to await its exit). */
  onFfmpegSpawn?: (proc: ChildProcess) => void
}

export type RelayResult =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 502; error: string }

export function buildStreamUrl(base: string, uuid: string, format: string | null): string {
  const query = format !== null ? `?output_format=${encodeURIComponent(format)}` : ''
  return `${base}/proxy/ts/stream/${uuid}${query}`
}

export function validateOutputFormat(raw: unknown): 'mpegts' | 'fmp4' | null {
  if (raw === undefined || raw === null || raw === '') return null
  if (raw === 'mpegts' || raw === 'fmp4') return raw
  throw new Error(`output_format must be mpegts or fmp4, got: ${String(raw)}`)
}

export function parseFixAudio(raw: unknown): boolean {
  return raw === '1' || raw === 'true'
}

const FFMPEG_BIN_FALLBACK = ffmpegPath as unknown as string

// Prefer a system ffmpeg (the Docker image ships Debian's — the bundled static linux build
// SIGSEGVs demuxing real Dispatcharr streams; see the Dockerfile), then fall back to the
// bundled binary for local dev machines without ffmpeg on PATH. Resolved once.
let ffmpegBinCache: string | null = null
function resolveFfmpegBin(): string {
  if (ffmpegBinCache !== null) return ffmpegBinCache
  const override = process.env.FFMPEG_PATH?.trim()
  if (override !== undefined && override !== '') {
    ffmpegBinCache = override
    return ffmpegBinCache
  }
  try {
    const onPath = execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim()
    if (onPath !== '') {
      ffmpegBinCache = onPath
      return ffmpegBinCache
    }
  } catch {
    // `which` failed or found nothing — fall through to the bundled binary.
  }
  ffmpegBinCache = FFMPEG_BIN_FALLBACK
  return ffmpegBinCache
}

function spawnAudioFixer(onFfmpegSpawn?: (proc: ChildProcess) => void): ChildProcess {
  // Video: copy (zero transcode cost, keeps the source bitrate). Audio: first audio track
  // → AAC stereo, playable by every MSE browser. Low-latency muxing knobs keep the added
  // delay small; the source arrives via stdin and leaves via stdout.
  const ff = spawn(resolveFfmpegBin(), [
    '-hide_banner', '-loglevel', 'error',
    '-fflags', '+nobuffer',
    '-i', 'pipe:0',
    '-map', '0:v:0', '-c:v', 'copy',
    '-map', '0:a:0?', '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    '-muxdelay', '0.2',
    '-f', 'mpegts', 'pipe:1'
  ], { stdio: ['pipe', 'pipe', 'pipe'] })
  onFfmpegSpawn?.(ff)
  return ff
}

export async function relayStream(deps: RelayDeps, uuid: string, format: 'mpegts' | 'fmp4' | null, clientRes: ServerResponse, clientReq?: IncomingMessage, fixAudio = false): Promise<RelayResult> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const known = deps.db.prepare('SELECT 1 FROM channels WHERE uuid = ?').get(uuid)
  if (!known) {
    return { ok: false, status: 404, error: 'unknown channel' }
  }

  const upstreamController = new AbortController()
  const connectTimeoutMs = deps.connectTimeoutMs ?? 15_000
  const connectTimer = setTimeout(() => upstreamController.abort(), connectTimeoutMs)

  let upstream: Response
  try {
    upstream = await fetchImpl(buildStreamUrl(deps.dispatcharrUrl, uuid, format), {
      signal: upstreamController.signal,
      // No credentials (Dispatcharr stream URLs are unauthenticated in v1) and no custom
      // Accept header — the live probe showed Dispatcharr answers 406 to `accept:
      // video/mp2t` on the proxy endpoint, so let the request default to */*.
      headers: { accept: '*/*' }
    })
  } catch (err) {
    clearTimeout(connectTimer)
    const message = err instanceof Error
      ? (err.name === 'AbortError' || err.name === 'TimeoutError' ? 'Dispatcharr did not accept the stream connection in time' : `upstream fetch failed: ${err.message}`)
      : String(err)
    return { ok: false, status: 502, error: message }
  }
  clearTimeout(connectTimer)

  if (!upstream.ok || upstream.body === null) {
    void upstream.body?.cancel()
    return { ok: false, status: 502, error: `Dispatcharr answered ${upstream.status} for the stream` }
  }

  // Spawn ffmpeg BEFORE the headers go out, so a spawn failure can still answer 502 JSON.
  let ff: ChildProcess | null = null
  let stderrTail = ''
  let spawnFailure: Promise<never> | null = null
  if (fixAudio) {
    ff = spawnAudioFixer(deps.onFfmpegSpawn)
    const proc = ff
    proc.stderr?.on('data', (c: Buffer) => {
      stderrTail = (stderrTail + c.toString()).slice(-800)
    })
    // stdin EPIPE after the client leaves or a kill — expected, not an app error.
    proc.stdin?.on('error', () => {})
    spawnFailure = new Promise<never>((_, reject) => {
      proc.once('error', (err) => reject(new Error(`audio-fix ffmpeg failed to spawn: ${err.message}`)))
    })
  }

  clientRes.writeHead(200, {
    'Content-Type': upstream.headers.get('content-type') ?? STREAM_CONTENT_TYPE,
    'Cache-Control': 'no-store'
  })

  const clientGone = new AbortController()
  const onClientClose = (): void => {
    // Client disconnect → tear down the upstream immediately so Dispatcharr frees its
    // provider session instead of streaming into the void. ffmpeg dies with it.
    clientGone.abort()
    upstreamController.abort()
    if (ff !== null) ff.kill('SIGKILL')
  }
  clientRes.on('close', onClientClose)
  clientReq?.on('close', onClientClose)

  try {
    if (fixAudio && ff !== null) {
      const proc = ff
      const session = (async (): Promise<void> => {
        const nodeUpstream = Readable.fromWeb(upstream.body as unknown as import('stream/web').ReadableStream)
        nodeUpstream.on('error', () => proc.kill('SIGKILL'))
        nodeUpstream.pipe(proc.stdin!)
        proc.stdout!.pipe(clientRes)
        // The session ends when ffmpeg exits: either the upstream ended (pipe closes ffmpeg's
        // stdin, ffmpeg flushes and exits) or the client left (kill above).
        await new Promise<void>((resolve) => {
          proc.once('exit', (code) => {
            if (code !== 0 && stderrTail !== '') {
              console.log(`[relay] audio-fix ffmpeg exited ${code}: ${stderrTail}`)
            }
            resolve()
          })
        })
        if (!clientRes.destroyed && !clientRes.writableEnded) clientRes.end()
      })()
      await Promise.race([session, spawnFailure])
      return { ok: true }
    }

    const reader = upstream.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (clientGone.signal.aborted || clientRes.destroyed || clientRes.writableEnded) break
      if (!clientRes.write(value)) {
        await new Promise<void>((resolve) => clientRes.once('drain', resolve))
      }
    }
    if (!clientRes.destroyed && !clientRes.writableEnded) clientRes.end()
  } catch (err) {
    // Upstream died, ffmpeg failed to spawn, or the client vanished mid-stream — nothing
    // sensible to report once bytes have flowed; make sure both ends are torn down.
    if (!clientRes.headersSent) {
      return { ok: false, status: 502, error: err instanceof Error ? err.message : 'relay failed' }
    }
    clientRes.destroy()
  } finally {
    clientRes.off('close', onClientClose)
    clientReq?.off('close', onClientClose)
    upstreamController.abort()
  }
  return { ok: true }
}
