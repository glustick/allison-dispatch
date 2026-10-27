import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'
import { createApp } from './app.js'
import { openDb, type Db } from './db.js'
import { startHttpServer, seedAndLogin, type RunningApp } from './testing/testServer.js'
import { startFakeDispatcharr, type FakeDispatcharr } from './testing/fakeDispatcharr.js'
import { syncVod } from './sync.js'
import { setDispatcharrUrl } from './settingsStore.js'
import { createDispatcharrAuth } from './dispatcharrAuth.js'

// VOD: the movie library syncs paged from Dispatcharr's REST, browses/searches from SQLite
// with proxied logos, and plays through the audio-fix relay (token → 301 → session path).

const FAKE_NOW = new Date('2026-10-25T12:00:00Z')
const ACCOUNT = { username: 'testuser', password: 'testpass' }

const LIBRARY = [
  { id: 1, uuid: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Alpha Movie', year: 2020, logoPath: '/api/vod/vodlogos/1/cache/?v=a' },
  { id: 2, uuid: 'aaaaaaaa-0000-4000-8000-000000000002', name: 'Beta Movie', year: 2021, logoPath: null },
  { id: 3, uuid: 'aaaaaaaa-0000-4000-8000-000000000003', name: 'Gamma Movie', year: 2022 },
  { id: 4, uuid: 'aaaaaaaa-0000-4000-8000-000000000004', name: 'Delta Movie', year: 2023 }
]

describe('VOD sync + API', () => {
  let fake: FakeDispatcharr
  let db: Db
  let running: RunningApp
  let cookie: string

  beforeEach(async () => {
    fake = await startFakeDispatcharr({ now: FAKE_NOW, account: ACCOUNT, vodMovies: LIBRARY })
    db = openDb(':memory:')
    await syncVod({ db, dispatcharrUrl: fake.url, vodAuth: createDispatcharrAuth({ baseUrl: fake.url, username: ACCOUNT.username, password: ACCOUNT.password }), vodPageSize: 2 })
    setDispatcharrUrl(db, fake.url)
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

  it('syncs the paged library completely (page size 2 over 4 movies)', () => {
    const states = db.prepare('SELECT kind, status, item_count FROM sync_state WHERE kind = ?').get('vod') as { kind: string; status: string; item_count: number }
    expect(states).toStrictEqual({ kind: 'vod', status: 'ok', item_count: 4 })
    const count = db.prepare('SELECT COUNT(*) AS n FROM vod_movies').get() as { n: number }
    expect(count.n).toBe(4)
    const alpha = db.prepare('SELECT logo_path FROM vod_movies WHERE name = ?').get('Alpha Movie') as { logo_path: string | null }
    expect(alpha.logo_path).toBe('/api/vod/vodlogos/1/cache/?v=a') // path-only, host-independent
  })

  it('fails with a clear message when no account is configured', async () => {
    const bare = openDb(':memory:')
    await expect(syncVod({ db: bare, dispatcharrUrl: fake.url })).rejects.toThrow(/No Dispatcharr account configured/)
  })

  it('lists, paginates and searches with proxied logos', async () => {
    const all = (await (await jfetch('/api/vod/movies?page_size=2&page=1')).json()) as {
      count: number
      movies: Array<{ name: string; logo: string | null }>
    }
    expect(all.count).toBe(4)
    expect(all.movies).toHaveLength(2)
    expect(all.movies[0].name).toBe('Alpha Movie')
    expect(all.movies[0].logo).toBe(`/api/logo?u=${encodeURIComponent(fake.url + '/api/vod/vodlogos/1/cache/?v=a')}`)

    const search = (await (await jfetch('/api/vod/movies?q=beta')).json()) as { movies: Array<{ name: string }> }
    expect(search.movies.map((m) => m.name)).toStrictEqual(['Beta Movie'])
  })

  it('hands out play info and 404s unknown movies', async () => {
    const play = (await (await jfetch('/api/vod/play/aaaaaaaa-0000-4000-8000-000000000003')).json()) as { relay: string; name: string }
    expect(play.name).toBe('Gamma Movie')
    expect(play.relay).toBe('/api/relay/vod/aaaaaaaa-0000-4000-8000-000000000003')

    const missing = await jfetch('/api/vod/play/00000000-0000-4000-8000-000000000000')
    expect(missing.status).toBe(404)
  })

  it('refuses VOD playback without an account and pipes bytes with one', { timeout: 20_000 }, async () => {
    // No account in this app instance → the relay says exactly what is missing.
    const noAccount = await jfetch('/api/relay/vod/aaaaaaaa-0000-4000-8000-000000000001')
    expect(noAccount.status).toBe(400)
    expect(((await noAccount.json()) as { error: string }).error).toMatch(/No Dispatcharr account configured/)

    // With an account (admin-configured), the relay follows the fake's token → 301 →
    // session chain and streams real bytes.
    const admin = await seedAndLogin(db, running.url, 'admin9', 'adminpass9', true)
    await fetch(`${running.url}/api/settings/account`, {
      method: 'PUT',
      headers: { cookie: admin, 'content-type': 'application/json' },
      body: JSON.stringify(ACCOUNT)
    })
    const stream = await jfetch('/api/relay/vod/aaaaaaaa-0000-4000-8000-000000000001')
    expect(stream.status).toBe(200)
    const reader = stream.body!.getReader()
    const { value } = await reader.read()
    expect(value![0]).toBe(0x47) // MPEG-TS sync bytes through the whole chain
    await reader.cancel()
  })

  it('404s the VOD relay for a uuid that is not a synced movie', async () => {
    const admin = await seedAndLogin(db, running.url, 'admin10', 'adminpass10', true)
    await fetch(`${running.url}/api/settings/account`, {
      method: 'PUT',
      headers: { cookie: admin, 'content-type': 'application/json' },
      body: JSON.stringify(ACCOUNT)
    })
    const res = await jfetch('/api/relay/vod/bbbbbbbb-0000-4000-8000-000000000009')
    expect(res.status).toBe(404)
  })
})
