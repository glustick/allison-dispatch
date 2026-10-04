import { describe, expect, it } from 'vitest'
import { createXmltvScanner, parseXmltvTimestamp, type XmltvChannel, type XmltvProgramme } from './xmltvStream.js'

const DOC = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE tv SYSTEM "xmltv.dtd">',
  '<tv generator-info-name="Dispatcharr">',
  '  <channel id="419">',
  '    <display-name>News &amp; Views</display-name>',
  '    <icon src="http://d:9191/api/channels/logos/97/cache/"/>',
  '  </channel>',
  '  <programme start="20261004120000 +0000" stop="20261004140000 +0000" channel="419">',
  '    <title lang="en">Midday Report</title>',
  '    <desc lang="en">Headlines &lt;b&gt;today&lt;/b&gt; — with <![CDATA[cdata & raw]]> bits</desc>',
  '    <category lang="en">News</category>',
  '  </programme>',
  '  <programme start="20261004140000 +0000" stop="20261004150000 +0000" channel="419">',
  '    <title lang="en">Afternoon</title>',
  '  </programme>',
  '  <programme start="20261004160000 +0200" stop="20261004170000 +0200" channel="999">',
  '    <title lang="en">Offset Show</title>',
  '  </programme>',
  '  <programme start="garbage" stop="20261004170000 +0000" channel="419">',
  '    <title lang="en">Broken Time</title>',
  '  </programme>',
  '</tv>'
].join('\n')

interface Collected {
  channels: XmltvChannel[]
  programmes: XmltvProgramme[]
}

function collect(): { scanner: ReturnType<typeof createXmltvScanner>; collected: Collected } {
  const collected: Collected = { channels: [], programmes: [] }
  const scanner = createXmltvScanner({
    onChannel: (ch) => collected.channels.push(ch),
    onProgramme: (p) => collected.programmes.push(p)
  })
  return { scanner, collected }
}

describe('createXmltvScanner', () => {
  it('parses channels and programmes from a full document in one feed', () => {
    const { scanner, collected } = collect()
    scanner.feed(DOC)
    scanner.end()
    expect(collected.channels).toEqual([
      { id: '419', displayName: 'News & Views', iconUrl: 'http://d:9191/api/channels/logos/97/cache/' }
    ])
    expect(collected.programmes).toHaveLength(3)
    expect(collected.programmes[0]).toMatchObject({
      channelId: '419',
      title: 'Midday Report',
      category: 'News'
    })
    expect(collected.programmes[0].description).toBe('Headlines <b>today</b> — with cdata & raw bits')
    // 2026-10-04 12:00:00 UTC
    expect(collected.programmes[0].startUtc).toBe(Date.UTC(2026, 9, 4, 12, 0, 0))
  })

  it('converts non-UTC zone offsets to epoch ms', () => {
    const { scanner, collected } = collect()
    scanner.feed(DOC)
    scanner.end()
    // 16:00 +0200 == 14:00 UTC
    expect(collected.programmes[2].startUtc).toBe(Date.UTC(2026, 9, 4, 14, 0, 0))
    expect(collected.programmes[2].channelId).toBe('999')
  })

  it('skips programmes with unparseable timestamps or no title', () => {
    const { scanner, collected } = collect()
    scanner.feed(DOC)
    scanner.end()
    expect(collected.programmes.some((p) => p.title === 'Broken Time')).toBe(false)
  })

  it('survives feeding one character at a time (worst-case chunk boundaries)', () => {
    const { scanner, collected } = collect()
    for (const ch of DOC) scanner.feed(ch)
    scanner.end()
    expect(collected.channels).toHaveLength(1)
    expect(collected.programmes).toHaveLength(3)
    expect(collected.programmes[0].description).toBe('Headlines <b>today</b> — with cdata & raw bits')
  })

  it('survives odd chunk sizes that split tags mid-name', () => {
    const { scanner, collected } = collect()
    // 7-byte chunks deliberately land inside '<programme' / '</programme>' literals.
    for (let i = 0; i < DOC.length; i += 7) scanner.feed(DOC.slice(i, i + 7))
    scanner.end()
    expect(collected.programmes).toHaveLength(3)
    expect(collected.channels).toHaveLength(1)
  })

  it('handles entity-encoded ampersands without double-decoding', () => {
    const { scanner, collected } = collect()
    scanner.feed(
      '<tv><programme start="20261004120000 +0000" stop="20261004130000 +0000" channel="1">' +
        '<title>A &amp;amp; B</title></programme></tv>'
    )
    scanner.end()
    expect(collected.programmes[0].title).toBe('A &amp; B')
  })
})

describe('parseXmltvTimestamp', () => {
  it('parses the standard XMLTV UTC form', () => {
    expect(parseXmltvTimestamp('20261004120000 +0000')).toBe(Date.UTC(2026, 9, 4, 12, 0, 0))
  })

  it('treats a missing zone as UTC and accepts fractional seconds', () => {
    expect(parseXmltvTimestamp('20261004120000.000')).toBe(Date.UTC(2026, 9, 4, 12, 0, 0))
    expect(parseXmltvTimestamp('2026100412')).toBe(Date.UTC(2026, 9, 4, 12, 0, 0))
  })

  it('rejects garbage', () => {
    expect(parseXmltvTimestamp('soon')).toBeNull()
    expect(parseXmltvTimestamp('')).toBeNull()
  })
})
