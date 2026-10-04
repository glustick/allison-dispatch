import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'
import { createApp } from './app.js'
import { openDb, type Db } from './db.js'
import { startHttpServer, seedAndLogin, type RunningApp } from './testing/testServer.js'
import { startFakeDispatcharr, type FakeDispatcharr } from './testing/fakeDispatcharr.js'
import { DEFAULT_FAKE_CHANNELS } from './testing/fixtures.js'
import { SyncFailure, type SyncSummary } from './sync.js'

const FAKE_NOW = new Date('2026-10-04T12:00:00Z')
const HOUR = 3_600_000

// M1 integration: settings → sync → channels/EPG read paths, over real HTTP against the
// wire-level fake. Since the auth round, these surfaces sit behind the session gate — the
// suite seeds a user and attaches the cookie to every request via jfetch.
describe('M1 API surfaces', () => {
  let fake: FakeDispatcharr
  let db: Db
  let running: RunningApp
  let cookie: string

  beforeEach(async () => {
    fake = await startFakeDispatcharr({ now: FAKE_NOW })
    db = openDb(':memory:')
    running = await startHttpServer(
      createApp(loadConfig({}), {
        db,
        clock: () => FAKE_NOW.getTime() + 10 * 60 * 1000
      })
    )
    cookie = await seedAndLogin(db, running.url)
  })

  afterEach(async () => {
    await running.close()
    await fake.close()
  })

  function jfetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('cookie', cookie)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    return fetch(`${running.url}${path}`, { ...init, headers })
  }

  async function putUrl(url: string | null): Promise<void> {
    const res = await jfetch('/api/settings', { method: 'PUT', body: JSON.stringify({ dispatcharrUrl: url }) })
    expect(res.status).toBe(200)
  }

  it('settings round-trip and reject invalid URLs', async () => {
    const empty = await (await jfetch('/api/settings')).json()
    expect(empty).toMatchObject({ dispatcharrUrl: null, source: null })

    const bad = await jfetch('/api/settings', { method: 'PUT', body: JSON.stringify({ dispatcharrUrl: 'not a url' }) })
    expect(bad.status).toBe(400)

    await putUrl(`${fake.url}/`) // trailing slash must be normalized away
    const stored = (await (await jfetch('/api/settings')).json()) as { dispatcharrUrl: string; source: string }
    expect(stored).toMatchObject({ dispatcharrUrl: fake.url, source: 'settings' })
  })

  it('connection test probes the public version endpoint', async () => {
    const res = await jfetch('/api/settings/test', { method: 'POST', body: JSON.stringify({ url: fake.url }) })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, version: '0.31.0', url: fake.url })
  })

  it('connection test reports unreachable targets as ok:false without throwing', async () => {
    const res = await jfetch('/api/settings/test', { method: 'POST', body: JSON.stringify({ url: 'http://127.0.0.1:1' }) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/fetch failed|timed out/)
  })

  it('full flow: save URL → sync → channel list sorted by number', async () => {
    await putUrl(fake.url)
    const syncRes = await jfetch('/api/sync/run', { method: 'POST' })
    expect(syncRes.status).toBe(200)
    const { summary } = (await syncRes.json()) as { summary: { m3u: { channels: number }; epg: { programmes: number } } }
    expect(summary.m3u.channels).toBe(6)
    expect(summary.epg.programmes).toBe(24)

    const channelsRes = await jfetch('/api/channels')
    const body = (await channelsRes.json()) as {
      count: number
      channels: Array<{ uuid: string; channel_number: number | null }>
    }
    expect(body.count).toBe(6)
    const numbers = body.channels.map((c) => c.channel_number)
    expect([...numbers].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(numbers)
    expect(body.channels[0].uuid).toBe(DEFAULT_FAKE_CHANNELS[0].uuid)
  })

  it('sync without a configured URL is a 400 with guidance', async () => {
    const res = await jfetch('/api/sync/run', { method: 'POST' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: /not configured/i })
  })

  it('sync run supports kind selection', async () => {
    await putUrl(fake.url)
    const res = await jfetch('/api/sync/run', { method: 'POST', body: JSON.stringify({ kinds: ['m3u'] }) })
    expect(res.status).toBe(200)
    const { summary } = (await res.json()) as { summary: { m3u: unknown; epg: unknown } }
    expect(summary.m3u).toMatchObject({ channels: 6 })
    expect(summary.epg).toBeNull()
  })

  it('sync failures map to 502, in-flight guard conflicts to 409', async () => {
    await putUrl(fake.url)
    const failingApp = await startHttpServer(
      createApp(loadConfig({}), {
        db,
        runSyncFn: () => Promise.reject(new SyncFailure('m3u', 'Dispatcharr answered 500 for /output/m3u'))
      })
    )
    try {
      const failingCookie = await seedAndLogin(db, failingApp.url)
      const res = await fetch(`${failingApp.url}/api/sync/run`, {
        method: 'POST',
        headers: { cookie: failingCookie }
      })
      expect(res.status).toBe(502)
      expect(await res.json()).toMatchObject({ error: /500/ })
    } finally {
      await failingApp.close()
    }

    const conflicted = await startHttpServer(
      createApp(loadConfig({}), {
        db,
        runSyncFn: () => Promise.reject(new SyncFailure('epg', 'EPG sync already running'))
      })
    )
    try {
      const conflictCookie = await seedAndLogin(db, conflicted.url)
      const res = await fetch(`${conflicted.url}/api/sync/run`, {
        method: 'POST',
        headers: { cookie: conflictCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ kinds: ['epg'] })
      })
      expect(res.status).toBe(409)
    } finally {
      await conflicted.close()
    }
  })

  it('now-next and window endpoints serve synced guide data', async () => {
    await putUrl(fake.url)
    await jfetch('/api/sync/run', { method: 'POST' })
    const uuid = DEFAULT_FAKE_CHANNELS[0].uuid

    const nnRes = await jfetch(`/api/epg/now-next?uuid=${uuid}`)
    expect(nnRes.status).toBe(200)
    const nn = (await nnRes.json()) as { now: { title: string } | null; next: { title: string } | null }
    expect(nn.now?.title).toBe('ACME News HD — Slot 1')
    expect(nn.next?.title).toBe('ACME News HD — Slot 2')

    const start = FAKE_NOW.getTime() - 60 * 60 * 1000
    const end = FAKE_NOW.getTime() + 3 * 60 * 60 * 1000
    const winRes = await jfetch(`/api/epg/window?uuid=${uuid}&start=${start}&end=${end}`)
    const win = (await winRes.json()) as { programmes: Array<{ title: string }> }
    expect(win.programmes.map((p) => p.title)).toEqual([
      'ACME News HD — Slot 1',
      'ACME News HD — Slot 2',
      'ACME News HD — Slot 3'
    ])
  })

  it('guide grid returns every channel with its programmes overlapping the window', async () => {
    await putUrl(fake.url)
    await jfetch('/api/sync/run', { method: 'POST' })
    const start = FAKE_NOW.getTime() - HOUR
    const end = FAKE_NOW.getTime() + 2 * HOUR
    const res = await jfetch(`/api/epg/grid?start=${start}&end=${end}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      count: number
      channels: Array<{ uuid: string; name: string; programmes: Array<{ title: string; start_utc: number; stop_utc: number }> }>
    }
    expect(body.count).toBe(6)
    const first = body.channels[0]
    expect(first.uuid).toBe(DEFAULT_FAKE_CHANNELS[0].uuid)
    // Slots are 2h with a 30min offset (Slot1 [now-1.5h, now+0.5h), Slot2 [now+0.5h, now+2.5h),
    // Slot3 [now+2.5h, …)); the 3h window [now-1h, now+2h) overlaps Slots 1 and 2.
    expect(first.programmes.map((p) => p.title)).toEqual([
      'ACME News HD — Slot 1',
      'ACME News HD — Slot 2'
    ])
    const starts = first.programmes.map((p) => p.start_utc)
    expect([...starts].sort((a, b) => a - b)).toEqual(starts)
  })

  it('guide grid validates the window (end > start, span ≤ 24h)', async () => {
    const now = Date.now()
    const badOrder = await jfetch(`/api/epg/grid?start=${now}&end=${now}`)
    expect(badOrder.status).toBe(400)
    const tooWide = await jfetch(`/api/epg/grid?start=${now}&end=${now + 25 * HOUR}`)
    expect(tooWide.status).toBe(400)
  })

  it('unknown channel uuid on now-next is a 404', async () => {
    await putUrl(fake.url)
    await jfetch('/api/sync/run', { method: 'POST' })
    const res = await jfetch('/api/epg/now-next?uuid=00000000-0000-4000-8000-000000000000')
    expect(res.status).toBe(404)
  })
})

// Type-level guard: the app's sync contract stays honest.
describe('SyncSummary shape', () => {
  it('allows null halves', () => {
    const summary: SyncSummary = { m3u: null, epg: null }
    expect(summary.m3u).toBeNull()
  })
})
