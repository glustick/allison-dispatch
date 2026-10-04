import { describe, expect, it } from 'vitest'
import { LivePlaybackMonitor } from './liveMonitor.js'

function harness(stallWindowMs = 10_000): {
  monitor: LivePlaybackMonitor
  clock: { nowMs: number }
  playing: (bufferedEnd: number) => { currentTime: number; bufferedEnd: number; paused: boolean; readyState: number }
  advance: (ms: number) => void
} {
  const clock = { nowMs: 1_000_000 }
  const monitor = new LivePlaybackMonitor({ now: () => clock.nowMs, stallWindowMs })
  const playing = (bufferedEnd: number) => ({
    currentTime: bufferedEnd - 1,
    bufferedEnd,
    paused: false,
    readyState: 3
  })
  const advance = (ms: number): void => {
    clock.nowMs += ms
  }
  return { monitor, clock, playing, advance }
}

describe('LivePlaybackMonitor', () => {
  it('stays watching while the buffer grows', () => {
    const { monitor, playing } = harness()
    expect(monitor.sample(playing(10))).toBe('watching')
    expect(monitor.sample(playing(11))).toBe('watching')
    expect(monitor.sample(playing(11.5))).toBe('watching')
  })

  it('calls a stream frozen after the stall window with no buffer growth', () => {
    const { monitor, playing, advance } = harness()
    monitor.sample(playing(10))
    advance(4_000)
    expect(monitor.sample(playing(10))).toBe('watching') // 4s in — inside the window
    advance(6_500)
    expect(monitor.sample(playing(10))).toBe('stalled') // 10.5s without growth
  })

  it('paused playback never counts toward a stall', () => {
    const { monitor, playing, advance } = harness()
    monitor.sample(playing(10))
    advance(60_000)
    expect(monitor.sample({ currentTime: 9, bufferedEnd: 10, paused: true, readyState: 3 })).toBe('watching')
    // Resumed and growing again → healthy.
    expect(monitor.sample(playing(11))).toBe('watching')
  })

  it('buffering (readyState < 2) holds the clock instead of accumulating stall time', () => {
    const { monitor, playing, advance } = harness()
    monitor.sample(playing(10))
    advance(6_000)
    monitor.sample({ currentTime: 10, bufferedEnd: 10, paused: false, readyState: 1 })
    advance(6_000)
    // The buffering sample reset the window, so 6s of the 10.5s elapsed is forgiven.
    expect(monitor.sample(playing(10))).toBe('watching')
    advance(5_000)
    expect(monitor.sample(playing(10))).toBe('stalled')
  })

  it('returns to watching once the buffer grows again after a stall', () => {
    const { monitor, playing, advance } = harness()
    monitor.sample(playing(10))
    advance(11_000)
    expect(monitor.sample(playing(10))).toBe('stalled')
    expect(monitor.sample(playing(12))).toBe('watching')
  })

  it('reset() clears a stall and the progress history', () => {
    const { monitor, playing, advance } = harness()
    monitor.sample(playing(10))
    advance(11_000)
    expect(monitor.sample(playing(10))).toBe('stalled')
    monitor.reset()
    expect(monitor.currentState).toBe('watching')
    advance(5_000)
    expect(monitor.sample(playing(10))).toBe('watching') // fresh window
  })
})
