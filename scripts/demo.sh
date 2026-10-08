#!/usr/bin/env bash
# One command to try KMOP HQ on your own computer:  npm run demo
# Creates a local database with demo data and opens http://localhost:8787
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d node_modules ] || npm install
[ -f .dev.vars ] || echo 'DEV_MODE="1"' > .dev.vars
rm -rf .wrangler/state
npx wrangler d1 migrations apply kmop-hq --local >/dev/null
npx wrangler d1 execute kmop-hq --local --file data/seed.sql >/dev/null
echo
echo "  KMOP HQ is starting at  http://localhost:8787"
echo "  Sign in with e.g.  k.antonopoulou@kmop.org  (the sign-in link appears on screen)"
echo "  Press Ctrl+C to stop."
echo
( sleep 4; open http://localhost:8787 2>/dev/null || xdg-open http://localhost:8787 2>/dev/null || true ) &
npx wrangler dev --port 8787
