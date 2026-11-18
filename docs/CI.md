# CI/CD (GitLab, git.0b.au)

`.gitlab-ci.yml` first proves the patch series apply and the result works, then
builds and pushes the Docker image to the **GitLab container registry** of this project.

## Pipeline

| Job | Stage | Runs on | What it does |
|---|---|---|---|
| `test:patches` | test | MR, default branch, tags | `scripts/ci-test.sh`: apply `patches/` and `patches-libraries/` onto the pinned upstream commits, `yarn install --frozen-lockfile`, typecheck, eslint, prettier, unit tests, `yarn build:app:docker`, server `npm test`, offline e2e (Playwright/chromium). Artifacts: `dist/app`, `dist/libraries` (1 week), Playwright report, JUnit. |
| `test:upstream-drift` | test | scheduled/web pipelines with `UPSTREAM_REF` or `LIBRARIES_REF` | Same script against that ref instead of the pinned commits. The resolved SHA is logged. Fails when the series stops applying or tests break. Nothing is built or pushed. |
| `build:mr` | build | MRs | docker-build component, `push: false` (build validation only). |
| `build` | build | default branch | Builds and pushes `$CI_REGISTRY_IMAGE:<short-sha>` and `:latest`. |
| `build:tag` | build | git tags | Pushes `:<tag>` and `:<short-sha>`. |
| `sbom` / `sbom:tag` | build | default branch / tags | CycloneDX SBOM of the pushed digest (sbom component). |
| `mirror:github` | mirror | default branch, when `GITHUB_TOKEN` is set | `scripts/mirror-github.sh`: pushes the default branch and tags to GitHub (`GITHUB_REPO`), every commit's author and committer rewritten to the GitHub identity. Runs after `build`. |
| `semgrep` | test | MRs, default branch, tags | semgrep component (non-failing by default). |

All build jobs `needs: test:patches` (with artifacts) and use `Dockerfile.ci`, a
runtime-only Dockerfile that copies the already built and tested `dist/app` and
`dist/libraries`, so the pushed image is exactly what was tested. The plain
`Dockerfile` still builds everything from scratch (`docker build .`) and also honours
`BASE_REGISTRY`, `DLCACHE_URL` and `npm_config_registry`.

Components come from `$CI_SERVER_FQDN/cicd-components/basics/{docker-build,sbom,semgrep}@main`.
Registry, credentials and image name use the components' defaults (`$CI_REGISTRY`,
`$CI_REGISTRY_USER`, `$CI_REGISTRY_PASSWORD`, `$CI_PROJECT_PATH`). Runner tag: `jack-cbr`.

## Variables

Required (instance/group level, already used by other projects): `HARBOR_DOCKER`
(Harbor Docker Hub proxy prefix for job and base images). The runners supply
`DLCACHE_URL` and `npm_config_registry`; `DLCACHE=off` makes everything fall back to
github.com / registry.yarnpkg.com directly.

Optional:

