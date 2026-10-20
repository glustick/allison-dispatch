import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startSyncScheduler, type SyncKind } from './syncScheduler.js'

// The cadence is the contract: boot sync once, then each kind on its own repeating interval.
// These tests exist because the first shipped scheduler used a single setTimeout per kind —
// it fired once and the guide silently stopped refreshing until the container restarted.
describe('startSyncScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function record(): { calls: SyncKind[][]; count: (kind: SyncKind) => number } {
    const calls: SyncKind[][] = []
    return {
      calls,
      count: (kind) => calls.filter((c) => c.includes(kind)).length
    }
  }

  it('runs both kinds after the boot delay, then keeps each cadence recurring', () => {
    const { calls, count } = record()
    const scheduler = startSyncScheduler({
      run: (kinds) => {
        calls.push(kinds)
      },
      bootDelayMs: 5_000,
      m3uIntervalMs: 60_000,
      epgIntervalMs: 300_000,
      jitterMs: 0
    })

    expect(calls).toEqual([])
    vi.advanceTimersByTime(4_999)
    expect(calls).toEqual([])

    vi.advanceTimersByTime(1)
    expect(calls).toEqual([['m3u', 'epg']])

    vi.advanceTimersByTime(60_000)
    expect(count('m3u')).toBe(2)

    // A second hourly tick — the exact behaviour the one-shot scheduler lost.
    vi.advanceTimersByTime(60_000)
    expect(count('m3u')).toBe(3)

    // ... and the guide cadence keeps ticking too, on its own slower clock.
    vi.advanceTimersByTime(180_000)
    expect(count('epg')).toBe(2)
    // boot run + hourly ticks at t=65s, 125s, 185s, 245s, 305s
    expect(count('m3u')).toBe(6)

    scheduler.stop()
    const afterStop = calls.length
    vi.advanceTimersByTime(24 * 60 * 60 * 1000)
    expect(calls.length).toBe(afterStop)
  })

  it('applies jitter per tick instead of drifting on a fixed clock', () => {
    const { calls } = record()
    const scheduler = startSyncScheduler({
      run: (kinds) => {
        calls.push(kinds)
      },
      bootDelayMs: 0,
      m3uIntervalMs: 10_000,
      epgIntervalMs: 10_000_000,
      jitterMs: 1_000,
      random: () => 0.5
    })

    vi.advanceTimersByTime(0)
    expect(calls).toEqual([['m3u', 'epg']])

    vi.advanceTimersByTime(10_000)
    expect(calls).toHaveLength(1) // no tick without its 500ms jitter
    vi.advanceTimersByTime(500)
    expect(calls).toHaveLength(2)

    scheduler.stop()
  })

  it('does nothing when stopped before the boot sync', () => {
    const { calls } = record()
    const scheduler = startSyncScheduler({
      run: (kinds) => {
        calls.push(kinds)
      },
      bootDelayMs: 1_000,
      m3uIntervalMs: 1_000,
      epgIntervalMs: 1_000,
      jitterMs: 0
    })

    scheduler.stop()
    vi.advanceTimersByTime(60_000)
    expect(calls).toEqual([])
  })
})
