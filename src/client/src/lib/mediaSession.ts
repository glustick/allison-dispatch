// OS media controls (Media Session API): what the macOS media HUD, the lock screen and the
// hardware media keys should know about the focused tile. The builder is pure so the shape
// is testable without a browser; the navigator wiring lives in WatchView.

export interface MediaSessionInput {
  channel: { name: string; logo_url: string | null }
  /** Title of the programme on right now, when the guide knows one. */
  nowTitle: string | null
}

export interface MediaMetadataShape {
  title: string
  artist: string
  artwork: Array<{ src: string; sizes: string }>
}

// With a programme the HUD reads "Programme — by Channel"; without one it falls back to the
// channel name alone. The logo rides along so the controls show the station, like a real TV.
export function buildMediaMetadata(input: MediaSessionInput): MediaMetadataShape {
  const { channel, nowTitle } = input
  return {
    title: nowTitle ?? channel.name,
    artist: nowTitle !== null ? channel.name : 'Allison Dispatch',
    artwork: channel.logo_url !== null ? [{ src: channel.logo_url, sizes: '192x192' }] : []
  }
}
