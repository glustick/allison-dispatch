// Parser for the M3U lineup Dispatcharr serves at /output/m3u. Shapes verified live against
// v0.31.0 (2026-10-04): the header carries x-tvg-url/url-tvg, and each channel is an EXTINF
// line (attribute list, then the display name after an unquoted comma) followed by a play URL
// of the form {origin}/proxy/ts/stream/{channel-uuid}. The origin in generated URLs reflects
// the request's Host header, so callers should never trust the stored URL — they extract the
// UUID and rebuild play URLs from the configured base.

export interface M3uEntry {
  attrs: Record<string, string>
  title: string
  url: string
}

export interface ParsedChannel {
  uuid: string
  name: string
  channelNumber: number | null
  tvgId: string | null
  tvgName: string | null
  logoUrl: string | null
  group: string | null
  position: number
}

export function parseM3u(text: string): M3uEntry[] {
  const lines = text.split(/\r?\n/)
  const entries: M3uEntry[] = []
  let pending: { attrs: Record<string, string>; title: string } | null = null
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line === '') continue
    if (line.startsWith('#')) {
      if (line.toUpperCase().startsWith('#EXTINF')) {
        pending = parseExtinf(line)
      }
      continue
    }
    // First non-comment line after an EXTINF is the resource URL.
    if (pending !== null) {
      entries.push({ ...pending, url: line })
      pending = null
    }
  }
  return entries
}

// "#EXTINF:-1 tvg-id=\"419\" group-title=\"UK| NEWS\",Display Name" — attribute values are
// quoted and may contain commas, so the attrs/title separator is the first comma OUTSIDE
// quotes.
function parseExtinf(line: string): { attrs: Record<string, string>; title: string } {
  const rest = line.slice('#EXTINF'.length)
  let separatorIndex = -1
  let inQuote = false
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]
    if (ch === '"') {
      inQuote = !inQuote
    } else if (ch === ',' && !inQuote) {
      separatorIndex = i
      break
    }
  }
  const attrsPart = separatorIndex === -1 ? rest : rest.slice(0, separatorIndex)
  const title = separatorIndex === -1 ? '' : rest.slice(separatorIndex + 1).trim()
  const attrs: Record<string, string> = {}
  const attrRegex = /([A-Za-z0-9_-]+)="([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = attrRegex.exec(attrsPart)) !== null) {
    attrs[match[1]] = match[2]
  }
  return { attrs, title }
}

// Only /proxy/ts/stream/{uuid} URLs carry a playable channel identity (the XC-flavored
// /live/{user}/{pass}/{id} URLs appear only in XC exports, which this app does not consume).
const STREAM_PATH = /^\/proxy\/ts\/stream\/([0-9a-fA-F-]{36})$/i

export function extractStreamUuid(url: string): string | null {
  try {
    const parsed = new URL(url)
    const match = STREAM_PATH.exec(parsed.pathname)
    return match ? match[1].toLowerCase() : null
  } catch {
    return null
  }
}

// Rebuilds a Dispatcharr-served URL (stream, logo, …) against the configured base so nothing
// request-host-dependent survives into the database.
export function rewriteToBase(url: string | null | undefined, base: string): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return base + parsed.pathname + parsed.search
  } catch {
    return null
  }
}

export function entryToChannel(entry: M3uEntry, base: string, position: number): ParsedChannel | null {
  const uuid = extractStreamUuid(entry.url)
  if (!uuid) return null
  const numberRaw = entry.attrs['tvg-chno'] ?? ''
  const channelNumber = /^\d+$/.test(numberRaw) ? Number(numberRaw) : null
  return {
    uuid,
    name: entry.title !== '' ? entry.title : entry.attrs['tvg-name'] ?? uuid,
    channelNumber,
    tvgId: entry.attrs['tvg-id'] ?? null,
    tvgName: entry.attrs['tvg-name'] ?? null,
    logoUrl: rewriteToBase(entry.attrs['tvg-logo'], base),
    group: entry.attrs['group-title'] ?? null,
    position
  }
}
