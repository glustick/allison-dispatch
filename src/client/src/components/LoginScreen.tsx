import { useState } from 'react'

interface LoginResponse {
  ok: boolean
  user?: { id: number; username: string; isAdmin: boolean }
  error?: string
}

// Shown whenever /api/auth/me answers 401. The app's APIs (and the stream relay) all sit
// behind the session cookie; this screen is the only public surface.
export default function LoginScreen({ onLoggedIn }: { onLoggedIn: () => void }): React.JSX.Element {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password })
      })
      const body = (await res.json()) as LoginResponse
      if (!res.ok || body.ok !== true) {
        setError(body.error ?? `Login failed (${res.status})`)
        return
      }
      onLoggedIn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="view login-view">
      <form className="card login-card" onSubmit={(e) => void submit(e)}>
        <h2>Sign in</h2>
        <p className="muted-note">Allison Dispatch is private — sign in to watch.</p>
        <div className="toolbar">
          <input
            type="text"
            placeholder="Username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
        </div>
        <div className="toolbar">
          <input
            type="password"
            placeholder="Password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="toolbar">
          <button type="submit" disabled={busy || username === '' || password === ''}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
        {error !== null && <p className="status-error">{error}</p>}
      </form>
    </section>
  )
}
