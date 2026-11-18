# shellcheck shell=bash
# Shared helper, sourced by apply-patches.sh / apply-libraries-patches.sh.
# Provides: fetch_tarball_base <github-slug> <ref-or-sha> <dir> [tarball-url-override]
#
# Downloads a GitHub source tarball (through the download cache when
# $DLCACHE_URL is set), extracts it into <dir>, `git init`s and commits the tree
# as a single base commit. The tree is byte-identical to the upstream commit, so
# `git am --3way` finds every blob it needs. Prints the resolved upstream SHA
# (from the tarball's embedded commit id) to stderr and sets TARBALL_SHA and
# BASE_REV (the local base commit) for the caller.
tarball_url() { # slug ref
  local slug="$1" ref="$2"
  if [ -n "${DLCACHE_URL:-}" ] && [ "${DLCACHE:-}" != "off" ]; then
    echo "${DLCACHE_URL%/}/github.com/$slug/archive/$ref.tar.gz"
  else
    echo "https://github.com/$slug/archive/$ref.tar.gz"
  fi
}

fetch_tarball_base() {
  local slug="$1" ref="$2" dir="$3" url="${4:-}" tmp
  [ -n "$url" ] || url="$(tarball_url "$slug" "$ref")"
  tmp="$(mktemp)"
  echo "downloading $url"
  if ! curl -fsSL --retry 3 --retry-delay 2 -o "$tmp" "$url"; then
    local direct="https://github.com/$slug/archive/$ref.tar.gz"
    if [ "$url" != "$direct" ] && [ -z "${4:-}" ]; then
      echo "download via cache failed; falling back to $direct" >&2
      curl -fsSL --retry 3 --retry-delay 2 -o "$tmp" "$direct" || { rm -f "$tmp"; return 1; }
    else
      rm -f "$tmp"; return 1
    fi
  fi
  TARBALL_SHA="$(gzip -dc "$tmp" | git get-tar-commit-id 2>/dev/null || true)"
  mkdir -p "$dir"
  tar -xzf "$tmp" -C "$dir" --strip-components=1 || { rm -rf "$tmp" "$dir"; return 1; }
  rm -f "$tmp"
  git -C "$dir" init --quiet
  git -C "$dir" add -f -A
  git -C "$dir" -c user.name=tarball-base -c user.email=base@localhost \
    commit --quiet -m "tarball base ${TARBALL_SHA:-$ref} ($slug)"
  BASE_REV="$(git -C "$dir" rev-parse HEAD)"
  echo "resolved $slug@$ref -> ${TARBALL_SHA:-unknown} (tarball base commit $BASE_REV)" >&2
}
