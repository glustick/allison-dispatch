import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'
import { createApp } from './app.js'
import { openDb, type Db } from './db.js'
import { startHttpServer, seedAndLogin, type RunningApp } from './testing/testServer.js'
import { startFakeDispatcharr, type FakeDispatcharr } from './testing/fakeDispatcharr.js'
import { DEFAULT_FAKE_CHANNELS } from './testing/fixtures.js'
import { syncM3u } from './sync.js'
import { addFavorite, listFavorites, listRecents, recordWatch, removeFavorite } from './userData.js'
import { ensureSeedUser } from './auth.js'
import { setDispatcharrUrl } from './settingsStore.js'

const FAKE_NOW = new Date('2026-10-04T12:00:00Z')

describe('userData store (pure)', () => {
  let db: Db
  beforeEach(() => {
    db = openDb(':memory:')
    // The lists JOIN against channels — seed the lineup the fixtures reference.
    const insert = db.prepare(
      'INSERT INTO channels (uuid, name, channel_number, tvg_id, logo_url, group_name, position, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)'
    )
    DEFAULT_FAKE_CHANNELS.forEach((ch, i) => {
      insert.run(ch.uuid, ch.name, ch.channelNumber, String(ch.id), ch.group, i, new Date().toISOString())
    })
  })

  it('favorites add/list/remove round-trip and ignore duplicates', () => {
    addFavorite(db, 1, DEFAULT_FAKE_CHANNELS[0].uuid)
    addFavorite(db, 1, DEFAULT_FAKE_CHANNELS[0].uuid) // idempotent
    addFavorite(db, 1, DEFAULT_FAKE_CHANNELS[2].uuid)
    expect(listFavorites(db, 1).map((c) => c.uuid)).toEqual([
      DEFAULT_FAKE_CHANNELS[0].uuid,
      DEFAULT_FAKE_CHANNELS[2].uuid
    ])
    removeFavorite(db, 1, DEFAULT_FAKE_CHANNELS[0].uuid)
    expect(listFavorites(db, 1).map((c) => c.uuid)).toEqual([DEFAULT_FAKE_CHANNELS[2].uuid])
    // Favorites are per-user.
    expect(listFavorites(db, 2)).toEqual([])
  })

  it('watch history upserts to one row per channel, newest first', () => {
    recordWatch(db, 1, DEFAULT_FAKE_CHANNELS[3].uuid, 1_000)
    recordWatch(db, 1, DEFAULT_FAKE_CHANNELS[0].uuid, 2_000)
    recordWatch(db, 1, DEFAULT_FAKE_CHANNELS[3].uuid, 3_000) // re-watch bumps it to the top
    const recents = listRecents(db, 1)
    expect(recents.map((c) => c.uuid)).toEqual([DEFAULT_FAKE_CHANNELS[3].uuid, DEFAULT_FAKE_CHANNELS[0].uuid])
    expect(recents[0].watched_at_utc).toBe(3_000)
    expect(listRecents(db, 2)).toEqual([])
  })

  it('lists respect the limit', () => {
    // The limit only binds with more distinct channels than the limit — seed 20 extras.
    const insert = db.prepare(
      'INSERT INTO channels (uuid, name, channel_number, tvg_id, logo_url, group_name, position, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)'
    )
    for (let i = 0; i < 20; i++) {
      const uuid = `9a1e0d6a-ffff-4a01-9a2b-${String(i).padStart(12, '0')}`
      insert.run(uuid, `Filler ${i}`, 900 + i, String(900 + i), 'Filler', i, new Date().toISOString())
      recordWatch(db, 1, uuid, i)
    }
    expect(listRecents(db, 1)).toHaveLength(12)
    // Newest first, even with the limit applied.
    const recents = listRecents(db, 1)
    expect(recents[0].name).toBe('Filler 19')
    expect(recents[11].name).toBe('Filler 8')
  })
})

// HTTP level: the relay records history when a stream starts; favorites/recents endpoints
// are per-session-user.
describe('favorites + history over HTTP', () => {
  let fake: FakeDispatcharr
  let db: Db
  let running: RunningApp
  let cookieA: string
  let cookieB: string

  beforeEach(async () => {
    fake = await startFakeDispatcharr({ now: FAKE_NOW, streamLifetimeMs: 400 })
    db = openDb(':memory:')
    await syncM3u({ db, dispatcharrUrl: fake.url })
    setDispatcharrUrl(db, fake.url)
    ensureSeedUser(db, 'alice', 'alice123')
    running = await startHttpServer(createApp(loadConfig({}), { db, clock: () => FAKE_NOW.getTime() }))
    cookieA = await seedAndLogin(db, running.url, 'alice', 'alice123')
    cookieB = await seedAndLogin(db, running.url, 'bob', 'bob12345')
  })

  afterEach(async () => {
    await running.close()
    await fake.close()
  })

  function jfetch(path: string, init: RequestInit = {}, whichCookie = cookieA): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('cookie', whichCookie)
    return fetch(`${running.url}${path}`, { ...init, headers })
  }

  it('favorites are per-user and unknown channels are rejected', async () => {
    const uuid = DEFAULT_FAKE_CHANNELS[0].uuid
    expect((await jfetch(`/api/favorites/${uuid}`, { method: 'PUT' })).status).toBe(200)
    const mine = (await (await jfetch('/api/favorites')).json()) as { favorites: Array<{ uuid: string }> }
    expect(mine.favorites.map((c) => c.uuid)).toEqual([uuid])

    const theirs = (await (await jfetch('/api/favorites', {}, cookieB)).json()) as { favorites: unknown[] }
    expect(theirs.favorites).toEqual([])

    const unknown = await jfetch('/api/favorites/00000000-0000-4000-8000-000000000000', { method: 'PUT' })
    expect(unknown.status).toBe(404)

    await jfetch(`/api/favorites/${uuid}`, { method: 'DELETE' })
    const after = (await (await jfetch('/api/favorites')).json()) as { favorites: unknown[] }
    expect(after.favorites).toEqual([])
  })

  it('starting a relay stream records history; recents order = watch order', async () => {
    const c0 = DEFAULT_FAKE_CHANNELS[0].uuid
    const c2 = DEFAULT_FAKE_CHANNELS[2].uuid
    // Watch c0, then c2 (the fake stream ends itself after 400ms so the fetch completes).
    await jfetch(`/api/relay/stream/${c0}`)
    await new Promise((r) => setTimeout(r, 100))
    await jfetch(`/api/relay/stream/${c2}`)
    await new Promise((r) => setTimeout(r, 100))

    const recents = (await (await jfetch('/api/history/recents')).json()) as {
      recents: Array<{ uuid: string; watched_at_utc: number }>
    }
    expect(recents.recents.map((c) => c.uuid)).toEqual([c2, c0])

    // The other user watched nothing.
    const theirs = (await (await jfetch('/api/history/recents', {}, cookieB)).json()) as { recents: unknown[] }
    expect(theirs.recents).toEqual([])
  })

  it('resume: the first recent is the last-watched channel with full channel data', async () => {
    recordWatch(db, 1, DEFAULT_FAKE_CHANNELS[4].uuid, FAKE_NOW.getTime()) // alice is user 1
    const recents = (await (await jfetch('/api/history/recents')).json()) as {
      recents: Array<{ uuid: string; name: string; channel_number: number | null }>
    }
    expect(recents.recents[0]).toMatchObject({
      uuid: DEFAULT_FAKE_CHANNELS[4].uuid,
      name: DEFAULT_FAKE_CHANNELS[4].name,
      channel_number: DEFAULT_FAKE_CHANNELS[4].channelNumber
    })
  })
})
