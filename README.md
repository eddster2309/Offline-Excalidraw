# excalidraw-offline

Excalidraw that runs fully offline, including live collaboration, shipped as:

1. a **patch series** (`patches/`) against a pinned upstream Excalidraw commit (`UPSTREAM_COMMIT`),
2. a **patch series for the library site** (`patches-libraries/`) against a pinned commit of [excalidraw-libraries](https://github.com/excalidraw/excalidraw-libraries) (`LIBRARIES_COMMIT`), the static site behind libraries.excalidraw.com, and
3. a **self-hosted Node server** (`server/`) that serves the built app, the socket.io collaboration room, share links (`/api/v2`), room scenes (`/api/scenes`) and image files (`/api/files`), the library site (`/libraries/`) and library publishing (`/api/libraries/submit`) from one port.

## Threat model

No network egress at runtime. The browser only talks to the origin that served the app (HTTP + websocket). No fonts CDN, analytics, error reporting, Firebase, excalidraw.com backends, AI or Excalidraw+ calls. Network is needed only at build time (git clone/fetch, `yarn`/`npm` installs). Collaboration stays end-to-end encrypted: the server stores/relays ciphertext only and never sees room keys (they live in the URL hash). There is no authentication: anyone who can reach the server and knows a room link can join; put it behind your own access control if needed.

**Serve it over HTTPS** (or open it on `localhost`). Collaboration and share links encrypt in the browser with the Web Crypto API, which browsers only allow in a secure context; over plain `http://<server-ip>` starting a session or exporting a link fails. In an air-gapped network that usually means a TLS-terminating reverse proxy (nginx, Traefik, Caddy) with a certificate from an internal CA in front of port 3000. Proxy websockets for `/socket.io/`.

## Quick start

    docker compose up --build          # http://localhost:3000, data in volume excalidraw-data

Per-deployment settings (banner, share note, toggles; see below) go in a `.env` file next to `docker-compose.yml`, which compose reads automatically and git ignores:

    BANNER_TEXT=QA
    SHARE_NOTE=**There is no access control.** Anyone with the link can access this drawing.
    DISABLE_PERSISTENCE=true

or without Docker (Node 22, yarn 1):

    scripts/build.sh
    STATIC_DIR=upstream/excalidraw-app/build LIBRARIES_DIR=libraries-upstream DATA_DIR=./data node server/src/server.js

The top-level `Dockerfile` builds everything (clone upstream at `UPSTREAM_COMMIT`, apply patches, build, fetch the library site at `LIBRARIES_COMMIT` and apply its patches, then a minimal alpine runtime image; non-root, `/healthz` healthcheck, volume `/data`). Build without the library site: `docker build --build-arg INCLUDE_LIBRARIES=false .` (or `INCLUDE_LIBRARIES=false scripts/build.sh`); `/libraries` then returns 404 and publishing is disabled, the app still works.

## Environment variables (server)

| var | default | meaning |
|---|---|---|
| PORT | 3000 | listen port |
| STATIC_DIR | ../upstream/excalidraw-app/build (image: /app/public) | built app |
| LIBRARIES_DIR | ../libraries-upstream (image: /app/libraries) | offline library site; if missing, `/libraries` is 404 and publishing is disabled |
| DATA_DIR | ./data (image: /data) | storage (links/, scenes/, files/, libraries/) |
| CORS_ORIGIN | unset | extra allowed origin for HTTP and socket.io (normally not needed: dev mode proxies through Vite) |
| BANNER_TEXT | unset (off) | environment banner text, max 100 chars (see Runtime configuration) |
| BANNER_MODE | always | `always`: permanent; `sending`: banner only while a live collaboration session is active. Anything else = `always` |
| SHARE_NOTE | unset | note shown in the share dialog (max 500 chars, see Runtime configuration) |
| BANNER_COLOR | #8b0000 | banner background: `#rgb`, `#rrggbb` or a CSS colour name; invalid values fall back to the default |
| BANNER_TEXT_COLOR | #ffffff | banner text colour (same validation) |
| USERNAME_HEADER | unset (off) | request header carrying the user's name, e.g. `X-Forwarded-User` |
| USERNAME_HEADER_LOCK | true | `false`: the header name is only a default the user can change |
| DISABLE_PERSISTENCE | false | `true`: no share links, no scene saving, no library publishing, nothing written to disk |
| DISABLE_COLLABORATION | false | `true`: no live collaboration (socket.io not attached, room endpoints 404, collaboration UI hidden); share links keep working unless `DISABLE_PERSISTENCE` is also set |
| MEMORY_FILES_MAX_MB | 256 | with persistence disabled: cap for in-memory collab images (HTTP 507 when full) |
| MEMORY_ROOM_GRACE_SECONDS | 60 | with persistence disabled: how long a room's images are kept after its last user left |

See `server/README.md` for the HTTP/socket API.

## Runtime configuration (one image for QA and PROD)

All of the following is read from environment variables when the container starts; the app fetches it once at startup from `GET /api/config` (same origin, never cached by the browser or the service worker). If that request fails (e.g. an older server) the app uses the defaults: no banner, no username, persistence and collaboration on. See `docker-compose.yml` (`docker compose --profile envs up`) for a QA and a PROD service from the same image.

### Environment banner

`BANNER_TEXT=QA` shows a thin full-width strip at the very top of the page (the editor shrinks to fit below it, also on mobile) in a system sans-serif font; the tab title is left unchanged. Colours are static settings (`BANNER_COLOR`, `BANNER_TEXT_COLOR`), not derived from the text; they are validated server-side (hex or plain colour names only) to rule out CSS injection. The text is rendered as text, never as HTML.

`BANNER_MODE` decides when it is shown. `always` (default): permanent, as described above. `sending`: only while a live collaboration session is active, i.e. while scene, cursors and images are leaving the browser; it appears when a session starts (also when joining via a `#room=` link) and disappears when the session is stopped; the editor resizes accordingly. The library site (`/libraries/`) sends nothing, so it hides the banner in `sending` mode.

### Share dialog note

`SHARE_NOTE` shows a note near the top of the share dialog, in every state (before starting a session, during a session, next to "Export to link"). The server trims it, strips control characters (newlines are kept), converts literal `\n` sequences to newlines and caps it at 500 characters (raw markup counts). It is shown as text with newlines preserved, never as HTML. A tiny markup is supported: `**bold**` and `[colour]text[/]` where colour is a CSS colour name (letters only) or `#rgb`/`#rrggbb`; they can be nested (`**[red]Do not share client data[/]**`), anything invalid or unmatched is shown literally. Example: `SHARE_NOTE='**[darkred]QA environment[/]** - test data only\nDo not share client data'`.

### Username from a request header

`USERNAME_HEADER=X-Forwarded-User` makes the server return that header's value from `/api/config` (percent-decoded if encoded, trimmed, control characters removed, max 64 chars). The app uses it as the collaboration name, overriding the name saved in the browser. With `USERNAME_HEADER_LOCK=true` (default) the name field in the live-collaboration dialog is read-only ("Set by your organisation") and the name cannot be changed; with `false` it is just the default.

**Security note.** This is identity *labelling*, not authentication. It is only safe behind a reverse proxy that authenticates users, sets the header itself and **strips any client-supplied copy of it**; otherwise anybody can send any name. The names are not cryptographically enforced between peers: they are sent inside the client-encrypted collaboration payloads, so a modified client can still claim another name. The server never sees them besides in this endpoint.

To try it locally, `examples/auth-proxy/` runs the app behind nginx with basic auth (test users alice, bob, carol) on http://localhost:3100.

### `DISABLE_PERSISTENCE=true`

For throw-away environments. Collaboration still works fully (new joiners get the scene from the peers over the socket, as in upstream), but nothing is stored:

- `/api/v2/*` (share links), `/api/scenes/*`, `/api/files/shareLinks/*` and `POST /api/libraries/submit` answer `404 {"error":"persistence disabled"}`; `DATA_DIR` is never created or written (the container can run with a read-only filesystem).
- The app hides "Export to link" (share and export dialogs) and "Publish library", and skips scene saves silently. The library site (browse/install, `LIBRARIES_DIR` catalog only) keeps working.
- Collaboration images: upstream sends images via storage, not via the socket, so `/api/files/rooms/<room>/<file>` keeps working but is backed by a **memory store**. A room's files are deleted `MEMORY_ROOM_GRACE_SECONDS` (default 60) after the last socket left the room (the grace period covers page reloads; a rejoin cancels the purge; files uploaded to a room nobody is in are purged the same way). Total size is capped by `MEMORY_FILES_MAX_MB` (default 256); uploads beyond it get `507`, and the image does not sync.
- Consequence: when everybody leaves a room, its content is gone for good (only the participants' own browsers keep their local copy).

### `DISABLE_COLLABORATION=true`

No live collaboration at all; nothing ever connects over a socket.

- The server does not attach socket.io (`/socket.io/` answers 404) and `/api/scenes/*` and `/api/files/rooms/*` answer `404 {"error":"collaboration disabled"}`. `/api/config` reports `"collaboration": false`.
- The app never creates a socket. The share dialog drops the "Live collaboration" section and the "Or" separator and shows only "Export to link" (plus `SHARE_NOTE`); the main menu, welcome screen and command palette entries for live collaboration and "stop session" are removed. The environment banner in `BANNER_MODE=sending` therefore never shows.
- Opening a `#room=` link keeps the local scene, shows the toast "Live collaboration is disabled on this server." and removes the hash from the URL.
- Share links (`/api/v2`, `/api/files/shareLinks`) and the library site are unaffected unless `DISABLE_PERSISTENCE` is set too.
- **Fully local mode** (`DISABLE_COLLABORATION=true` and `DISABLE_PERSISTENCE=true`): there is nothing to share, so the Share button is hidden completely; drawings stay in the browser's local storage and the server only serves static files and the library site; `DATA_DIR` is never created.

## Patch series

`patches/` (upstream Excalidraw, in this order; each commit compiles on its own):

1. **backends**: Firebase, json.excalidraw.com and the collab URL become same-origin HTTP (`/api/v2/`, `/api/scenes`, `/api/files`, `/socket.io`); drops `firebase` and the Excalidraw+ export component; dev server proxies `/api`, `/socket.io`, `/libraries` to `localhost:3000`.
2. **fonts**: self-hosted fonts, no CDN/esm.sh/Google font hosts.
3. **telemetry**: removes Sentry and simpleanalytics.
4. **index.html**: no Excalidraw+ redirect, relative meta urls, no sitemap plugin.
5. **Excalidraw+**: removes promos, sign-in, export route and `vercel.json`.
6. **AI**: removes text-to-diagram chat and diagram-to-code; keeps Mermaid.
7. **external links**: removes social/external links (and the snapshot updates that follow).
8. **same-origin restrictions + libraries**: `#url=`, embeddables and `#addLibrary=` only accept same-origin urls (one `isSameOriginUrl` helper); library browser/publish point at `/libraries/` and `/api/libraries`.
9. **runtime config**: `GET /api/config` drives the environment banner (`BANNER_MODE`), forced username, `DISABLE_PERSISTENCE`, `SHARE_NOTE` and `DISABLE_COLLABORATION`.

`patches-libraries/` (library site): 1. remove Google Analytics; serve the CSS and the Virgil font from `vendor/` instead of CDNs; 2. same-origin install flow, escaped catalog strings, no external links; 3. environment banner from `/api/config` (hidden in `BANNER_MODE=sending`).

## Layout

- `UPSTREAM_COMMIT`, `patches/` - upstream Excalidraw base commit and the `git format-patch` series against it (generated, commit it)
- `LIBRARIES_COMMIT`, `patches-libraries/` - the same for the library site
- `server/` - the Node server (`src/server.js`, `src/libraries.js`, `src/runtimeConfig.js`) and its tests (`npm test`)
- `e2e/` - Playwright offline verification
- `scripts/apply-patches.sh [dir]`, `scripts/apply-libraries-patches.sh [dir]` - create branch `offline` at the base commit and `git am --3way` the series (git clone, or a tarball through `$DLCACHE_URL` in CI)
- `scripts/export-patches.sh` - regenerate `patches/` and `patches-libraries/` from the `offline` branches
- `scripts/build.sh` - apply both series, install, build the app, `npm ci` in `server/`
- `scripts/ci-test.sh` - everything CI runs (apply, typecheck, lint, unit, build, server tests, e2e)
- `Dockerfile` - standalone image build from source; `Dockerfile.ci` - runtime-only image from CI's tested build; `docker-compose.yml` - default service plus a QA/PROD example
- `.gitlab-ci.yml`, `docs/CI.md` - GitLab pipeline
- `examples/auth-proxy/` - test environment for `USERNAME_HEADER` (nginx + basic auth)
- `upstream/`, `libraries-upstream/` (gitignored) - working checkouts on branch `offline`

## Dev workflow

1. `scripts/apply-patches.sh` (once) to get `upstream/` on branch `offline`.
2. Edit and commit in `upstream/` (or `libraries-upstream/`) on branch `offline` (one logical change per commit).
3. `scripts/export-patches.sh`, then commit `patches/` and `patches-libraries/` in this repo.

To run the app in dev mode: start the server (`node server/src/server.js`, port 3000) and `yarn start` in `upstream/` (Vite on port 3001). Vite proxies `/api`, `/socket.io` and `/libraries` to the server, so everything is same-origin and `CORS_ORIGIN` is not needed.

### Rebase onto newer upstream

    cd upstream && git fetch origin && git rebase --onto <new-commit> $(cat ../UPSTREAM_COMMIT) offline
    # resolve conflicts, rebuild, run e2e
    cd .. && echo <new-commit> > UPSTREAM_COMMIT && scripts/export-patches.sh

## Libraries (browse, install, publish - offline)

The library site of libraries.excalidraw.com is mirrored and served by the server at `/libraries/` (same origin as the app). The app is built with `VITE_APP_LIBRARY_URL=/libraries/` and `VITE_APP_LIBRARY_BACKEND=/api/libraries` (relative, so everything stays on one origin).

- **Browse**: library sidebar -> "Browse libraries" opens `/libraries/` (new tab). The catalog (232 libraries at the pinned commit) is searchable and sortable. Google Analytics, CDN CSS and the remote font were removed/vendored (`vendor/`). External author links are shown as plain text.
- **Install**: "Add to Excalidraw" hands the absolute same-origin library URL (`<origin>/libraries/libraries/<author>/<file>.excalidrawlib`) back to the editor tab that opened the site (`#addLibrary=<url>&token=<token>`), which adds it to the user's library (stored in the browser's IndexedDB). The editor only accepts library URLs from its own origin, and the site only honours a same-origin `referrer`.
- **Publish**: select items in the library sidebar -> "Rename or publish" -> fill the form -> Submit. The app POSTs multipart form data to `/api/libraries/submit`; the library is stored in `DATA_DIR/libraries/<handle-or-author>/<name>.excalidrawlib` (+ preview image) and listed immediately (no review step) in the merged `/libraries/libraries.json`, i.e. it appears on the library site for everyone using this server. The index of published entries is `DATA_DIR/libraries/index.json`; delete an entry there (and its files) to unpublish. There is no authentication: anyone who can reach the server can publish (10 MB limit per library).
- **Update the catalog**: bump `LIBRARIES_COMMIT` to a newer excalidraw-libraries commit, `cd libraries-upstream && git fetch --depth 1 origin <sha> && git rebase --onto <sha> $(cat ../LIBRARIES_COMMIT) offline`, fix conflicts, `echo <sha> > LIBRARIES_COMMIT && scripts/export-patches.sh`, rebuild the image. Locally published libraries live in `DATA_DIR` and survive catalog updates.
- **Limitations**: the "Downloads" counters come from upstream's static `stats.json` and are not updated (locally published libraries show 0); published libraries are never reviewed; the publish-success dialog text is only changed in English; other locales still say "submitted for review".

## End-to-end tests

    scripts/build.sh                      # or any build in upstream/excalidraw-app/build (override: STATIC_DIR=...)
    cd e2e && npm install && npx playwright install chromium && npx playwright test

Each test starts the server on a random port with a temp data dir (and its own env where needed) and runs Chromium contexts that **abort every request to a host other than 127.0.0.1/localhost**, flagging non-local websockets too; every test asserts that nothing was blocked. Service workers are blocked so all requests are observable. Covered:

- load, draw, local fonts; Mermaid-only text-to-diagram dialog
- live collaboration between two browsers, server-side scene persistence (decrypted in the test), late joiner, share-link round trip
- library browse/install from the local site, rejecting a foreign `#addLibrary` URL, publishing, no HTML injection through the site's `?target=`
- runtime config: banner (modes, colours, layout, dark theme, library site), share note (markup, text-only), username header, `DISABLE_PERSISTENCE` (incl. images in a collab session), `DISABLE_COLLABORATION` and fully local mode

Production builds do not expose `window.h`, so scene sync is observed through canvas pixels and the decrypted `scenes/<room>.json`.

## CI

`.gitlab-ci.yml` applies both series, runs `scripts/ci-test.sh` and builds the image from the tested output with the `cicd-components/basics` docker-build component (GitLab registry). See `docs/CI.md`.

## Removed / disabled features

See `patches/` for the exact list. In summary: AI features, Excalidraw+ (export/promo/sign-in), external embeds (restricted to same origin), social links, Sentry and analytics, Firebase. The library browser and publishing are *not* removed: they are redirected to the local `/libraries/` site and `/api/libraries/submit` (see above); the upstream library URLs (libraries.excalidraw.com, GitHub, cloud functions) are gone.

## License

MIT for this repository's own code (`LICENSE`). The patches modify Excalidraw and excalidraw-libraries, both MIT; see `NOTICE` for attributions.
