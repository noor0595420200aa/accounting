#!/bin/sh
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Install Node.js from https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install
(sleep 3; open http://localhost:3000 2>/dev/null || xdg-open http://localhost:3000) &
node server/index.js
