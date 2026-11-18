#!/usr/bin/env bash
# Export our commits on branch `offline` in upstream/ as a patch series in patches/,
# and (if libraries-upstream/ has an `offline` branch) those in libraries-upstream/
# as a series in patches-libraries/.
# Usage: scripts/export-patches.sh [upstream-dir [libraries-dir]]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UP="${1:-$ROOT/upstream}"
LIB="${2:-$ROOT/libraries-upstream}"
BASE="$(tr -d '[:space:]' < "$ROOT/UPSTREAM_COMMIT")"

[ -d "$UP/.git" ] || { echo "error: $UP is not a git checkout" >&2; exit 1; }
git -C "$UP" rev-parse --verify --quiet "$BASE^{commit}" >/dev/null \
  || { echo "error: base commit $BASE not found in $UP" >&2; exit 1; }
git -C "$UP" rev-parse --verify --quiet offline >/dev/null \
  || { echo "error: branch 'offline' not found in $UP" >&2; exit 1; }
git -C "$UP" merge-base --is-ancestor "$BASE" offline \
  || { echo "error: branch 'offline' is not based on $BASE (rebase it first)" >&2; exit 1; }

mkdir -p "$ROOT/patches"
rm -f "$ROOT"/patches/*.patch
git -C "$UP" format-patch --no-signature -o "$ROOT/patches" "$BASE..offline"
echo "exported $(find "$ROOT/patches" -maxdepth 1 -name "*.patch" | wc -l) patch(es) to patches/"

# ---- library site series
if [ -d "$LIB/.git" ] && git -C "$LIB" rev-parse --verify --quiet offline >/dev/null; then
  LBASE="$(tr -d '[:space:]' < "$ROOT/LIBRARIES_COMMIT")"
  git -C "$LIB" rev-parse --verify --quiet "$LBASE^{commit}" >/dev/null \
    || { echo "error: base commit $LBASE not found in $LIB" >&2; exit 1; }
  git -C "$LIB" merge-base --is-ancestor "$LBASE" offline \
    || { echo "error: branch 'offline' in $LIB is not based on $LBASE (rebase it first)" >&2; exit 1; }
  mkdir -p "$ROOT/patches-libraries"
  rm -f "$ROOT"/patches-libraries/*.patch
  git -C "$LIB" format-patch --no-signature -o "$ROOT/patches-libraries" "$LBASE..offline"
  echo "exported $(find "$ROOT/patches-libraries" -maxdepth 1 -name "*.patch" | wc -l) patch(es) to patches-libraries/"
else
  echo "note: no 'offline' branch in $LIB; patches-libraries/ left untouched"
fi
