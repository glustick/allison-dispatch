import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'
import { createApp } from './app.js'
import { openDb, type Db } from './db.js'
import { startHttpServer, type RunningApp } from './testing/testServer.js'
import { startFakeDispatcharr, type FakeDispatcharr } from './testing/fakeDispatcharr.js'
import { syncM3u } from './sync.js'
import {
  ensureSeedUser,
  hashPassword,
  verifyPassword,
  issueSessionToken,
  verifySessionToken,
  resetLoginLimiter
} from './auth.js'
import { setDispatcharrUrl } from './settingsStore.js'

const FAKE_NOW = new Date('2026-10-04T12:00:00Z')

function cookieFrom(res: Response): string {
  const raw = res.headers.get('set-cookie')
  return raw !== null ? raw.split(';')[0] : ''
}

describe('password hashing and session tokens (pure)', () => {
  it('hashes and verifies passwords with per-user salts', () => {
    const a = hashPassword('hunter22')
    const b = hashPassword('hunter22')
    expect(a).not.toBe(b) // different salts
    expect(verifyPassword('hunter22', a)).toBe(true)
    expect(verifyPassword('wrong', a)).toBe(false)
    expect(verifyPassword('hunter22', 'garbage')).toBe(false)
  })

  it('round-trips session tokens and rejects tampering/expiry', () => {
    const secret = '0123456789abcdef0123456789abcdef'
    const token = issueSessionToken(secret, 7, 1_000_000)
    expect(verifySessionToken(secret, token, 1_000_001)).toBe(7)
    expect(verifySessionToken('other secret same length xxx', token, 1_000_001)).toBeNull()
    expect(verifySessionToken(secret, `${token}x`, 1_000_001)).toBeNull()
    // Issued at t=0 with the 7-day TTL; verifying AFTER that window must fail.
    const expired = issueSessionToken(secret, 7, 0)
    expect(verifySessionToken(secret, expired, 8 * 24 * 60 * 60 * 1000)).toBeNull()
    expect(verifySessionToken(secret, undefined, 0)).toBeNull()
  })

  it('ensureSeedUser only fires on an empty table', () => {
    const db = openDb(':memory:')
    expect(ensureSeedUser(db, 'chris', 'hunter22')).toEqual({ seeded: true })
    expect(ensureSeedUser(db, 'someone', 'else123')).toEqual({ seeded: false })
    const row = db.prepare('SELECT username, is_admin FROM users').get() as { username: string; is_admin: number }
    expect(row).toEqual({ username: 'chris', is_admin: 1 })
  })
})

describe('auth over HTTP', () => {
  let fake: FakeDispatcharr
  let db: Db
  let running: RunningApp

  beforeEach(async () => {
    resetLoginLimiter()
    fake = await startFakeDispatcharr({ now: FAKE_NOW })
    db = openDb(':memory:')
    ensureSeedUser(db, 'chris', 'hunter22')
    db.prepare("INSERT INTO users (username, password_hash, is_admin) VALUES ('viewer', ?, 0)").run(hashPassword('viewer123'))
    await syncM3u({ db, dispatcharrUrl: fake.url })
    setDispatcharrUrl(db, fake.url)
    running = await startHttpServer(createApp(loadConfig({}), { db, clock: () => FAKE_NOW.getTime() }))
  })

  afterEach(async () => {
    await running.close()
    await fake.close()
  })

  async function login(username: string, password: string): Promise<Response> {
    return fetch(`${running.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password })
    })
  }

  it('health and version stay public for deploy checks', async () => {
    expect((await fetch(`${running.url}/api/health`)).status).toBe(200)
    expect((await fetch(`${running.url}/api/version`)).status).toBe(200)
  })

  it('protected APIs answer 401 without a session', async () => {
    for (const path of ['/api/channels', '/api/auth/me', '/api/settings', `/api/relay/stream/00000000-0000-4000-8000-000000000000`]) {
      const res = await fetch(`${running.url}${path}`)
      expect(res.status, path).toBe(401)
    }
  })

  it('login sets a cookie that unlocks the APIs', async () => {
    const bad = await login('chris', 'wrong-password')
    expect(bad.status).toBe(401)

    const res = await login('chris', 'hunter22')
    expect(res.status).toBe(200)
    const cookie = cookieFrom(res)
    expect(cookie).toMatch(/^ad_session=/)

    const me = await fetch(`${running.url}/api/auth/me`, { headers: { cookie } })
    expect(await me.json()).toEqual({ user: { id: 1, username: 'chris', isAdmin: true } })

    const channels = await fetch(`${running.url}/api/channels`, { headers: { cookie } })
    expect(channels.status).toBe(200)
    expect(((await channels.json()) as { count: number }).count).toBe(6)

    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
  })

  it('the stream relay requires the session cookie (no anonymous bandwidth)', async () => {
    const loginRes = await login('viewer', 'viewer123')
    const cookie = cookieFrom(loginRes)
    const no = await fetch(`${running.url}/api/relay/stream/5a1e0d6a-1111-4a01-9a2b-000000000001`)
    expect(no.status).toBe(401)
    expect(fake.streams.opened).toBe(0)

    const yes = await fetch(`${running.url}/api/relay/stream/5a1e0d6a-1111-4a01-9a2b-000000000001`, {
      headers: { cookie },
      signal: AbortSignal.timeout(1_500)
    })
    expect(yes.status).toBe(200)
    const reader = yes.body!.getReader()
    const { value } = await reader.read()
    expect(value).toBeDefined()
    await reader.cancel()
  })

  it('repeated failures from one IP get throttled, success clears the counter', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await login('chris', 'nope-nope')
      expect(res.status).toBe(401)
    }
    const blocked = await login('chris', 'hunter22')
    expect(blocked.status).toBe(429)
    // A different IP is unaffected (tests run on loopback, so simulate via x-forwarded-for).
    const other = await fetch(`${running.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.9.9.9' },
      body: JSON.stringify({ username: 'chris', password: 'hunter22' })
    })
    expect(other.status).toBe(200)
  })

  it('logout clears the session', async () => {
    const cookie = cookieFrom(await login('chris', 'hunter22'))
    const out = await fetch(`${running.url}/api/auth/logout`, { method: 'POST', headers: { cookie } })
    expect(out.status).toBe(200)
    expect(out.headers.get('set-cookie')).toMatch(/ad_session=;/)
    // The OLD cookie still technically validates (stateless) — the client discards it.
  })
})

