#!/usr/bin/env bash
# CI test pipeline: apply both patch series, install, typecheck/lint/format/unit
# tests, build the app, test the server, run the offline e2e suite.
# Runs identically in GitLab CI (node:22-bookworm) and locally in a container:
#   docker run --rm -v "$PWD:/repo" -w /repo node:22-bookworm scripts/ci-test.sh
# Env:
#   UPSTREAM_REF / LIBRARIES_REF   test against a branch instead of the pinned commits
#   DLCACHE_URL, npm_config_registry   download cache (set by the runners; optional)
#   PLAYWRIGHT_DOWNLOAD_HOST       browser CDN override (default: playwright's own CDN)
#   WORK_DIR (default ./work)  OUT_DIR (default ./dist)  CACHE_DIR (default ./.cache)
#   SKIP_UNIT=1 / SKIP_E2E=1       skip those steps (local convenience)
#   VITEST_MAX_WORKERS             unit test workers (default: the container's CPU quota)
#   VITEST_RETRY                   retries per failed unit test (default 2)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${WORK_DIR:-$ROOT/work}"; OUT="${OUT_DIR:-$ROOT/dist}"; CACHE="${CACHE_DIR:-$ROOT/.cache}"
UP="$WORK/upstream"; LIB="$WORK/libraries"
export YARN_CACHE_FOLDER="$CACHE/yarn" npm_config_cache="$CACHE/npm" PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$CACHE/ms-playwright}"
export CI=true GIT_COMMITTER_NAME=ci GIT_COMMITTER_EMAIL=ci@localhost GIT_AUTHOR_NAME=ci GIT_AUTHOR_EMAIL=ci@localhost
# CPUs this container may actually use: the cgroup quota (v2, then v1), else
# nproc. vitest sizes its worker pool from the host's cores, which inside a
# CPU-limited pod oversubscribes it until tests hit their timeouts.
cgroup_cpus() {
  local quota period
  if read -r quota period 2>/dev/null < /sys/fs/cgroup/cpu.max && [ "$quota" != max ]; then :
  elif quota=$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us 2>/dev/null) && [ "$quota" -gt 0 ] 2>/dev/null; then
    period=$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us)
  else
    nproc; return
  fi
  local n=$(( (quota + period - 1) / period ))
  echo $(( n < 1 ? 1 : n ))
}
UNIT_WORKERS="${VITEST_MAX_WORKERS:-$(cgroup_cpus)}"
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

step "node $(node -v), yarn $(yarn -v), npm $(npm -v); DLCACHE_URL=${DLCACHE_URL:-<unset>} npm_config_registry=${npm_config_registry:-<unset>}"
# runner capacity, for comparing slow pipelines: visible cores, cgroup quota,
# and a fixed single-threaded workload (~0.5s on a fast desktop core)
echo "cpus: nproc=$(nproc) quota=$(cat /sys/fs/cgroup/cpu.max 2>/dev/null || echo n/a) unit_workers=$UNIT_WORKERS" \
  "bench=$(node -e 'const t=Date.now();let x=0;for(let i=0;i<3e8;i++)x+=i%7;console.log((Date.now()-t)+"ms")')"
rm -rf "$WORK" "$OUT"; mkdir -p "$WORK" "$OUT"

step "apply upstream patches (${UPSTREAM_REF:-pinned $(cat "$ROOT/UPSTREAM_COMMIT")})"
"$ROOT/scripts/apply-patches.sh" "$UP"
step "apply libraries patches (${LIBRARIES_REF:-pinned $(cat "$ROOT/LIBRARIES_COMMIT")})"
"$ROOT/scripts/apply-libraries-patches.sh" "$LIB"

step "yarn install --frozen-lockfile"
cd "$UP"
# yarn 1 ignores npm_config_registry for URLs already pinned in yarn.lock, so
# point them at the cache registry (Verdaccio proxies the same tarballs) and
# restore the lockfile afterwards so the tree stays clean.
if [ -n "${npm_config_registry:-}" ]; then
  sed -i "s#https://registry.yarnpkg.com/#${npm_config_registry%/}/#g" yarn.lock
fi
# one retry: yarn 1 occasionally fails a parallel fetch (ENOENT in its cache); a rerun reuses what was fetched
yarn install --frozen-lockfile --network-timeout 300000 || yarn install --frozen-lockfile --network-timeout 300000
git checkout --quiet -- yarn.lock

step "typecheck / lint / format"
yarn test:typecheck
yarn test:code
yarn test:other
if [ -z "${SKIP_UNIT:-}" ]; then
  step "unit tests (${UNIT_WORKERS} workers, ${VITEST_RETRY:-2} retries)"
  # Retries absorb cold-start timeouts on slow runners: a worker's first editor
  # render loads the lazy modules and can exceed the test helpers' 1s wait.
  # A real failure fails every attempt and still fails the job.
  yarn test:app --watch=false --maxWorkers="$UNIT_WORKERS" --minWorkers=1 --retry="${VITEST_RETRY:-2}"
fi

step "build app"
yarn build:app:docker
mkdir -p "$OUT/app" "$OUT/libraries"
cp -r "$UP/excalidraw-app/build/." "$OUT/app/"
# same whitelist as the Dockerfile's libs stage
(cd "$LIB" && cp -r index.html script.js style.css favicon.ico LICENSE libraries.json stats.json total.json vendor libraries "$OUT/libraries/")

step "server tests"
cd "$ROOT/server" && npm ci && npm test

if [ -z "${SKIP_E2E:-}" ]; then
  step "e2e (offline) tests"
  cd "$ROOT/e2e" && npm ci
  if [ -n "${PLAYWRIGHT_DOWNLOAD_HOST:-}" ]; then echo "playwright browsers from $PLAYWRIGHT_DOWNLOAD_HOST"; fi
  npx playwright install --with-deps chromium
  mkdir -p "$ROOT/reports"
  STATIC_DIR="$OUT/app" LIBRARIES_DIR="$OUT/libraries" \
  PLAYWRIGHT_JUNIT_OUTPUT_FILE="$ROOT/reports/e2e-junit.xml" \
  PLAYWRIGHT_HTML_OUTPUT_DIR="$ROOT/reports/playwright-report" PLAYWRIGHT_HTML_OPEN=never \
    npx playwright test --reporter=list,junit,html --output="$ROOT/reports/test-results"
fi
step "all green"
