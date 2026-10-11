import { describe, expect, it } from 'vitest'
import { assignChannel, enterSplit, exitSplit, focusTile, INITIAL_TILES, stopTile, zapFocused } from './tiles.js'
import type { Channel } from './api.js'

function ch(uuid: string, channelNumber: number | null = null, name = uuid): Channel {
  return { uuid, name, channel_number: channelNumber, tvg_id: null, tvg_name: null, logo_url: null, group_name: null }
}

const A = ch('a', 1, 'Alpha')
const B = ch('b', 2, 'Bravo')
const C = ch('c', 3, 'Charlie')
const LINEUP = [A, B, C]
const zap = (lineup: Channel[], current: string | null, delta: number): Channel | null => {
  const idx = current === null ? -1 : lineup.findIndex((c) => c.uuid === current)
  if (idx === -1) return delta >= 0 ? lineup[0] : lineup[lineup.length - 1]
  const raw = (idx + delta) % lineup.length
  return lineup[raw < 0 ? raw + lineup.length : raw]
}

describe('tiles', () => {
  it('single mode tunes the main tile and never opens the second', () => {
    const s = assignChannel(INITIAL_TILES, A)
    expect(s.split).toBe(false)
    expect(s.channels[0]?.uuid).toBe('a')
    expect(s.channels[1]).toBeNull()
  })

  it('enterSplit keeps the main picture; exitSplit keeps it and drops the second stream', () => {
    let s = assignChannel(INITIAL_TILES, A)
    s = enterSplit(s)
    expect(s.split).toBe(true)
    expect(s.channels[0]?.uuid).toBe('a')
    expect(s.channels[1]).toBeNull()
    s = assignChannel(s, B) // fills the empty OTHER slot
    expect(s.channels[1]?.uuid).toBe('b')
    expect(s.focused).toBe(0) // audio stayed on Alpha
    s = exitSplit(s)
    expect(s.split).toBe(false)
    expect(s.channels[0]?.uuid).toBe('a')
    expect(s.channels[1]).toBeNull()
    expect(s.focused).toBe(0)
  })

  it('filling the second slot never moves focus; the focused slot fills first when empty', () => {
    let s = enterSplit(assignChannel(INITIAL_TILES, A))
    s = stopTile(s, 0) // stopped the main picture — the focused slot is now empty
    s = assignChannel(s, C)
    expect(s.channels[0]?.uuid).toBe('c') // attention was on slot 0
    expect(s.focused).toBe(0)
  })

  it('clicking a channel already on a tile focuses it instead of retuning', () => {
    let s = enterSplit(assignChannel(INITIAL_TILES, A))
    s = assignChannel(s, B)
    s = focusTile(s, 1)
    expect(s.focused).toBe(1)
    s = assignChannel(s, A)
    expect(s.focused).toBe(0)
    expect(s.channels[0]?.uuid).toBe('a') // untouched, just focused
  })

  it('with both slots full, a new channel replaces the NON-focused tile', () => {
    let s = enterSplit(assignChannel(INITIAL_TILES, A))
    s = assignChannel(s, B)
    s = assignChannel(s, C)
    expect(s.focused).toBe(0)
    expect(s.channels[0]?.uuid).toBe('a') // audio stable
    expect(s.channels[1]?.uuid).toBe('c')
  })

  it('focusTile ignores no-ops and non-split states', () => {
    expect(focusTile(INITIAL_TILES, 1)).toBe(INITIAL_TILES)
    const s = enterSplit(assignChannel(INITIAL_TILES, A))
    expect(focusTile(s, 0)).toBe(s)
  })

  it('stopTile clears one slot and keeps the rest', () => {
    let s = enterSplit(assignChannel(INITIAL_TILES, A))
    s = assignChannel(s, B)
    s = stopTile(s, 1)
    expect(s.channels[1]).toBeNull()
    expect(s.channels[0]?.uuid).toBe('a')
    expect(stopTile(s, 1)).toBe(s) // no-op is identity
  })

  it('zapping moves only the focused tile through the lineup with wrap', () => {
    let s = enterSplit(assignChannel(INITIAL_TILES, A))
    s = assignChannel(s, B)
    s = zapFocused(s, LINEUP, 1, zap) // focused slot 0: Alpha → Bravo
    expect(s.channels[0]?.uuid).toBe('b')
    expect(s.channels[1]?.uuid).toBe('b') // other tile untouched…
    // duplicate is allowed; zapping again wraps to Charlie
    s = zapFocused(s, LINEUP, 1, zap)
    expect(s.channels[0]?.uuid).toBe('c')
    s = zapFocused(s, LINEUP, -2, zap) // wraps backwards to Alpha
    expect(s.channels[0]?.uuid).toBe('a')
  })
})
