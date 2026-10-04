import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

// Drag-to-resize machinery, ported from the sibling app's lib/useResizableDimension.ts (itself
// a port of the desktop app's v0.7.9 drag-resizable EPG channel column): `dimension` state
// updates live during the drag, a ref mirrors it so window listeners always read fresh values
// without re-binding, and `onCommit` fires exactly once on release — the place to persist.

/** Pure clamp so the drag math is directly testable without a DOM. */
export function clampDimension(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Reads a saved panel dimension from localStorage, re-clamped to [min, max] so a stale value
 * from a different screen or an older layout can't produce an unusable panel.
 */
export function loadSavedDimension(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return fallback
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return fallback
    return clampDimension(parsed, min, max)
  } catch {
    // Private-browsing-style environments can throw on localStorage access — a panel width is
    // not worth failing a render over.
    return fallback
  }
}

export function saveDimension(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value))
  } catch {
    // See loadSavedDimension.
  }
}

export interface ResizableDimensionOptions {
  min: number
  max: number
  onCommit?: (dimension: number) => void
}

export function useResizableDimension(initial: number, axis: 'x' | 'y', options: ResizableDimensionOptions): {
  dimension: number
  startDrag: (event: ReactPointerEvent<HTMLElement>) => void
} {
  const [dimension, setDimension] = useState(initial)
  const dimRef = useRef(dimension)
  dimRef.current = dimension
  const gestureRef = useRef<{ startPos: number; startDim: number; pointerId: number } | null>(null)
  const { min, max, onCommit } = options

  const startDrag = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    const pointerId = event.pointerId
    gestureRef.current = {
      startPos: axis === 'x' ? event.clientX : event.clientY,
      startDim: dimRef.current,
      pointerId
    }
    const onMove = (ev: PointerEvent): void => {
      const g = gestureRef.current
      if (g === null || ev.pointerId !== g.pointerId) return
      const pos = axis === 'x' ? ev.clientX : ev.clientY
      setDimension(clampDimension(g.startDim + (pos - g.startPos), min, max))
    }
    const onUp = (ev: PointerEvent): void => {
      const g = gestureRef.current
      if (g === null || ev.pointerId !== g.pointerId) return
      gestureRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      onCommit?.(dimRef.current)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [axis, min, max, onCommit])

  return { dimension, startDrag }
}
