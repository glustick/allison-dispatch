import { useCallback, useEffect, useState } from 'react'
import {
  getJson,
  sendJson,
  type ConnectionTestResult,
  type SettingsResponse,
  type SyncRunResponse,
  type SyncStatusResponse
} from '../lib/api.js'

export interface SettingsUser {
  id: number
  username: string
  isAdmin: boolean
}

function formatLastRun(epochMs: number | null): string {
  if (epochMs === null) return 'never'
  const seconds = Math.floor((Date.now() - epochMs) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

function UsersPanel({ currentUser, onChanged }: { currentUser: SettingsUser; onChanged: () => void }): React.JSX.Element | null {
  const [users, setUsers] = useState<SettingsUser[] | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [makeAdmin, setMakeAdmin] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [resetFor, setResetFor] = useState<SettingsUser | null>(null)
  const [resetPassword, setResetPassword] = useState('')

  const reload = useCallback(async (): Promise<void> => {
    try {
      const body = await getJson<{ users: SettingsUser[] }>('/api/users')
      setUsers(body.users)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  if (currentUser.isAdmin !== true) return null

  async function create(): Promise<void> {
    setNotice(null)
    setError(null)
    try {
      await sendJson('/api/users', 'POST', { username, password, isAdmin: makeAdmin })
      setUsername('')
      setPassword('')
      setMakeAdmin(false)
      setNotice(`User '${username}' created.`)
      await reload()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function remove(user: SettingsUser): Promise<void> {
    setNotice(null)
    setError(null)
    try {
      await sendJson(`/api/users/${user.id}`, 'DELETE')
      setNotice(`User '${user.username}' deleted.`)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function reset(): Promise<void> {
    if (resetFor === null) return
    setNotice(null)
    setError(null)
    try {
      await sendJson(`/api/users/${resetFor.id}/password`, 'PUT', { password: resetPassword })
      setNotice(`Password set for '${resetFor.username}'.`)
      setResetFor(null)
      setResetPassword('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="card">
      <h2>Users</h2>
      <ul className="user-list">
        {(users ?? []).map((u) => (
          <li key={u.id} className="user-row">
            <span className="user-name">{u.username}</span>
            {u.isAdmin && <span className="user-badge">admin</span>}
            {u.id !== currentUser.id && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setResetFor(resetFor?.id === u.id ? null : u)
                    setResetPassword('')
                  }}
                >
                  Set password
                </button>
                <button type="button" className="danger" onClick={() => void remove(u)}>
                  Delete
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {resetFor !== null && (
        <div className="toolbar">
          <input
            type="password"
            placeholder={`New password for ${resetFor.username}`}
            value={resetPassword}
            onChange={(e) => setResetPassword(e.target.value)}
          />
          <button type="button" disabled={resetPassword.length < 6} onClick={() => void reset()}>
            Save
          </button>
          <button type="button" onClick={() => setResetFor(null)}>Cancel</button>
        </div>
      )}
      <h2>Create user</h2>
      <div className="toolbar">
        <input type="text" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input type="password" placeholder="Password (6+ chars)" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <div className="toolbar">
        <label>
          <input type="checkbox" checked={makeAdmin} onChange={(e) => setMakeAdmin(e.target.checked)} />{' '}
          Administrator (can manage users)
        </label>
        <button type="button" disabled={username === '' || password.length < 6} onClick={() => void create()}>
          Create user
        </button>
      </div>
      {notice !== null && <p className="ok-note">{notice}</p>}
      {error !== null && <p className="status-error">{error}</p>}
    </div>
  )
}

function OwnPasswordCard(): React.JSX.Element {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function change(): Promise<void> {
    setNotice(null)
    setError(null)
    try {
      await sendJson('/api/auth/password', 'PUT', { currentPassword, newPassword })
      setCurrentPassword('')
      setNewPassword('')
      setNotice('Password changed.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="card">
      <h2>My password</h2>
      <div className="toolbar">
        <input type="password" placeholder="Current password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
        <input type="password" placeholder="New password (6+ chars)" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
        <button type="button" disabled={currentPassword === '' || newPassword.length < 6} onClick={() => void change()}>
          Change
        </button>
      </div>
      {notice !== null && <p className="ok-note">{notice}</p>}
      {error !== null && <p className="status-error">{error}</p>}
    </div>
  )
}

export default function SettingsView({ currentUser }: { currentUser: SettingsUser }): React.JSX.Element {
  const [urlInput, setUrlInput] = useState('')
  const [source, setSource] = useState<SettingsResponse['source']>(null)
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)
  const [syncStatus, setSyncStatus] = useState<SyncStatusResponse | null>(null)
  const [busy, setBusy] = useState<'save' | 'test' | 'sync' | null>(null)

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      setSyncStatus(await getJson<SyncStatusResponse>('/api/sync/status'))
    } catch {
      setSyncStatus(null)
    }
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const settings = await getJson<SettingsResponse>('/api/settings')
        setLoadedUrl(settings.dispatcharrUrl)
        setSource(settings.source)
        if (settings.source === 'env' && settings.dispatcharrUrl !== null) setUrlInput(settings.dispatcharrUrl)
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err))
      }
      await loadStatus()
    })()
  }, [loadStatus])

  async function save(): Promise<void> {
    setBusy('save')
    setNotice(null)
    try {
      const body = await sendJson<{ ok: boolean; dispatcharrUrl: string | null }>('/api/settings', 'PUT', {
        dispatcharrUrl: urlInput.trim() === '' ? null : urlInput
      })
      setLoadedUrl(body.dispatcharrUrl)
      setSource(body.dispatcharrUrl === null ? null : 'settings')
      setNotice(body.dispatcharrUrl === null ? 'Dispatcharr URL cleared.' : 'Dispatcharr URL saved.')
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function test(): Promise<void> {
    setBusy('test')
    setNotice(null)
    try {
      const body = urlInput.trim() === ''
        ? await sendJson<ConnectionTestResult>('/api/settings/test', 'POST')
        : await sendJson<ConnectionTestResult>('/api/settings/test', 'POST', { url: urlInput })
      setTestResult(body)
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  async function syncNow(): Promise<void> {
    setBusy('sync')
    setNotice(null)
    try {
      const body = await sendJson<SyncRunResponse>('/api/sync/run', 'POST')
      if (body.ok && body.summary !== undefined) {
        const parts: string[] = []
        if (body.summary.m3u !== null) parts.push(`${body.summary.m3u.channels} channels`)
        if (body.summary.epg !== null) parts.push(`${body.summary.epg.programmes} programmes across ${body.summary.epg.channels} EPG channels`)
        setNotice(`Sync complete: ${parts.join(', ')}.`)
      }
      await loadStatus()
    } catch (err) {
      setNotice(`Sync failed: ${err instanceof Error ? err.message : String(err)}`)
      await loadStatus()
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="view">
      <div className="card">
        <h2>Dispatcharr</h2>
        <p className="muted-note">
          {source === 'settings' && 'Override stored in settings.'}
          {source === 'env' && 'Currently from the environment — saving stores an override.'}
          {source === null && 'Not configured yet.'}
        </p>
        <div className="toolbar">
          <input
            type="url"
            placeholder="http://192.168.0.20:9191"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
          />
        </div>
        <div className="toolbar">
          <button type="button" disabled={busy !== null} onClick={() => void save()}>
            {busy === 'save' ? 'Saving…' : 'Save URL'}
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void test()}>
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void syncNow()}>
            {busy === 'sync' ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
        {testResult !== null && (
          <p className={testResult.ok ? 'ok-note' : 'status-error'}>
            {testResult.ok
              ? `Connected — Dispatcharr v${testResult.version} at ${testResult.url ?? ''}`
              : `Connection failed: ${testResult.error ?? 'unknown error'}`}
          </p>
        )}
        {notice !== null && <p className="ok-note">{notice}</p>}
      </div>

      <div className="card">
        <h2>Sync status</h2>
        {syncStatus === null ? (
          <p className="muted-note">No sync information.</p>
        ) : (
          <table className="sync-table">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Status</th>
                <th>Items</th>
                <th>Last run</th>
              </tr>
            </thead>
            <tbody>
              {Object.values(syncStatus.kinds).map((kind) => (
                <tr key={kind.kind}>
                  <td>{kind.kind.toUpperCase()}</td>
                  <td className={kind.status === 'ok' ? 'ok-note' : kind.status === 'error' ? 'status-error' : ''}>
                    {kind.status}
                    {kind.error !== null && <span className="muted-note"> — {kind.error}</span>}
                  </td>
                  <td>{kind.item_count ?? '—'}</td>
                  <td>{formatLastRun(kind.last_run_utc)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted-note">Lineup syncs hourly, the guide every 6 hours (with jitter). Current URL: {loadedUrl ?? '—'}</p>
      </div>

      <UsersPanel currentUser={currentUser} onChanged={() => {}} />
      <OwnPasswordCard />
    </section>
  )
}
