// A chunk-fed streaming XMLTV scanner. Dispatcharr's /output/epg can be tens of MB for a
// full guide; allison-web-iptv once died in an OOM restart loop building a DOM of a ~97MB
// provider guide before moving to streaming parse (retained data dropped from ~1.3GB to
// ~570MB). This app never gets the chance: elements are emitted as complete blocks are
// recognized in the byte stream, and nothing but a small scan tail is retained.
//
// Machine-generated XMLTV (which Dispatcharr emits) needs no full XML grammar: the scanner
// recognizes <channel>…</channel> and <programme>…</programme> blocks, parses attributes
// from the opening tag, and extracts the handful of child elements the guide needs. Chunk
// boundaries at arbitrary byte offsets are handled by retaining an unconsumed tail — a
// partial closing tag at a boundary simply waits for the next feed.

export interface XmltvChannel {
  id: string
  displayName: string | null
  iconUrl: string | null
}

export interface XmltvProgramme {
  channelId: string
  startUtc: number
  stopUtc: number
  title: string | null
  description: string | null
  category: string | null
}

export interface XmltvHandlers {
  onChannel(channel: XmltvChannel): void
  onProgramme(programme: XmltvProgramme): void
}

export interface XmltvScanner {
  feed(chunk: string): void
  end(): void
}

interface BlockSpec {
  tag: 'channel' | 'programme'
  open: string
  close: string
}

const BLOCKS: BlockSpec[] = [
  { tag: 'channel', open: '<channel', close: '</channel>' },
  { tag: 'programme', open: '<programme', close: '</programme>' }
]

// If garbage with no element opener at all accumulates (malformed upstream), keep only a
// small tail so a tag split across the garbage boundary can still complete.
const MAX_TAGLESS_TAIL = 64

export function createXmltvScanner(handlers: XmltvHandlers): XmltvScanner {
  let buffer = ''
  let ended = false

  function processBuffer(): void {
    for (;;) {
      // Earliest complete element opener in the buffer.
      let best: { spec: BlockSpec; openStart: number; tagEnd: number } | null = null
      for (const spec of BLOCKS) {
        const idx = buffer.indexOf(spec.open)
        if (idx === -1) continue
        // The opener must be the whole tag name: '<channelx' is not '<channel'.
        const after = buffer.slice(idx + spec.open.length, idx + spec.open.length + 1)
        if (after !== '' && after !== ' ' && after !== '>' && after !== '\n' && after !== '\r' && after !== '\t' && after !== '/') continue
        const tagEnd = buffer.indexOf('>', idx)
        if (tagEnd === -1) continue // opening tag itself split across chunks
        if (best === null || idx < best.openStart) {
          best = { spec, openStart: idx, tagEnd }
        }
      }
      if (best === null) {
        // No opener: drop pure garbage but retain a tail in case a tag is mid-arrival.
        const lastLt = buffer.lastIndexOf('<')
        if (lastLt === -1 && buffer.length > MAX_TAGLESS_TAIL) {
          buffer = buffer.slice(buffer.length - MAX_TAGLESS_TAIL)
        }
        return
      }
      const closeIdx = buffer.indexOf(best.spec.close, best.tagEnd)
      if (closeIdx === -1) return // wait for the closing tag to arrive
      const block = buffer.slice(best.openStart, closeIdx + best.spec.close.length)
      emitBlock(best.spec.tag, block)
      buffer = buffer.slice(closeIdx + best.spec.close.length)
    }
  }

  function emitBlock(tag: 'channel' | 'programme', block: string): void {
    if (tag === 'channel') {
      const channel = parseChannel(block)
      if (channel !== null) handlers.onChannel(channel)
    } else {
      const programme = parseProgramme(block)
      if (programme !== null) handlers.onProgramme(programme)
    }
  }

  return {
    feed(chunk: string): void {
      if (ended) throw new Error('scanner already ended')
      buffer += chunk
      processBuffer()
    },
    end(): void {
      ended = true
      processBuffer()
      buffer = ''
    }
  }
}

function parseOpeningAttrs(block: string, tag: string): Record<string, string> | null {
  const tagEnd = block.indexOf('>')
  if (tagEnd === -1) return null
  const attrText = block.slice(tag.length + 1, tagEnd)
  const attrs: Record<string, string> = {}
  const attrRegex = /([A-Za-z0-9_:-]+)="([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = attrRegex.exec(attrText)) !== null) {
    attrs[match[1]] = match[2]
  }
  return attrs
}

function childText(block: string, tag: string): string | null {
  // Self-closing or missing child → null.
  const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i')
  const match = regex.exec(block)
  if (!match) return null
  return decodeXmlText(match[1]).trim()
}

export function decodeXmlText(text: string): string {
  const withoutCdata = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  return withoutCdata
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeFromCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeFromCode(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function safeFromCode(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  return String.fromCodePoint(code)
}

function parseChannel(block: string): XmltvChannel | null {
  const attrs = parseOpeningAttrs(block, 'channel')
  if (!attrs || attrs['id'] === undefined) return null
  const iconMatch = /<icon[^>]*\bsrc="([^"]*)"/.exec(block)
  return {
    id: attrs['id'],
    displayName: childText(block, 'display-name'),
    iconUrl: iconMatch ? decodeXmlText(iconMatch[1]) : null
  }
}

// XMLTV timestamps: "YYYYMMDDHHMMSS[.frac] [+-]HHMM" — the zone may be omitted (treated as
// UTC). Returns epoch ms, or null for unparseable values (those programmes are skipped).
export function parseXmltvTimestamp(raw: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?(?:[.,]\d+)?\s*([+-]\d{4})?\s*$/.exec(raw.trim())
  if (!match) return null
  const [, y, mo, d, h = '00', mi = '00', se = '00', zone] = match
  let ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se))
  if (zone !== undefined) {
    const sign = zone[0] === '-' ? -1 : 1
    const minutes = Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5))
    ms -= sign * minutes * 60_000
  }
  return ms
}

function parseProgramme(block: string): XmltvProgramme | null {
  const attrs = parseOpeningAttrs(block, 'programme')
  if (!attrs || attrs['channel'] === undefined) return null
  const startUtc = attrs['start'] !== undefined ? parseXmltvTimestamp(attrs['start']) : null
  const stopUtc = attrs['stop'] !== undefined ? parseXmltvTimestamp(attrs['stop']) : null
  if (startUtc === null || stopUtc === null) return null
  const title = childText(block, 'title')
  if (title === null || title === '') return null
  return {
    channelId: attrs['channel'],
    startUtc,
    stopUtc,
    title,
    description: childText(block, 'desc'),
    category: childText(block, 'category')
  }
}
