import type { DispatcharrAuth } from './dispatcharrAuth.js'

// Catch-up sessions against Dispatcharr's REST API (probed live against v0.31.0,
// 2026-10-24): POST /api/catchup/sessions/ {channel_uuid, start: ISO} with a Bearer access
// token answers 201 {session_id, playback_url, expires_at}. The playback_url is a plain
// Dispatcharr proxy path (no auth — the session id is the capability) streaming MPEG-TS
// from the requested instant toward live, which is exactly the shape our relay pipes.

export interface CatchupSession {
  sessionId: string
  /** Path-only URL on the Dispatcharr origin: /proxy/catchup/<uuid>?session_id=<sid> */
  playbackUrl: string
  /** Epoch SECONDS after which the session is no longer accepted (~15 min observed). */
  expiresAtSec: number
}

export interface CatchupDeps {
  baseUrl: string
  auth: DispatcharrAuth
  fetchImpl?: typeof fetch
}

export class CatchupFailure extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function createCatchupSession(deps: CatchupDeps, channelUuid: string, startUtcMs: number): Promise<CatchupSession> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const token = await deps.auth.getAccessToken()
  let res: Response
  try {
    res = await fetchImpl(`${deps.baseUrl}/api/catchup/sessions/`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({ channel_uuid: channelUuid, start: new Date(startUtcMs).toISOString() })
    })
  } catch (err) {
    throw new CatchupFailure(502, `catch-up request to Dispatcharr failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (res.status === 400) {
    throw new CatchupFailure(400, 'Dispatcharr rejected this catch-up request — the channel may not support catch-up, or the start time is outside its window')
  }
  if (res.status === 401) {
    throw new CatchupFailure(401, 'Dispatcharr rejected the account credentials for catch-up')
  }
  if (res.status !== 201) {
    let detail = ''
    try {
      const body = (await res.json()) as { detail?: unknown }
      if (typeof body.detail === 'string') detail = `: ${body.detail}`
    } catch {
      // non-JSON body
    }
    throw new CatchupFailure(502, `Dispatcharr answered ${res.status} for the catch-up session${detail}`)
  }
  const body = (await res.json()) as { session_id?: unknown; playback_url?: unknown; expires_at?: unknown }
  if (typeof body.session_id !== 'string' || typeof body.playback_url !== 'string') {
    throw new CatchupFailure(502, 'Dispatcharr catch-up response was missing its session fields')
  }
  return {
    sessionId: body.session_id,
    playbackUrl: body.playback_url,
    expiresAtSec: typeof body.expires_at === 'number' ? body.expires_at : 0
  }
}
