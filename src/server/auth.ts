import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import type { Request, Response, NextFunction } from 'express'
import type { Db } from './db.js'
import { getSetting, setSetting } from './settingsStore.js'

// Session-cookie auth for the public-facing deployment. Deliberately dependency-free:
//   * passwords: scrypt (Node crypto) with a per-user random salt, timing-safe compare;
//   * sessions: stateless HMAC-signed cookie `userId.exp.signature` — no server-side store
//     to prune, and the signing secret lives in the SQLite settings table on the /data
//     volume, so sessions stay valid across container upgrades. SESSION_SECRET overrides it
//     for operators who want to pin one;
//   * brute force: a small in-memory per-IP failed-login limiter (public internet reality).
//
// Seeding: when the users table is completely empty (first boot ever), the operator's
// initial admin account is created. Upgrades never re-seed — the check is "any users?",
// not a version flag, so it cannot clobber accounts that exist.

const SECRET_KEY = 'auth.secret'
const COOKIE_NAME = 'ad_session'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const SCRYPT_KEYLEN = 64

export interface UserRow {
  id: number
  username: string
  password_hash: string
  is_admin: number
  created_at: string
}

export interface SessionUser {
  id: number
  username: string
  isAdmin: boolean
}

// ---- passwords ----

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (salt === undefined || hash === undefined) return false
  const candidate = scryptSync(password, salt, SCRYPT_KEYLEN)
  const expected = Buffer.from(hash, 'hex')
  if (candidate.length !== expected.length) return false
  return timingSafeEqual(candidate, expected)
}

export function validateUsername(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[a-zA-Z0-9_.-]{2,32}$/.test(raw)) {
    throw new Error('username must be 2-32 characters (letters, digits, . _ -)')
  }
  return raw
}

export function validatePassword(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length < 6) {
    throw new Error('password must be at least 6 characters')
  }
  return raw
}

// ---- session signing ----

function resolveSecret(db: Db, envSecret?: string): string {
  if (envSecret !== undefined && envSecret.length >= 16) return envSecret
  const existing = getSetting(db, SECRET_KEY)
  if (existing !== null) return existing
  const generated = randomBytes(32).toString('hex')
  setSetting(db, SECRET_KEY, generated)
  return generated
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

export function issueSessionToken(secret: string, userId: number, now = Date.now()): string {
  // Token format v2: `userId.iat.exp.signature` — iat is what password changes check against
  // (sessions_not_before_utc). v1 (userId.exp) cookies die on upgrade: one re-login.
  const payload = `${userId}.${now}.${now + SESSION_TTL_MS}`
  return `${payload}.${sign(secret, payload)}`
}

export interface VerifiedToken {
  userId: number
  iat: number
}

export function verifySessionToken(secret: string, token: string | undefined, now = Date.now()): VerifiedToken | null {
  if (token === undefined) return null
  const parts = token.split('.')
  if (parts.length !== 4) return null
  const [userIdRaw, iatRaw, expRaw, signature] = parts
  const payload = `${userIdRaw}.${iatRaw}.${expRaw}`
  const expected = sign(secret, payload)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  const userId = Number(userIdRaw)
  const iat = Number(iatRaw)
  const exp = Number(expRaw)
  if (!Number.isInteger(userId) || !Number.isInteger(iat) || !Number.isInteger(exp) || exp < now || iat > now) return null
  return { userId, iat }
}

// ---- cookies ----

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie
  if (header === undefined) return {}
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key !== '') out[key] = value
  }
  return out
}

function sessionCookieHeader(token: string, req: Request): string {
  // Secure only behind HTTPS — the app is also reachable over plain LAN HTTP, where a
  // Secure cookie would be silently dropped and look like a broken login.
  const proto = req.headers['x-forwarded-proto']
  const isHttps = req.secure || (Array.isArray(proto) ? proto[0] : proto) === 'https'
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${isHttps ? '; Secure' : ''}`
}

// ---- brute-force limiter ----

const MAX_FAILURES = 5
const FAILURE_WINDOW_MS = 15 * 60 * 1000
const failures = new Map<string, { count: number; resetAt: number }>()

export function loginBlockedFor(ip: string, now = Date.now()): boolean {
  const entry = failures.get(ip)
  if (entry === undefined || entry.resetAt < now) return false
  return entry.count >= MAX_FAILURES
}

export function recordLoginFailure(ip: string, now = Date.now()): void {
  const entry = failures.get(ip)
  if (entry === undefined || entry.resetAt < now) {
    failures.set(ip, { count: 1, resetAt: now + FAILURE_WINDOW_MS })
    return
  }
  entry.count++
}

export function clearLoginFailures(ip: string): void {
  failures.delete(ip)
}

/** Test isolation: the limiter is module-global, so suites reset it between tests. */
export function resetLoginLimiter(): void {
  failures.clear()
}

// ---- store + middleware ----

export interface AuthContext {
  secret: string
  user(req: Request): SessionUser | null
}

export function createAuthContext(db: Db, envSecret?: string): AuthContext {
  const secret = resolveSecret(db, envSecret)
  return {
    secret,
    user(req: Request): SessionUser | null {
      const verified = verifySessionToken(secret, parseCookies(req)[COOKIE_NAME])
      if (verified === null) return null
      const row = db
        .prepare('SELECT id, username, is_admin, sessions_not_before_utc FROM users WHERE id = ?')
        .get(verified.userId) as Pick<UserRow, 'id' | 'username' | 'is_admin'> & { sessions_not_before_utc: number } | undefined
      if (row === undefined) return null
      // Password changes bump sessions_not_before_utc; tokens issued before that instant
      // are dead even though their signature is still valid.
      if (verified.iat < row.sessions_not_before_utc) return null
      return { id: row.id, username: row.username, isAdmin: row.is_admin === 1 }
    }
  }
}

/** Seeds the initial admin account when — and only when — no users exist at all. */
export function ensureSeedUser(db: Db, username: string, password: string): { seeded: boolean } {
  const any = db.prepare('SELECT 1 FROM users LIMIT 1').get()
  if (any !== undefined) return { seeded: false }
  db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)').run(username, hashPassword(password))
  return { seeded: true }
}

export function requireAuth(ctx: AuthContext) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = ctx.user(req)
    if (user === null) {
      res.status(401).json({ error: 'Not signed in' })
      return
    }
    ;(req as Request & { sessionUser?: SessionUser }).sessionUser = user
    next()
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as Request & { sessionUser?: SessionUser }).sessionUser
  if (user?.isAdmin !== true) {
    res.status(403).json({ error: 'Admin only' })
    return
  }
  next()
}

export function setSessionCookie(res: Response, req: Request, token: string): void {
  res.setHeader('Set-Cookie', sessionCookieHeader(token, req))
}

export function clearSessionCookie(res: Response, req: Request): void {
  const proto = req.headers['x-forwarded-proto']
  const isHttps = req.secure || (Array.isArray(proto) ? proto[0] : proto) === 'https'
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps ? '; Secure' : ''}`)
}

export const AUTH_COOKIE_NAME = COOKIE_NAME
