import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import { existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { openDb, type Db } from './db.js'
import { startFakeDispatcharr, type FakeDispatcharr } from './testing/fakeDispatcharr.js'
import { DEFAULT_FAKE_CHANNELS } from './testing/fixtures.js'
import { syncM3u } from './sync.js'
import { relayStream, resolveFfmpegBin } from './relay.js'
import type { ChildProcess } from 'child_process'

// The audio-fix relay, proven with real ffmpeg: the fake serves a genuinely encoded TS
// fixture carrying AC-3 audio (what Dispatcharr actually delivers — verified live on
// 2026-10-04), and the relayed output must carry AAC. Fixture generation AND the codec
// probe use resolveFfmpegBin() — the same resolution the relay itself uses — because the
// bundled static binary SIGSEGVs demuxing real TS under Linux (the exact class of bug these
// tests guard). The fixture is 45s long so the fake's byte-loop never rewinds timestamps
// during a capture window (non-monotonic PTS makes some ffmpeg builds drop everything).

const FIXTURE_PATH = path.join(tmpdir(), 'allison-dispatch-ac3-fixture.ts')

function generateTsFixture(filePath: string, size: string): string {
  const result = spawnSync(resolveFfmpegBin(), [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc=duration=45:size=${size}:rate=15`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=45',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'ac3', '-b:a', '128k',
    '-f', 'mpegts', '-y', filePath
  ], { timeout: 120_000 })
  if (result.status !== 0 || !existsSync(filePath)) {
    throw new Error(`fixture generation failed: ${result.stderr?.toString().slice(0, 400)}`)
  }
  return filePath
}

function ensureAc3Fixture(): string {
  if (existsSync(FIXTURE_PATH)) return FIXTURE_PATH
  return generateTsFixture(FIXTURE_PATH, '320x240')
}

// Taller than the 240-line test cap, so a capped relay must visibly downscale (640x480 → 320x240).
const TALL_FIXTURE_PATH = path.join(tmpdir(), 'allison-dispatch-ac3-tall-fixture.ts')

function ensureTallAc3Fixture(): string {
  if (existsSync(TALL_FIXTURE_PATH)) return TALL_FIXTURE_PATH
  return generateTsFixture(TALL_FIXTURE_PATH, '640x480')
}

async function captureBytes(url: string, ms: number): Promise<Buffer> {
  const controller = new AbortController()
  const bail = setTimeout(() => controller.abort(), ms)
  const chunks: Buffer[] = []
  try {
    const res = await fetch(url, { signal: controller.signal })
    const reader = res.body!.getReader()
    for (;;) {
      try {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(Buffer.from(value))
      } catch {
        break // abort — we have enough
      }
    }
  } catch {
    // aborted — expected path for an endless stream
  } finally {
    clearTimeout(bail)
  }
  return Buffer.concat(chunks)
}

function probeCodecs(file: string): string {
  const result = spawnSync(resolveFfmpegBin(), ['-hide_banner', '-i', file], { encoding: 'utf8' })
  return result.stderr ?? ''
}

// A captured live TS often won't yield dimensions from header probing alone ("unspecified
// size" even at 5MB probesize) — so decode one real frame to PNG and read the size from that.
function probeVideoSize(file: string): { width: number; height: number } | null {
  const frame = `${file}.frame.png`
  const decode = spawnSync(resolveFfmpegBin(), ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-frames:v', '1', '-y', frame], { encoding: 'utf8', timeout: 30_000 })
  if (decode.status !== 0 || !existsSync(frame)) return null
  const match = probeCodecs(frame).match(/(\d{2,5})x(\d{2,5})/)
  return match === null ? null : { width: Number(match[1]), height: Number(match[2]) }
}

describe('audio-fix relay (real ffmpeg)', () => {
  let fake: FakeDispatcharr
  let db: Db
  let spawned: ChildProcess[]
  let stderrAll: string

  beforeEach(async () => {
    ensureAc3Fixture()
    fake = await startFakeDispatcharr({ now: new Date('2026-10-04T12:00:00Z'), streamFile: FIXTURE_PATH })
    db = openDb(':memory:')
    await syncM3u({ db, dispatcharrUrl: fake.url })
    spawned = []
    stderrAll = ''
  })

  afterEach(async () => {
    await fake.close()
  })

  it('turns AC-3 audio into AAC and keeps video copied', { timeout: 45_000 }, async () => {
    const { createServer } = await import('http')
    const server = createServer((req, res) => {
      void relayStream(
        { db, dispatcharrUrl: fake.url, onFfmpegSpawn: (p) => {
          spawned.push(p)
          console.log('[diag] spawned:', p.spawnfile, p.spawnargs?.slice(2).join(' '))
          p.stderr?.on('data', (d: Buffer) => { stderrAll += d.toString() })
        } },
        DEFAULT_FAKE_CHANNELS[0].uuid, null, res, req, true
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/relay`
    try {
      // Generous budget: ffmpeg's analysis of a piped live TS can take >6s to first byte on
      // a busy CI runner (the same cold-start latency measured at ~8s against real
      // Dispatcharr) — a tight window here fails with zero bytes, not a codec problem.
      const out = await captureBytes(url, 15_000)
      if (out.length === 0) {
        console.log('[diag] captured ZERO bytes; ffmpeg stderr:', stderrAll.slice(0, 1200))
      }
      expect(out.length).toBeGreaterThan(20_000) // real encoded bytes flowed
      const outFile = path.join(tmpdir(), `allison-dispatch-fixaudio-out-${Date.now()}.ts`)
      writeFileSync(outFile, out)
      const codecs = probeCodecs(outFile)
      expect(codecs).toMatch(/Video: h264/) // video untouched
      expect(codecs).toMatch(/Audio: aac/) // audio transcoded
      expect(codecs).not.toMatch(/ac3/) // no Dolby passthrough left
      // The spawned ffmpeg should have been torn down when the capture aborted.
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(spawned.every((p) => p.exitCode !== null || p.killed)).toBe(true)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('a max_height cap downscales the video and keeps the audio fix', { timeout: 45_000 }, async () => {
    ensureTallAc3Fixture()
    // A fresh fake serving the 640x480 fixture — the beforeEach one serves 320x240.
    const tallFake = await startFakeDispatcharr({ now: new Date('2026-10-04T12:00:00Z'), streamFile: TALL_FIXTURE_PATH })
    const tallDb = openDb(':memory:')
    await syncM3u({ db: tallDb, dispatcharrUrl: tallFake.url })
    const { createServer } = await import('http')
    const server = createServer((req, res) => {
      void relayStream(
        { db: tallDb, dispatcharrUrl: tallFake.url },
        DEFAULT_FAKE_CHANNELS[0].uuid, null, res, req, true, 240
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/relay`
    try {
      const out = await captureBytes(url, 15_000)
      if (out.length === 0) {
        console.log('[diag] capped relay captured ZERO bytes')
      }
      expect(out.length).toBeGreaterThan(20_000)
      const outFile = path.join(tmpdir(), `allison-dispatch-capped-out-${Date.now()}.ts`)
      writeFileSync(outFile, out)
      const size = probeVideoSize(outFile)
      expect(size).not.toBeNull()
      // min(ih, 240) downscaled 480-line input to 240, width from -2 keeps the 4:3 shape.
      expect(size!.height).toBe(240)
      expect(size!.width).toBe(320)
      const codecs = probeCodecs(outFile)
      expect(codecs).toMatch(/Audio: aac/) // the audio fix rides along under a cap
      expect(codecs).not.toMatch(/ac3/)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await tallFake.close()
    }
  })

  it('plain relay (no fixAudio) leaves the bytes untouched', { timeout: 20_000 }, async () => {
    const { createServer } = await import('http')
    let ffmpegSpawned = false
    const server = createServer((req, res) => {
      void relayStream(
        { db, dispatcharrUrl: fake.url, onFfmpegSpawn: () => { ffmpegSpawned = true } },
        DEFAULT_FAKE_CHANNELS[1].uuid, null, res, req, false
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const out = await captureBytes(`http://127.0.0.1:${(server.address() as { port: number }).port}/relay`, 1_500)
      expect(out.length).toBeGreaterThan(1_000)
      expect(ffmpegSpawned).toBe(false) // no ffmpeg in the plain path
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