- `GITHUB_TOKEN` (masked, protected): enables `mirror:github`. A fine-grained token with *Contents: read and write* on the GitHub repo. `GITHUB_REPO` (default `eddster2309/Offline-Excalidraw`), `GITHUB_NAME` and `GITHUB_EMAIL` (default the eddster2309 noreply address) override the target and identity. The rewrite keeps dates and messages, so it is deterministic: the same GitLab history always gives the same GitHub SHAs. The push is `--force`, so GitHub must not be committed to directly. Try it locally with `DRY_RUN=1 MIRROR_BRANCH=main scripts/mirror-github.sh`.
- `UPSTREAM_REF`, `LIBRARIES_REF`: branch/tag/sha to test instead of the pinned commits (drift job only).
- `PLAYWRIGHT_DOWNLOAD_HOST`: where `playwright install` fetches Chromium from (see below).
- `VITEST_MAX_WORKERS`: unit test workers. `.gitlab-ci.yml` sets `2`: the runner pods have no CPU request or limit, see all 12 cores of a node but get a fraction of them, and more workers push tests past their timeouts. Unset, `ci-test.sh` uses the container's CPU quota, else `nproc`.
- `VITEST_RETRY`: retries per failed unit test (default `2`), for cold-start timeouts on slow runners.
- `VITEST_TEST_TIMEOUT`: default per-test timeout in ms (default `60000`, vitest's own is 5000).
- `VITEST_SKIP`: regex of full unit test names to leave out. `.gitlab-ci.yml` skips `exportToSvg with a CJK font` (fixed 30s budget, ~70s on the current runner nodes) and `exportToSvg with exportEmbedScene` (its snapshot depends on the ids the CJK test generates). Remove it once the runner is faster; both pass locally.

The job log prints the runner's capacity (`cpus: nproc=… quota=… bench=…ms`). For faster, steadier pipelines give the Kubernetes runner a CPU request (or allow `KUBERNETES_CPU_REQUEST` overrides via `cpu_request_overwrite_max_allowed`) so the pod is not best-effort.

The registry cache and image repository need no setup: the job token pushes to the project's own registry.

## Download cache behaviour

- Patch scripts: with `DLCACHE_URL` set (or `UPSTREAM_TARBALL_URL` / `LIBRARIES_TARBALL_URL`) the sources are fetched as
  `$DLCACHE_URL/github.com/<owner>/<repo>/archive/<ref>.tar.gz`, extracted, committed as a base commit
  and patched with `git am --3way` (identical tree, so the blobs exist). Without it the scripts clone from github as before.
  If the cache download fails they retry directly from github.com.
- yarn 1 does **not** apply `npm_config_registry` to URLs already pinned in `yarn.lock` (verified: it still requests
  registry.yarnpkg.com). `ci-test.sh` and the `Dockerfile` therefore `sed` the lockfile URLs to the cache registry
  before installing and restore the lockfile afterwards. `npm ci` (server, e2e) honours `npm_config_registry` natively.

## Weekly drift check

1. CI/CD > Schedules > New schedule (e.g. `0 4 * * 1`, target branch = default branch).
2. Add schedule variable `UPSTREAM_REF` = `master` (optionally `LIBRARIES_REF` = `main`).
3. A pipeline with only `test:upstream-drift` runs. When it fails, rebase the patches
   (`upstream/` checkout, `git rebase`, `scripts/export-patches.sh`) and bump `UPSTREAM_COMMIT`.

Run it by hand: Build > Pipelines > Run pipeline (source `web`) with `UPSTREAM_REF` set.

## Playwright browser download

The Playwright CDN (`cdn.playwright.dev`, `playwright.download.prss.microsoft.com`) is not on the
dlcache allowlist, so `npx playwright install --with-deps chromium` downloads straight from the
internet (apt packages for `--with-deps` come through the runner's rewritten apt sources). Browsers are cached in
`.cache/ms-playwright` by GitLab cache keyed on `e2e/package-lock.json`. To route the download through dlcache:
add both hosts to the dlcache nginx allowlist, then set a CI/CD variable
`PLAYWRIGHT_DOWNLOAD_HOST=$DLCACHE_URL/cdn.playwright.dev` (check the path layout of the proxy; the fallback host
`playwright.download.prss.microsoft.com` is used by Playwright when the first fails).

## Running the test job locally

    docker run --rm -v "$PWD:/repo" -w /repo \
      -e DLCACHE_URL=https://cache.0b.au -e npm_config_registry=https://cache.0b.au/npm/ \
      node:22-bookworm scripts/ci-test.sh
    docker build -f Dockerfile.ci .      # afterwards; uses ./dist

`SKIP_UNIT=1` and `SKIP_E2E=1` skip those steps. Work files go to `work/`, `dist/`, `reports/`, `.cache/` (git-ignored).
