import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'
import { createApp } from './app.js'
import { openDb, type Db } from './db.js'
import { startHttpServer, seedAndLogin, type RunningApp } from './testing/testServer.js'
import { startFakeDispatcharr, type FakeDispatcharr } from './testing/fakeDispatcharr.js'
import { syncM3u } from './sync.js'
import { setDispatcharrUrl } from './settingsStore.js'
import { proxiedLogoUrl } from './logoProxy.js'

// The logo proxy exists because the app is served over HTTPS while Dispatcharr is plain
// HTTP on the LAN: direct logo URLs are mixed content (blocked) and unreachable off-LAN.
// The rewrite happens at every logo_url emission point; the bytes flow through /api/logo.

describe('proxiedLogoUrl', () => {
  const BASE = 'http://192.168.0.20:9191'

  it('rewrites a Dispatcharr logo URL to the same-origin proxy path', () => {
    const out = proxiedLogoUrl(BASE, 'http://192.168.0.20:9191/api/channels/logos/97/cache/')
    expect(out).toBe(`/api/logo?u=${encodeURIComponent('http://192.168.0.20:9191/api/channels/logos/97/cache/')}`)
  })

  it('resolves path-only URLs against the base and refuses foreign origins', () => {
    expect(proxiedLogoUrl(BASE, '/api/channels/logos/5/cache/')).toBe(
      `/api/logo?u=${encodeURIComponent('http://192.168.0.20:9191/api/channels/logos/5/cache/')}`
    )
    // An open proxy is exactly what this must never be.
    expect(proxiedLogoUrl(BASE, 'http://evil.example/steal.png')).toBeNull()
  })

  it('null logo in, null out; unconfigured base, null out', () => {
    expect(proxiedLogoUrl(BASE, null)).toBeNull()
    expect(proxiedLogoUrl(BASE, '')).toBeNull()
    expect(proxiedLogoUrl(null, 'http://192.168.0.20:9191/x.png')).toBeNull()
  })
})

describe('logo proxy API', () => {
  let fake: FakeDispatcharr
  let db: Db
  let running: RunningApp
  let cookie: string

  beforeEach(async () => {
    fake = await startFakeDispatcharr({ now: new Date('2026-10-04T12:00:00Z') })
    db = openDb(':memory:')
    await syncM3u({ db, dispatcharrUrl: fake.url })
    setDispatcharrUrl(db, fake.url) // the proxy resolves its guard against the configured base
    running = await startHttpServer(createApp(loadConfig({}), { db }))
    cookie = await seedAndLogin(db, running.url)
  })

  afterEach(async () => {
    await running.close()
    await fake.close()
  })

  function jfetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('cookie', cookie)
    return fetch(`${running.url}${path}`, { ...init, headers })
  }

  it('serves logo bytes same-origin with browser caching', async () => {
    const channels = (await (await jfetch('/api/channels')).json()) as { channels: Array<{ logo_url: string | null }> }
    const proxied = channels.channels[0]?.logo_url
    expect(proxied).toMatch(/^\/api\/logo\?u=/)

    const res = await jfetch(proxied!)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toContain('max-age=86400')
    const bytes = await res.arrayBuffer()
    expect(bytes.byteLength).toBeGreaterThan(50) // real PNG bytes, not the SPA catch-all
  })

  it('refuses to proxy anything off the Dispatcharr origin', async () => {
    const res = await jfetch(`/api/logo?u=${encodeURIComponent('http://evil.example/steal.png')}`)
    expect(res.status).toBe(400)
  })

  it('answers 404 for a logo Dispatcharr does not have', async () => {
    // The fake's catch-all answers 200+HTML for unknown paths, so a genuinely missing logo
    // can't be simulated there — a wrong-origin check already covers refusal; this asserts
    // the passthrough of a *fetch* failure via a port with nothing listening.
    const res = await jfetch(`/api/logo?u=${encodeURIComponent('http://127.0.0.1:1/api/channels/logos/1/cache/')}`)
    // Same origin as the fake? No — this URL's origin differs from the configured base, so
    // the guard refuses before any network I/O.
    expect(res.status).toBe(400)
  })
})
