import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'
import { createApp } from './app.js'
import { openDb, type Db } from './db.js'
import { startHttpServer, seedAndLogin, type RunningApp } from './testing/testServer.js'
import { startFakeDispatcharr, type FakeDispatcharr } from './testing/fakeDispatcharr.js'
import { DEFAULT_FAKE_CHANNELS } from './testing/fixtures.js'
import { syncM3u } from './sync.js'

// Programme reminders: PUT from the guide's detail panel, GET polled by the viewer (due
// ones become toasts), DELETE on dismiss or cancel. Identity is (tvg_id, start_utc) — the
// EPG's own key — and a reminder must reference a real channel's tvg_id to be accepted.

const HOUR = 3_600_000
const FAKE_NOW = new Date('2026-10-04T12:00:00Z')

describe('reminders API', () => {
  let fake: FakeDispatcharr
  let db: Db
  let running: RunningApp
  let cookie: string
  let channel: { uuid: string; tvg_id: string | null }

  beforeEach(async () => {
    fake = await startFakeDispatcharr({ now: FAKE_NOW })
    db = openDb(':memory:')
    await syncM3u({ db, dispatcharrUrl: fake.url })
    running = await startHttpServer(
      createApp(loadConfig({}), { db, clock: () => FAKE_NOW.getTime() })
    )
    cookie = await seedAndLogin(db, running.url)
    channel = db.prepare('SELECT uuid, tvg_id FROM channels ORDER BY position LIMIT 1').get() as {
      uuid: string
      tvg_id: string | null
    }
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

  const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    channel_uuid: channel.uuid,
    tvg_id: channel.tvg_id,
    title: 'Big Match',
    start_utc: FAKE_NOW.getTime() + 2 * HOUR,
    stop_utc: FAKE_NOW.getTime() + 4 * HOUR,
    ...overrides
  })

  it('creates, lists and deletes a reminder', async () => {
    const put = await jfetch('/api/reminders', { method: 'PUT', body: JSON.stringify(body()) })
    expect(put.status).toBe(201)

    const list = (await (await jfetch('/api/reminders')).json()) as { reminders: Array<{ title: string; start_utc: number }> }
    expect(list.reminders).toHaveLength(1)
    expect(list.reminders[0].title).toBe('Big Match')

    const del = await jfetch(`/api/reminders/${encodeURIComponent(channel.tvg_id!)}/${FAKE_NOW.getTime() + 2 * HOUR}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    const after = (await (await jfetch('/api/reminders')).json()) as { reminders: unknown[] }
    expect(after.reminders).toHaveLength(0)
  })

  it('is idempotent per programme — re-adding does not duplicate', async () => {
    await jfetch('/api/reminders', { method: 'PUT', body: JSON.stringify(body()) })
    await jfetch('/api/reminders', { method: 'PUT', body: JSON.stringify(body()) })
    const list = (await (await jfetch('/api/reminders')).json()) as { reminders: unknown[] }
    expect(list.reminders).toHaveLength(1)
  })

  it('refuses reminders whose tvg_id does not belong to the channel', async () => {
    const res = await jfetch('/api/reminders', {
      method: 'PUT',
      body: JSON.stringify(body({ tvg_id: 'some-other-channel' }))
    })
    expect(res.status).toBe(404)
  })

  it('refuses malformed bodies', async () => {
    expect((await jfetch('/api/reminders', { method: 'PUT', body: JSON.stringify({ title: 'x' }) })).status).toBe(400)
    expect(
      (await jfetch('/api/reminders', {
        method: 'PUT',
        body: JSON.stringify(body({ stop_utc: FAKE_NOW.getTime() })) // stop <= start
      })).status
    ).toBe(400)
  })

  it('stops serving reminders whose programme has ended', async () => {
    await jfetch('/api/reminders', { method: 'PUT', body: JSON.stringify(body()) })
    // The fake's channel carries programmes every 2h from now−4h (fixture shape); this
    // reminder is in the future — list with a clock far ahead sees nothing.
    const later = startHttpServer(
      createApp(loadConfig({}), { db, clock: () => FAKE_NOW.getTime() + 10 * 24 * HOUR })
    ).then(async (r2) => {
      const c2 = await seedAndLogin(db, r2.url, 'tester2')
      const res = await fetch(`${r2.url}/api/reminders`, { headers: { cookie: c2 } })
      const list = (await res.json()) as { reminders: unknown[] }
      expect(list.reminders).toHaveLength(0)
      await r2.close()
    })
    await later
    void DEFAULT_FAKE_CHANNELS // referenced to keep the import meaningful if fixtures change
  })
})
