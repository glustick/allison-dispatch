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
right, and the EPG guide grid under the player (drag-to-pan, now-line, programme detail —
click any channel anywhere to tune). Playback always rides the BFF relay with the Dolby
audio fix (ffmpeg video-copy + AC-3→AAC — every provider stream carries AC-3, so without
it there is no audio; there is deliberately no toggle). Cold channels take ~8s to first
byte while Dispatcharr spins up the provider session — the player shows "Connecting…".

### Deployment (live)

Deployed on the NAS (192.168.0.20) as container `allison-dispatch` on **:8086**, data volume
`/volume1/docker/allison-dispatch/data`, `DISPATCHARR_URL=http://192.168.0.20:9191`. Redeploy
after changes:

```sh
rsync -az --delete --exclude .git --exclude node_modules --exclude dist --exclude public \
  --exclude data --exclude .env ./ allison-iptv-host:allison-dispatch/
ssh -t allison-iptv-host 'bash ~/allison-dispatch/scripts/deploy-nas.sh'   # needs sudo
```

Verify: `curl http://192.168.0.20:8086/api/health` and `/api/version`. The boot scheduler
syncs the lineup at start (+5s), then hourly (M3U) / 6-hourly (EPG, jittered).

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

Dispatcharr side prerequisites: its `M3U_EPG` network-ACL scope must include this app's
source IP (the default localhost + LAN CIDRs already cover a LAN deployment), and nothing
else — v1 stores no Dispatcharr credentials.

## Deployment

Multi-arch Docker image (amd64 + arm64), same Dockhand-based manual deploy flow to the NAS
as the sibling app. Verify a deployment with the unauthenticated `GET /api/health` and
`GET /api/version`.
