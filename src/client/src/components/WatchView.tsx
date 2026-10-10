import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import mpegts from 'mpegts.js'
import { getJson, type Channel, type ChannelsResponse, type ProgrammeHit, type ProgrammeSearchResponse } from '../lib/api.js'
import { appendDigit, resolveNumberExact, resolveNumberImmediate, zapStep } from '../lib/zapping.js'
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
  const [autoplayBlocked, setAutoplayBlocked] = useState(false)
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

  // ---- Favorites + recents (per-user, server-side) ----
  const [favorites, setFavorites] = useState<Set<string>>(new Set())
  const [recents, setRecents] = useState<Channel[]>([])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [favs, hist] = await Promise.all([
          getJson<{ favorites: Channel[] }>('/api/favorites'),
          getJson<{ recents: Channel[] }>('/api/history/recents')
        ])
        if (cancelled) return
        setFavorites(new Set(favs.favorites.map((c) => c.uuid)))
        setRecents(hist.recents)
        // Resume: tune the last-watched channel automatically, like switching a TV back on.
        if (hist.recents.length > 0) setSelected(hist.recents[0])
      } catch {
        // Favorites/resume are enhancements — a failure here shouldn't blank the app.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function toggleFavorite(channel: Channel): Promise<void> {
    const wasFavorite = favorites.has(channel.uuid)
    const next = new Set(favorites)
    if (wasFavorite) next.delete(channel.uuid)
    else next.add(channel.uuid)
    setFavorites(next) // optimistic; revert if the server disagrees
    try {
      await fetch(`/api/favorites/${encodeURIComponent(channel.uuid)}`, {
        method: wasFavorite ? 'DELETE' : 'PUT'
      })
    } catch {
      setFavorites(favorites)
    }
  }

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

  // ---- Programme search: the sidebar needle searches the guide too (debounced) ----
  const [programmeHits, setProgrammeHits] = useState<ProgrammeHit[] | null>(null)
  const needle = search.trim()
  useEffect(() => {
    if (needle === '') {
      setProgrammeHits(null)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      getJson<ProgrammeSearchResponse>(`/api/epg/search?q=${encodeURIComponent(needle)}&limit=50`)
        .then((body) => {
          if (!cancelled) setProgrammeHits(body.programmes)
        })
        .catch(() => {
          if (!cancelled) setProgrammeHits(null)
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [needle])

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
        const info = await fetchPlayInfo(selected.uuid, prefsRef.current.format, prefsRef.current.maxHeight)
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
  }, [selected?.uuid, prefs.format, prefs.maxHeight, gen])

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

  // ---- Keyboard zapping (TV style): ↑/↓ ±1, PgUp/PgDn ±5, digits = number entry with a
  // 2s commit timeout. Skipped while typing in a field, while the video element (its own
  // controls use arrows) has focus, and for modifier chords. ----
  const [digitBuffer, setDigitBuffer] = useState<string | null>(null)
  const digitsRef = useRef('')
  const digitTimerRef = useRef<number | null>(null)
  const commitDigits = useCallback((channel: Channel | null): void => {
    digitsRef.current = ''
    setDigitBuffer(null)
    if (digitTimerRef.current !== null) {
      window.clearTimeout(digitTimerRef.current)
      digitTimerRef.current = null
    }
    if (channel !== null) setSelected((prev) => (prev?.uuid === channel.uuid ? prev : channel))
  }, [])
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (
        target !== null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable || target.tagName === 'VIDEO')
      ) {
        return
      }
      const lineup = channels ?? []
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'PageUp' || event.key === 'PageDown') {
        event.preventDefault()
        const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : event.key === 'PageUp' ? -5 : 5
        const next = zapStep(lineup, selected?.uuid ?? null, delta)
        if (next !== null) setSelected((prev) => (prev?.uuid === next.uuid ? prev : next))
        return
      }
      if (/^[0-9]$/.test(event.key)) {
        event.preventDefault()
        const buffer = appendDigit(digitsRef.current, event.key, lineup)
        digitsRef.current = buffer
        setDigitBuffer(buffer)
        const immediate = resolveNumberImmediate(lineup, buffer)
        if (immediate !== null) {
          commitDigits(immediate)
          return
        }
        if (digitTimerRef.current !== null) window.clearTimeout(digitTimerRef.current)
        digitTimerRef.current = window.setTimeout(() => {
          digitTimerRef.current = null
          commitDigits(resolveNumberExact(lineup, digitsRef.current))
        }, 2000)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      if (digitTimerRef.current !== null) window.clearTimeout(digitTimerRef.current)
    }
  }, [channels, selected?.uuid, commitDigits])

  const groups = useMemo(() => {
    const set = new Set<string>()
    for (const ch of channels ?? []) if (ch.group_name !== null) set.add(ch.group_name)
    return ['all', ...Array.from(set).sort((a, b) => a.localeCompare(b))]
  }, [channels, favorites])

  const filtering = search.trim() !== '' || group !== 'all'
  const byUuid = useMemo(() => new Map((channels ?? []).map((c) => [c.uuid, c])), [channels])

  // Sidebar sections: ★ favorites pinned, then recently watched, then the rest — only when
  // not filtering; a filter shows one flat matching list.
  const sections = useMemo(() => {
    const all = channels ?? []
    if (filtering) {
      const needle = search.trim().toLowerCase()
      return [
        {
          label: null,
          items: all.filter((ch) => {
            if (group !== 'all' && ch.group_name !== group) return false
            return needle === '' || ch.name.toLowerCase().includes(needle)
          })
        }
      ]
    }
    const favItems = all.filter((ch) => favorites.has(ch.uuid))
    const recentItems = recents
      .map((r) => byUuid.get(r.uuid))
      .filter((ch): ch is Channel => ch !== undefined && !favorites.has(ch.uuid))
    const rest = all.filter((ch) => !favorites.has(ch.uuid) && !recentItems.some((r) => r.uuid === ch.uuid))
    const out: Array<{ label: string | null; items: Channel[] }> = []
    if (favItems.length > 0) out.push({ label: '★ Favorites', items: favItems })
    if (recentItems.length > 0) out.push({ label: 'Recent', items: recentItems })
    out.push({ label: favItems.length > 0 || recentItems.length > 0 ? 'All channels' : null, items: rest })
    return out
  }, [channels, favorites, recents, filtering, search, group, byUuid])

  return (
    <section className="view">
      <div className="watch-layout" style={{ gridTemplateColumns: `${sidebarWidth}px 6px 1fr` }}>
        <aside className="watch-list">
          <input
            type="search"
            placeholder="Search channels & programmes…"
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
            {sections.map((section) => (
              <li key={section.label ?? 'all'} className="watch-section">
                {section.label !== null && <span className="watch-section-label">{section.label}</span>}
                <ul className="watch-channel-list">
                  {section.items.map((ch) => (
                    <li key={ch.uuid} className="watch-channel-row">
                      <button
                        type="button"
                        className={selected?.uuid === ch.uuid ? 'watch-channel watch-channel-active' : 'watch-channel'}
                        onClick={() => tune(ch)}
                      >
                        <span className="channel-number">{ch.channel_number ?? ''}</span>
                        <span className="channel-name">{ch.name}</span>
                      </button>
                      <button
                        type="button"
                        className={favorites.has(ch.uuid) ? 'star-btn star-on' : 'star-btn'}
                        title={favorites.has(ch.uuid) ? 'Remove from favorites' : 'Add to favorites'}
                        aria-label={favorites.has(ch.uuid) ? 'Remove from favorites' : 'Add to favorites'}
                        onClick={() => void toggleFavorite(ch)}
                      >
                        {favorites.has(ch.uuid) ? '★' : '☆'}
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
            {channels !== null && channels.length === 0 && (
              <li className="muted-note">No channels — sync first in Settings.</li>
            )}
            {needle !== '' && programmeHits !== null && programmeHits.length > 0 && (
              <li className="watch-section">
                <span className="watch-section-label">
                  Programmes{programmeHits.length > 12 ? ` — 12 of ${programmeHits.length}` : ''}
                </span>
                <ul className="watch-channel-list">
                  {programmeHits.slice(0, 12).map((hit) => (
                    <li key={`${hit.uuid}-${hit.start_utc}`} className="watch-channel-row">
                      <button
                        type="button"
                        className="watch-programme-hit"
                        title={`${hit.title}\n${hit.name} · ${formatClock(hit.start_utc)}–${formatClock(hit.stop_utc)}`}
                        onClick={() => {
                          const channel = byUuid.get(hit.uuid)
                          if (channel !== undefined) tune(channel)
                        }}
                      >
                        <span className="programme-hit-time">{formatClock(hit.start_utc)}</span>
                        <span className="programme-hit-main">
                          <span className="programme-hit-title">{hit.title}</span>
                          <span className="programme-hit-channel">{hit.name}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            )}
            {filtering && sections.every((s) => s.items.length === 0) && (programmeHits === null || programmeHits.length === 0) && (
              <li className="muted-note">No matches in channels or programmes.</li>
            )}
          </ul>
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
            {digitBuffer !== null && digitBuffer !== '' && <div className="zap-osd">{digitBuffer}</div>}
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
                Quality{' '}
                <select
                  value={prefs.maxHeight === null ? '' : String(prefs.maxHeight)}
                  onChange={(e) => {
                    const raw = e.target.value
                    setPrefs((prev) => {
                      const next = { ...prev, maxHeight: raw === '' ? null : Number(raw) }
                      savePrefs(next)
                      return next
                    })
                  }}
                >
                  <option value="">Source</option>
                  <option value="1080">1080p</option>
                  <option value="720">720p</option>
                  <option value="480">480p</option>
                </select>
              </label>
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
          {autoplayBlocked && status.kind !== 'playing' && (
            <p className="status-banner status-banner-warn">Press ▶ to start — the browser blocked autoplay with sound.</p>
          )}
          {status.kind === 'playing' && <p className="status-banner status-banner-ok">Playing live.</p>}
          {codecNote !== null && selected !== null && <p className="muted-note">Codecs: {codecNote}</p>}

          <GuideView embedded onWatch={tune} />
        </div>
      </div>
    </section>
  )
}
