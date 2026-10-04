import { describe, expect, it } from 'vitest'
import { clampDimension } from './useResizableDimension.js'

// The DOM-adjacent parts (localStorage, pointer gestures) aren't unit-testable in the node
// environment; the pure clamp that underpins the drag math is.
describe('clampDimension', () => {
  it('passes through in-range values', () => {
    expect(clampDimension(280, 200, 480)).toBe(280)
  })
  it('clamps to min and max', () => {
    expect(clampDimension(120, 200, 480)).toBe(200)
    expect(clampDimension(900, 200, 480)).toBe(480)
  })
  it('handles drag undershoot and overshoot deltas via the caller arithmetic', () => {
    const start = 280
    expect(clampDimension(start + (-500), 200, 480)).toBe(200)
    expect(clampDimension(start + 5000, 200, 480)).toBe(480)
  })
})
