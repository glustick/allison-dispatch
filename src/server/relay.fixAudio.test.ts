import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import { existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import ffmpegPath from 'ffmpeg-static'
import { openDb, type Db } from './db.js'
import { startFakeDispatcharr, type FakeDispatcharr } from './testing/fakeDispatcharr.js'
import { DEFAULT_FAKE_CHANNELS } from './testing/fixtures.js'
import { syncM3u } from './sync.js'
import { relayStream } from './relay.js'
import type { ChildProcess } from 'child_process'

// The audio-fix relay, proven with real ffmpeg: the fake serves a genuinely encoded TS
// fixture carrying AC-3 audio (what Dispatcharr actually delivers — verified live on
// 2026-10-04), and the relayed output must carry AAC. The fixture is generated once and
// cached; tests use generous timeouts because real encoding is timing-sensitive.

const FFMPEG_BIN = ffmpegPath as unknown as string

const FIXTURE_PATH = path.join(tmpdir(), 'allison-dispatch-ac3-fixture.ts')

function ensureAc3Fixture(): string {
  if (existsSync(FIXTURE_PATH)) return FIXTURE_PATH
  const result = spawnSync(FFMPEG_BIN, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'ac3', '-b:a', '128k',
    '-f', 'mpegts', '-y', FIXTURE_PATH
  ], { timeout: 30_000 })
  if (result.status !== 0 || !existsSync(FIXTURE_PATH)) {
    throw new Error(`fixture generation failed: ${result.stderr?.toString().slice(0, 400)}`)
  }
  return FIXTURE_PATH
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
  const result = spawnSync(FFMPEG_BIN, ['-hide_banner', '-i', file], { encoding: 'utf8' })
  return result.stderr ?? ''
}

describe('audio-fix relay (real ffmpeg)', () => {
  let fake: FakeDispatcharr
  let db: Db
  let spawned: ChildProcess[]

  beforeEach(async () => {
    ensureAc3Fixture()
    fake = await startFakeDispatcharr({ now: new Date('2026-10-04T12:00:00Z'), streamFile: FIXTURE_PATH })
    db = openDb(':memory:')
    await syncM3u({ db, dispatcharrUrl: fake.url })
    spawned = []
  })

  afterEach(async () => {
    await fake.close()
  })

  it('turns AC-3 audio into AAC and keeps video copied', { timeout: 45_000 }, async () => {
    const { createServer } = await import('http')
    const server = createServer((req, res) => {
      void relayStream(
        { db, dispatcharrUrl: fake.url, onFfmpegSpawn: (p) => spawned.push(p) },
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
