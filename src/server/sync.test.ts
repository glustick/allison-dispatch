import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Server } from 'http'
import { createServer } from 'http'
import { AddressInfo } from 'net'
import { openDb, type Db } from './db.js'
import { startFakeDispatcharr, type FakeDispatcharr } from './testing/fakeDispatcharr.js'
import { DEFAULT_FAKE_CHANNELS } from './testing/fixtures.js'
import { syncM3u, syncEpg, runSync, SyncFailure } from './sync.js'
import { getSyncStates, listChannels, nowNext } from './queries.js'

const FAKE_NOW = new Date('2026-10-04T12:00:00Z')

describe('sync against the wire-level fake', () => {
  let fake: FakeDispatcharr
  let db: Db

  beforeEach(async () => {
    fake = await startFakeDispatcharr({ now: FAKE_NOW })
    db = openDb(':memory:')
  })

  afterEach(async () => {
    await fake.close()
  })

  it('syncM3u writes the full lineup with rewritten logo origins', async () => {
    const summary = await syncM3u({ db, dispatcharrUrl: fake.url })
    expect(summary).toEqual({ channels: 6, skipped: 0 })
    const channels = listChannels(db)
    expect(channels).toHaveLength(6)
    expect(channels[0]).toMatchObject({
      uuid: DEFAULT_FAKE_CHANNELS[0].uuid,
      name: 'ACME News HD',
      channel_number: 101,
      tvg_id: '101',
      group_name: 'News'
    })
    // The fake generated the M3U against its own request host; the stored logo must carry
    // the configured base (here they coincide, but the rewrite is asserted by m3u.test.ts —
    // here we assert the stored value is at least a same-origin absolute URL).
    expect(channels[0].logo_url).toBe(`${fake.origin}/api/channels/logos/1/cache/`)
  })

  it('replace-all semantics: channels that vanish from the playlist vanish from the DB', async () => {
    await syncM3u({ db, dispatcharrUrl: fake.url })
    const small = await startFakeDispatcharr({
      now: FAKE_NOW,
      channels: DEFAULT_FAKE_CHANNELS.slice(0, 2)
    })
    try {
      await syncM3u({ db, dispatcharrUrl: small.url })
      expect(listChannels(db).map((c) => c.uuid)).toEqual(DEFAULT_FAKE_CHANNELS.slice(0, 2).map((c) => c.uuid))
    } finally {
      await small.close()
    }
  })

  it('syncEpg streams the guide into programmes reachable via now/next queries', async () => {
    await syncM3u({ db, dispatcharrUrl: fake.url })
    const summary = await syncEpg({ db, dispatcharrUrl: fake.url, now: () => FAKE_NOW.getTime() })
    expect(summary?.programmes).toBe(24) // 6 channels × 4 slots
    expect(summary?.channels).toBe(6)

    // Ten minutes into the fake's broadcast day → inside slot 1 ([-1.5h, +0.5h]).
    const clockMs = FAKE_NOW.getTime() + 10 * 60 * 1000
    const result = nowNext(db, DEFAULT_FAKE_CHANNELS[0].uuid, clockMs)
    expect(result).not.toBeNull()
    expect(result?.now?.title).toBe('ACME News HD — Slot 1')
    expect(result?.now?.start_utc).toBeLessThanOrEqual(clockMs)
    expect(result?.now?.stop_utc).toBeGreaterThan(clockMs)
    expect(result?.next?.title).toBe('ACME News HD — Slot 2')
  })

  it('EPG retention drops programmes that stopped more than 6h before the sync clock', async () => {
    await syncM3u({ db, dispatcharrUrl: fake.url })
    // 11 hours after the fixture clock: every slot has been over for ≥ 6.5h.
    await syncEpg({ db, dispatcharrUrl: fake.url, now: () => FAKE_NOW.getTime() + 11 * 60 * 60 * 1000 })
    const count = db.prepare('SELECT COUNT(*) AS n FROM epg_programs').get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('runSync fills sync_state bookkeeping for both kinds', async () => {
    await syncM3u({ db, dispatcharrUrl: fake.url })
    await syncEpg({ db, dispatcharrUrl: fake.url, now: () => FAKE_NOW.getTime() })
    const states = getSyncStates(db)
    expect(states.m3u).toMatchObject({ status: 'ok', item_count: 6, error: null })
    expect(states.epg).toMatchObject({ status: 'ok', item_count: 24, error: null })
    expect(states.m3u?.last_run_utc).toBeGreaterThan(0)
  })
})

describe('sync failure paths', () => {
  let db: Db

  beforeEach(() => {
    db = openDb(':memory:')
  })

  it('a dead Dispatcharr records an error in sync_state and throws SyncFailure', async () => {
    await expect(syncM3u({ db, dispatcharrUrl: 'http://127.0.0.1:1' })).rejects.toBeInstanceOf(SyncFailure)
    const states = getSyncStates(db)
    expect(states.m3u?.status).toBe('error')
    expect(states.m3u?.error).toMatch(/fetch failed/)
  })

  it('an HTTP error status is reported with the ACL hint', async () => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(403)
      res.end('forbidden')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      await expect(syncM3u({ db, dispatcharrUrl: url })).rejects.toThrow(/403.*ACL/s)
      expect(getSyncStates(db).m3u?.error).toMatch(/M3U_EPG network ACL/)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('runSync runs m3u before epg and surfaces both summaries', async () => {
    const fake = await startFakeDispatcharr({ now: FAKE_NOW })
    try {
      const summary = await runSync({ db, dispatcharrUrl: fake.url, now: () => FAKE_NOW.getTime() })
      expect(summary.m3u).toEqual({ channels: 6, skipped: 0 })
      expect(summary.epg).toEqual({ programmes: 24, channels: 6 })
    } finally {
      await fake.close()
    }
  })
})
