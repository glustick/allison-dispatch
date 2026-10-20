import { describe, expect, it } from 'vitest'
import { ALL_GROUPS, filterGuideChannels, guideGroups } from './guideFilters.js'

const CHANNELS = [
  { uuid: 'a', group_name: 'News' },
  { uuid: 'b', group_name: 'Sport' },
  { uuid: 'c', group_name: 'News' },
  { uuid: 'd', group_name: null }
]

const NONE: ReadonlySet<string> = new Set()

describe('guideGroups', () => {
  it('lists all groups alphabetically behind the all sentinel, skipping channel-less groups', () => {
    expect(guideGroups(CHANNELS)).toEqual([ALL_GROUPS, 'News', 'Sport'])
  })

  it('offers only the sentinel when no channel carries a group', () => {
    expect(guideGroups([{ uuid: 'x', group_name: null }])).toEqual([ALL_GROUPS])
  })
})

describe('filterGuideChannels', () => {
  it('returns the whole lineup for the default filter', () => {
    expect(filterGuideChannels(CHANNELS, { group: ALL_GROUPS, favoritesOnly: false, favorites: NONE })).toEqual(CHANNELS)
  })

  it('keeps one group and preserves order', () => {
    const out = filterGuideChannels(CHANNELS, { group: 'News', favoritesOnly: false, favorites: NONE })
    expect(out.map((c) => c.uuid)).toEqual(['a', 'c'])
  })

  it('applies the favourites toggle', () => {
    const out = filterGuideChannels(CHANNELS, {
      group: ALL_GROUPS,
      favoritesOnly: true,
      favorites: new Set(['b', 'd'])
    })
    expect(out.map((c) => c.uuid)).toEqual(['b', 'd'])
  })

  it('combines both filters', () => {
    const out = filterGuideChannels(CHANNELS, { group: 'News', favoritesOnly: true, favorites: new Set(['c']) })
    expect(out.map((c) => c.uuid)).toEqual(['c'])
  })

  it('returns nothing when no channel matches', () => {
    expect(filterGuideChannels(CHANNELS, { group: 'Kids', favoritesOnly: false, favorites: NONE })).toEqual([])
  })
})
