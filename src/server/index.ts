import { loadConfig } from './config.js'
import { createApp } from './app.js'
import { readAppVersion } from './version.js'
import { openDb } from './db.js'
import { resolveDispatcharrUrl } from './settingsStore.js'
import { runSync, SyncFailure } from './sync.js'
import { ensureSeedUser, validatePassword, validateUsername } from './auth.js'

const cfg = loadConfig(process.env)
const db = openDb(cfg.dataDir)

// First-boot seeding: creates the initial admin ONLY when no users exist at all. The
// credentials come from the environment (passed once at deploy time) — never hardcoded in
// this public repo — and the seeded account lives in SQLite on the /data volume, so it
// survives every image upgrade. Later boots with users present skip this entirely.
const seedUsername = process.env.SEED_ADMIN_USERNAME?.trim()
const seedPassword = process.env.SEED_ADMIN_PASSWORD
if (seedUsername !== undefined && seedUsername !== '' && seedPassword !== undefined && seedPassword !== '') {
  try {
    validateUsername(seedUsername)
    validatePassword(seedPassword)
    const { seeded } = ensureSeedUser(db, seedUsername, seedPassword)
    console.log(seeded ? `[auth] seeded initial admin user '${seedUsername}'` : '[auth] users already exist — seed skipped')
  } catch (err) {
    console.log(`[auth] seed skipped: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const app = createApp(cfg, { db })

app.listen(cfg.port, () => {
  // Operator-friendly boot lines — the NAS workflow greps logs, so keep them short, greppable
  // and free of churn.
  console.log(`allison-dispatch v${readAppVersion()}`)
  console.log(`listening on :${cfg.port}`)
  console.log(`data dir: ${cfg.dataDir}`)
  console.log(`dispatcharr: ${resolveDispatcharrUrl(db, cfg.dispatcharrUrl) ?? 'not configured'}`)
})

// ---- Periodic sync ----
// Lineup changes are small and frequent (provider reshuffles), the guide is a multi-MB
// transfer — so M3U syncs run hourly and the EPG every 6 hours, both with random jitter so a
// fleet of restarts doesn't thundering-herd Dispatcharr. In-flight double-runs are guarded in
// sync.ts; failures are already recorded in sync_state, so here we only log one line.
const M3U_INTERVAL_MS = 60 * 60 * 1000
const EPG_INTERVAL_MS = 6 * 60 * 60 * 1000
const JITTER_MS = 15 * 60 * 1000
const BOOT_DELAY_MS = 5_000

function scheduledSync(kinds: Array<'m3u' | 'epg'>): () => void {
  return () => {
    const base = resolveDispatcharrUrl(db, cfg.dispatcharrUrl)
    if (base === null) return
    runSync({ db, dispatcharrUrl: base }, kinds).catch((err: unknown) => {
      const message = err instanceof SyncFailure ? err.message : String(err)
      console.log(`[sync] ${kinds.join('+')} failed: ${message}`)
    })
  }
}

function schedule(fn: () => void, intervalMs: number): void {
  const timer = setTimeout(fn, intervalMs + Math.random() * JITTER_MS)
  timer.unref()
}

const initial = setTimeout(() => scheduledSync(['m3u', 'epg'])(), BOOT_DELAY_MS)
initial.unref()
schedule(scheduledSync(['m3u']), M3U_INTERVAL_MS)
schedule(scheduledSync(['epg']), EPG_INTERVAL_MS)
