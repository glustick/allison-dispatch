// Pure, clock-injected detector for a frozen live stream. Ported in spirit from the sibling
// app's playlistStall.ts (which survived an OOM release, so the shape is trusted): a live
// stream is healthy while the buffer grows, and "frozen" when the viewer is unpaused, the
// buffer has stopped growing, and the wall clock has outrun the last sign of progress by a
// full stall window. The monitor only DETECTS — the player wrapper owns retries and the
// honest status sentences.

export interface LiveSample {
  currentTime: number
  /** End of the buffered range (seconds of media). Growth = the stream is delivering. */
  bufferedEnd: number
  paused: boolean
  readyState: number
}

export type LiveStallState = 'watching' | 'stalled'

export interface LiveMonitorOptions {
  now: () => number
  /** Wall-clock time without buffered growth before a playing stream is called frozen. */
  stallWindowMs?: number
}

const BUFFER_EPSILON_SEC = 0.05
const DEFAULT_STALL_WINDOW_MS = 10_000

export class LivePlaybackMonitor {
  private lastProgressAt: number
  private lastBufferedEnd = -1
  private state: LiveStallState = 'watching'
  private readonly stallWindowMs: number
  private readonly nowFn: () => number

  constructor(options: LiveMonitorOptions) {
    this.nowFn = options.now
    this.stallWindowMs = options.stallWindowMs ?? DEFAULT_STALL_WINDOW_MS
    this.lastProgressAt = options.now()
  }

  get currentState(): LiveStallState {
    return this.state
  }

  sample(s: LiveSample): LiveStallState {
    const now = this.nowFn()
    const grew = s.bufferedEnd > this.lastBufferedEnd + BUFFER_EPSILON_SEC
    if (grew) {
      this.lastBufferedEnd = s.bufferedEnd
      this.lastProgressAt = now
      this.state = 'watching'
      return this.state
    }
    if (s.paused || s.readyState < 2) {
      // Paused or still buffering: not evidence of a dead stream — hold the clock, don't
      // accumulate stall time.
      this.lastProgressAt = now
      return this.state
    }
    if (now - this.lastProgressAt >= this.stallWindowMs) {
      this.state = 'stalled'
    }
    return this.state
  }

  reset(): void {
    this.lastBufferedEnd = -1
    this.lastProgressAt = this.nowFn()
    this.state = 'watching'
  }
}
