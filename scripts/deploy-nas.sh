#!/bin/sh
# Deploys allison-dispatch on the NAS (192.168.0.20). Docker is root-only there, so this
# script runs with sudo inside — run it via:
#   ssh -t allison-iptv-host 'bash ~/allison-dispatch/scripts/deploy-nas.sh'
# Idempotent: rebuilds the image and replaces the container; /volume1/docker/allison-dispatch/data
# persists across deploys.
set -eu

cd "$(dirname "$0")/.."
APP_DIR="/volume1/docker/allison-dispatch"
DATA_DIR="$APP_DIR/data"

sudo mkdir -p "$DATA_DIR"
# Same ownership pattern as the sibling's dir (chris-owned, root-created via sudo).
sudo chown -R chris:chris "$APP_DIR"

echo "==> Building image (first build compiles better-sqlite3; a few minutes)..."
sudo docker build -t allison-dispatch:latest .

echo "==> Removing any previous container..."
sudo docker rm -f allison-dispatch 2>/dev/null || true

echo "==> Starting allison-dispatch on :8086..."
sudo docker run -d --name allison-dispatch \
  --restart unless-stopped \
  -p 8086:8086 \
  -v "$DATA_DIR":/data \
  -e PORT=8086 \
  -e DATA_DIR=/data \
  -e DISPATCHARR_URL=http://192.168.0.20:9191 \
  --log-driver json-file \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  allison-dispatch:latest

echo "==> Waiting for boot, then showing the log..."
sleep 4
sudo docker logs allison-dispatch 2>&1 | tail -10
echo ""
echo "==> Done. Verify from anywhere: curl http://192.168.0.20:8086/api/health"
