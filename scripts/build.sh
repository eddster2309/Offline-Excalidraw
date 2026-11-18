#!/usr/bin/env bash
# Build everything: patched Excalidraw app + server deps.
# Network access is needed ONLY here (git clone, yarn/npm install). The built
# app and the server make no external requests at runtime.
# Usage: scripts/build.sh [upstream-dir]
# Set INCLUDE_LIBRARIES=false to skip the offline library site.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UP="${1:-$ROOT/upstream}"

"$ROOT/scripts/apply-patches.sh" "$UP"
if [ "${INCLUDE_LIBRARIES:-true}" = "true" ]; then
  "$ROOT/scripts/apply-libraries-patches.sh" "${LIBRARIES_DIR:-$ROOT/libraries-upstream}"
fi

cd "$UP"
yarn install --frozen-lockfile        # network
yarn build:app:docker                 # local; output: excalidraw-app/build

cd "$ROOT/server"
npm ci                                # network

echo
echo "done. run: STATIC_DIR=$UP/excalidraw-app/build LIBRARIES_DIR=${LIBRARIES_DIR:-$ROOT/libraries-upstream} node $ROOT/server/src/server.js"
