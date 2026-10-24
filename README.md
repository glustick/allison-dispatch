# Allison Dispatch

Self-hosted web IPTV **player/client** for a [Dispatcharr](https://github.com/Dispatcharr/Dispatcharr)
instance. Dispatcharr keeps doing what it is good at — provider ingest, load-balancing,
stream proxying, DVR — while this app focuses purely on the viewing experience on top of
its feed: channel lineup, EPG guide, favorites.

A clean-rebuild sibling of [Allison Web IPTV](../allison-web-iptv) — new codebase, with that
project's hard-won lessons applied from day one (streaming XMLTV parsing, wire-level fakes,
the test gate, unauthenticated health/version endpoints for deploys).

See [PLAN.md](PLAN.md) for the full architecture, milestones, and the verified Dispatcharr
integration surface.

## Status

**Live at https://dispatch.iallison.com** (Nginx Proxy Manager on 192.168.0.3:8181 →
192.168.0.20:8086, Let's Encrypt cert, streaming-safe proxy config: 86400s read/send
timeouts + buffering off). **Sign-in required** — the hostname is internet-reachable, so
every API (including the stream relay) sits behind a session cookie; only health, version
and login are public. Accounts live in SQLite on the /data host volume and survive image
upgrades. First boot seeds an admin from `SEED_ADMIN_USERNAME`/`SEED_ADMIN_PASSWORD` env
(only while no users exist; never commit real values). Admins manage users in Settings →
Users (create/delete/set password, last-admin and self-deletion guards); everyone can
change their own password there. Failed logins are throttled per IP (5 per 15 min).

One **TV** screen (watch + guide + channels combined) plus **Settings**. The TV screen:
resizable channel bar on the left (search + group filter), player with now/next on the
right, and the EPG guide grid under the player (drag-to-pan, 3-hour steps, a **Prime time**
jump and group/★ filters, now-line, programme detail — click any channel anywhere to tune).
Panning refetches once the drag settles, not per pointer event. **Multi-view**: "+ Tile"
grows the screen from one picture to a 2×2 grid of four concurrent streams; the focused tile
carries audio and the zap keys, every tile has its own × close, and audio-only (radio)
channels render a station card with logo and live equalizer bars instead of a black frame.
Playback always rides the BFF relay with the Dolby
audio fix (ffmpeg video-copy + AC-3→AAC — every provider stream carries AC-3, so without
it there is no audio; there is deliberately no toggle). Cold channels take ~8s to first
byte while Dispatcharr spins up the provider session — the player shows "Connecting…".

### Deployment (live)

Deployed on the NAS (192.168.0.20) as container `allison-dispatch` on **:8086**, data volume
`/volume1/docker/allison-dispatch/data`, `DISPATCHARR_URL=http://192.168.0.20:9191`. The
container runs the published `ghcr.io/glustick/allison-dispatch:latest` image (so Dockhand and
similar updaters can pull it) and carries the image's own `HEALTHCHECK` on `/api/health`.
Redeploy after changes:

```sh
rsync -az --delete --exclude .git --exclude node_modules --exclude dist --exclude public \
  --exclude data --exclude .env ./ allison-iptv-host:allison-dispatch/
ssh -t allison-iptv-host 'bash ~/allison-dispatch/scripts/deploy-nas.sh'   # needs sudo
```

The script pulls the image and waits for it to report healthy. `LOCAL_BUILD=1` builds from the
synced checkout instead, and `IMAGE=<ref>` pins a specific tag.

Verify: `curl http://192.168.0.20:8086/api/health` (liveness) and `/api/ready` (real readiness —
it queries the database and reports whether Dispatcharr is configured; `?deep=1` adds a 3s
reachability probe). The boot scheduler syncs the lineup at start (+5s), then hourly (M3U) /
6-hourly (EPG, jittered) — re-arming each tick, not once after boot.

### Verifying playback in a browser

```sh
DISPATCHARR_URL=http://192.168.0.20:9191 npm run dev
npm run dev:client   # open the printed localhost URL
```

Click a channel in the Watch tab — video should start within a few seconds ("Playing
live."). The relay toggle and MPEG-TS/fMP4 switch are on the player bar. Server-level
stream plumbing is already curl-verified against the real instance (0x47 TS sync bytes via
both direct and relay paths).

## Development

```sh
npm install
npm run dev          # server on :8086 (tsx watch)
npm run dev:client   # Vite dev server, proxies /api to :8086
npm test             # vitest
npm run typecheck    # server + client
npm run lint
npm run build && npm run build:client   # server → dist/, client → public/
```

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8086` | HTTP port |
| `DATA_DIR` | `./data` | SQLite database and sync state |
| `PUBLIC_DIR` | `./public` | Built client assets served with SPA fallback |
| `DISPATCHARR_URL` | — | Base URL of the Dispatcharr instance (e.g. `http://192.168.0.20:9191`). Required from M1 (sync) onward; validated at boot when set. |
| `RELAY_MAX_STREAMS` | `4` | Cap on concurrent relayed streams — each holds a provider session (and, with the audio fix, an ffmpeg) on the host. The default covers one viewer's full 4-tile multi-view grid; past the cap the relay answers 429. `0` disables the cap. |
| `BACKUP_KEEP` | `7` | Daily gzipped snapshots of the SQLite db, kept in `<DATA_DIR>/backups` (one at boot, then every 24h; older ones pruned). |

Dispatcharr side prerequisites: its `M3U_EPG` network-ACL scope must include this app's
source IP (the default localhost + LAN CIDRs already cover a LAN deployment), and nothing
else — v1 stores no Dispatcharr credentials.

## Deployment

Multi-arch Docker image (amd64 + arm64) published to GHCR on every non-doc push to `main`
and on `v*` tags, same Dockhand-based manual deploy flow to the NAS as the sibling app. The
image's `HEALTHCHECK` calls the unauthenticated `GET /api/health`; verify a deployment with
that and `GET /api/version` (or `docker ps`, which should read `(healthy)`).
