import { describe, expect, it } from 'vitest'
import { addTile, assignChannel, collapseToSingle, focusTile, INITIAL_TILES, MAX_TILES, removeTile, stopTile, zapFocused, type TileState } from './tiles.js'
import type { Channel } from './api.js'

function ch(uuid: string, channelNumber: number | null = null, name = uuid): Channel {
  return { uuid, name, channel_number: channelNumber, tvg_id: null, tvg_name: null, logo_url: null, group_name: null }
}

const A = ch('a', 1, 'Alpha')
const B = ch('b', 2, 'Bravo')
const C = ch('c', 3, 'Charlie')
const D = ch('d', 4, 'Delta')
const E = ch('e', 5, 'Echo')
const LINEUP = [A, B, C]
const zap = (lineup: Channel[], current: string | null, delta: number): Channel | null => {
  const idx = current === null ? -1 : lineup.findIndex((c) => c.uuid === current)
  if (idx === -1) return delta >= 0 ? lineup[0] : lineup[lineup.length - 1]
  const raw = (idx + delta) % lineup.length
  return lineup[raw < 0 ? raw + lineup.length : raw]
}

const uuids = (s: TileState): (string | null)[] => s.channels.map((c) => c?.uuid ?? null)

describe('tiles', () => {
  it('single mode tunes the main tile and never opens a second', () => {
    const s = assignChannel(INITIAL_TILES, A)
    expect(s.count).toBe(1)
    expect(s.channels[0]?.uuid).toBe('a')
    expect(s.channels).toHaveLength(1)
  })

  it('addTile grows the grid up to MAX_TILES and keeps every picture', () => {
    let s = assignChannel(INITIAL_TILES, A)
    s = addTile(s)
    expect(s.count).toBe(2)
    expect(s.channels).toStrictEqual([A, null])
    s = assignChannel(s, B)
    s = addTile(s)
    s = addTile(s)
    expect(s.count).toBe(4)
    expect(uuids(s)).toStrictEqual(['a', 'b', null, null])
    expect(addTile(s)).toBe(s) // capped
  })

  it('collapseToSingle keeps the main picture and drops every other stream', () => {
    let s = assignChannel(INITIAL_TILES, A)
    s = addTile(s)
    s = assignChannel(s, B)
    s = collapseToSingle(s)
    expect(s.count).toBe(1)
    expect(s.channels).toStrictEqual([A])
    expect(s.focused).toBe(0)
    expect(collapseToSingle(s)).toBe(s) // already single
  })

  it('removeTile drops only that tile; focus follows the surviving picture', () => {
    let s = assignChannel(INITIAL_TILES, A)
    for (const c of [B, C, D]) {
      s = addTile(s)
      s = assignChannel(s, c)
    }
    expect(uuids(s)).toStrictEqual(['a', 'b', 'c', 'd'])

    // Closing a tile above focus slides focus down to the same picture.
    s = focusTile(s, 2)
    s = removeTile(s, 3)
    expect(uuids(s)).toStrictEqual(['a', 'b', 'c'])
    expect(s.focused).toBe(2)

    // Closing the focused tile hands audio back to the main tile.
    s = removeTile(s, 2)
    expect(uuids(s)).toStrictEqual(['a', 'b'])
    expect(s.focused).toBe(0)

    // The last tile is not closable — closing must never empty the screen.
    const one = collapseToSingle(s)
    expect(removeTile(one, 0).count).toBe(1)
    expect(removeTile(s, 9)).toBe(s) // out of range is a no-op
  })

  it('an empty focused slot is filled first', () => {
    let s = addTile(assignChannel(INITIAL_TILES, A))
    s = stopTile(s, 0) // stopped the main picture — the focused slot is now empty
    s = assignChannel(s, C)
    expect(s.channels[0]?.uuid).toBe('c') // attention was on slot 0
    expect(s.focused).toBe(0)
  })

  it('clicking a channel already on a tile focuses it instead of retuning', () => {
    let s = addTile(assignChannel(INITIAL_TILES, A))
    s = assignChannel(s, B)
    s = focusTile(s, 1)
    expect(s.focused).toBe(1)
    s = assignChannel(s, A)
    expect(s.focused).toBe(0)
    expect(s.channels[0]?.uuid).toBe('a') // untouched, just focused
  })

  it('filling an empty side slot never moves focus (audio stays put)', () => {
    let s = addTile(assignChannel(INITIAL_TILES, A))
    s = addTile(s)
    s = assignChannel(s, B)
    expect(s.focused).toBe(0)
    expect(uuids(s)).toStrictEqual(['a', 'b', null])
  })

  it('a full grid replaces the lowest-index non-focused tile', () => {
    let s = assignChannel(INITIAL_TILES, A)
    for (const c of [B, C, D]) {
      s = addTile(s)
      s = assignChannel(s, c)
    }
    s = focusTile(s, 1) // watching Bravo
    s = assignChannel(s, E)
    expect(uuids(s)).toStrictEqual(['e', 'b', 'c', 'd'])
    expect(s.focused).toBe(1)
  })

  it('focusTile ignores no-ops, single mode, and out-of-range indices', () => {
    expect(focusTile(INITIAL_TILES, 0)).toBe(INITIAL_TILES)
    const s = addTile(assignChannel(INITIAL_TILES, A))
    expect(focusTile(s, 0)).toBe(s)
    expect(focusTile(s, 5)).toBe(s)
  })

  it('stopTile empties the channel but keeps the slot', () => {
    let s = addTile(assignChannel(INITIAL_TILES, A))
    s = assignChannel(s, B)
    s = stopTile(s, 1)
    expect(s.count).toBe(2)
    expect(s.channels).toStrictEqual([A, null])
    expect(stopTile(s, 1)).toBe(s) // already empty
  })

  it('zapping moves only the focused tile through the lineup with wrap', () => {
    let s = addTile(assignChannel(INITIAL_TILES, A))
    s = assignChannel(s, B)
    s = focusTile(s, 1)
    s = zapFocused(s, LINEUP, 1, zap) // Bravo → Charlie on tile 1
    expect(uuids(s)).toStrictEqual(['a', 'c'])
    s = zapFocused(s, LINEUP, 1, zap) // wraps Charlie → Alpha
    expect(s.channels[1]?.uuid).toBe('a')
    s = zapFocused(s, LINEUP, -2, zap) // wraps Alpha back to Bravo
    expect(s.channels[1]?.uuid).toBe('b')
    expect(s.channels[0]?.uuid).toBe('a') // main tile untouched throughout
  })

  it('MAX_TILES matches the 2×2 grid the CSS can express', () => {
    expect(MAX_TILES).toBe(4)
  })
})
