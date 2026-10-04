export interface Channel {
  uuid: string
  name: string
  channel_number: number | null
  tvg_id: string | null
  tvg_name: string | null
  logo_url: string | null
  group_name: string | null
}

export interface ChannelsResponse {
  count: number
  channels: Channel[]
}

export interface SyncKindState {
  kind: string
  last_run_utc: number | null
  status: string
  item_count: number | null
  error: string | null
}

export interface SyncStatusResponse {
  kinds: Record<string, SyncKindState>
}

export interface SettingsResponse {
  dispatcharrUrl: string | null
  source: 'settings' | 'env' | null
}

export interface ConnectionTestResult {
  ok: boolean
  version?: string
  error?: string
  url?: string
}

export interface SyncSummary {
  m3u: { channels: number; skipped: number } | null
  epg: { programmes: number; channels: number } | null
}

export interface SyncRunResponse {
  ok: boolean
  summary?: SyncSummary
  error?: string
}

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} failed with ${res.status}`)
  return (await res.json()) as T
}

export async function sendJson<T>(url: string, method: 'POST' | 'PUT', body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  })
  const parsed = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(parsed.error ?? `${method} ${url} failed with ${res.status}`)
  return parsed
}
