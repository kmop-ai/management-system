#!/usr/bin/env bash
# Full local check, in a throwaway database: static checks, fresh migrations,
# seed, a dev server on a spare port, then the smoke test against it.
#   npm test
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8799}"
STATE=".wrangler/test-state"

[ -f .dev.vars ] || echo 'DEV_MODE="1"' > .dev.vars
npm run --silent check
rm -rf "$STATE"
npx wrangler d1 migrations apply kmop-hq --local --persist-to "$STATE" >/dev/null
npx wrangler d1 execute kmop-hq --local --persist-to "$STATE" --file data/seed.sql >/dev/null
echo "migrated + seeded $STATE"

npx wrangler dev --port "$PORT" --persist-to "$STATE" --test-scheduled > .wrangler/test-dev.log 2>&1 &
DEV=$!
trap 'kill $DEV 2>/dev/null || true' EXIT
for i in $(seq 1 60); do curl -sf "http://localhost:$PORT/api/health" >/dev/null && break; sleep 1; done
curl -sf "http://localhost:$PORT/api/health" >/dev/null || { echo "dev server did not start"; tail -30 .wrangler/test-dev.log; exit 1; }
# The scheduled handler must run cleanly too.
curl -sf "http://localhost:$PORT/__scheduled?cron=5+*+*+*+*" >/dev/null && echo "cron handler OK"
BASE="http://localhost:$PORT" node scripts/smoke.mjs
