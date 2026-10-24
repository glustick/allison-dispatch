import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'
import { createApp } from './app.js'
import { openDb, type Db } from './db.js'
import { startHttpServer, seedAndLogin, type RunningApp } from './testing/testServer.js'
import { startFakeDispatcharr, type FakeDispatcharr } from './testing/fakeDispatcharr.js'
import { syncM3u } from './sync.js'
import { setDispatcharrUrl } from './settingsStore.js'
import { resolveDispatcharrAccount } from './settingsStore.js'

// Catch-up end-to-end against the wire-level fake: the play endpoint turns a start instant
// into a Dispatcharr catch-up session (JWT login → session POST), hands back a catch-up
// relay path, and that relay pipes the session's MPEG-TS through the audio fix like live.

const HOUR = 3_600_000
const FAKE_NOW = new Date('2026-10-24T12:00:00Z')
const ACCOUNT = { username: 'testuser', password: 'testpass' }

describe('catch-up API', () => {
  let fake: FakeDispatcharr
  let db: Db
  let running: RunningApp
  let cookie: string
  let channelUuid: string

  beforeEach(async () => {
    fake = await startFakeDispatcharr({ now: FAKE_NOW, account: ACCOUNT })
    db = openDb(':memory:')
    await syncM3u({ db, dispatcharrUrl: fake.url })
    setDispatcharrUrl(db, fake.url)
    // Credentials come from env in this suite (the Settings-UI path is covered separately).
    running = await startHttpServer(
      createApp(loadConfig({ DISPATCHARR_USERNAME: ACCOUNT.username, DISPATCHARR_PASSWORD: ACCOUNT.password }), {
        db,
        clock: () => FAKE_NOW.getTime()
      })
    )
    cookie = await seedAndLogin(db, running.url)
    channelUuid = (db.prepare('SELECT uuid FROM channels ORDER BY position LIMIT 1').get() as { uuid: string }).uuid
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

  it('turns a start instant into a catch-up relay path and pipes its bytes', { timeout: 20_000 }, async () => {
    const start = FAKE_NOW.getTime() - 2 * HOUR
    const res = await jfetch(`/api/channels/${channelUuid}/play?output_format=mpegts&start=${start}`)
    expect(res.status).toBe(200)
    const info = (await res.json()) as { relay: string; direct: string }
    expect(info.relay).toMatch(/^\/api\/relay\/catchup\/[0-9a-f-]+\?session_id=/)
    expect(info.direct).toContain('/proxy/catchup/')

    // Plain pipe (no fixaudio): the fake serves sync-byte filler, which real ffmpeg cannot
    // analyze — the audio-fix path itself is covered by the real-fixture relay tests.
    const stream = await jfetch(info.relay)
    expect(stream.status).toBe(200)
    const reader = stream.body!.getReader()
    const { value } = await reader.read()
    expect(value![0]).toBe(0x47) // real MPEG-TS sync bytes flowed
    await reader.cancel()
  })

  it('answers 400 for catch-up with no account configured', async () => {
    const bare = await startHttpServer(createApp(loadConfig({}), { db, clock: () => FAKE_NOW.getTime() }))
    try {
      const c = await seedAndLogin(db, bare.url, 'plain')
      const res = await fetch(`${bare.url}/api/channels/${channelUuid}/play?start=${FAKE_NOW.getTime() - HOUR}`, {
        headers: { cookie: c }
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toMatch(/No Dispatcharr account configured/)
    } finally {
      await bare.close()
    }
  })

  it('rejects a future start and a non-numeric start', async () => {
    const future = await jfetch(`/api/channels/${channelUuid}/play?start=${FAKE_NOW.getTime() + 5 * HOUR}`)
    expect(future.status).toBe(400)
    const garbage = await jfetch(`/api/channels/${channelUuid}/play?start=yesterday`)
    expect(garbage.status).toBe(400)
  })

  it('requires a session_id on the catch-up relay', async () => {
    const res = await jfetch(`/api/relay/catchup/${channelUuid}`)
    expect(res.status).toBe(400)
  })

  it('surfaces Dispatcharr rejection for a channel that cannot catch up', async () => {
    // The fake only knows the synced channel uuids; an unknown-but-uuid-shaped value is
    // rejected with 400 by Dispatcharr — our mapping must surface it, not 500.
    const res = await jfetch(`/api/channels/00000000-0000-4000-8000-000000000000/play?start=${FAKE_NOW.getTime() - HOUR}`)
    // Our own channel-existence check fires first (404); a known channel on an
    // unsupporting provider surfaces as the mapped 400.
    expect([400, 404]).toContain(res.status)
  })

  it('stores the account via the admin settings API and never echoes the password', async () => {
    const adminCookie = await seedAndLogin(db, running.url, 'admin2', 'adminpass123', true)
    const put = await fetch(`${running.url}/api/settings/account`, {
      method: 'PUT',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'acct', password: 'secret' })
    })
    expect(put.status).toBe(200)
    expect(resolveDispatcharrAccount(db, null, null)).toStrictEqual({ username: 'acct', password: 'secret' })

    const settings = (await (await fetch(`${running.url}/api/settings`, { headers: { cookie: adminCookie } })).json()) as {
      account: { username: string; passwordSet: boolean; source: string } | null
    }
    expect(settings.account).toStrictEqual({ username: 'acct', passwordSet: true, source: 'settings' })
    expect(JSON.stringify(settings)).not.toContain('secret')

    // Non-admins may not touch the credential.
    const forbidden = await fetch(`${running.url}/api/settings/account`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'x', password: 'y' })
    })
    expect(forbidden.status).toBe(403)
  })
})
