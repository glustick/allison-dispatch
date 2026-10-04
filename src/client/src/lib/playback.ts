import { getJson } from './api.js'

export type OutputFormat = 'mpegts' | 'fmp4'

export interface PlayInfo {
  uuid: string
  name: string
  format: OutputFormat | null
  /** Direct browser → Dispatcharr URL (unused in practice — see buildPlaybackUrl). */
  direct: string
  /** Same-origin BFF relay path. */
  relay: string
}

export interface PlaybackPrefs {
  format: OutputFormat
}

const PREFS_KEY = 'allison-dispatch.playbackPrefs'
const DEFAULT_PREFS: PlaybackPrefs = { format: 'mpegts' }

// Playback always goes through the BFF relay with the audio fix on. Dispatcharr passes
// provider codecs through untouched and the providers deliver AC-3/E-AC-3 (Dolby) audio,
// which browser MSE cannot play — verified live 2026-10-04: every probed channel carried
// AC-3, and without the fix there is simply no audio. There is deliberately no toggle for
// this; the relay re-encodes audio to AAC and copies the video untouched.

export async function fetchPlayInfo(uuid: string, format: OutputFormat): Promise<PlayInfo> {
  return getJson<PlayInfo>(`/api/channels/${encodeURIComponent(uuid)}/play?output_format=${format}`)
}

export function loadPrefs(): PlaybackPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw === null) return { ...DEFAULT_PREFS }
    const parsed = JSON.parse(raw) as Partial<PlaybackPrefs>
    return { format: parsed.format === 'fmp4' ? 'fmp4' : 'mpegts' }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export function savePrefs(prefs: PlaybackPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // Storage unavailable (private mode etc.) — prefs just won't persist.
  }
}

export function lastBufferedEnd(video: HTMLVideoElement): number {
  const b = video.buffered
  return b.length > 0 ? b.end(b.length - 1) : 0
}

export function buildPlaybackUrl(info: PlayInfo): string {
  return `${info.relay}${info.relay.includes('?') ? '&' : '?'}fixaudio=1`
}

export function isDolbyAudioCodec(codec: string | undefined): boolean {
  if (codec === undefined || codec === '') return false
  return /(^|[^a-z])e?ac-?3([^a-z]|$)/i.test(codec) || /dolby/i.test(codec)
}
