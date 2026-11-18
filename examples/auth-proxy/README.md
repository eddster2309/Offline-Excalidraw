# Testing `USERNAME_HEADER` behind an auth proxy

A throw-away environment for the username-header feature: nginx with basic auth
stands in for your real SSO/auth proxy. It authenticates the user, then sets
`X-Forwarded-User` to the login name and passes the request on. Any
`X-Forwarded-User` the browser sends is overwritten, which is exactly what a
production proxy must do.

    docker compose -f examples/auth-proxy/docker-compose.yml up -d

Open http://localhost:3100 and log in as one of the test users (password =
username): `alice`, `bob`, `carol`.

Uses the `excalidraw-offline` image from the top-level compose file (run
`docker compose build` in the repo root first if you don't have it). The app
container has no published port, so the proxy is the only way in. It runs with
`DISABLE_PERSISTENCE=true` and an `AUTH TEST` banner so it can't be confused
with a real deployment.

## Things to try

- **Your name comes from the login.** Click Share -> Start session: the name
  field shows your login name and is read-only ("Set by your organisation").
- **Other users see it.** Open the session link in a second browser or a
  private window (basic auth is per browser), log in as another user, and move
  the mouse in both windows. Names appear on the cursors and in the collaborator
  list (the avatar pill top right). Peers only learn a name once that user has
  moved their pointer, as in upstream Excalidraw.
- **Spoofing is ignored.** The proxy overwrites the header:

      curl -u bob:bob -H 'X-Forwarded-User: Mallory' http://localhost:3100/api/config
      # -> "username":"bob"

- **Unlocked mode.** The header name becomes just a default the user can edit:

      USERNAME_HEADER_LOCK=false docker compose -f examples/auth-proxy/docker-compose.yml up -d

- **No login, no access:** `curl -i http://localhost:3100/` returns 401.

Stop it with `docker compose -f examples/auth-proxy/docker-compose.yml down`.

## Notes

- `htpasswd` contains test users only. For real use, replace basic auth with your
  SSO proxy (oauth2-proxy, Authelia, Authentik, ...) and set the header from the
  authenticated identity, e.g. `proxy_set_header X-Forwarded-User $upstream_http_remote_user;`.
- Plain HTTP works here only because the page is on `localhost`. On any other
  host, serve it over HTTPS (see the main README).
- The name is a label, not proof of identity between peers: it travels inside
  the client-encrypted collaboration messages, so a modified client could still
  show a different name.
