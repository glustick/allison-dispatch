// Synthetic fixture data for the wire-level fake Dispatcharr. Deliberately sanitized —
// channel names, groups and UUIDs here are invented, because real provider playlists carry
// credentials in their URLs and must never end up committed to the repo. The SHAPES mirror
// what a real v0.31.0 instance serves (probed live on 2026-10-04): the M3U header with both
// x-tvg-url and url-tvg, the EXTINF attribute set, the logo-cache URL pattern, and the
// /proxy/ts/stream/{uuid} play URLs.

export const FAKE_DISPATCHARR_VERSION = '0.31.0'

export interface FakeChannel {
  uuid: string
  id: number
  name: string
  channelNumber: number
  group: string
  logoId: number
}

export const DEFAULT_FAKE_CHANNELS: FakeChannel[] = [
  { uuid: '5a1e0d6a-1111-4a01-9a2b-000000000001', id: 101, name: 'ACME News HD', channelNumber: 101, group: 'News', logoId: 1 },
  { uuid: '5a1e0d6a-1111-4a01-9a2b-000000000002', id: 102, name: 'ACME News 2', channelNumber: 102, group: 'News', logoId: 2 },
  { uuid: '5a1e0d6a-2222-4a01-9a2b-000000000003', id: 201, name: 'ACME Sports 1', channelNumber: 201, group: 'Sport', logoId: 3 },
  { uuid: '5a1e0d6a-2222-4a01-9a2b-000000000004', id: 202, name: 'ACME Sports 2', channelNumber: 202, group: 'Sport', logoId: 4 },
  { uuid: '5a1e0d6a-3333-4a01-9a2b-000000000005', id: 301, name: 'ACME Cinema', channelNumber: 301, group: 'Movies', logoId: 5 },
  { uuid: '5a1e0d6a-3333-4a01-9a2b-000000000006', id: 302, name: 'ACME Classics', channelNumber: 302, group: 'Movies', logoId: 6 }
]

// 1x1 transparent PNG, so logo-cache tests can assert on real image bytes.
export const FAKE_LOGO_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

export function buildM3u(origin: string, channels: FakeChannel[]): string {
  const lines: string[] = [
    `#EXTM3U x-tvg-url="${origin}/output/epg" url-tvg="${origin}/output/epg"`
  ]
  for (const ch of channels) {
    lines.push(
      `#EXTINF:-1 tvg-id="${ch.id}" tvg-name="${ch.name}" ` +
        `tvg-logo="${origin}/api/channels/logos/${ch.logoId}/cache/" ` +
        `tvg-chno="${ch.channelNumber}" group-title="${ch.group}",${ch.name}`
    )
    lines.push(`${origin}/proxy/ts/stream/${ch.uuid}`)
  }
  return lines.join('\n') + '\n'
}

// XMLTV timestamps: "YYYYMMDDHHmmss +0000" (UTC), the format real XMLTV guides use.
export function xmltvTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())} +0000`
  )
}

export interface ProgrammeSlot {
  start: Date
  stop: Date
  title: string
}

// Four 2-hour programme slots per channel straddling `now` — offset by 30 minutes so the
// "live" slot strictly CONTAINS now instead of ending exactly on it (real programme grids
// don't align with sync moments, and now/next queries must handle strict containment).
export function buildProgrammeSlots(now: Date, channel: FakeChannel): ProgrammeSlot[] {
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000
  const OFFSET_MS = 30 * 60 * 1000
  const slots: ProgrammeSlot[] = []
  for (let i = -2; i <= 1; i++) {
    const start = new Date(now.getTime() + i * TWO_HOURS_MS + OFFSET_MS)
    const stop = new Date(start.getTime() + TWO_HOURS_MS)
    slots.push({
      start,
      stop,
      title: `${channel.name} — Slot ${i + 2}`
    })
  }
  return slots
}

export function buildEpgXml(now: Date, channels: FakeChannel[]): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE tv SYSTEM "xmltv.dtd">',
    '<tv generator-info-name="fake-dispatcharr">'
  ]
  for (const ch of channels) {
    out.push(`  <channel id="${ch.id}">`)
    out.push(`    <display-name>${esc(ch.name)}</display-name>`)
    out.push(`    <icon src="http://logo.invalid/${ch.logoId}.png"/>`)
    out.push('  </channel>')
  }
  for (const ch of channels) {
    for (const slot of buildProgrammeSlots(now, ch)) {
      out.push(
        `  <programme start="${xmltvTimestamp(slot.start)}" stop="${xmltvTimestamp(slot.stop)}" channel="${ch.id}">`
      )
      out.push(`    <title lang="en">${esc(slot.title)}</title>`)
      out.push(`    <desc lang="en">${esc('A synthetic programme for testing.')}</desc>`)
      out.push(`    <category lang="en">${esc(ch.group)}</category>`)
      out.push('  </programme>')
    }
  }
  out.push('</tv>')
  return out.join('\n') + '\n'
}
