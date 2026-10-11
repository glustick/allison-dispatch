import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getJson, type Channel, type ChannelsResponse, type ProgrammeHit, type ProgrammeSearchResponse } from '../lib/api.js'
import { appendDigit, resolveNumberExact, resolveNumberImmediate, zapStep } from '../lib/zapping.js'
import { loadPrefs, savePrefs, type OutputFormat, type PlaybackPrefs } from '../lib/playback.js'
import { useLivePlayer } from '../lib/useLivePlayer.js'
import { assignChannel, enterSplit, exitSplit, focusTile, INITIAL_TILES, stopTile, zapFocused, type TileState } from '../lib/tiles.js'
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
// Multi-view: "Split" opens a second tile (two concurrent relay streams — inside the server's
// RELAY_MAX_STREAMS cap). Exactly one tile is focused: it carries the audio, the zap keys and
// the now/next bar; the other is muted. Tile placement rules live in lib/tiles.ts — filling
// the second slot never steals audio from what's being watched.
export default function WatchView(): React.JSX.Element {
  const [channels, setChannels] = useState<Channel[] | null>(null)
  const [search, setSearch] = useState('')
  const [group, setGroup] = useState('all')
  const [tiles, setTiles] = useState<TileState>(INITIAL_TILES)
  const [prefs, setPrefs] = useState<PlaybackPrefs>(() => loadPrefs())
  const [nowNext, setNowNext] = useState<NowNextPayload | null>(null)
  const [digitBuffer, setDigitBuffer] = useState<string | null>(null)

  const main = tiles.channels[0]
  const second = tiles.split ? tiles.channels[1] : null
  const focusedChannel = tiles.channels[tiles.focused]
  // Tile 1 mounts muted: a muted video autoplays without a gesture; focusing it (a click)
  // is the gesture that unmutes. The audio-sync effect below keeps this true on every change.
  const mainPlayer = useLivePlayer(main, prefs)
  const secondPlayer = useLivePlayer(second, prefs, true)

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
  // unmuted, exactly as before split existed). Hook setters are stable; the tile shapes
  // below fully determine the audio map, so the hook objects stay out of the deps.
  useEffect(() => {
    mainPlayer.setMuted(!(tiles.split && tiles.focused === 1))
    secondPlayer.setMuted(!(tiles.split && tiles.focused === 1))
  }, [tiles.split, tiles.focused, main?.uuid, second?.uuid])

  // Now/next for the focused tile's channel.
  useEffect(() => {
    if (focusedChannel === null) {
      setNowNext(null)
      return
    }
    const channel = focusedChannel
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
  }, [focusedChannel])

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

  const focusedStatus = tiles.focused === 0 ? mainPlayer : secondPlayer

  // A compact per-tile status line (split mode keeps banners out of the way).
  function tileStatus(status: { kind: string; message: string | null }, autoplayBlocked: boolean): string {
    if (status.kind === 'failed') return status.message ?? 'Failed.'
    if (status.kind === 'reconnecting') return status.message ?? 'Reconnecting…'
    if (status.kind === 'connecting') return 'Connecting…'
    if (status.kind === 'playing') return autoplayBlocked ? 'Press ▶ for sound' : 'Playing live'
    return ''
  }

  function renderTile(index: 0 | 1, player: ReturnType<typeof useLivePlayer>, channel: Channel | null): React.JSX.Element {
    const isFocused = tiles.focused === index
    return (
      <div
        className={`watch-tile${isFocused ? ' watch-tile-focused' : ''}${tiles.split ? '' : ' watch-tile-solo'}`}
        onClick={() => setTiles((s) => focusTile(s, index))}
        role={tiles.split ? 'button' : undefined}
        aria-label={tiles.split ? `Focus ${channel?.name ?? 'empty tile'}` : undefined}
      >
        <div className="video-frame">
          <video ref={player.attachVideo} controls playsInline className="watch-video" />
          {isFocused && digitBuffer !== null && digitBuffer !== '' && <div className="zap-osd">{digitBuffer}</div>}
          {tiles.split && channel === null && <div className="tile-hint">Pick a channel to fill this tile.</div>}
          {tiles.split && channel !== null && <span className="tile-name">{channel.name}</span>}
          {tiles.split && channel !== null && !isFocused && <span className="tile-muted-badge">muted</span>}
          {tiles.split && tileStatus(player.status, player.autoplayBlocked) !== '' && (
            <p className={`tile-status${player.status.kind === 'failed' ? ' tile-status-error' : ''}`}>
              {tileStatus(player.status, player.autoplayBlocked)}
            </p>
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
                    const onAnyTile = main?.uuid === ch.uuid || second?.uuid === ch.uuid
                    return (
                      <li key={ch.uuid} className="watch-channel-row">
                        <button
                          type="button"
                          className={`watch-channel${onFocused ? ' watch-channel-active' : ''}${onAnyTile && !onFocused ? ' watch-channel-passive' : ''}`}
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
          <div className={tiles.split ? 'watch-tiles' : 'watch-tiles watch-tiles-single'}>
            {renderTile(0, mainPlayer, main)}
            {tiles.split && renderTile(1, secondPlayer, second)}
          </div>

          <div className="watch-bar">
            <div className="watch-now-next">
              {focusedChannel === null ? (
                <span className="muted-note">
                  {tiles.split ? 'Click a tile, then pick a channel.' : 'Pick a channel to start watching.'}
                </span>
              ) : (
                <>
                  <strong>{focusedChannel.name}</strong>
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
              {main !== null && (
                <button
                  type="button"
                  onClick={() => setTiles((s) => (s.split ? exitSplit(s) : enterSplit(s)))}
                  title={tiles.split ? 'Back to one tile — the second stream stops' : 'Watch a second channel side by side'}
                >
                  {tiles.split ? 'Exit split' : 'Split'}
                </button>
              )}
              {focusedChannel !== null && (
                <button type="button" onClick={() => setTiles((s) => stopTile(s, s.focused))}>
                  Stop
                </button>
              )}
            </div>
          </div>

          {!tiles.split && (
            <>
              {mainPlayer.status.kind === 'reconnecting' && (
                <p className="status-banner status-banner-warn">{mainPlayer.status.message}</p>
              )}
              {mainPlayer.status.kind === 'failed' && (
                <p className="status-banner status-banner-error">{mainPlayer.status.message}</p>
              )}
              {mainPlayer.status.kind === 'connecting' && <p className="status-banner">Connecting…</p>}
              {mainPlayer.autoplayBlocked && mainPlayer.status.kind !== 'playing' && (
                <p className="status-banner status-banner-warn">Press ▶ to start — the browser blocked autoplay with sound.</p>
              )}
              {mainPlayer.status.kind === 'playing' && <p className="status-banner status-banner-ok">Playing live.</p>}
            </>
          )}
          {focusedChannel !== null && focusedStatus.codecNote !== null && (
            <p className="muted-note">Codecs: {focusedStatus.codecNote}</p>
          )}

          <GuideView embedded onWatch={tune} />
        </div>
      </div>
    </section>
  )
}
