import path from 'path'

export interface AppConfig {
  port: number
  dataDir: string
  publicDir: string
  /**
   * Base URL of the Dispatcharr instance, normalized to have no trailing slash.
   * Null until configured — M0 only validates it; M1's sync pipeline is the first consumer.
   */
  dispatcharrUrl: string | null
  /**
   * Cap on concurrent relayed streams (each spawns an ffmpeg on the host). 0 disables the
   * cap — an operator escape hatch, not the default. Beyond the cap the relay route
   * answers 429 so a stuck tab can't fork the host into oblivion.
   */
  relayMaxStreams: number
  /** How many gzipped db snapshots the daily backup loop keeps. */
  backupKeep: number
}

const DEFAULT_PORT = 8086

function parsePort(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got: ${raw}`)
  }
  return value
}

function parseIntEnv(name: string, raw: string | undefined, defaultValue: number, min: number): number {
  if (raw === undefined || raw.trim() === '') return defaultValue
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}, got: ${raw}`)
  }
  return value
}

export function normalizeDispatcharrUrl(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    throw new Error(`DISPATCHARR_URL is not a valid URL: ${raw}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`DISPATCHARR_URL must use http or https, got: ${parsed.protocol}`)
  }
  // The M3U/EPG outputs generate URLs from the request's Host header, so consumers must
  // rewrite origins anyway (observed live: requesting via 192.168.0.20 yields 192.168.0.20
  // URLs). Keeping only scheme://host[:port] makes that rewrite deterministic and drops any
  // path/query noise a user pasted in.
  return parsed.origin
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const rawDispatcharrUrl = env.DISPATCHARR_URL?.trim()
  return {
    port: parsePort(env.PORT) ?? DEFAULT_PORT,
    // Absolute paths: express.static/sendFile require them, and the server may be started
    // from any cwd (Docker WORKDIR, launchd, a dev terminal).
    dataDir: env.DATA_DIR?.trim() ? path.resolve(env.DATA_DIR) : path.resolve('data'),
    publicDir: env.PUBLIC_DIR?.trim() ? path.resolve(env.PUBLIC_DIR) : path.resolve('public'),
    dispatcharrUrl: rawDispatcharrUrl ? normalizeDispatcharrUrl(rawDispatcharrUrl) : null,
    relayMaxStreams: parseIntEnv('RELAY_MAX_STREAMS', env.RELAY_MAX_STREAMS?.trim(), 3, 0),
    backupKeep: parseIntEnv('BACKUP_KEEP', env.BACKUP_KEEP?.trim(), 7, 1)
  }
}