describe('user management over HTTP', () => {
  let db: Db
  let running: RunningApp
  let adminCookie: string
  let viewerCookie: string

  beforeEach(async () => {
    resetLoginLimiter()
    db = openDb(':memory:')
    ensureSeedUser(db, 'chris', 'hunter22')
    db.prepare("INSERT INTO users (username, password_hash, is_admin) VALUES ('viewer', ?, 0)").run(hashPassword('viewer123'))
    running = await startHttpServer(createApp(loadConfig({}), { db }))
    const admin = await fetch(`${running.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'chris', password: 'hunter22' })
    })
    adminCookie = cookieFrom(admin)
    const viewer = await fetch(`${running.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'viewer', password: 'viewer123' })
    })
    viewerCookie = cookieFrom(viewer)
  })

  afterEach(async () => {
    await running.close()
  })

  it('non-admins are locked out of user management', async () => {
    for (const [method, path] of [['GET', '/api/users'], ['POST', '/api/users']] as const) {
      const res = await fetch(`${running.url}${path}`, { method, headers: { cookie: viewerCookie, 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify({ username: 'x', password: 'y' }) : undefined })
      expect(res.status, `${method} ${path}`).toBe(403)
    }
  })

  it('admin creates a user, new user can sign in and use the app', async () => {
    const create = await fetch(`${running.url}/api/users`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'family', password: 'family123', isAdmin: false })
    })
    expect(create.status).toBe(201)

    const login = await fetch(`${running.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'family', password: 'family123' })
    })
    expect(login.status).toBe(200)
    const channels = await fetch(`${running.url}/api/channels`, { headers: { cookie: cookieFrom(login) } })
    expect(channels.status).toBe(200)

    const list = await fetch(`${running.url}/api/users`, { headers: { cookie: adminCookie } })
    const body = (await list.json()) as { users: Array<{ username: string }> }
    expect(body.users.map((u) => u.username)).toEqual(['chris', 'viewer', 'family'])
  })

  it('duplicate usernames, weak passwords and bad names are rejected', async () => {
    const dup = await fetch(`${running.url}/api/users`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'viewer', password: 'viewer999' })
    })
    expect(dup.status).toBe(409)
    const weak = await fetch(`${running.url}/api/users`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'okname', password: '123' })
    })
    expect(weak.status).toBe(400)
    const badname = await fetch(`${running.url}/api/users`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'not ok!', password: '123456' })
    })
    expect(badname.status).toBe(400)
  })

  it('admin resets a password; the old one stops working', async () => {
    const viewerId = ((await (await fetch(`${running.url}/api/users`, { headers: { cookie: adminCookie } })).json()) as {
      users: Array<{ id: number; username: string }>
    }).users.find((u) => u.username === 'viewer')?.id
    const reset = await fetch(`${running.url}/api/users/${viewerId}/password`, {
      method: 'PUT',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'brand-new-9' })
    })
    expect(reset.status).toBe(200)
    const oldLogin = await fetch(`${running.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'viewer', password: 'viewer123' })
    })
    expect(oldLogin.status).toBe(401)
    const newLogin = await fetch(`${running.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'viewer', password: 'brand-new-9' })
    })
    expect(newLogin.status).toBe(200)
  })

  it('own-password change requires the current password; deletion guards hold', async () => {
    const change = await fetch(`${running.url}/api/auth/password`, {
      method: 'PUT',
      headers: { cookie: viewerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'wrong', newPassword: 'newpass99' })
    })
    expect(change.status).toBe(401)
    const changeOk = await fetch(`${running.url}/api/auth/password`, {
      method: 'PUT',
      headers: { cookie: viewerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'viewer123', newPassword: 'newpass99' })
    })
    expect(changeOk.status).toBe(200)

    const adminId = ((await (await fetch(`${running.url}/api/users`, { headers: { cookie: adminCookie } })).json()) as {
      users: Array<{ id: number; username: string }>
    }).users.find((u) => u.username === 'chris')?.id
    const selfDelete = await fetch(`${running.url}/api/users/${adminId}`, { method: 'DELETE', headers: { cookie: adminCookie } })
    expect(selfDelete.status).toBe(400) // cannot delete yourself

    // Make chris the only remaining admin path: delete viewer, then last-admin guard.
    const viewerId = ((await (await fetch(`${running.url}/api/users`, { headers: { cookie: adminCookie } })).json()) as {
      users: Array<{ id: number; username: string }>
    }).users.find((u) => u.username === 'viewer')?.id
    const delViewer = await fetch(`${running.url}/api/users/${viewerId}`, { method: 'DELETE', headers: { cookie: adminCookie } })
    expect(delViewer.status).toBe(200)
    const delAdmin = await fetch(`${running.url}/api/users/${adminId}`, { method: 'DELETE', headers: { cookie: adminCookie } })
    expect(delAdmin.status).toBe(400) // cannot delete the last admin
  })
})
