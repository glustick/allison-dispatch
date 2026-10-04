import { useEffect, useState } from 'react'
import WatchView from './components/WatchView.js'
import SettingsView from './components/SettingsView.js'
import { getJson } from './lib/api.js'

interface VersionInfo {
  version: string
}

type Tab = 'tv' | 'settings'

export default function App() {
  const [tab, setTab] = useState<Tab>('tv')
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const v = await getJson<VersionInfo>('/api/version')
        setVersion(v.version)
      } catch {
        setVersion(null)
      }
    })()
  }, [])

  return (
    <main className="shell shell-wide">
      <header className="shell-header">
        <h1>Allison Dispatch</h1>
        <p className="subtitle">
          IPTV player for Dispatcharr{version !== null ? ` · v${version}` : ''}
        </p>
      </header>
      <nav className="tabs" aria-label="Sections">
        <button
          type="button"
          className={tab === 'tv' ? 'tab tab-active' : 'tab'}
          onClick={() => setTab('tv')}
        >
          TV
        </button>
        <button
          type="button"
          className={tab === 'settings' ? 'tab tab-active' : 'tab'}
          onClick={() => setTab('settings')}
        >
          Settings
        </button>
      </nav>
      {tab === 'tv' ? <WatchView /> : <SettingsView />}
    </main>
  )
}
