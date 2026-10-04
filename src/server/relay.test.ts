import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from './db.js'
import { startFakeDispatcharr, type FakeDispatcharr } from './testing/fakeDispatcharr.js'
import { DEFAULT_FAKE_CHANNELS } from './testing/fixtures.js'
import { syncM3u } from './sync.js'
import { buildStreamUrl, relayStream, validateOutputFormat } from './relay.js'
import { startHttpServer, type RunningApp } from './testing/testServer.js'

const FAKE_NOW = new Date('2026-10-04T12:00:00Z')

async function readSomeBytes(url: string, bytesWanted: number, timeoutMs = 5000): Promise<{ text: string; status: number; contentType: string | null }> {
  const controller = new AbortController()
  const bail = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    const reader = res.body?.getReader()
    let text = ''
    if (reader) {
      while (text.length < bytesWanted) {
        const { done, value } = await reader.read()
        if (done) break
        text += Buffer.from(value).toString('binary')
      }
      await reader.cancel()
    }
    return { text: text.slice(0, bytesWanted), status: res.status, contentType: res.headers.get('content-type') }
  } finally {
    clearTimeout(bail)
  }
}

describe('relayStream', () => {
  let fake: FakeDispatcharr
  let db: Db

  beforeEach(async () => {
    fake = await startFakeDispatcharr({ now: FAKE_NOW })
    db = openDb(':memory:')
    await syncM3u({ db, dispatcharrUrl: fake.url })
  })

  afterEach(async () => {
    await fake.close()
  })

  it('pipes stream bytes through to the client with the upstream content type', async () => {
    // Exercise relayStream via a raw http server so we have genuine req/res objects.
    const { createServer } = await import('http')
    const server = createServer((req, res) => {
      void relayStream({ db, dispatcharrUrl: fake.url }, DEFAULT_FAKE_CHANNELS[0].uuid, null, res, req)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/relay`
    try {
      const { text, status, contentType } = await readSomeBytes(url, 4000)
      expect(status).toBe(200)
      expect(contentType).toBe('video/mp2t')
      expect(text.length).toBeGreaterThanOrEqual(4000)
      expect(fake.streams.opened).toBe(1)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('a client disconnect closes the upstream connection (no held provider sessions)', async () => {
    const { createServer } = await import('http')
    const server = createServer((req, res) => {
      void relayStream({ db, dispatcharrUrl: fake.url }, DEFAULT_FAKE_CHANNELS[0].uuid, null, res, req)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/relay`
    try {
      const controller = new AbortController()
      const res = await fetch(url, { signal: controller.signal })
      const reader = res.body!.getReader()
      await reader.read() // one chunk proves the stream flows
      expect(fake.streams.open).toBe(1)
      controller.abort() // the viewer changed channel / closed the tab
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(fake.streams.open).toBe(0)
      expect(fake.streams.closed).toBe(1)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('refuses unknown channel uuids (no open proxy)', async () => {
    const { createServer } = await import('http')
    let json = ''
    const server = createServer((req, res) => {
      void relayStream({ db, dispatcharrUrl: fake.url }, '00000000-0000-4000-8000-000000000000', null, res, req).then((result) => {
        json = JSON.stringify(result)
        if (!res.headersSent) {
          res.writeHead(result.ok ? 200 : 404, { 'Content-Type': 'application/json' })
          res.end(json)
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/relay`)
      expect(res.status).toBe(404)
      expect(await res.text()).toContain('unknown channel')
      expect(fake.streams.opened).toBe(0)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('buildStreamUrl includes the output format query only when asked', () => {
    expect(buildStreamUrl('http://d:9191', 'abc-uuid', null)).toBe('http://d:9191/proxy/ts/stream/abc-uuid')
    expect(buildStreamUrl('http://d:9191', 'abc-uuid', 'fmp4')).toBe('http://d:9191/proxy/ts/stream/abc-uuid?output_format=fmp4')
  })

  it('validateOutputFormat whitelists strictly', () => {
    expect(validateOutputFormat(undefined)).toBeNull()
    expect(validateOutputFormat('')).toBeNull()
    expect(validateOutputFormat('mpegts')).toBe('mpegts')
    expect(validateOutputFormat('fmp4')).toBe('fmp4')
    expect(() => validateOutputFormat('hls')).toThrow(/must be mpegts or fmp4/)
  })
})

// Over the real HTTP app surface: play info + relay route + status codes.
describe('M2 routes over HTTP', () => {
  let fake: FakeDispatcharr
  let db: Db
  let running: RunningApp

  beforeEach(async () => {
    fake = await startFakeDispatcharr({ now: FAKE_NOW })
    db = openDb(':memory:')
    await syncM3u({ db, dispatcharrUrl: fake.url })
    const { createApp } = await import('./app.js')
    const { loadConfig } = await import('./config.js')
    running = await startHttpServer(createApp(loadConfig({}), { db }))
  })

  afterEach(async () => {
    await running.close()
    await fake.close()
  })

  it('play info builds direct + relay URLs from the configured base', async () => {
    // No base configured yet → 400.
    const none = await fetch(`${running.url}/api/channels/${DEFAULT_FAKE_CHANNELS[0].uuid}/play`)
    expect(none.status).toBe(400)

    const { setDispatcharrUrl } = await import('./settingsStore.js')
    setDispatcharrUrl(db, fake.url)

    const res = await fetch(`${running.url}/api/channels/${DEFAULT_FAKE_CHANNELS[0].uuid}/play?output_format=fmp4`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { direct: string; relay: string; format: string; name: string }
    expect(body.direct).toBe(`${fake.url}/proxy/ts/stream/${DEFAULT_FAKE_CHANNELS[0].uuid}?output_format=fmp4`)
    expect(body.relay).toBe(`/api/relay/stream/${DEFAULT_FAKE_CHANNELS[0].uuid}?output_format=fmp4`)
    expect(body.format).toBe('fmp4')
  })

  it('unknown channel on play info is a 404, bad format a 400', async () => {
    const { setDispatcharrUrl } = await import('./settingsStore.js')
    setDispatcharrUrl(db, fake.url)
    const missing = await fetch(`${running.url}/api/channels/00000000-0000-4000-8000-000000000000/play`)
    expect(missing.status).toBe(404)
    const bad = await fetch(`${running.url}/api/channels/${DEFAULT_FAKE_CHANNELS[0].uuid}/play?output_format=hls`)
    expect(bad.status).toBe(400)
  })

  it('relay route serves bytes end-to-end and 404s unknown channels', async () => {
    const { setDispatcharrUrl } = await import('./settingsStore.js')
    setDispatcharrUrl(db, fake.url)
    const { text, status } = await readSomeBytes(`${running.url}/api/relay/stream/${DEFAULT_FAKE_CHANNELS[1].uuid}`, 2000)
    expect(status).toBe(200)
    expect(text.length).toBeGreaterThanOrEqual(2000)
    const missing = await fetch(`${running.url}/api/relay/stream/00000000-0000-4000-8000-000000000000`)
    expect(missing.status).toBe(404)
  })
})
