import type { Channel } from './api.js'

// Multi-view tile bookkeeping — pure so the rules are testable without React. Two slots:
// index 0 is the main player (the one single-mode viewers know), index 1 only exists while
// split is on. Exactly one tile is focused; it carries the audio and the zap keys.

export interface TileState {
  split: boolean
  channels: [Channel | null, Channel | null]
  focused: 0 | 1
}

export const INITIAL_TILES: TileState = { split: false, channels: [null, null], focused: 0 }

export function enterSplit(s: TileState): TileState {
  if (s.split) return s
  return { ...s, split: true }
}

// Leaving split keeps the main player exactly as it is and drops the second stream —
// unsplit must never cost the viewer their primary picture.
export function exitSplit(s: TileState): TileState {
  if (!s.split) return s
  return { split: false, channels: [s.channels[0], null], focused: 0 }
}

export function focusTile(s: TileState, index: 0 | 1): TileState {
  if (!s.split || s.focused === index) return s
  return { ...s, focused: index }
}

/**
 * Where does a clicked channel go?
 *   1. already on a tile  → just focus that tile (it was a "look at that" click)
 *   2. focused slot empty → the focused tile (attention is already there)
 *   3. other slot empty   → the other tile, focus UNCHANGED (filling the second picture
 *                           shouldn't steal the audio from what's being watched)
 *   4. both full          → replace the NON-focused tile (same audio-stability rule)
 * Single mode always tunes the main tile, exactly like before.
 */
export function assignChannel(s: TileState, channel: Channel): TileState {
  if (!s.split) {
    return s.channels[0]?.uuid === channel.uuid ? s : { ...s, channels: [channel, s.channels[1]] }
  }
  const atZero = s.channels[0]?.uuid === channel.uuid
  const atOne = s.channels[1]?.uuid === channel.uuid
  if (atZero) return focusTile(s, 0)
  if (atOne) return focusTile(s, 1)
  const other: 0 | 1 = s.focused === 0 ? 1 : 0
  if (s.channels[s.focused] === null) {
    const channels: [Channel | null, Channel | null] = [...s.channels]
    channels[s.focused] = channel
    return { ...s, channels }
  }
  if (s.channels[other] === null || s.channels[other]!.uuid !== channel.uuid) {
    const channels: [Channel | null, Channel | null] = [...s.channels]
    channels[other] = channel
    return { ...s, channels }
  }
  return s
}

export function stopTile(s: TileState, index: 0 | 1): TileState {
  if (s.channels[index] === null) return s
  const channels: [Channel | null, Channel | null] = [...s.channels]
  channels[index] = null
  return { ...s, channels }
}

/** Zap the focused tile ±delta through the lineup, wrapping (pure wrapper over zapStep). */
export function zapFocused(s: TileState, lineup: Channel[], delta: number, zapStep: (channels: Channel[], currentUuid: string | null, delta: number) => Channel | null): TileState {
  const next = zapStep(lineup, s.channels[s.focused]?.uuid ?? null, delta)
  if (next === null || next.uuid === s.channels[s.focused]?.uuid) return s
  const channels: [Channel | null, Channel | null] = [...s.channels]
  channels[s.focused] = next
  return { ...s, channels }
}
