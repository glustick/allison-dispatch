// Dispatcharr JWT client — the credential layer catch-up rides on. The REST surface
// (probed live against v0.31.0, 2026-10-24) is Django SimpleJWT:
//   POST /api/accounts/token/          {username, password} → {access, refresh}
//   POST /api/accounts/token/refresh/  {refresh}            → {access}
// Access lives 30 min, refresh 1 day. The login endpoint is THROTTLED (3/min observed in
// Dispatcharr's own docs), so this module caches: access is reused until shortly before its
// exp, the refresh token is reused across restarts of the cache, and a full re-login only
// happens when the refresh itself fails. A short cooldown after a failed login keeps a bad
// password from burning the throttle.

export interface DispatcharrAuthDeps {
  baseUrl: string
  username: string
  password: string
  fetchImpl?: typeof fetch
  now?: () => number
  /** How long to refuse re-login attempts after one fails (login throttle is 3/min). */
  loginCooldownMs?: number
}

export interface DispatcharrAuth {
  /** A valid access token, refreshing or re-logging in as needed. */
  getAccessToken(): Promise<string>
  /** Drop all cached tokens (e.g. the credentials were changed). */
  reset(): void
}

interface JwtPayload {
  exp?: number
  token_type?: string
}

function jwtExp(token: string): number | null {
  try {
    const payloadPart = token.split('.')[1]
    if (payloadPart === undefined) return null
    const json = Buffer.from(payloadPart, 'base64url').toString('utf8')
    const payload = JSON.parse(json) as JwtPayload
    return typeof payload.exp === 'number' ? payload.exp : null
  } catch {
    return null
  }
}

export function createDispatcharrAuth(deps: DispatcharrAuthDeps): DispatcharrAuth {
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? (() => Date.now())
  const loginCooldownMs = deps.loginCooldownMs ?? 21_000

  let accessToken: string | null = null
  let accessExpSec = 0
  let refreshToken: string | null = null
  let lastLoginAttemptMs = 0

  async function postJson(path: string, body: unknown): Promise<{ status: number; data: { access?: unknown; refresh?: unknown; detail?: unknown } }> {
    const res = await fetchImpl(`${deps.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body)
    })
    let data: { access?: unknown; refresh?: unknown; detail?: unknown } = {}
    try {
      data = (await res.json()) as typeof data
    } catch {
      // Non-JSON error bodies (HTML catch-all etc.) surface as a generic failure below.
    }
    return { status: res.status, data }
  }

  async function login(): Promise<void> {
    const sinceLast = now() - lastLoginAttemptMs
    if (sinceLast < loginCooldownMs) {
      throw new Error(`Dispatcharr login was attempted recently — retry in ${Math.ceil((loginCooldownMs - sinceLast) / 1000)}s (the token endpoint is throttled)`)
    }
    lastLoginAttemptMs = now()
    const { status, data } = await postJson('/api/accounts/token/', { username: deps.username, password: deps.password })
    if (status !== 200 || typeof data.access !== 'string') {
      const detail = typeof data.detail === 'string' ? data.detail : `HTTP ${status}`
      throw new Error(status === 401 ? `Dispatcharr rejected the account credentials: ${detail}` : `Dispatcharr login failed: ${detail}`)
    }
    accessToken = data.access
    accessExpSec = jwtExp(accessToken) ?? 0
    refreshToken = typeof data.refresh === 'string' ? data.refresh : null
  }

  async function refresh(): Promise<boolean> {
    if (refreshToken === null) return false
    const { status, data } = await postJson('/api/accounts/token/refresh/', { refresh: refreshToken })
    if (status !== 200 || typeof data.access !== 'string') {
      // The refresh token expired or was revoked — a full login is the only way back.
      refreshToken = null
      return false
    }
    accessToken = data.access
    accessExpSec = jwtExp(accessToken) ?? 0
    return true
  }

  return {
    async getAccessToken(): Promise<string> {
      // 60s of slack so a token that is about to expire is not used for a fresh session.
      if (accessToken !== null && accessExpSec - 60 > Math.floor(now() / 1000)) {
        return accessToken
      }
      if (await refresh()) return accessToken as string
      await login()
      return accessToken as string
    },
    reset(): void {
      accessToken = null
      refreshToken = null
      accessExpSec = 0
      lastLoginAttemptMs = 0
    }
  }
}
