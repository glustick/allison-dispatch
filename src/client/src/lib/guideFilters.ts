// Pure filtering for the guide grid: which channels survive the group filter and the
// favourites-only toggle. Kept out of the component because the grid renders whatever it is
// handed — "the filter did nothing" is a regression a DOM-less test can only catch if the
// decision itself is a function with no React in it.

export interface GuideFilterableChannel {
  uuid: string
  group_name: string | null
}

export interface GuideFilterState {
  /** A group name, or ALL_GROUPS for no group filter. */
  group: string
  favoritesOnly: boolean
  favorites: ReadonlySet<string>
}

export const ALL_GROUPS = 'all'

/** Group names present in the grid, alphabetically — 'all' first, matching the channel bar. */
export function guideGroups<T extends GuideFilterableChannel>(channels: T[]): string[] {
  const groups = new Set<string>()
  for (const channel of channels) {
    if (channel.group_name !== null && channel.group_name !== '') groups.add(channel.group_name)
  }
  return [ALL_GROUPS, ...Array.from(groups).sort((a, b) => a.localeCompare(b))]
}

/** Applies both filters, preserving the server's channel order. */
export function filterGuideChannels<T extends GuideFilterableChannel>(channels: T[], filter: GuideFilterState): T[] {
  return channels.filter((channel) => {
    if (filter.group !== ALL_GROUPS && channel.group_name !== filter.group) return false
    if (filter.favoritesOnly && !filter.favorites.has(channel.uuid)) return false
    return true
  })
}
