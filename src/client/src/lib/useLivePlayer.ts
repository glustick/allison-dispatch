import { useCallback, useEffect, useRef, useState } from 'react'
import mpegts from 'mpegts.js'
import type { Channel } from './api.js'
import { buildPlaybackUrl, fetchPlayInfo, isDolbyAudioCodec, lastBufferedEnd, type PlaybackPrefs } from './playback.js'
import { LivePlaybackMonitor } from './liveMonitor.js'

// One live player instance, extracted verbatim from WatchView's inline effect so the
// multi-view tiles can each run their own stream. Same behavior, same retry budget (2 per
// channel selection), same config — the hook owns its <video> element via a callback ref,
// its status, and its restart lifecycle; the component decides what to tune where.

export type StatusKind = 'idle' | 'connecting' | 'playing' | 'reconnecting' | 'failed'

export interface StatusState {
  kind: StatusKind
  message: string | null
}

export interface LivePlayer {
  /** Callback ref for the tile's <video> element. */
  attachVideo: (el: HTMLVideoElement | null) => void
  status: StatusState
  codecNote: string | null
  autoplayBlocked: boolean
  muted: boolean
  setMuted: (muted: boolean) => void
  restart: () => void
}

export function useLivePlayer(channel: Channel | null, prefs: PlaybackPrefs, initialMuted = false): LivePlayer {
  const [status, setStatus] = useState<StatusState>({ kind: 'idle', message: null })
  const [codecNote, setCodecNote] = useState<string | null>(null)
  const [autoplayBlocked, setAutoplayBlocked] = useState(false)
  // initialMuted seeds the FIRST attached element only (a secondary tile mounts muted so its
  // autoplay needs no gesture); the audio-follows-focus effect drives everything after that.
  const [muted, setMutedState] = useState(initialMuted)
  const [gen, setGen] = useState(0)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const attemptsRef = useRef(0)
  // The reload budget survives effect re-runs but not channel changes; a ref read inside
  // the effect would go stale, so failures funnel through a callback ref.
  const failureRef = useRef<(what: string) => void>(() => {})
  // Prefs as seen inside the long-lived player effect without re-binding its dependencies.
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const mutedRef = useRef(muted)
  mutedRef.current = muted

  const attachVideo = useCallback((el: HTMLVideoElement | null): void => {
    videoRef.current = el
    // A freshly attached element inherits the tile's current audio state (muted tiles
    // autoplay without a gesture; the focused tile carries sound).
    if (el !== null) el.muted = mutedRef.current
  }, [])

  const setMuted = useCallback((m: boolean): void => {
    setMutedState(m)
    const video = videoRef.current
    if (video !== null) video.muted = m
  }, [])

  const restart = useCallback((): void => {
    setGen((g) => g + 1)
  }, [])

  // Player lifecycle — re-runs on channel change, pref change, or restart (gen bump).
  useEffect(() => {
    const video = videoRef.current
    if (!channel || !video) {
      setStatus({ kind: 'idle', message: null })
      return
    }
    let disposed = false
    let player: mpegts.Player | null = null
    let pollTimer: number | null = null
    const monitor = new LivePlaybackMonitor({ now: () => Date.now() })

    const onPlaying = (): void => {
      if (!disposed) {
        setStatus({ kind: 'playing', message: null })
        setAutoplayBlocked(false)
      }
    }
    video.addEventListener('playing', onPlaying)

    const start = async (): Promise<void> => {
      setStatus({ kind: 'connecting', message: null })
      monitor.reset()
      try {
        const info = await fetchPlayInfo(channel.uuid, prefsRef.current.format, prefsRef.current.maxHeight)
        if (disposed) return
        if (!mpegts.isSupported()) {
          setStatus({ kind: 'failed', message: 'This browser cannot play live MPEG-TS (Media Source Extensions unsupported).' })
          return
        }
        player = mpegts.createPlayer(
          { type: 'mpegts', isLive: true, url: buildPlaybackUrl(info) },
          // Live hygiene: enough IO stash to ride out the proxy's bursty feed (stash OFF made
          // playback underrun constantly on real channels), plus latency chasing so the
          // buffer can't drift far behind the live edge.
          {
            enableStashBuffer: true,
            lazyLoad: false,
            liveBufferLatencyChasing: true,
            liveBufferLatencyMaxLatency: 10,
            liveBufferLatencyMinRemain: 2
          }
        )
        player.on(mpegts.Events.ERROR, () => failureRef.current('The stream session ended'))
        player.on(mpegts.Events.MEDIA_INFO, (raw: unknown) => {
          if (disposed) return
          const mi = raw as { audioCodec?: string; videoCodec?: string }
          const audio = mi.audioCodec ?? ''
          setCodecNote(
            audio === ''
              ? `${mi.videoCodec ?? 'video'} · no audio track`
              : isDolbyAudioCodec(audio)
                ? `${mi.videoCodec ?? 'video'} + ${audio} — Dolby fixed to AAC by the server`
                : `${mi.videoCodec ?? 'video'} + ${audio}`
          )
        })
        player.attachMediaElement(video)
        player.load()
        void video.play().catch(() => {
          // Autoplay with sound needs a user gesture — resumed sessions on a fresh page load
          // often hit this. Say so instead of looking broken.
          if (!disposed) setAutoplayBlocked(true)
        })
        pollTimer = window.setInterval(() => {
          const state = monitor.sample({
            currentTime: video.currentTime,
            bufferedEnd: lastBufferedEnd(video),
            paused: video.paused,
            readyState: video.readyState
          })
          if (state === 'stalled') failureRef.current('The stream seems frozen')
        }, 1_000)
      } catch (err) {
        if (!disposed) {
          setStatus({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
        }
      }
    }
    void start()

    return () => {
      disposed = true
      video.removeEventListener('playing', onPlaying)
      if (pollTimer !== null) window.clearInterval(pollTimer)
      try {
        player?.destroy()
      } catch {
        // destroy can throw if the pipeline was already torn down — nothing to do.
      }
      player = null
    }
    // The effect intentionally keys on channel/format/quality/restart only — status updates
    // and the retry budget flow through refs and setters that stay stable across re-runs.
    // A quality change restarts the stream (restart-for-quality, like the sibling app).
  }, [channel?.uuid, prefs.format, prefs.maxHeight, gen])

  // Retry budget: per channel selection, shared by stall + error paths.
  useEffect(() => {
    attemptsRef.current = 0
  }, [channel?.uuid])

  const handleFailure = useCallback((what: string): void => {
    if (attemptsRef.current < 2) {
      attemptsRef.current++
      setStatus({ kind: 'reconnecting', message: `${what} — restarting it… (attempt ${attemptsRef.current} of 2)` })
      setGen((g) => g + 1)
    } else {
      setStatus({ kind: 'failed', message: `${what}. The channel appears to be not broadcasting.` })
    }
  }, [])
  failureRef.current = handleFailure

  return { attachVideo, status, codecNote, autoplayBlocked, muted, setMuted, restart }
}
