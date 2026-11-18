# TODO

Open items only; see README for what is implemented.

## Needs a decision

- [ ] Create the GitLab project on git.0b.au and push; then create the weekly drift schedule (`UPSTREAM_REF=master`, see `docs/CI.md`)
- [ ] Add `cdn.playwright.dev` and `playwright.download.prss.microsoft.com` to the dlcache allowlist (homelab-infra) so CI downloads Chromium through the cache (today: direct)
- [ ] Keep the built-in collab relay, or run the official `excalidraw-room` image for `/socket.io/` behind a reverse proxy (current: built-in)

## Verify on GitLab

- [ ] First real pipeline: YAML lint, `build*` jobs wait for `test:patches`, drift job with `UPSTREAM_REF`

## Gaps

- [ ] With `DISABLE_PERSISTENCE=true`, an old `#json=` share link still calls `/api/v2` and shows a generic error instead of "share links are disabled"
- [ ] "Live collaboration is disabled on this server." and the library "published" wording are English only (not in the locale files)
- [ ] Libraries: no review/auth on publish; unpublish by hand (`DATA_DIR/libraries/index.json`); download counts are upstream's static stats
- [ ] Banner layout: the editor re-measures via a synthetic `resize` event when the banner appears/disappears (workaround for a rare stale canvas height; root cause not found)
- [ ] No access control on the server (rooms, links, publishing); rely on a reverse proxy

## Untested

- [ ] Images in share links (e2e covers images in live collaboration only)
- [ ] Service worker / PWA offline install (e2e blocks service workers)
- [ ] Banner in zen mode

## Maintenance ideas

- [ ] Stop carrying `yarn.lock` and test-snapshot changes in the patches (regenerate in CI) to reduce rebase conflicts
- [ ] Build-output domain scan in CI against an allowlist of inert strings
- [ ] Upstream the generic parts (pluggable storage backend, configurable asset URLs, env-gated Plus/AI) to shrink the series
- [ ] Data retention option on the server (purge rooms/links untouched for N days)
- [ ] Remove links from the unused `MainMenu.DefaultItems.Socials` component (dead code in the bundle)
