import { createServer, type Server } from 'http'
import type { Express } from 'express'
import { AddressInfo } from 'net'

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
