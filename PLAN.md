# allison-dispatch — PLAN

> Working title (rename is a one-liner — see Open Questions). A clean-rebuild, browser-based
> IPTV player that consumes a self-hosted Dispatcharr instance as its single source:
> Dispatcharr keeps doing ingest, load-balancing, proxying and DVR; this app focuses purely
> on a great viewing experience on top of its feed.

## Decisions so far

| Question | Decision | Source |
|---|---|---|
| Role | Polished player/client — no ingest, no DVR, no transcoding of our own | user |
| Relationship to allison-web-iptv | Clean rebuild — new codebase, hard-won lessons baked in from day one | user |
| Platform | Web app, Docker-deployable to the NAS (same pattern as allison-web-iptv) | best judgment (was skipped) |
| V1 scope | Live TV + EPG + favorites; VOD/catch-up/users deferred to backlog | best judgment (was skipped) |
| Local user accounts in v1 | None — no login. Favorites/recent keyed to an anonymous profile cookie. Schema leaves room for real users later | best judgment |

## Why this architecture

Dispatcharr (v0.31.0 verified, Oct 2026) exposes exactly what a client needs **without admin
API access and without storing any credentials**:

- **Lineup**: `GET /output/m3u[/{channel_profile}]` — unauthenticated, gated only by the
  `M3U_EPG` network-ACL scope (default: localhost + LAN CIDRs). Each `#EXTINF` carries
  tvg-id, logo, group, channel number, and an embedded play URL
  `{dispatcharr}/proxy/ts/stream/{channel_uuid}`.
- **Guide**: `GET /output/epg?days=7` — same ACL. Standard XMLTV.
- **Playback**: `GET /proxy/ts/stream/{uuid}?output_format=mpegts|fmp4` — no public HLS for
  live (the internal `hls_proxy` URLconf is not mounted). Stream ACL (`STREAMS`) is
  allow-all by default. CORS on Dispatcharr is wide open (`CORS_ALLOW_ALL_ORIGINS = True`).

So v1 has **zero Dispatcharr credentials** and zero REST/JWT surface. The app is a thin BFF
(Node) that syncs lineup+guide into SQLite and serves a normalized API to a React frontend;
the browser plays Dispatcharr's proxy URLs directly.

```
Browser (React 19 + Vite + mpegts.js)
   │  /api/*  normalized JSON            ▲ video: MPEG-TS / fMP4 bytes
   ▼                                     │ (direct to Dispatcharr by default)
BFF  Node + Express + better-sqlite3 ────┘ (optional relay mode: BFF proxies bytes)
   │  periodic sync + manual refresh
   ▼
Dispatcharr  /output/m3u ─► channels      (streaming parse)
             /output/epg ─► programs      (streaming XMLTV parse — never DOM)
             /proxy/ts/stream/{uuid} ─► player
```

### Playback engine

- **mpegts.js** (successor to flv.js) drives MSE for both `mpegts` and `fmp4` output
  formats — this is the correct engine given Dispatcharr ships no live HLS playlist.
  hls.js returns the day Dispatcharr ships HLS output (kept in mind, not installed yet).
- Direct browser→Dispatcharr playback by default (one less hop on the NAS, CORS is open).
  Optional BFF **relay mode** per channel for: mixed-content (if the app is ever served
  HTTPS while Dispatcharr is HTTP), ACL edge cases, and debugging.
- Live-latency hygiene: `enableStashBuffer: false`, latency chasing on, stall detection and
  honest status notices — port the proven patterns (stall ladder, "not broadcasting"
  detector, dead-session notice) from allison-web-iptv rather than reinventing them.
- Dispatcharr enforces per-user concurrent-stream limits only on *authenticated* stream
  requests (else 429). Anonymous playback is unlimited. Fine for v1 single-household; if
  per-user limits are wanted later, switch stream URLs to XC-style
  `/live/{user}/{pass}/{id}` or attach a JWT.

### EPG pipeline (the OOM lesson, applied from day one)

- Stream-parse the XMLTV (fast-xml-parser incremental or sax-js) — never build a DOM. The
  allison-web-iptv incident (1,271 MB DOM → 566 MB streaming) does not get to happen twice.
- Bound the fetch with `days=7&prev_days=0`.
- Request lineup and guide with the **same** `tvg_id_source` (default `channel_number`) so
  channel↔program joins are trivial.
- Upsert into SQLite in transaction batches; indexes on `(tvg_id, start_utc)`; now/next and
  grid are plain indexed queries.
- Sync scheduler: periodic with jitter + manual refresh button + sync-state table for
  last-run/status/count. M3U syncs are small and can run more often than EPG.
- Logos: cache BFF-side (Dispatcharr has a logo cache endpoint; worst case we proxy and
  cache ourselves) so the guide doesn't hammer upstreams.

