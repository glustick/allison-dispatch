import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import mpegts from 'mpegts.js'
import { getJson, type Channel, type ChannelsResponse } from '../lib/api.js'
import GuideView from './GuideView.js'
import {
  buildPlaybackUrl,
  fetchPlayInfo,
  isDolbyAudioCodec,
  lastBufferedEnd,
  loadPrefs,
  savePrefs,
  type OutputFormat,
  type PlaybackPrefs
} from '../lib/playback.js'
import { LivePlaybackMonitor } from '../lib/liveMonitor.js'
import { loadSavedDimension, saveDimension, useResizableDimension } from '../lib/useResizableDimension.js'

interface ProgrammeSummary {
  title: string
  start_utc: number
  stop_utc: number
}

interface NowNextPayload {
  now: ProgrammeSummary | null
  next: ProgrammeSummary | null
}

type StatusKind = 'idle' | 'connecting' | 'playing' | 'reconnecting' | 'failed'

interface StatusState {
  kind: StatusKind
  message: string | null
}

function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// The one TV screen: resizable channel bar on the left (search + group filter — it absorbed
// the old Channels tab), player on the right with now/next, and the EPG guide under the
// player. Clicking a channel anywhere — sidebar or guide — tunes the player in place.
// Playback always rides the BFF relay with the Dolby audio fix on (no toggle: without it
// there is no audio at all — every provider stream carries AC-3).
export default function WatchView(): React.JSX.Element {
  const [channels, setChannels] = useState<Channel[] | null>(null)
  const [search, setSearch] = useState('')
  const [group, setGroup] = useState('all')
  const [selected, setSelected] = useState<Channel | null>(null)
  const [prefs, setPrefs] = useState<PlaybackPrefs>(() => loadPrefs())
  const [gen, setGen] = useState(0)
  const [status, setStatus] = useState<StatusState>({ kind: 'idle', message: null })
  const [nowNext, setNowNext] = useState<NowNextPayload | null>(null)
  const [codecNote, setCodecNote] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const attemptsRef = useRef(0)
  // The reload budget survives effect re-runs but not channel changes; a ref read inside
  // the effect would go stale, so failures funnel through a callback ref.
  const failureRef = useRef<(what: string) => void>(() => {})
  // Prefs as seen inside the long-lived player effect without re-binding its dependencies.
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs

  // The channel bar is drag-resizable (min 200, max 480) and persisted, matching the
  // sibling's own resizable panels.
  const SIDEBAR_KEY = 'allison-dispatch.sidebar-width'
  const { dimension: sidebarWidth, startDrag: startSidebarDrag } = useResizableDimension(
    loadSavedDimension(SIDEBAR_KEY, 280, 200, 480),
    'x',
    { min: 200, max: 480, onCommit: (w) => saveDimension(SIDEBAR_KEY, w) }
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const body = await getJson<ChannelsResponse>('/api/channels')
        if (!cancelled) setChannels(body.channels)
      } catch {
        if (!cancelled) setChannels([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Now/next for the selected channel.
  useEffect(() => {
    if (selected === null) {
      setNowNext(null)
      return
    }
    const channel = selected
    let cancelled = false
    async function poll(): Promise<void> {
      try {
        const body = await getJson<NowNextPayload>(`/api/epg/now-next?uuid=${encodeURIComponent(channel.uuid)}`)
        if (!cancelled) setNowNext(body)
      } catch {
        if (!cancelled) setNowNext(null)
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 30_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [selected])

  // Player lifecycle — re-runs on channel change, pref change, or restart (gen bump).
  useEffect(() => {
    const video = videoRef.current
    if (!selected || !video) {
      setStatus({ kind: 'idle', message: null })
      return
    }
    let disposed = false
    let player: mpegts.Player | null = null
    let pollTimer: number | null = null
    const monitor = new LivePlaybackMonitor({ now: () => Date.now() })

    const onPlaying = (): void => {
      if (!disposed) setStatus({ kind: 'playing', message: null })
    }
    video.addEventListener('playing', onPlaying)

    const start = async (): Promise<void> => {
      setStatus({ kind: 'connecting', message: null })
      monitor.reset()
      try {
        const info = await fetchPlayInfo(selected.uuid, prefsRef.current.format)
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
          // Autoplay policy blocked us — the user can press play on the controls.
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
    // The effect intentionally keys on channel/format/restart only — status updates and the
    // retry budget flow through refs and setters that stay stable across re-runs.
  }, [selected?.uuid, prefs.format, gen])

  // Retry budget: per channel selection, shared by stall + error paths.
  useEffect(() => {
    attemptsRef.current = 0
  }, [selected?.uuid])

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

  function tune(channel: Channel): void {
    setSelected((prev) => (prev?.uuid === channel.uuid ? prev : channel))
  }

  const groups = useMemo(() => {
    const set = new Set<string>()
    for (const ch of channels ?? []) if (ch.group_name !== null) set.add(ch.group_name)
    return ['all', ...Array.from(set).sort((a, b) => a.localeCompare(b))]
  }, [channels])

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return (channels ?? []).filter((ch) => {
      if (group !== 'all' && ch.group_name !== group) return false
      if (needle !== '' && !ch.name.toLowerCase().includes(needle)) return false
      return true
    })
  }, [channels, group, search])

  return (
    <section className="view">
      <div className="watch-layout" style={{ gridTemplateColumns: `${sidebarWidth}px 6px 1fr` }}>
        <aside className="watch-list">
          <input
            type="search"
            placeholder="Find a channel…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Filter by group">
            {groups.map((g) => (
              <option key={g} value={g}>
                {g === 'all' ? 'All groups' : g}
              </option>
            ))}
          </select>
          <ul className="watch-channel-list">
            {visible.map((ch) => (
              <li key={ch.uuid}>
                <button
                  type="button"
                  className={selected?.uuid === ch.uuid ? 'watch-channel watch-channel-active' : 'watch-channel'}
                  onClick={() => tune(ch)}
                >
                  <span className="channel-number">{ch.channel_number ?? ''}</span>
                  <span className="channel-name">{ch.name}</span>
                </button>
              </li>
            ))}
            {channels !== null && channels.length === 0 && (
              <li className="muted-note">No channels — sync first in Settings.</li>
            )}
          </ul>
          {channels !== null && visible.length !== channels.length && (
            <p className="muted-note">Showing {visible.length} of {channels.length}</p>
          )}
        </aside>

        <div
          className="resize-handle resize-handle-v"
          onPointerDown={startSidebarDrag}
          title="Drag to resize the channel bar"
          role="separator"
          aria-orientation="vertical"
        />

        <div className="watch-main">
          <div className="video-frame">
            <video ref={videoRef} controls playsInline className="watch-video" />
          </div>

          <div className="watch-bar">
            <div className="watch-now-next">
              {selected === null ? (
                <span className="muted-note">Pick a channel to start watching.</span>
              ) : (
                <>
                  <strong>{selected.name}</strong>
                  {nowNext?.now != null && (
                    <span className="muted-note">
                      {' '}· now: {nowNext.now.title} ({formatClock(nowNext.now.start_utc)}–{formatClock(nowNext.now.stop_utc)})
                    </span>
                  )}
                  {nowNext?.next != null && (
                    <span className="muted-note"> · next: {nowNext.next.title}</span>
                  )}
                </>
              )}
            </div>
            <div className="watch-controls">
              <label>
                Format{' '}
                <select
                  value={prefs.format}
                  onChange={(e) => {
                    const format = e.target.value as OutputFormat
                    setPrefs((prev) => {
                      const next = { ...prev, format }
                      savePrefs(next)
                      return next
                    })
                  }}
                >
                  <option value="mpegts">MPEG-TS</option>
                  <option value="fmp4">fMP4</option>
                </select>
              </label>
              {selected !== null && (
                <button type="button" onClick={() => setSelected(null)}>
                  Stop
                </button>
              )}
            </div>
          </div>

          {status.kind === 'reconnecting' && (
            <p className="status-banner status-banner-warn">{status.message}</p>
          )}
          {status.kind === 'failed' && <p className="status-banner status-banner-error">{status.message}</p>}
          {status.kind === 'connecting' && <p className="status-banner">Connecting…</p>}
          {status.kind === 'playing' && <p className="status-banner status-banner-ok">Playing live.</p>}
          {codecNote !== null && selected !== null && <p className="muted-note">Codecs: {codecNote}</p>}

          <GuideView embedded onWatch={tune} />
        </div>
      </div>
    </section>
  )
}
