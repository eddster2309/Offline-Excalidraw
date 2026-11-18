# Excalidraw offline server

Single Node 22 process (ESM, no build) serving the built Excalidraw app, socket.io collab (same protocol as excalidraw-room), share links (json.excalidraw.com v2 compatible) and Firebase-replacement storage. All same-origin on one port.

    npm install && npm start      # PORT=3000 STATIC_DIR=../upstream/excalidraw-app/build LIBRARIES_DIR=../libraries-upstream
    npm test

## Env vars
| var | default | meaning |
|---|---|---|
| PORT | 3000 | listen port |
| STATIC_DIR | ../upstream/excalidraw-app/build | built app; unknown GETs (not /api, /socket.io) return index.html |
| LIBRARIES_DIR | ../libraries-upstream | patched excalidraw-libraries site served at `/libraries/`; if missing `/libraries*` and `POST /api/libraries/submit` return 404 and the app is unaffected |
| DATA_DIR | ./data | storage root (links/, scenes/, files/<kind>/<id>/, libraries/) |
| CORS_ORIGIN | unset | extra allowed origin for HTTP + socket.io; not needed for `yarn start` dev mode, whose Vite server proxies `/api`, `/socket.io` and `/libraries` to this server |
| BANNER_MODE | always | `always`: permanent (also on the library site); `sending`: the app shows the banner only while a collaboration session is live, the library site never; invalid -> `always` |
| SHARE_NOTE | unset | share dialog note, max 500 chars, control chars stripped (newlines kept), literal `\n` -> newline; client markup `**bold**`, `[red]text[/]` (name or hex colour) |
| BANNER_TEXT / BANNER_COLOR / BANNER_TEXT_COLOR | unset / #8b0000 / #ffffff | environment banner (text <= 100 chars; colours `#rgb`, `#rrggbb` or letters-only names, else default) |
| USERNAME_HEADER / USERNAME_HEADER_LOCK | unset / true | username from a request header (see `GET /api/config`) |
| DISABLE_PERSISTENCE | false | `true`: share links, scenes, share-link files and library publishing return 404 `{"error":"persistence disabled"}`; DATA_DIR is never created; room files live in memory |
| DISABLE_COLLABORATION | false | `true`: socket.io is not attached (`/socket.io/` -> 404); `/api/scenes/*` and `/api/files/rooms/*` return 404 `{"error":"collaboration disabled"}`; share links and libraries are unaffected unless DISABLE_PERSISTENCE is set too (then the server is fully local) |
| MEMORY_FILES_MAX_MB / MEMORY_ROOM_GRACE_SECONDS | 256 / 60 | in-memory room file store cap (507 when full) / purge delay after a room became empty |

## HTTP API
- `GET /healthz` -> `ok`
- `GET /api/config` -> `{"banner": {"text","color","textColor","mode":"sending"|"always"} | null, "shareNote": string|null, "username": string|null, "usernameLocked": bool, "persistence": bool, "collaboration": bool}`, `Cache-Control: no-store`. `username` comes from the `USERNAME_HEADER` request header (percent-decoded, trimmed, control chars stripped, max 64 chars; empty -> null); `usernameLocked` is true only when a username is present and `USERNAME_HEADER_LOCK` is not false.
- `POST /api/v2/post/` raw octet-stream (<=50MB) -> `{"id": "..."}`
- `GET /api/v2/:id` -> raw bytes / 404
- `GET /api/scenes/:roomId` -> `{sceneVersion, iv, ciphertext}` / 404
- `PUT /api/scenes/:roomId` JSON body same shape (<=50MB) -> `{"ok":true}`
- `PUT /api/files/:kind/:id/:fileId` raw bytes (<=50MB), kind is `rooms` or `shareLinks` -> `{"ok":true}`
- `GET /api/files/:kind/:id/:fileId` -> raw bytes / 404, `Cache-Control: public, max-age=31536000, immutable`

### Library site
- `GET /libraries/` (and `/libraries` -> 301) -> the static library site; only `index.html`, `script.js`, `style.css`, `favicon.ico`, `LICENSE`, `stats.json`, `total.json`, `vendor/`, `libraries/` of `LIBRARIES_DIR` are served
- `GET /libraries/libraries.json` -> `LIBRARIES_DIR/libraries.json` merged with the locally published entries (`DATA_DIR/libraries/index.json`), `Cache-Control: no-cache`
- `GET /libraries/libraries/<author>/<file>` -> published library files/previews (`DATA_DIR/libraries/`) first, then the upstream checkout

### Publishing: `POST /api/libraries/submit`
`multipart/form-data` exactly as sent by `PublishLibrary.tsx`:

| field | | |
|---|---|---|
| `excalidrawLib` | file, required | JSON `{type:"excalidrawlib", version:1|2, libraryItems:[...]}`, non-empty; <= 10 MB |
| `previewImage` | file, required | PNG or JPEG (sniffed from magic bytes; the app sends JPEG); <= 10 MB |
| `name` (or `title`) | text, required | <= 100 chars |
| `authorName` | text, required | <= 100 chars |
| `description`, `githubHandle`, `twitterHandle`, `website`, `previewImageType` | text, optional | description <= 1000 chars; website must be http(s) to be kept |

Files are stored as `DATA_DIR/libraries/<slug(githubHandle || authorName)>/<slug(name)>.excalidrawlib` and `.png|.jpg` (slugs are `[a-z0-9-]`, a numeric suffix is added on collision, so nothing is ever overwritten) and a `libraries.json` entry `{name, description, authors:[{name, github?, twitter?, url}], source, preview, created, updated, version, itemNames?, id}` is appended.
- success: `200 {"url": "<origin>/libraries/#<library id>"}` (origin from `Host` / `X-Forwarded-Proto`)
- errors: `{"message": "..."}` with 400 (validation, bad multipart), 413 (too large), 404 (no library site installed)

All path params of the other endpoints must match `^[A-Za-z0-9_-]{1,128}$` (else 400). Data is stored as received; the server never decrypts.

## Socket.io (path /socket.io/, websocket + polling)
Server emits `init-room` on connect. Client events: `join-room(roomID)`, `server-broadcast(roomID, data, iv)`, `server-volatile-broadcast(roomID, data, iv)`, `user-follow({userToFollow:{socketId,username}, action:"FOLLOW"|"UNFOLLOW"})`.
Server events: `first-in-room`, `new-user(socketId)`, `room-user-change(ids[])`, `client-broadcast(data, iv)`, `user-follow-room-change(ids[])`, `broadcast-unfollow`.
Messages are limited to 1 MB (socket.io default, same as excalidraw-room); malformed `join-room` / `user-follow` payloads are ignored.

## Docker
There is no separate server image: the top-level `Dockerfile` builds the app, the library site and this server into one image (`docker compose up --build`); `Dockerfile.ci` packages an already built `dist/`. In the image the app is at `/app/public`, the library site at `/app/libraries` and data at the `/data` volume.