## Data model (SQLite via better-sqlite3)

- `settings(key, value)` — dispatcharr_url, channel profile, output format, sync intervals, relay toggle
- `channels(id, uuid, name, channel_number, tvg_id, logo_url, group_name, enabled, updated_at)`
- `epg_programs(id, tvg_id, title, sub_title, description, start_utc, end_utc, category, icon, rating)`
- `sync_state(kind, last_run, status, item_count)`
- `profiles(id, label, created_at)` — anonymous profile cookie
- `favorites(profile_id, channel_uuid)`, `recent(profile_id, channel_uuid, last_watched)`

## Frontend surface (v1)

- **Watch** — channel list (react-window for large lineups), player, now/next strip,
  zapping with number keys.
- **Guide** — 7-day grid, time-of-day jump, channel-logo + program detail panel.
- **Settings** — Dispatcharr base URL, channel-profile choice, output format, sync controls,
  relay toggle, connection test.

## Dispatcharr compatibility notes (verified against v0.31.0 source)

- `M3U_EPG` ACL scope must include the BFF's source IP — default LAN CIDRs cover
  NAS↔NAS; nothing to change for a same-LAN deploy. Remote (off-LAN) access is the case
  that forces ACL edits or relay design.
- Don't probe Dispatcharr paths by status code — unknown paths serve the SPA with **200**,
  not 404. Feature detection uses real endpoints with known payloads.
- XC emulation (`player_api.php`) exists with per-user XC passwords, but v1 doesn't use it;
  M3U+XMLTV is one consistent ID space with less auth complexity.
- Pin expectations to v0.31.0; keep an integration test suite that runs against a wire-level
  fake so drift is caught by our CI, not by a broken TV night.
- Login token endpoint is throttled (3/min) — only relevant when M6+ adds REST usage; cache
  and refresh tokens (access 30 min / refresh 1 day).

## Testing (the wire-level fake lesson, applied from day one)

- A fake Dispatcharr HTTP server that behaves like the real thing at the wire level —
  correct URLs, chunked XMLTV streaming, the SPA-200 catch-all quirk — because fake origins
  that don't match real host behavior can't catch wrong-host bugs.
- Gate: vitest unit + typecheck (server & client) + eslint + vite build, all green in CI
  (GitHub Actions) before merge — same gate as the sibling apps.
- Rig-style manual proofs on the real Dispatcharr before each release milestone.

## Deployment

- Multi-stage Dockerfile (node build → slim runtime), docker-compose for the NAS,
  SQLite on a mounted volume.
- Deploy via Dockhand (manual, same flow as allison-web-iptv). Verify with unauthenticated
  `/api/health` + `/api/version` — the pattern that already works on the NAS.
- Dev happens on this Mac (the NAS has broken `.bin` shims — nothing ever runs `npm run`
  there); NAS only ever runs the built image.

## Milestones

| M | Deliverable | Notes |
|---|---|---|
| M0 | Scaffold: monorepo layout, tsconfigs, Vite+React, eslint, vitest, CI, Dockerfile, `/api/health` | half a day |
| M1 | Sync: M3U + streaming XMLTV → SQLite; settings UI; channel list API | the EPG pipeline lands here |
| M2 | Playback: mpegts.js player, direct mode, stall/reconnect UX, relay mode | |
| M3 | Guide: 7-day grid, now/next, program detail | |
| M4 | Polish: favorites, recents, search, logo caching, keyboard zapping | |
| M5 | NAS deploy + real-Dispatcharr verification | release gate |
| M6+ | Backlog: VOD (`/proxy/vod/…`), catch-up (`/api/catchup/sessions/`), real user accounts, multi-view, radio, HLS when Dispatcharr ships it | needs JWT REST + XC creds |

## Risks

| Risk | Mitigation |
|---|---|
| Dispatcharr API/output drift | Pin v0.31.0 behavior; wire-level fake in CI; integration smoke vs real instance at M5 |
| MPEG-TS decode CPU in weak TV browsers | Prefer fMP4 output format there; relay mode can remux later if ever needed |
| Huge EPG memory | Streaming parser + `days` bound — non-negotiable, enforced in code review and tests |
| ACL surprises on remote access | v1 is LAN-scoped by design; remote access is an explicit later decision |
| Two-proxy latency in relay mode | Direct mode is default; relay only for channels that need it |

## Open questions

1. **Name** — working title `allison-dispatch`; alternatives: `allison-view`, `iptv-client`.
2. Which Dispatcharr version is actually running on the NAS (plan assumes ≥ 0.31.0 shapes)?
3. Off-LAN (remote) access in scope this year, or LAN-only product?
4. Any UI taste constraints (dark-first? TV/10-foot mode priority)?
