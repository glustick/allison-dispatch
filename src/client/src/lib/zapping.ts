import type { Channel } from './api.js'

// TV-style channel zapping — pure helpers so the logic is testable without a DOM.
// "Lineup order" is the server's channel ordering (number, then position/name), which is
// what a remote's CH+/CH− means on a numbered lineup.

// Step ±delta channels from the current one, wrapping at both ends. With nothing tuned yet
// (or a uuid the lineup no longer contains) it enters from the top (delta ≥ 0) or the bottom.
export function zapStep(channels: Channel[], currentUuid: string | null, delta: number): Channel | null {
  if (channels.length === 0) return null
  const idx = currentUuid === null ? -1 : channels.findIndex((c) => c.uuid === currentUuid)
  if (idx === -1) return delta >= 0 ? channels[0] : channels[channels.length - 1]
  const raw = (idx + delta) % channels.length
  return channels[raw < 0 ? raw + channels.length : raw] ?? null
}

// Number-entry buffer: digits accumulate like a remote. The buffer never outgrows the
// longest channel number — past that, the new digit starts a fresh buffer.
export function appendDigit(buffer: string, digit: string, channels: Channel[]): string {
  const next = `${buffer}${digit}`
  const maxLen = channels.reduce(
    (max, c) => Math.max(max, c.channel_number === null ? 0 : String(c.channel_number).length),
    0
  )
  return maxLen > 0 && next.length > maxLen ? digit : next
}

// Immediate resolution: the buffer exactly equals a channel number AND no longer number
// starts with the same digits (so "1" doesn't jump to channel 1 while channel 17 exists).
export function resolveNumberImmediate(channels: Channel[], buffer: string): Channel | null {
  if (buffer === '') return null
  const hasLonger = channels.some(
    (c) => c.channel_number !== null && String(c.channel_number).length > buffer.length && String(c.channel_number).startsWith(buffer)
  )
  if (hasLonger) return null
  return (
    channels.find((c) => c.channel_number !== null && String(c.channel_number) === buffer) ?? null
  )
}

// Timeout resolution: whatever the buffer matches exactly, if anything — ambiguity just
// means the entry failed, like a remote flashing and doing nothing.
export function resolveNumberExact(channels: Channel[], buffer: string): Channel | null {
  if (buffer === '') return null
  return channels.find((c) => c.channel_number !== null && String(c.channel_number) === buffer) ?? null
}
