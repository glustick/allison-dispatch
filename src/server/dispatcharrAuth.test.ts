import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'http'
import { AddressInfo } from 'net'
import { createDispatcharrAuth } from './dispatcharrAuth.js'

// The Dispatcharr JWT client, against a hand-rolled token server (full control over what
// succeeds and when): caching must spare the throttled login endpoint, refresh must be
// preferred over re-login, and a bad password must surface as a clear error with a cooldown.

function fakeJwt(lifetimeSec: number, nowSec: number): string {
  const payload = Buffer.from(JSON.stringify({ token_type: 'access', exp: nowSec + lifetimeSec })).toString('base64url')
  return `h.${payload}.s`
}

describe('dispatcharrAuth', () => {
  let server: Server
  let baseUrl: string
  let logins: number
  let refreshes: number
  let rejectLogins: boolean
  let rejectRefresh: boolean
  let nowSec: number

  beforeEach(async () => {
    logins = 0
    refreshes = 0
    rejectLogins = false
    rejectRefresh = false
    nowSec = 1_700_000_000
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c: Buffer) => { raw += c.toString() })
      req.on('end', () => {
        if (req.url === '/api/accounts/token/') {
          logins++
          if (rejectLogins) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ detail: 'No active account found with the given credentials' }))
            return
          }
          const body = JSON.parse(raw) as { username?: string; password?: string }
          if (body.username !== 'u' || body.password !== 'p') {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ detail: 'No active account found with the given credentials' }))
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ access: fakeJwt(1800, nowSec), refresh: 'refresh-1' }))
          return
        }
        if (req.url === '/api/accounts/token/refresh/') {
          refreshes++
          if (rejectRefresh) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ detail: 'Token is invalid or expired' }))
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ access: fakeJwt(1800, nowSec) }))
          return
        }
        res.writeHead(404)
        res.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  function makeAuth(): ReturnType<typeof createDispatcharrAuth> {
    return createDispatcharrAuth({ baseUrl, username: 'u', password: 'p', now: () => nowSec * 1000 })
  }

  it('logs in once and serves subsequent tokens from the cache', async () => {
    const auth = makeAuth()
    const a = await auth.getAccessToken()
    const b = await auth.getAccessToken()
    expect(a).toBe(b)
    expect(logins).toBe(1)
    expect(refreshes).toBe(0)
  })

  it('refreshes — and does not re-login — once the access token nears expiry', async () => {
    const auth = makeAuth()
    await auth.getAccessToken()
    nowSec += 1800 - 30 // past the 60s expiry slack
    const again = await auth.getAccessToken()
    expect(again).toMatch(/^h\./)
    expect(refreshes).toBe(1)
    expect(logins).toBe(1)
  })

  it('falls back to a full login when the refresh token is refused', async () => {
    const auth = makeAuth()
    await auth.getAccessToken()
    nowSec += 1800 - 30
    rejectRefresh = true
    const again = await auth.getAccessToken()
    expect(again).toMatch(/^h\./)
    expect(refreshes).toBe(1)
    expect(logins).toBe(2)
  })

  it('surfaces bad credentials and cools down before the next login attempt', async () => {
    const auth = createDispatcharrAuth({ baseUrl, username: 'u', password: 'wrong', now: () => nowSec * 1000 })
    await expect(auth.getAccessToken()).rejects.toThrow(/rejected the account credentials/)
    // The token endpoint is throttled (3/min): an immediate retry must not even reach it.
    await expect(auth.getAccessToken()).rejects.toThrow(/retry in \d+s/)
    expect(logins).toBe(1)
    nowSec += 30 // past the cooldown
    await expect(auth.getAccessToken()).rejects.toThrow(/rejected the account credentials/)
    expect(logins).toBe(2)
  })
})
