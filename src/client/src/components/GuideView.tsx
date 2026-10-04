import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { getJson, type Channel } from '../lib/api.js'
import { loadSavedDimension, saveDimension, useResizableDimension } from '../lib/useResizableDimension.js'

const HOUR_MS = 3_600_000
const WINDOW_HOURS = 3
const WINDOW_MS = WINDOW_HOURS * HOUR_MS
const ROW_HEIGHT = 40
const PAN_THRESHOLD_PX = 4

// Mirrors the sibling app's EPG grid (its EpgGrid.tsx, itself from the desktop app):
// channels down, time across, programmes as blocks sized by duration; drag the timeline to
// pan through time; a red now-line when the window contains the present; click a programme
// for its details, click a channel to go watch it. The channel column is drag-resizable and
// persisted, like the sibling's. Scaled down for this app's lineup size: plain rows instead
// of react-window virtualization (24 channels here vs thousands there).
interface ProgrammeRow {
  title: string
  description: string | null
  category: string | null
  start_utc: number
  stop_utc: number
}

interface GridChannel extends Channel {
  programmes: ProgrammeRow[]
}

interface GridResponse {
  count: number
  channels: GridChannel[]
}

interface Selection {
  channel: GridChannel
  programme: ProgrammeRow
}

function pct(t: number, windowStart: number, windowEnd: number): number {
  return ((t - windowStart) / (windowEnd - windowStart)) * 100
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function hourLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric' })
}

