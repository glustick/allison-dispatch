import { describe, expect, it } from 'vitest'
import { appendDigit, resolveNumberExact, resolveNumberImmediate, zapStep } from './zapping.js'
import type { Channel } from './api.js'

function ch(uuid: string, channelNumber: number | null, name = uuid): Channel {
  return { uuid, name, channel_number: channelNumber, tvg_id: null, tvg_name: null, logo_url: null, group_name: null }
}

// Lineup in server order: ascending channel number, unnumbered last.
const LINEUP = [ch('one', 1, 'One'), ch('seventeen', 17, 'Seventeen'), ch('cent', 100, 'Century'), ch('none', null, 'No Number')]

describe('zapStep', () => {
  it('steps forward and backward in lineup order', () => {
    expect(zapStep(LINEUP, 'one', 1)?.uuid).toBe('seventeen')
    expect(zapStep(LINEUP, 'seventeen', -1)?.uuid).toBe('one')
    // six steps from index 1 → index 3, wrapping once along the way
    expect(zapStep(LINEUP, 'seventeen', 6)?.uuid).toBe('none')
  })

  it('wraps at both ends', () => {
    expect(zapStep(LINEUP, 'none', 1)?.uuid).toBe('one')
    expect(zapStep(LINEUP, 'one', -1)?.uuid).toBe('none')
  })

  it('with nothing tuned, enters from the top (down) or bottom (up)', () => {
    expect(zapStep(LINEUP, null, 1)?.uuid).toBe('one')
    expect(zapStep(LINEUP, null, -1)?.uuid).toBe('none')
  })

  it('enters from the top for a stale uuid and never returns null for a non-empty lineup', () => {
    expect(zapStep(LINEUP, 'gone', 1)?.uuid).toBe('one')
    expect(zapStep([], null, 1)).toBeNull()
  })

  it('steps by more than one (PageUp/PageDown)', () => {
    expect(zapStep(LINEUP, 'one', 2)?.uuid).toBe('cent')
    expect(zapStep(LINEUP, 'cent', -2)?.uuid).toBe('one')
  })
})

describe('number entry', () => {
  it('accumulates digits and caps the buffer at the longest channel number', () => {
    expect(appendDigit('', '1', LINEUP)).toBe('1')
    expect(appendDigit('1', '7', LINEUP)).toBe('17')
    // "100" is 3 digits, so a 3-digit buffer is legal even if it matches nothing…
    expect(appendDigit('17', '0', LINEUP)).toBe('170')
    // …but a fourth digit overflows and starts a fresh buffer
    expect(appendDigit('170', '5', LINEUP)).toBe('5')
  })

  it('with no numbered channels at all, the buffer just grows past any cap', () => {
    const unnumbered = [ch('none', null)]
    expect(appendDigit('99', '9', unnumbered)).toBe('999')
  })

  it('resolves immediately only when no longer number shares the prefix', () => {
    expect(resolveNumberImmediate(LINEUP, '1')).toBeNull() // 17 and 100 also start with 1
    expect(resolveNumberImmediate(LINEUP, '17')).toEqual(LINEUP[1])
    expect(resolveNumberImmediate(LINEUP, '100')).toEqual(LINEUP[2])
    expect(resolveNumberImmediate(LINEUP, '2')).toBeNull()
  })

  it('ignores unnumbered channels and unknown buffers', () => {
    expect(resolveNumberImmediate(LINEUP, '999')).toBeNull()
    expect(resolveNumberExact(LINEUP, '')).toBeNull()
    expect(resolveNumberExact(LINEUP, '999')).toBeNull()
  })

  it('timeout resolution takes the exact match even when it was ambiguous mid-entry', () => {
    // "1" was held ambiguous by 17/100; a timeout with just "1" still lands on channel 1.
    expect(resolveNumberExact(LINEUP, '1')).toEqual(LINEUP[0])
  })
})
