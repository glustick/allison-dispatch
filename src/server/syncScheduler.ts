// The periodic sync driver. A scheduler built from one `setTimeout` only ever fires once —
// which is exactly how v0.1.1 shipped: the lineup refreshed an hour after boot, the guide six
// hours after, and then both went stale until the next container restart. Every loop here
// therefore RE-ARMS itself (a timeout chain, not a single timeout), applies jitter per tick so
// a fleet of restarts cannot thundering-herd Dispatcharr, and stops cleanly through the
// returned disposer.
//
// Kept out of index.ts so the cadence is testable with fake timers: a regression to one-shot
// scheduling is invisible in production (the first refresh still happens) and would otherwise
// only show up as a guide that quietly stops having tomorrow in it.

export type SchedulerSyncKind = 'm3u' | 'epg' | 'vod'

export interface SyncSchedulerOptions {
  /** Fire-and-forget: failures are the callback's business (sync.ts records them in sync_state). */
  run: (kinds: SchedulerSyncKind[]) => void | Promise<unknown>
  bootDelayMs?: number
  m3uIntervalMs?: number
  epgIntervalMs?: number
  vodIntervalMs?: number
  jitterMs?: number
  /** Test seam for deterministic jitter. */
  random?: () => number
}

export interface SyncScheduler {
  stop: () => void
}

export const SYNC_DEFAULTS = {
  bootDelayMs: 5_000,
  m3uIntervalMs: 60 * 60 * 1000,
  epgIntervalMs: 6 * 60 * 60 * 1000,
  vodIntervalMs: 24 * 60 * 60 * 1000,
  jitterMs: 15 * 60 * 1000
} as const

export function startSyncScheduler(options: SyncSchedulerOptions): SyncScheduler {
  const bootDelayMs = options.bootDelayMs ?? SYNC_DEFAULTS.bootDelayMs
  const m3uIntervalMs = options.m3uIntervalMs ?? SYNC_DEFAULTS.m3uIntervalMs
  const epgIntervalMs = options.epgIntervalMs ?? SYNC_DEFAULTS.epgIntervalMs
  const vodIntervalMs = options.vodIntervalMs ?? SYNC_DEFAULTS.vodIntervalMs
  const jitterMs = options.jitterMs ?? SYNC_DEFAULTS.jitterMs
  const random = options.random ?? Math.random

  let stopped = false
  const timers = new Set<ReturnType<typeof setTimeout>>()

  const arm = (fn: () => void, delayMs: number): void => {
    if (stopped) return
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (stopped) return
      fn()
    }, delayMs)
    timers.add(timer)
    // Don't hold the process open just for a scheduled sync (Docker stops us with SIGTERM).
    if (typeof timer.unref === 'function') timer.unref()
  }

  // One cadence: run, then re-arm for the next tick. This is the whole fix — the previous
  // version armed exactly one timeout and considered the job done.
  const loop = (kinds: SchedulerSyncKind[], intervalMs: number): void => {
    arm(() => {
      void options.run(kinds)
      loop(kinds, intervalMs)
    }, intervalMs + Math.floor(random() * jitterMs))
  }

  // Boot sync once, then the independent cadences (lineup hourly, guide 6-hourly, VOD
  // library daily — a snapshot, not a live surface). Intervals are measured from the boot
  // sync rather than from process start, so a slow start doesn't stack runs.
  arm(() => {
    void options.run(['m3u', 'epg'])
    loop(['m3u'], m3uIntervalMs)
    loop(['epg'], epgIntervalMs)
    loop(['vod'], vodIntervalMs)
  }, bootDelayMs)

  return {
    stop(): void {
      stopped = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    }
  }
}
