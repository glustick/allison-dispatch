import type { Channel } from './api.js'

// Multi-view tile bookkeeping — pure so the rules are testable without React. Slots grow
// from 1 to MAX_TILES (a 2×2 grid); index 0 is the main player (the one single-mode viewers
// know). Exactly one tile is focused; it carries the audio and the zap keys.

export const MAX_TILES = 4

export interface TileState {
  count: number
  /** Always exactly `count` slots — closing a tile removes its slot, it never dangles. */
  channels: (Channel | null)[]
  focused: number
}

export const INITIAL_TILES: TileState = { count: 1, channels: [null], focused: 0 }

// Two channels are the same tile occupant only when they are the same channel AND the same
// playback mode: a catch-up session of channel A is not "already on a tile" when the viewer
// clicks live A — that click means "switch this watching back to live".
function sameTileChannel(a: Channel | null, b: Channel): boolean {
  return a !== null && a.uuid === b.uuid && a.catchupStartMs === b.catchupStartMs
}

export function addTile(s: TileState): TileState {
  if (s.count >= MAX_TILES) return s
  return { count: s.count + 1, channels: [...s.channels, null], focused: s.focused }
}

// Closing a tile keeps every remaining picture exactly as it is. Focus moves with the
// removal: closing the focused tile hands audio to the main tile, closing one above it
// slides focus down to the same picture it was on.
export function removeTile(s: TileState, index: number): TileState {
  if (s.count <= 1 || index < 0 || index >= s.count) return s
  const channels = s.channels.filter((_, i) => i !== index)
  const focused = s.focused === index ? 0 : s.focused > index ? s.focused - 1 : s.focused
  return { count: s.count - 1, channels, focused }
}

export function focusTile(s: TileState, index: number): TileState {
  if (s.count <= 1 || index < 0 || index >= s.count || s.focused === index) return s
  return { ...s, focused: index }
}

/**
 * Where does a clicked channel go?
 *   1. already on a tile  → just focus that tile (it was a "look at that" click)
 *   2. focused slot empty → the focused tile (attention is already there)
 *   3. any slot empty     → the FIRST empty slot, focus UNCHANGED (filling a picture
 *                           shouldn't steal the audio from what's being watched)
 *   4. all full           → replace the lowest-index NON-focused tile (same audio-stability
 *                           rule — with several tiles, the oldest side picture gives way)
 * Single mode always tunes the main tile, exactly like before tiles existed.
 */
export function assignChannel(s: TileState, channel: Channel): TileState {
  if (s.count === 1) {
    return sameTileChannel(s.channels[0], channel) ? s : { ...s, channels: [channel] }
  }
  const showing = s.channels.findIndex((c) => sameTileChannel(c, channel))
  if (showing !== -1) return focusTile(s, showing)
  const focusedEmpty = s.channels[s.focused] === null
  const channels = [...s.channels]
  if (focusedEmpty) {
    channels[s.focused] = channel
    return { ...s, channels }
  }
  const empty = s.channels.findIndex((c) => c === null)
  if (empty !== -1) {
    channels[empty] = channel
    return { ...s, channels }
  }
  const victim = s.channels.findIndex((_, i) => i !== s.focused)
  channels[victim] = channel
  return { ...s, channels }
}

/** Empties a tile's channel but keeps the tile (the viewer chose the grid, not the channel). */
export function stopTile(s: TileState, index: number): TileState {
  if (index < 0 || index >= s.count || s.channels[index] === null) return s
  const channels = [...s.channels]
  channels[index] = null
  return { ...s, channels }
}

/** Collapse to the single main picture — tile 0 survives untouched, every other stream stops. */
export function collapseToSingle(s: TileState): TileState {
  if (s.count === 1) return s
  return { count: 1, channels: [s.channels[0]], focused: 0 }
}

/** Zap the focused tile ±delta through the lineup, wrapping (pure wrapper over zapStep). */
export function zapFocused(s: TileState, lineup: Channel[], delta: number, zapStep: (channels: Channel[], currentUuid: string | null, delta: number) => Channel | null): TileState {
  const next = zapStep(lineup, s.channels[s.focused]?.uuid ?? null, delta)
  if (next === null || next.uuid === s.channels[s.focused]?.uuid) return s
  const channels = [...s.channels]
  channels[s.focused] = next
  return { ...s, channels }
}
