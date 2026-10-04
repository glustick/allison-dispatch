import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { loadConfig, normalizeDispatcharrUrl } from './config.js'
import { createApp } from './app.js'
import { startHttpServer, type RunningApp } from './testing/testServer.js'
import { readAppVersion } from './version.js'

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const cfg = loadConfig({})
    expect(cfg.port).toBe(8086)
    expect(cfg.publicDir).not.toBe('')
    expect(cfg.dispatcharrUrl).toBeNull()
  })

  it('normalizes DISPATCHARR_URL to scheme://host:port with no trailing slash or path', () => {
    const cfg = loadConfig({ DISPATCHARR_URL: 'http://192.168.0.20:9191/' })
    expect(cfg.dispatcharrUrl).toBe('http://192.168.0.20:9191')
  })

  it('strips path and query noise from DISPATCHARR_URL', () => {
    const cfg = loadConfig({ DISPATCHARR_URL: 'http://nas.local:9191/some/prefix?x=1' })
    expect(cfg.dispatcharrUrl).toBe('http://nas.local:9191')
  })

  it('rejects non-http schemes', () => {
    expect(() => loadConfig({ DISPATCHARR_URL: 'ftp://192.168.0.20' })).toThrow(/must use http or https/)
  })

  it('rejects unparseable URLs with a clear message', () => {
    expect(() => loadConfig({ DISPATCHARR_URL: 'not a url' })).toThrow(/not a valid URL/)
  })

  it('rejects a non-integer or out-of-range PORT', () => {
    expect(() => loadConfig({ PORT: '8086.5' })).toThrow(/PORT/)
    expect(() => loadConfig({ PORT: '0' })).toThrow(/PORT/)
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/)
  })
})

describe('normalizeDispatcharrUrl', () => {
  it('keeps an explicit https origin', () => {
    expect(normalizeDispatcharrUrl('https://dispatch.example.net')).toBe('https://dispatch.example.net')
  })
})

describe('createApp — M0 endpoints', () => {
  let running: RunningApp
  let tmpPublic: string

  beforeEach(() => {
    tmpPublic = mkdtempSync(path.join(tmpdir(), 'allison-dispatch-public-'))
  })

  afterEach(async () => {
    if (running) await running.close()
    rmSync(tmpPublic, { recursive: true, force: true })
  })

  async function boot(publicDir?: string): Promise<void> {
    running = await startHttpServer(createApp({ ...loadConfig({}), ...(publicDir ? { publicDir } : {}) }))
  }

  it('GET /api/health answers ok with uptime and timestamp', async () => {
    await boot()
    const res = await fetch(`${running.url}/api/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; uptimeSeconds: number; timestamp: string }
    expect(body.status).toBe('ok')
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0)
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false)
  })

  it('GET /api/version reports the package version', async () => {
    await boot()
    const res = await fetch(`${running.url}/api/version`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { name: string; version: string }
    expect(body.name).toBe('allison-dispatch')
    expect(body.version).toBe(readAppVersion())
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('GET /api/config reports whether Dispatcharr is configured', async () => {
    await boot()
    const res = await fetch(`${running.url}/api/config`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { dispatcharrConfigured: boolean }
    expect(body.dispatcharrConfigured).toBe(false)
  })

  it('unknown /api paths answer 404 JSON (not the SPA catch-all Dispatcharr does)', async () => {
    await boot()
    const res = await fetch(`${running.url}/api/definitely-not-a-route`)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Not found')
  })

  it('serves the built client with an SPA fallback when the build exists', async () => {
    writeFileSync(path.join(tmpPublic, 'index.html'), '<!doctype html><html><body>client-shell</body></html>')
    await boot(tmpPublic)
    const root = await fetch(`${running.url}/`)
    expect(root.status).toBe(200)
    expect(await root.text()).toContain('client-shell')
    const deep = await fetch(`${running.url}/watch/bbc-news`)
    expect(deep.status).toBe(200)
    expect(await deep.text()).toContain('client-shell')
  })

  it('answers 404 for non-API pages when no client build exists (dev before build:client)', async () => {
    await boot(path.join(tmpPublic, 'does-not-exist'))
    const res = await fetch(`${running.url}/`)
    expect(res.status).toBe(404)
  })
})
