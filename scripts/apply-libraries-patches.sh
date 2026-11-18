#!/usr/bin/env bash
# Prepare the offline library site (mirror of libraries.excalidraw.com) with our
# patch series applied.
# Usage: scripts/apply-libraries-patches.sh [dir]     (default: ./libraries-upstream)
#  - dir missing         -> fetch ONLY the pinned commit (shallow) from $LIBRARIES_REPO
#                           (default github.com/excalidraw/excalidraw-libraries)
#  - dir exists (git)    -> reuse it; must have a clean tree
#  - branch `offline` already exists -> nothing to do (delete it to re-apply)
# Source selection (when dir is missing):
#   LIBRARIES_TARBALL_URL set                 -> download that tarball
#   DLCACHE_URL set (and DLCACHE!=off)   -> tarball via the download cache
#   otherwise                            -> git clone/fetch from github
# LIBRARIES_REF (e.g. master) overrides the pinned commit (drift check); the resolved
# SHA is logged. Tarball mode commits the extracted tree as the base so no git
# history is needed.
# Needs network only for the initial fetch.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${1:-$ROOT/libraries-upstream}"
REPO="${LIBRARIES_REPO:-https://github.com/excalidraw/excalidraw-libraries.git}"
BASE="$(tr -d '[:space:]' < "$ROOT/LIBRARIES_COMMIT")"
BRANCH=offline
REF="${LIBRARIES_REF:-}"
TARBALL_URL="${LIBRARIES_TARBALL_URL:-}"
USE_TARBALL=false
if [ -n "$TARBALL_URL" ] || { [ -n "${DLCACHE_URL:-}" ] && [ "${DLCACHE:-}" != "off" ]; }; then USE_TARBALL=true; fi
TARBALL_REF="${REF:-$BASE}"
# shellcheck source=scripts/_tarball.sh
. "$ROOT/scripts/_tarball.sh"

die() { echo "error: $*" >&2; exit 1; }

shopt -s nullglob
PATCHES=("$ROOT"/patches-libraries/*.patch)
[ ${#PATCHES[@]} -gt 0 ] || die "no patches in $ROOT/patches-libraries (run scripts/export-patches.sh first)"

FRESH_TARBALL=false
if [ ! -e "$DIR" ] && $USE_TARBALL; then
  fetch_tarball_base excalidraw/excalidraw-libraries "$TARBALL_REF" "$DIR" "$TARBALL_URL" || die "tarball download failed (network?)"
  BASE="$BASE_REV"; FRESH_TARBALL=true
elif [ ! -e "$DIR" ]; then
  echo "fetching ${REF:-$BASE} from $REPO into $DIR"
  mkdir -p "$DIR"
  git -C "$DIR" init --quiet
  git -C "$DIR" remote add origin "$REPO"
  git -C "$DIR" fetch --quiet --depth 1 origin "${REF:-$BASE}" || { rm -rf "$DIR"; die "fetch failed (network?)"; }
  git -C "$DIR" checkout --quiet --detach FETCH_HEAD
  if [ -n "$REF" ]; then BASE="$(git -C "$DIR" rev-parse HEAD)"; echo "resolved $REF -> $BASE"; fi
elif [ ! -d "$DIR/.git" ]; then
  die "$DIR exists but is not a git checkout"
fi

cd "$DIR"
if [ -n "$REF" ] && ! $FRESH_TARBALL && [ "$BASE" = "$(tr -d '[:space:]' < "$ROOT/LIBRARIES_COMMIT")" ]; then
  git fetch --quiet --depth 1 origin "$REF" || die "cannot fetch $REF from origin"
  BASE="$(git rev-parse FETCH_HEAD)"
  echo "resolved $REF -> $BASE"
fi
if ! git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
  echo "fetching $BASE"
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "$REPO"
  git fetch --quiet --depth 1 origin "$BASE" || die "base commit $BASE not available and fetch failed"
  git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null || die "base commit $BASE still missing after fetch"
fi

if git rev-parse --verify --quiet "$BRANCH" >/dev/null; then
  if git merge-base --is-ancestor "$BASE" "$BRANCH"; then
    echo "branch '$BRANCH' already exists in $DIR; assuming patches applied (git branch -D $BRANCH to redo)"
    git checkout --quiet "$BRANCH" || die "cannot checkout $BRANCH (dirty tree?)"
    exit 0
  fi
  die "branch '$BRANCH' exists but is not based on $BASE"
fi

[ -z "$(git status --porcelain --untracked-files=no)" ] || die "$DIR has uncommitted changes"

git config user.name >/dev/null 2>&1 || export GIT_COMMITTER_NAME="excalidraw-offline" GIT_AUTHOR_NAME="excalidraw-offline"
git config user.email >/dev/null 2>&1 || export GIT_COMMITTER_EMAIL="offline@localhost" GIT_AUTHOR_EMAIL="offline@localhost"

git checkout --quiet -b "$BRANCH" "$BASE"
if ! git am --3way "${PATCHES[@]}"; then
  git am --abort || true
  git checkout --quiet - || true
  git branch -D "$BRANCH" >/dev/null 2>&1 || true
  die "patch application failed (series may need rebasing onto $BASE; see README)"
fi
echo "applied ${#PATCHES[@]} patch(es) on $BASE in $DIR (branch $BRANCH)"
