import { createServer, type Server } from 'http'
import type { Express } from 'express'
import { AddressInfo } from 'net'
import type { Db } from '../db.js'

export interface RunningApp {
  url: string
  port: number
  close(): Promise<void>
}

// Boots an Express app on an ephemeral loopback port for tests — real HTTP, real fetch,
// no supertest (the sibling's tests follow the same "genuine local server" pattern).
export async function startHttpServer(app: Express): Promise<RunningApp> {
  const server: Server = createServer(app)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
  }
}

/**
 * Ensures a specific user exists (upsert — unlike the product's only-when-empty seeding,
 * tests need arbitrary accounts) and returns a logged-in cookie header value.
 */
export async function seedAndLogin(
  db: Db,
  url: string,
  username = 'tester',
  password = 'tester123',
  isAdmin = false
): Promise<string> {
  const { hashPassword } = await import('../auth.js')
  db.prepare(
    `INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, is_admin = excluded.is_admin`
  ).run(username, hashPassword(password), isAdmin ? 1 : 0)
  const res = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password })
  })
  if (!res.ok) throw new Error(`seedAndLogin: login failed with ${res.status}`)
  return (res.headers.get('set-cookie') ?? '').split(';')[0]
}
