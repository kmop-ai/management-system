#!/bin/bash
# Double-click to start KMOP HQ on this Mac. Keep the window that opens;
# closing it stops KMOP HQ for everyone.
cd "$(dirname "$0")"
if ! command -v node >/dev/null; then
  echo "Node.js is not installed. Install it from https://nodejs.org (the LTS button), then double-click again."
  read -r -p "Press Enter to close." _; exit 1
fi
[ -d node_modules ] || npm install --silent
if [ ! -d local-data ]; then npm run --silent local:setup || { read -r -p "Press Enter to close." _; exit 1; }; fi
npm run --silent local
