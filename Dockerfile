# Debian-based ("bookworm-slim"), matching the sibling app's choice. There is no ffmpeg here
# on purpose: v1 does no transcoding of its own — Dispatcharr is the one that remuxes, and the
# browser plays its /proxy/ts/stream/ output through mpegts.js. If a future milestone ever
# needs ffmpeg, revisit the glibc/NSS lessons from the sibling's Dockerfile first.
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Build tools for better-sqlite3: it ships prebuilt binaries for many Node/arch combinations
# but not reliably for all of them, and without a compiler `npm ci` can fail outright with a
# node-gyp error. Build stage only — none of this reaches the runtime image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:client

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8086
# All variable state (SQLite database, sync state) lives here — kept across image updates
# by the volume mapping in docker-compose.yml.
ENV DATA_DIR=/data

# Debian's own ffmpeg, installed deliberately (same lesson as the sibling app, re-learned
# here the hard way): the bundled ffmpeg-static binary is a static build whose linux 7.0.2
# variant SIGSEGV'd demuxing the real Dispatcharr live TS (verified in-container 2026-10-04,
# every mode including pure stream copy, ~265KB in, zero stderr), while synthetic lavfi input
# ran fine. The distro build is the one the sibling has run in production on this same NAS
# against the same provider streams. Costs ~400MB of image size.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
# Reuses the build stage's node_modules wholesale rather than a second `npm ci --omit=dev` —
# same reasoning as the sibling: simpler, and the runtime cost is only image size on a
# personal self-hosted deployment.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY package.json ./
VOLUME /data
EXPOSE 8086
CMD ["node", "dist/server/index.js"]
