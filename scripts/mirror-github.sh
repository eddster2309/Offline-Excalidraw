#!/bin/sh
# Mirror the default branch and tags to GitHub with every commit's author and
# committer rewritten to the GitHub identity. Dates and messages are kept, so
# the rewrite is deterministic: the same GitLab history always gives the same
# GitHub SHAs and repeat runs push nothing new.
# Env:
#   GITHUB_TOKEN        token with contents:write on GITHUB_REPO (required)
#   GITHUB_REPO         owner/name (default eddster2309/excalidraw-offline)
#   GITHUB_NAME / GITHUB_EMAIL   identity (default the eddster2309 noreply address)
#   MIRROR_BRANCH       branch to mirror (default CI_DEFAULT_BRANCH, else main)
#   DRY_RUN=1           rewrite but don't push
set -eu
: "${GITHUB_REPO:=eddster2309/excalidraw-offline}"
: "${GITHUB_NAME:=eddster2309}"
: "${GITHUB_EMAIL:=16095534+eddster2309@users.noreply.github.com}"
BRANCH="${MIRROR_BRANCH:-${CI_DEFAULT_BRANCH:-main}}"
[ -n "${DRY_RUN:-}" ] || : "${GITHUB_TOKEN:?set GITHUB_TOKEN (masked CI/CD variable)}"

# Work in a throwaway clone so the checkout (or a local repo) is never rewritten.
SRC="$(git rev-parse --show-toplevel)"
[ "$(git -C "$SRC" rev-parse --is-shallow-repository)" = false ] || { echo "shallow clone: set GIT_DEPTH: 0" >&2; exit 1; }
REV="${CI_COMMIT_SHA:-$(git -C "$SRC" rev-parse "$BRANCH")}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
git init -q --bare "$TMP/repo"
git -C "$SRC" push -q "$TMP/repo" "$REV:refs/heads/$BRANCH" 'refs/tags/*:refs/tags/*'
cd "$TMP/repo"

export GITHUB_NAME GITHUB_EMAIL FILTER_BRANCH_SQUELCH_WARNING=1
git filter-branch -f --env-filter '
  GIT_AUTHOR_NAME="$GITHUB_NAME"; GIT_AUTHOR_EMAIL="$GITHUB_EMAIL"
  GIT_COMMITTER_NAME="$GITHUB_NAME"; GIT_COMMITTER_EMAIL="$GITHUB_EMAIL"
' --tag-name-filter cat -- "$BRANCH" --tags >/dev/null

echo "authors after rewrite:"; git log "$BRANCH" --tags --format='  %an <%ae> / %cn <%ce>' | sort | uniq -c
if [ -n "${DRY_RUN:-}" ]; then git log --oneline "$BRANCH" | head; exit 0; fi
# GitHub is a mirror: GitLab history wins (--force), tags are pushed as rewritten.
git push --force "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git" \
  "refs/heads/$BRANCH:refs/heads/$BRANCH" 'refs/tags/*:refs/tags/*'
