import { loadConfig } from './config.js'
import { createApp } from './app.js'
import { readAppVersion } from './version.js'
import { openDb } from './db.js'
import { resolveDispatcharrUrl } from './settingsStore.js'
import { runSync, SyncFailure } from './sync.js'
import { ensureSeedUser, validatePassword, validateUsername } from './auth.js'
import { startBackupLoop } from './backup.js'
import { startSyncScheduler } from './syncScheduler.js'
import path from 'path'

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
// fleet of restarts doesn't thundering-herd Dispatcharr. The cadence itself lives in
// syncScheduler.ts, where "does it re-arm?" is testable: v0.1.1 scheduled a single timeout,
// so after the first refresh the lineup and guide went stale until the next container
// restart. In-flight double-runs are guarded in sync.ts; failures are already recorded in
// sync_state, so here we only log one line.
startSyncScheduler({
  run: (kinds) => {
    const base = resolveDispatcharrUrl(db, cfg.dispatcharrUrl)
    if (base === null) return
    return runSync({ db, dispatcharrUrl: base }, kinds).catch((err: unknown) => {
      const message = err instanceof SyncFailure ? err.message : String(err)
      console.log(`[sync] ${kinds.join('+')} failed: ${message}`)
    })
  }
})

// ---- Daily db backup ----
// One gzipped snapshot at boot and one per day after, pruned to the newest BACKUP_KEEP.
// The db is the only state that survives redeploys — losing it means re-seeding users and
// losing every favorite and the watch history.
startBackupLoop(db, path.join(cfg.dataDir, 'backups'), cfg.backupKeep)
