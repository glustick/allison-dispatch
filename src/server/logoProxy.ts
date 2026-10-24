import type { ServerResponse } from 'http'

// The BFF logo proxy. Channel logos come from Dispatcharr's own cache URLs
// (http://<dispatcharr>/api/channels/logos/...), and the browser used to load them directly.
// That breaks the moment the app is served over HTTPS (mixed content — browsers block the
// http images) or from outside the LAN (Dispatcharr isn't exposed). So every logo_url the
// API emits is rewritten to a same-origin /api/logo?u=… path, and this module fetches the
// bytes server-side.

/**
 * Rewrites a stored logo URL to the same-origin proxy path. Full URLs must carry the
 * Dispatcharr origin (the sync already normalizes to it) and path-only forms resolve
 * against the base; anything foreign is refused — the proxy is not an open redirector.
 * Null when there is nothing safe to proxy to (no logo, or Dispatcharr unconfigured).
 */
export function proxiedLogoUrl(base: string | null, raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null
  if (base === null) return null
  try {
    const parsed = new URL(raw, base)
    if (parsed.origin !== new URL(base).origin) return null
    return `/api/logo?u=${encodeURIComponent(base + parsed.pathname + parsed.search)}`
  } catch {
    return null
  }
}

export interface LogoProxyDeps {
  dispatcharrBase: string
  fetchImpl?: typeof fetch
  /** Connect timeout only — a logo is small, but a hung Dispatcharr must not hang the tab. */
  connectTimeoutMs?: number
}

export type LogoProxyResult = { ok: true } | { ok: false; status: 400 | 404 | 502; error: string }

export async function proxyLogo(deps: LogoProxyDeps, src: string, res: ServerResponse): Promise<LogoProxyResult> {
  let target: URL
  try {
    const parsed = new URL(src, deps.dispatcharrBase)
    if (parsed.origin !== new URL(deps.dispatcharrBase).origin) {
      return { ok: false, status: 400, error: 'logo source must be on the Dispatcharr origin' }
    }
    target = parsed
  } catch {
    return { ok: false, status: 400, error: 'invalid logo source' }
  }

  const fetchImpl = deps.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.connectTimeoutMs ?? 10_000)
  let upstream: Response
  try {
    upstream = await fetchImpl(target.toString(), { signal: controller.signal })
  } catch (err) {
    clearTimeout(timer)
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 502, error: `logo fetch failed: ${message}` }
  }
  clearTimeout(timer)
  if (!upstream.ok || upstream.body === null) {
    void upstream.body?.cancel()
    return { ok: false, status: 404, error: `Dispatcharr answered ${upstream.status} for the logo` }
  }

  // Logos barely ever change; the browser caching them same-origin keeps the guide, the
  // sidebar and the radio cards cheap on repeat loads.
  res.writeHead(200, {
    'Content-Type': upstream.headers.get('content-type') ?? 'image/png',
    'Cache-Control': 'public, max-age=86400'
  })
  try {
    const reader = upstream.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (res.destroyed || res.writableEnded) break
      if (!res.write(value)) {
        await new Promise<void>((resolve) => res.once('drain', resolve))
      }
    }
    if (!res.destroyed && !res.writableEnded) res.end()
  } catch {
    // Upstream or client died mid-logo — nothing sensible to report once bytes flowed.
    res.destroy()
  } finally {
    controller.abort()
  }
  return { ok: true }
}
