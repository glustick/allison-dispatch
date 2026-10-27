import { useCallback, useEffect, useRef, useState } from 'react'
import { getJson, type VodMovie, type VodMoviesResponse } from '../lib/api.js'
import { loadPrefs, type PlaybackPrefs } from '../lib/playback.js'
import { useLivePlayer } from '../lib/useLivePlayer.js'

function formatDuration(secs: number | null): string | null {
  if (secs === null || secs <= 0) return null
  const h = Math.floor(secs / 3600)
  const m = Math.round((secs % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

// The VOD screen: the provider's movie library (synced daily from Dispatcharr's REST into
// SQLite), searched and paged server-side. Clicking a poster plays it through the same
// audio-fix relay as live TV — one player at the top, browse grid underneath.
export default function VodView(): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<VodMoviesResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<VodMovie | null>(null)
  const [prefs] = useState<PlaybackPrefs>(() => loadPrefs())

  const player = useLivePlayer(null, prefs, false, selected !== null ? { uuid: selected.uuid } : null)
  const gridRef = useRef<HTMLDivElement | null>(null)

  // Debounced browse: every keystroke (or page turn) refetches from the BFF.
  const needle = search.trim()
  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      getJson<VodMoviesResponse>(
        `/api/vod/movies?q=${encodeURIComponent(needle)}&page=${page}&page_size=60`
      )
        .then((body) => {
          if (cancelled) return
          setData(body)
          setError(null)
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err))
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [needle, page])

  const pageCount = data !== null ? Math.max(1, Math.ceil(data.count / data.pageSize)) : 1
  const lastQuery = useRef('')
  const onSearch = useCallback((value: string): void => {
    setSearch(value)
    if (value.trim() !== lastQuery.current) setPage(1)
    lastQuery.current = value.trim()
  }, [])

  return (
    <section className="view">
      {selected !== null && (
        <div className="card vod-player-card">
          <div className="video-frame">
            <video ref={player.attachVideo} controls autoPlay playsInline className="watch-video" />
            <span className="tile-name">{selected.name}</span>
            {player.status.kind === 'connecting' && <p className="tile-status">Connecting…</p>}
            {player.status.kind === 'failed' && (
              <p className="tile-status tile-status-error">{player.status.message ?? 'Failed.'}</p>
            )}
          </div>
          <div className="watch-bar">
            <div className="watch-now-next">
              <strong>{selected.name}</strong>
              {selected.year !== null && <span className="muted-note"> · {selected.year}</span>}
              {selected.genre !== null && <span className="muted-note"> · {selected.genre}</span>}
              {selected.rating !== null && <span className="muted-note"> · ★ {selected.rating}</span>}
              {formatDuration(selected.duration_secs) !== null && (
                <span className="muted-note"> · {formatDuration(selected.duration_secs)}</span>
              )}
            </div>
            <div className="watch-controls">
              <button type="button" onClick={() => setSelected(null)}>Close</button>
            </div>
          </div>
          {player.status.kind === 'failed' && (
            <button type="button" className="banner-retry" onClick={() => player.restart()}>
              Try again
            </button>
          )}
        </div>
      )}

      <div className="vod-toolbar">
        <input
          type="search"
          placeholder={`Search ${data?.count?.toLocaleString() ?? 'the'} movies…`}
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          aria-label="Search movies"
        />
        <span className="muted-note">
          {data !== null ? `${data.count.toLocaleString()} movies` : 'Loading library…'}
        </span>
      </div>

      {error !== null && <p className="status-error">Library failed to load: {error}</p>}
      {data !== null && data.count > 0 && data.movies.length === 0 && (
        <p className="muted-note">No movies match. The library syncs daily — or sync now in Settings.</p>
      )}
      {data !== null && data.count === 0 && (
        <p className="muted-note">
          Library empty — set the Dispatcharr account in Settings (admin) and run a sync with VOD.
        </p>
      )}

      <div className="vod-grid" ref={gridRef}>
        {(data?.movies ?? []).map((movie) => (
          <button
            type="button"
            className="vod-card"
            key={movie.uuid}
            onClick={() => setSelected(movie)}
            title={movie.description ?? movie.name}
          >
            {movie.logo !== null ? (
              <img src={movie.logo} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.visibility = 'hidden' }} />
            ) : (
              <span className="vod-card-fallback">{movie.name.slice(0, 1)}</span>
            )}
            <span className="vod-card-name">{movie.name}</span>
            {movie.year !== null && <span className="vod-card-year">{movie.year}</span>}
          </button>
        ))}
      </div>

      {pageCount > 1 && (
        <div className="vod-pager">
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>‹ Prev</button>
          <span className="muted-note">Page {page} of {pageCount.toLocaleString()}</span>
          <button type="button" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>Next ›</button>
        </div>
      )}
    </section>
  )
}
