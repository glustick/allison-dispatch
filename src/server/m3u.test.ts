import { describe, expect, it } from 'vitest'
import { parseM3u, extractStreamUuid, rewriteToBase, entryToChannel } from './m3u.js'

// Line shapes mirror the live-probed v0.31.0 output (2026-10-04), with sanitized values.
const SAMPLE = [
  '#EXTM3U x-tvg-url="http://d:9191/output/epg" url-tvg="http://d:9191/output/epg"',
  '#EXTINF:-1 tvg-id="419" tvg-name="News One" tvg-logo="http://d:9191/api/channels/logos/97/cache/" tvg-chno="419" group-title="News",News One',
  'http://d:9191/proxy/ts/stream/78fda7e9-73ab-4b12-b5fa-1c055722884d',
  '#EXTINF:-1 tvg-id="422" tvg-name="City, Life" tvg-logo="http://other.host/api/channels/logos/98/cache/" group-title="General",City, Life',
  'http://d:9191/proxy/ts/stream/9e5e91a2-8707-408a-80b7-3a48015474fb?output_format=fmp4',
  '#EXTINF:-1 tvg-name="No URL Channel",No URL Channel',
  '#EXTVLCOPT:http-user-agent=player'
].join('\n')

describe('parseM3u', () => {
  it('pairs EXTINF attribute lines with their following URL', () => {
    const entries = parseM3u(SAMPLE)
    // The third EXTINF never gets a URL line, so it is dropped entirely.
    expect(entries).toHaveLength(2)
    expect(entries[0].attrs['tvg-id']).toBe('419')
    expect(entries[0].title).toBe('News One')
    expect(entries[0].url).toBe('http://d:9191/proxy/ts/stream/78fda7e9-73ab-4b12-b5fa-1c055722884d')
  })

  it('keeps commas inside quoted attributes out of the attrs/title separator', () => {
    const entries = parseM3u(SAMPLE)
    expect(entries[1].attrs['tvg-name']).toBe('City, Life')
    expect(entries[1].title).toBe('City, Life')
  })

  it('ignores other comment directives and drops an EXTINF that never gets a URL', () => {
    const entries = parseM3u(SAMPLE)
    expect(entries.some((e) => e.title === 'No URL Channel')).toBe(false)
    expect(entries.some((e) => e.url === '#EXTVLCOPT:http-user-agent=player')).toBe(false)
  })
})

describe('extractStreamUuid', () => {
  it('extracts the channel uuid from proxy stream URLs', () => {
    expect(extractStreamUuid('http://d:9191/proxy/ts/stream/78fda7e9-73ab-4b12-b5fa-1c055722884d')).toBe(
      '78fda7e9-73ab-4b12-b5fa-1c055722884d'
    )
  })

  it('tolerates query strings and normalizes case', () => {
    expect(extractStreamUuid('http://d:9191/proxy/ts/stream/78FDA7E9-73AB-4B12-B5FA-1C055722884D?x=1')).toBe(
      '78fda7e9-73ab-4b12-b5fa-1c055722884d'
    )
  })

  it('rejects non-stream URLs and garbage', () => {
    expect(extractStreamUuid('http://d:9191/live/user/pass/419')).toBeNull()
    expect(extractStreamUuid('http://d:9191/proxy/ts/stream/not-a-uuid')).toBeNull()
    expect(extractStreamUuid('not a url')).toBeNull()
  })
})

describe('rewriteToBase', () => {
  it('replaces whatever origin with the configured base, preserving path and query', () => {
    expect(rewriteToBase('http://other.host:1/api/channels/logos/9/cache/?v=2', 'http://d:9191')).toBe(
      'http://d:9191/api/channels/logos/9/cache/?v=2'
    )
  })

  it('returns null for missing or unparseable URLs', () => {
    expect(rewriteToBase(null, 'http://d:9191')).toBeNull()
    expect(rewriteToBase(undefined, 'http://d:9191')).toBeNull()
    expect(rewriteToBase('::garbage::', 'http://d:9191')).toBeNull()
  })
})

describe('entryToChannel', () => {
  const base = 'http://d:9191'

  it('maps a full entry with channel number and rewritten logo', () => {
    const [entry] = parseM3u(SAMPLE)
    const channel = entryToChannel(entry, base, 7)
    expect(channel).toEqual({
      uuid: '78fda7e9-73ab-4b12-b5fa-1c055722884d',
      name: 'News One',
      channelNumber: 419,
      tvgId: '419',
      tvgName: 'News One',
      logoUrl: 'http://d:9191/api/channels/logos/97/cache/',
      group: 'News',
      position: 7
    })
  })

  it('treats a missing tvg-chno as no channel number and skips entries without a stream uuid', () => {
    const [, second] = parseM3u(SAMPLE)
    const noNumber = entryToChannel(second, base, 1)
    expect(noNumber?.channelNumber).toBeNull()
    const nonStream = parseM3u('#EXTINF:-1 tvg-name="Odd",Odd\nhttp://d:9191/some/other/path')
    expect(entryToChannel(nonStream[0], base, 2)).toBeNull()
  })

  it('falls back to tvg-name then uuid for the display name', () => {
    const entries = parseM3u('#EXTINF:-1 tvg-name="Fallback Name",\nhttp://d:9191/proxy/ts/stream/78fda7e9-73ab-4b12-b5fa-1c055722884d')
    const channel = entryToChannel(entries[0], base, 0)
    expect(channel?.name).toBe('Fallback Name')
  })
})
