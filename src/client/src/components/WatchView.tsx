import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getJson, sendJson, type Channel, type ChannelsResponse, type ProgrammeHit, type ProgrammeSearchResponse, type Reminder, type RemindersResponse } from '../lib/api.js'
import { isReminderDue, reminderKey } from '../lib/reminders.js'
import { appendDigit, resolveNumberExact, resolveNumberImmediate, toggledChannel, zapStep } from '../lib/zapping.js'
import { loadPrefs, savePrefs, togglePictureInPicture, type OutputFormat, type PlaybackPrefs } from '../lib/playback.js'
import { buildMediaMetadata } from '../lib/mediaSession.js'
import { useLivePlayer } from '../lib/useLivePlayer.js'
import { addTile, assignChannel, collapseToSingle, focusTile, INITIAL_TILES, MAX_TILES, removeTile, stopTile, zapFocused, type TileState } from '../lib/tiles.js'
import GuideView from './GuideView.js'
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

function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// The one TV screen: resizable channel bar on the left (search + group filter — it absorbed
// the old Channels tab), player on the right with now/next, and the EPG guide under the
// player. Clicking a channel anywhere — sidebar or guide — tunes the focused tile in place.
// Playback always rides the BFF relay with the Dolby audio fix on (no toggle: without it
// there is no audio at all — every provider stream carries AC-3).
//
// Multi-view: "+ Tile" grows the grid from one picture to a 2×2 of four concurrent relay
// streams (inside the server's RELAY_MAX_STREAMS cap, raised to match). Exactly one tile is
// focused: it carries the audio, the zap keys and the now/next bar; the others are muted.
// Tile placement rules live in lib/tiles.ts — filling an empty side slot never steals audio
// from what's being watched. Audio-only streams (radio channels) render a radio card with
// the channel logo instead of a black rectangle — the <video> element is still the engine.
export default function WatchView(): React.JSX.Element {
  const [channels, setChannels] = useState<Channel[] | null>(null)
  const [search, setSearch] = useState('')
  const [group, setGroup] = useState('all')
  const [tiles, setTiles] = useState<TileState>(INITIAL_TILES)
  const [prefs, setPrefs] = useState<PlaybackPrefs>(() => loadPrefs())
  const [digitBuffer, setDigitBuffer] = useState<string | null>(null)

  const activeChannel = (index: number): Channel | null => (index < tiles.count ? tiles.channels[index] ?? null : null)
  const main = activeChannel(0)
  const focusedChannel = activeChannel(tiles.focused)
  const focusedUuid = focusedChannel?.uuid ?? null
  // Tiles 1+ mount muted: a muted video autoplays without a gesture; focusing one (a click)
  // is the gesture that unmutes. The audio-sync effect below keeps this true on every change.
  // All MAX_TILES hooks exist for the session — an unused one sits idle on a null channel.
  const players = [
    useLivePlayer(activeChannel(0), prefs),
    useLivePlayer(activeChannel(1), prefs, true),
    useLivePlayer(activeChannel(2), prefs, true),
    useLivePlayer(activeChannel(3), prefs, true)
  ]

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
        if (hist.recents.length > 0) setTiles((s) => assignChannel(s, hist.recents[0]))
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

  // Audio follows focus: the focused tile is the only unmuted one (single mode = tile 0
  // unmuted, exactly as before tiles existed). Hook setters are stable; the tile shapes
  // below fully determine the audio map, so the hook objects stay out of the deps.
  const activeUuids = tiles.channels.map((c) => c?.uuid ?? null).join('|')
  useEffect(() => {
    for (let i = 0; i < players.length; i++) {
      players[i].setMuted(i !== tiles.focused)
    }
  }, [tiles.focused, tiles.count, activeUuids])

  // ---- Last-channel memory (the remote's "back" button) ----
  // Whenever the focused tile moves from one channel to another, remember where it came
  // from. 'z'/Backspace then jumps back — and because that jump is itself a change, the
  // next press returns, remote-toggle style. Stopping a tile doesn't erase the memory, so
  // "stop, watch something else, back" still finds the stopped channel.
  const lastChannelRef = useRef<string | null>(null)
  const prevFocusedRef = useRef<string | null>(null)
  useEffect(() => {
    if (focusedUuid === null) return
    if (prevFocusedRef.current !== null && prevFocusedRef.current !== focusedUuid) {
      lastChannelRef.current = prevFocusedRef.current
    }
    prevFocusedRef.current = focusedUuid
  }, [focusedUuid])

  // ---- Now/next for every active tile (the focused one also drives the bar below) ----
  const [nowNextByUuid, setNowNextByUuid] = useState<Record<string, NowNextPayload>>({})
  useEffect(() => {
    if (activeUuids === '') {
      setNowNextByUuid({})
      return
    }
    const uuids = activeUuids.split('|')
    let cancelled = false
    async function poll(): Promise<void> {
      const pairs = await Promise.all(
        uuids.map(async (uuid) => {
          try {
            return [uuid, await getJson<NowNextPayload>(`/api/epg/now-next?uuid=${encodeURIComponent(uuid)}`)] as const
          } catch {
            return [uuid, null] as const
          }
        })
      )
      if (cancelled) return
      const map: Record<string, NowNextPayload> = {}
      for (const [uuid, payload] of pairs) {
        if (payload !== null) map[uuid] = payload
      }
      setNowNextByUuid(map)
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 30_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [activeUuids])
  const focusedNowNext = focusedUuid !== null ? nowNextByUuid[focusedUuid] ?? null : null

  // ---- OS media controls (Media Session): hardware keys, the media HUD, the lock screen ----
  // The focused tile is "what's playing": programme + channel + logo in the HUD, and the
  // media keys behave like a remote (play/pause, next/previous channel, stop).
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    if (focusedChannel === null) {
      ms.metadata = null
      ms.playbackState = 'none'
      return
    }
    ms.metadata = new MediaMetadata(
      buildMediaMetadata({ channel: focusedChannel, nowTitle: focusedNowNext?.now?.title ?? null })
    )
    ms.playbackState = players[tiles.focused].status.kind === 'playing' ? 'playing' : 'paused'
    ms.setActionHandler('play', () => { void players[tiles.focused].getVideoEl()?.play() })
    ms.setActionHandler('pause', () => { players[tiles.focused].getVideoEl()?.pause() })
    ms.setActionHandler('previoustrack', () => setTiles((s) => zapFocused(s, channels ?? [], -1, zapStep)))
    ms.setActionHandler('nexttrack', () => setTiles((s) => zapFocused(s, channels ?? [], 1, zapStep)))
    ms.setActionHandler('stop', () => setTiles((s) => stopTile(s, s.focused)))
  }, [focusedChannel, focusedNowNext, tiles.focused, channels, players[tiles.focused].status.kind])

  // The tab (and any PiP window) names the channel it is playing.
  useEffect(() => {
    document.title = focusedChannel !== null ? `${focusedChannel.name} · Allison Dispatch` : 'Allison Dispatch'
  }, [focusedChannel])

  // ---- Keyboard shortcuts overlay ('?') ----
  const [helpOpen, setHelpOpen] = useState(false)

  // ---- Programme reminders: poll, toast the ones just starting, delete them server-side ----
  // The pure timing rule (isReminderDue) keeps a tab reopened after hours from replaying a
  // whole evening of stale reminders; the fired-set keeps one programme from toasting twice
  // in a session even if the poll and the delete race.
  const [toasts, setToasts] = useState<Reminder[]>([])
  const firedRemindersRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    let cancelled = false
    async function poll(): Promise<void> {
      try {
        const body = await getJson<RemindersResponse>('/api/reminders')
        if (cancelled) return
        const now = Date.now()
        for (const reminder of body.reminders) {
          const key = reminderKey(reminder.tvg_id, reminder.start_utc)
          if (!isReminderDue(reminder.start_utc, now) || firedRemindersRef.current.has(key)) continue
          firedRemindersRef.current.add(key)
          setToasts((prev) => [...prev, reminder])
          void sendJson(`/api/reminders/${encodeURIComponent(reminder.tvg_id)}/${reminder.start_utc}`, 'DELETE').catch(() => {})
          window.setTimeout(() => {
            setToasts((prev) => prev.filter((t) => t !== reminder))
          }, 60_000)
        }
      } catch {
        // Reminder polling is best-effort.
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 30_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  function dismissToast(reminder: Reminder): void {
    setToasts((prev) => prev.filter((t) => t !== reminder))
  }

  function watchToast(reminder: Reminder): void {
    const channel = byUuid.get(reminder.channel_uuid)
    if (channel !== undefined) tune(channel)
    dismissToast(reminder)
  }

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

  function tune(channel: Channel): void {
    setTiles((prev) => assignChannel(prev, channel))
  }

  // ---- Picture-in-Picture for the focused tile (Safari's webkit mode covered in the helper) ----
  const [pipAvailable] = useState(
    () => typeof document !== 'undefined' && (document.pictureInPictureEnabled === true || 'webkitSupportsPictureInPicture' in document)
  )
  async function togglePip(): Promise<void> {
    const video = players[tiles.focused].getVideoEl()
    if (video === null) return
    try {
      await togglePictureInPicture(video)
    } catch {
      // The browser refused (rare — e.g. mid-fullscreen transition); nothing sensible to show.
    }
  }

  // ---- Keyboard zapping (TV style): ↑/↓ ±1, PgUp/PgDn ±5, digits = number entry with a
  // 2s commit timeout. Targets the FOCUSED tile. Skipped while typing in a field, while the
  // video element (its own controls use arrows) has focus, and for modifier chords. ----
  const digitsRef = useRef('')
  const digitTimerRef = useRef<number | null>(null)
  const commitDigits = useCallback((channel: Channel | null): void => {
    digitsRef.current = ''
    setDigitBuffer(null)
    if (digitTimerRef.current !== null) {
      window.clearTimeout(digitTimerRef.current)
      digitTimerRef.current = null
    }
    if (channel !== null) setTiles((prev) => assignChannel(prev, channel))
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
        setTiles((prev) => zapFocused(prev, lineup, delta, zapStep))
        return
      }
      if (event.key === 'z' || event.key === 'Backspace') {
        // "Back" on a remote: return the focused tile to the channel it just left.
        event.preventDefault()
        const back = toggledChannel(lineup, lastChannelRef.current)
        if (back !== null) setTiles((prev) => assignChannel(prev, back))
        return
      }
      if (event.key === '?') {
        event.preventDefault()
        setHelpOpen((open) => !open)
        return
      }
      if (event.key === 'Escape') {
        setHelpOpen(false)
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
  }, [channels, focusedChannel?.uuid, commitDigits])

  const groups = useMemo(() => {
    const set = new Set<string>()
    for (const ch of channels ?? []) if (ch.group_name !== null) set.add(ch.group_name)
    return ['all', ...Array.from(set).sort((a, b) => a.localeCompare(b))]
  }, [channels, favorites])

  const filtering = search.trim() !== '' || group !== 'all'
  const byUuid = useMemo(() => new Map((channels ?? []).map((c) => [c.uuid, c])), [channels])

  // Sidebar sections: ★ favorites pinned, then recently watched, then the rest — only when
  // not filtering; a filter shows one flat matching list. Names match the needle; a purely
  // numeric needle also matches channel numbers by prefix ("10" finds channel 101…109, 100x).
  const sections = useMemo(() => {
    const all = channels ?? []
    if (filtering) {
      const needle = search.trim().toLowerCase()
      const needleIsNumber = /^\d+$/.test(needle)
      return [
        {
          label: null,
          items: all.filter((ch) => {
            if (group !== 'all' && ch.group_name !== group) return false
            if (needle === '') return true
            if (ch.name.toLowerCase().includes(needle)) return true
            return needleIsNumber && ch.channel_number !== null && String(ch.channel_number).startsWith(needle)
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

  const focusedStatus = players[tiles.focused]

  // A compact per-tile status line (multi-tile mode keeps banners out of the way).
  function tileStatus(status: { kind: string; message: string | null }, autoplayBlocked: boolean): string {
    if (status.kind === 'failed') return status.message ?? 'Failed.'
    if (status.kind === 'reconnecting') return status.message ?? 'Reconnecting…'
    if (status.kind === 'connecting') return 'Connecting…'
    if (status.kind === 'playing') return autoplayBlocked ? 'Press ▶ for sound' : 'Playing live'
    return ''
  }

  function renderTile(index: number): React.JSX.Element {
    const player = players[index]
    const channel = activeChannel(index)
    const isFocused = tiles.focused === index
    const multi = tiles.count > 1
    const tileNow = channel !== null ? nowNextByUuid[channel.uuid]?.now ?? null : null
    return (
      <div
        className={`watch-tile${isFocused ? ' watch-tile-focused' : ''}${multi ? '' : ' watch-tile-solo'}`}
        onClick={() => setTiles((s) => focusTile(s, index))}
        role={multi ? 'button' : undefined}
        aria-label={multi ? `Focus ${channel?.name ?? 'empty tile'}` : undefined}
      >
        <div className="video-frame">
          <video ref={player.attachVideo} controls playsInline className="watch-video" />
          {isFocused && digitBuffer !== null && digitBuffer !== '' && <div className="zap-osd">{digitBuffer}</div>}
          {player.audioOnly && channel !== null && (
            <div className={`tile-radio${player.status.kind === 'playing' ? ' tile-radio-live' : ''}`} aria-hidden="true">
              {channel.logo_url !== null && <img className="tile-radio-logo" src={channel.logo_url} alt="" loading="lazy" />}
              <span className="tile-radio-name">{channel.name}</span>
              <span className="tile-radio-bars">
                <i /><i /><i /><i />
              </span>
            </div>
          )}
          {channel?.catchupStartMs != null && (
            <span className="tile-catchup" title={`Catch-up from ${new Date(channel.catchupStartMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}>
              ⏪ catch-up
            </span>
          )}
          {multi && channel === null && <div className="tile-hint">Pick a channel to fill this tile.</div>}
          {multi && channel !== null && !player.audioOnly && (
            <span className={`tile-name${channel.catchupStartMs != null ? ' tile-name-catchup' : ''}`}>{channel.name}</span>
          )}
          {multi && channel !== null && !player.audioOnly && tileNow !== null && <span className="tile-now">{tileNow.title}</span>}
          {multi && channel !== null && !isFocused && <span className="tile-muted-badge">muted</span>}
          {multi && tileStatus(player.status, player.autoplayBlocked) !== '' && (
            <p className={`tile-status${player.status.kind === 'failed' ? ' tile-status-error' : ''}`}>
              {tileStatus(player.status, player.autoplayBlocked)}
            </p>
          )}
          {multi && player.status.kind === 'failed' && (
            <button
              type="button"
              className="tile-retry"
              onClick={(e) => {
                e.stopPropagation() // retrying is not focusing
                player.restart()
              }}
            >
              Try again
            </button>
          )}
          {multi && (
            <button
              type="button"
              className="tile-close"
              title="Close this tile"
              aria-label={`Close ${channel?.name ?? 'empty tile'} tile`}
              onClick={(e) => {
                e.stopPropagation() // closing is not focusing
                setTiles((s) => removeTile(s, index))
              }}
            >
              ×
            </button>
          )}
        </div>
      </div>
    )
  }

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
                  {section.items.map((ch) => {
                    const onFocused = focusedChannel?.uuid === ch.uuid
                    const onAnyTile = tiles.channels.some((c) => c?.uuid === ch.uuid)
                    return (
                      <li key={ch.uuid} className="watch-channel-row">
                        <button
                          type="button"
                          className={`watch-channel${ch.logo_url !== null ? ' watch-channel-logoed' : ''}${onFocused ? ' watch-channel-active' : ''}${onAnyTile && !onFocused ? ' watch-channel-passive' : ''}`}
                          onClick={() => tune(ch)}
                        >
                          {ch.logo_url !== null && (
                            <img
                              className="channel-logo"
                              src={ch.logo_url}
                              alt=""
                              loading="lazy"
                              onError={(e) => { e.currentTarget.style.visibility = 'hidden' }}
                            />
                          )}
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
                    )
                  })}
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
          <div
            className={tiles.count === 1 ? 'watch-tiles watch-tiles-single' : 'watch-tiles'}
            data-count={tiles.count}
          >
            {Array.from({ length: tiles.count }, (_, i) => renderTile(i))}
          </div>

          <div className="watch-bar">
            <div className="watch-now-next">
              {focusedChannel === null ? (
                <span className="muted-note">
                  {tiles.count > 1 ? 'Click a tile, then pick a channel.' : 'Pick a channel to start watching.'}
                </span>
              ) : (
                <>
                  <strong>{focusedChannel.name}</strong>
                  {focusedNowNext?.now != null && (
                    <span className="muted-note">
                      {' '}· now: {focusedNowNext.now.title} ({formatClock(focusedNowNext.now.start_utc)}–{formatClock(focusedNowNext.now.stop_utc)})
                    </span>
                  )}
                  {focusedNowNext?.next != null && (
                    <span className="muted-note"> · next: {focusedNowNext.next.title}</span>
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
              {main !== null && tiles.count < MAX_TILES && (
                <button
                  type="button"
                  onClick={() => setTiles((s) => addTile(s))}
                  title={`Add another tile — up to ${MAX_TILES} channels at once`}
                >
                  + Tile
                </button>
              )}
              {tiles.count > 1 && (
                <button
                  type="button"
                  onClick={() => setTiles((s) => collapseToSingle(s))}
                  title="Back to one tile — the other streams stop"
                >
                  Single
                </button>
              )}
              {focusedChannel !== null && pipAvailable && (
                <button
                  type="button"
                  onClick={() => void togglePip()}
                  title="Pop the focused picture out into a floating window (Picture-in-Picture)"
                >
                  PiP
                </button>
              )}
              {focusedChannel !== null && (
                <button type="button" onClick={() => setTiles((s) => stopTile(s, s.focused))}>
                  Stop
                </button>
              )}
              <button
                type="button"
                onClick={() => setHelpOpen(true)}
                title="Keyboard shortcuts"
                aria-label="Keyboard shortcuts"
              >
                ?
              </button>
            </div>
          </div>

          {tiles.count === 1 && (
            <>
              {players[0].status.kind === 'reconnecting' && (
                <p className="status-banner status-banner-warn">{players[0].status.message}</p>
              )}
              {players[0].status.kind === 'failed' && (
                <p className="status-banner status-banner-error">{players[0].status.message}</p>
              )}
              {players[0].status.kind === 'failed' && (
                <button type="button" className="banner-retry" onClick={() => players[0].restart()}>
                  Try again
                </button>
              )}
              {players[0].status.kind === 'connecting' && <p className="status-banner">Connecting…</p>}
              {players[0].autoplayBlocked && players[0].status.kind !== 'playing' && (
                <p className="status-banner status-banner-warn">Press ▶ to start — the browser blocked autoplay with sound.</p>
              )}
              {players[0].status.kind === 'playing' && <p className="status-banner status-banner-ok">Playing live.</p>}
            </>
          )}
          {focusedChannel !== null && focusedStatus.codecNote !== null && (
            <p className="muted-note">Codecs: {focusedStatus.codecNote}</p>
          )}

          {helpOpen && (
            <div className="help-overlay" onClick={() => setHelpOpen(false)}>
              <div className="help-card" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
                <h2>Keyboard shortcuts</h2>
                <dl className="help-list">
                  <dt>↑ / ↓</dt>
                  <dd>Previous / next channel</dd>
                  <dt>PgUp / PgDn</dt>
                  <dd>Zap five channels at a time</dd>
                  <dt>0–9</dt>
                  <dd>Enter a channel number, like a remote</dd>
                  <dt>z / Backspace</dt>
                  <dd>Back to the previous channel (press again to return)</dd>
                  <dt>?</dt>
                  <dd>This help</dd>
                </dl>
                <p className="muted-note">Keys are ignored while typing in a field. Clicking a channel anywhere tunes the focused tile.</p>
                <button type="button" onClick={() => setHelpOpen(false)}>Close</button>
              </div>
            </div>
          )}

          <GuideView embedded onWatch={tune} favorites={favorites} />
        </div>

        {toasts.length > 0 && (
          <div className="toast-stack" role="status" aria-live="polite">
            {toasts.map((reminder) => (
              <div className="toast" key={reminderKey(reminder.tvg_id, reminder.start_utc)}>
                <div className="toast-main">
                  <strong>{reminder.title}</strong>
                  <span className="muted-note">
                    starting now on {byUuid.get(reminder.channel_uuid)?.name ?? 'a channel'}
                  </span>
                </div>
                <div className="toast-actions">
                  <button type="button" onClick={() => watchToast(reminder)}>Watch</button>
                  <button type="button" onClick={() => dismissToast(reminder)} aria-label="Dismiss reminder">×</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
