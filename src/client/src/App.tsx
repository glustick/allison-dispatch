import { useCallback, useEffect, useState } from 'react'
import WatchView from './components/WatchView.js'
import SettingsView from './components/SettingsView.js'
import LoginScreen from './components/LoginScreen.js'
import { getJson, sendJson, type Channel } from './lib/api.js'

interface VersionInfo {
  version: string
}

interface SessionUser {
  id: number
  username: string
  isAdmin: boolean
}

type Tab = 'tv' | 'settings'

export default function App() {
  const [tab, setTab] = useState<Tab>('tv')
  const [version, setVersion] = useState<string | null>(null)
  const [authState, setAuthState] = useState<'loading' | 'anonymous' | SessionUser>('loading')

  const refreshSession = useCallback(async (): Promise<void> => {
    try {
      const body = await getJson<{ user: SessionUser | null }>('/api/auth/me')
      setAuthState(body.user ?? 'anonymous')
    } catch {
      setAuthState('anonymous')
    }
  }, [])

  useEffect(() => {
    void refreshSession()
  }, [refreshSession])

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

  async function logout(): Promise<void> {
    try {
      await sendJson('/api/auth/logout', 'POST')
    } catch {
      // The state change below clears the client side regardless.
    }
    setAuthState('anonymous')
  }

  if (authState === 'loading') {
    return (
      <main className="shell">
        <p className="muted-note">Loading…</p>
      </main>
    )
  }

  if (authState === 'anonymous') {
    return (
      <main className="shell">
        <header className="shell-header">
          <h1>Allison Dispatch</h1>
          <p className="subtitle">
            IPTV player for Dispatcharr{version !== null ? ` · v${version}` : ''}
          </p>
        </header>
        <LoginScreen onLoggedIn={() => void refreshSession()} />
      </main>
    )
  }

  return (
    <main className="shell shell-wide">
      <header className="shell-header">
        <h1>Allison Dispatch</h1>
        <p className="subtitle">
          IPTV player for Dispatcharr{version !== null ? ` · v${version}` : ''}
          {' '}· signed in as {authState.username}
          <button type="button" className="logout-btn" onClick={() => void logout()}>
            Sign out
          </button>
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
      {tab === 'tv' && <WatchView />}
      {tab === 'settings' && <SettingsView currentUser={authState} />}
    </main>
  )
}
