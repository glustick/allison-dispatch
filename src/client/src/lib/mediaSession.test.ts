import { describe, expect, it } from 'vitest'
import { buildMediaMetadata } from './mediaSession.js'

describe('buildMediaMetadata', () => {
  it('leads with the programme and credits the channel', () => {
    expect(buildMediaMetadata({ channel: { name: 'BBC News', logo_url: 'http://x/l.png' }, nowTitle: 'Signed: BBC News' })).toStrictEqual({
      title: 'Signed: BBC News',
      artist: 'BBC News',
      artwork: [{ src: 'http://x/l.png', sizes: '192x192' }]
    })
  })

  it('falls back to the channel name without guide data', () => {
    const meta = buildMediaMetadata({ channel: { name: 'BBC News', logo_url: null }, nowTitle: null })
    expect(meta.title).toBe('BBC News')
    expect(meta.artist).toBe('Allison Dispatch')
    expect(meta.artwork).toStrictEqual([])
  })
})
