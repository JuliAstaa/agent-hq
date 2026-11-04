#!/usr/bin/env bash
# Update, build, and (re)start Agent HQ under pm2 on 127.0.0.1:8787.
# Optional env (captured by pm2 at start): HQ_TOKEN, HQ_TRANSCRIPT_ROOTS, HQ_NAMES_FILE, HQ_DEBUG.

APP=agent-hq
HOST=127.0.0.1
PORT=${PORT:-8787}

cd "$(dirname "$0")" || exit 1

if ! command -v pm2 >/dev/null 2>&1; then
  echo "pm2 tidak ditemukan. Pasang dulu: npm install -g pm2"
  exit 1
fi

pm2 stop "$APP" 2>/dev/null
pm2 delete "$APP" 2>/dev/null

set -e

git fetch
git pull
npm install
npm run build

# next start (not standalone): next.config.ts has no output: "standalone", and the bridge writes
# agent-hq-names.json to process.cwd(), so run from the project root.
pm2 start node --name "$APP" --cwd "$PWD" --max-memory-restart 800M -- \
  node_modules/next/dist/bin/next start -H "$HOST" -p "$PORT"

pm2 save

echo "Agent HQ jalan di http://$HOST:$PORT"
