import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startFakeDispatcharr, type FakeDispatcharr } from './fakeDispatcharr.js'
import { DEFAULT_FAKE_CHANNELS, buildProgrammeSlots } from './fixtures.js'

// These tests pin the fake's WIRE behavior — the shapes a real Dispatcharr v0.31.0 serves
// (probed live on 2026-10-04 against 192.168.0.20:9191). The sibling project's lesson: a
// fake that doesn't behave like the real host at the wire level can't catch wrong-host bugs,
// so anything the real instance is known to do (request-host origin in generated URLs,
// chunked EPG without content-length, the 200 SPA catch-all) is pinned here.

describe('wire-level fake Dispatcharr', () => {
  let fake: FakeDispatcharr

  beforeEach(async () => {
    fake = await startFakeDispatcharr({ now: new Date('2026-10-04T12:00:00Z') })
  })

  afterEach(async () => {
    await fake.close()
  })

  it('serves the M3U with the request-host origin in generated URLs', async () => {
    const res = await fetch(`${fake.url}/output/m3u`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('audio/x-mpegurl')
    const body = await res.text()
    const first = body.split('\n')
    expect(first[0]).toBe(`#EXTM3U x-tvg-url="${fake.origin}/output/epg" url-tvg="${fake.origin}/output/epg"`)
    expect(first[1]).toContain('tvg-id="101"')
    expect(first[1]).toContain('tvg-chno="101"')
    expect(first[1]).toContain('group-title="News"')
    expect(first[1]).toContain(`tvg-logo="${fake.origin}/api/channels/logos/1/cache/"`)
    expect(first[2]).toBe(`${fake.origin}/proxy/ts/stream/${DEFAULT_FAKE_CHANNELS[0].uuid}`)
  })

  it('origin changes with the Host header, like the real instance', async () => {
    // The real Dispatcharr generates URLs from the request's Host — a consumer requesting via
    // a different host gets different URLs back. The fake must reproduce that so M1's
    // origin-rewriting logic is exercised against the true behavior.
    const port = fake.port
    const res = await fetch(`http://localhost:${port}/output/m3u`)
    const body = await res.text()
    expect(body).toContain(`http://localhost:${port}/proxy/ts/stream/`)
    expect(body).not.toContain('127.0.0.1')
  })

  it('serves the EPG chunked with attachment disposition and programme data straddling now', async () => {
    const res = await fetch(`${fake.url}/output/epg?days=7`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/xml')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="Dispatcharr.xml"')
    expect(res.headers.get('transfer-encoding')).toBe('chunked')
    expect(res.headers.get('content-length')).toBeNull()
    const body = await res.text()
    expect(body).toContain('<tv generator-info-name="fake-dispatcharr">')
    expect(body).toContain('<programme start=')
    expect(body).toContain('channel="101"')
  })

  it('programme slots genuinely straddle the injected clock', () => {
    const now = new Date('2026-10-04T12:00:00Z')
    const slots = buildProgrammeSlots(now, DEFAULT_FAKE_CHANNELS[0])
    expect(slots).toHaveLength(4)
    expect(slots[0].start.getTime()).toBeLessThan(now.getTime())
    expect(slots[0].stop.getTime()).toBeLessThanOrEqual(now.getTime())
    const live = slots[1]
    expect(live.start.getTime()).toBeLessThan(now.getTime())
    expect(live.stop.getTime()).toBeGreaterThan(now.getTime())
    expect(slots[3].stop.getTime()).toBeGreaterThan(now.getTime())
  })

  it('serves a public version endpoint shaped like the real one', async () => {
    const res = await fetch(`${fake.url}/api/core/version/`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ version: '0.31.0', timestamp: null })
  })

  it('serves logo cache bytes as PNG', async () => {
    const res = await fetch(`${fake.url}/api/channels/logos/3/cache/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    const bytes = Buffer.from(await res.arrayBuffer())
    // PNG magic number — proves real image bytes, not a text placeholder.
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })

  it('answers 200 + HTML for unknown paths (the SPA catch-all quirk, NOT 404)', async () => {
    const res = await fetch(`${fake.url}/definitely-not-a-real-path-xyz`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('fake-dispatcharr-spa')
  })

  it('records request paths for tests that need to assert what was fetched', async () => {
    await fetch(`${fake.url}/output/m3u`)
    await fetch(`${fake.url}/output/epg`)
    expect(fake.requests.map((r) => r.path)).toEqual(['/output/m3u', '/output/epg'])
  })
})