export default function GuideView({ onWatch, embedded = false }: { onWatch: (channel: Channel) => void; embedded?: boolean }): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const [windowOffsetMs, setWindowOffsetMs] = useState(0)
  const [grid, setGrid] = useState<GridResponse | null>(null)
  const [gridError, setGridError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<Selection | null>(null)
  const [panning, setPanning] = useState(false)

  const { dimension: channelColWidth, startDrag: startChannelColDrag } = useResizableDimension(
    loadSavedDimension('allison-dispatch.guide-channel-col', 160, 90, 320),
    'x',
    { min: 90, max: 320, onCommit: (w) => saveDimension('allison-dispatch.guide-channel-col', w) }
  )

  const baseHour = Math.floor(now / HOUR_MS) * HOUR_MS
  const windowStart = baseHour + windowOffsetMs
  const windowEnd = windowStart + WINDOW_MS

  // Ticking clock for the now-line (and the base-hour anchor, which snaps the window back to
  // the current hour as real time crosses it — the same anchoring the sibling uses).
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const reload = useCallback((start: number, end: number): void => {
    setLoading(true)
    getJson<GridResponse>(`/api/epg/grid?start=${start}&end=${end}`)
      .then((body) => {
        setGrid(body)
        setGridError(null)
      })
      .catch((err: unknown) => setGridError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [])

  const fetchKey = `${windowStart}`
  useEffect(() => {
    reload(windowStart, windowEnd)
    // Refetches when the hour-aligned window moves; reload is stable and now/windowEnd are
    // captured per fetchKey change.
  }, [fetchKey])

  // ---- drag-to-pan through time (horizontal only; the channel list scrolls on its own) ----
  const panRef = useRef<{ startX: number; startOffset: number; width: number; pointerId: number } | null>(null)
  const pannedRef = useRef(false)
  const offsetRef = useRef(0)
  offsetRef.current = windowOffsetMs
  const didPan = useCallback((): boolean => pannedRef.current, [])

  const onTimelinePointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const track = event.currentTarget
    track.setPointerCapture(event.pointerId)
    panRef.current = {
      startX: event.clientX,
      startOffset: offsetRef.current,
      width: track.getBoundingClientRect().width,
      pointerId: event.pointerId
    }
    pannedRef.current = false
    const onMove = (ev: PointerEvent): void => {
      const g = panRef.current
      if (g === null || ev.pointerId !== g.pointerId) return
      const dx = event.clientX - ev.clientX
      if (Math.abs(dx) > PAN_THRESHOLD_PX) {
        setPanning(true)
        pannedRef.current = true
      }
      if (!pannedRef.current) return
      setWindowOffsetMs(g.startOffset + Math.round((dx / g.width) * WINDOW_MS))
    }
    const finish = (ev: PointerEvent): void => {
      const g = panRef.current
      if (g === null || ev.pointerId !== g.pointerId) return
      panRef.current = null
      setPanning(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  const hours: number[] = []
  for (let t = windowStart; t < windowEnd; t += HOUR_MS) hours.push(t)
  const showNowLine = now >= windowStart && now <= windowEnd
  const nowPct = pct(now, windowStart, windowEnd)

  return (
    <section className={`view epg-grid${panning ? ' epg-grid--panning' : ''}${embedded ? ' epg-grid--embedded' : ''}`}>
      <div className="epg-time-header">
        <div className="epg-grid-nav" style={{ width: channelColWidth }}>
          <button
            type="button"
            className="epg-resize-handle"
            onPointerDown={startChannelColDrag}
            title="Drag to resize the channel column"
            aria-label="Resize channel column"
          />
          <button
            type="button"
            className="epg-now-btn"
            onClick={() => {
              setWindowOffsetMs(0)
              setDetail(null)
            }}
          >
            Now
          </button>
        </div>
        <div className="epg-time-header-track" onPointerDown={onTimelinePointerDown} title="Drag left/right to move through time">
          {hours.map((t) => (
            <span key={t} className="epg-time-tick" style={{ left: `${pct(t, windowStart, windowEnd)}%` }}>
              {hourLabel(t)}
            </span>
          ))}
          {showNowLine && <span className="epg-time-tick epg-time-tick--now" style={{ left: `${nowPct}%` }}>{formatTime(now)}</span>}
        </div>
      </div>

      <div className="epg-grid-body">
        {gridError !== null && <p className="status-error">Guide failed to load: {gridError}</p>}
        {loading && grid === null && <p className="muted-note">Loading guide…</p>}
        {grid !== null && grid.count === 0 && (
          <p className="empty-hint">No channels yet — sync first in Settings.</p>
        )}
        <div className="epg-rows">
          {(grid?.channels ?? []).map((channel) => (
            <div className="epg-row" key={channel.uuid} style={{ height: ROW_HEIGHT }}>
              <button
                type="button"
                className="epg-row-channel"
                style={{ width: channelColWidth }}
                onClick={() => onWatch(channel)}
                title={`Watch ${channel.name}`}
              >
                {channel.logo_url !== null
                  ? <img src={channel.logo_url} alt="" loading="lazy" />
                  : <span className="epg-row-channel-icon placeholder">{channel.name.slice(0, 1)}</span>}
                <span className="epg-row-channel-name">{channel.name}</span>
              </button>
              <div
                className="epg-row-timeline"
                onPointerDown={onTimelinePointerDown}
              >
                {channel.programmes.length === 0 && <span className="epg-row-empty">No guide data</span>}
                {channel.programmes
                  .filter((p) => p.stop_utc > windowStart && p.start_utc < windowEnd)
                  .map((p) => {
                    const left = pct(p.start_utc, windowStart, windowEnd)
                    const width = Math.max(pct(p.stop_utc, windowStart, windowEnd) - left, 2)
                    const isPast = p.stop_utc <= now
                    const isLive = p.start_utc <= now && p.stop_utc > now
                    return (
                      <button
                        key={`${channel.uuid}-${p.start_utc}`}
                        type="button"
                        className={`epg-block${isPast ? ' epg-block--past' : ''}${isLive ? ' epg-block--live' : ''}`}
                        style={{ left: `${left}%`, width: `${width}%` }}
                        title={`${formatTime(p.start_utc)} – ${formatTime(p.stop_utc)}\n${p.title}`}
                        onClick={() => {
                          if (didPan()) return
                          setDetail({ channel, programme: p })
                        }}
                      >
                        <span className="epg-block-label">{formatTime(p.start_utc)} {p.title}</span>
                      </button>
                    )
                  })}
                {showNowLine && <div className="epg-now-indicator" style={{ left: `${nowPct}%` }} />}
              </div>
            </div>
          ))}
        </div>
      </div>

      {detail !== null && (
        <div className="card epg-detail">
          <h2>{detail.programme.title}</h2>
          <p className="muted-note">
            {detail.channel.name} · {formatTime(detail.programme.start_utc)} – {formatTime(detail.programme.stop_utc)}
          </p>
          {detail.programme.description !== null && <p>{detail.programme.description}</p>}
          <div className="toolbar">
            <button type="button" onClick={() => onWatch(detail.channel)}>Watch {detail.channel.name}</button>
            <button type="button" onClick={() => setDetail(null)}>Close</button>
          </div>
        </div>
      )}
    </section>
  )
}
