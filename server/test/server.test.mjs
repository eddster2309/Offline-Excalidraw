import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { io as connect } from "socket.io-client";
import { createServer } from "../src/server.js";

let srv, base, tmp;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exc-"));
  fs.mkdirSync(path.join(tmp, "static/assets"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "static/index.html"), "<html>SPA</html>");
  fs.writeFileSync(path.join(tmp, "static/assets/a.js"), "x");
  srv = await createServer({ port: 0, staticDir: path.join(tmp, "static"), dataDir: path.join(tmp, "data"), log: () => {} });
  base = `http://127.0.0.1:${srv.port}`;
});
after(async () => {
  await srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const bytes = () => Buffer.from([0, 1, 2, 250, 255, 7]);

test("healthz", async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "ok");
});

test("v2 post/get roundtrip + 404", async () => {
  const r = await fetch(`${base}/api/v2/post/`, { method: "POST", body: bytes() });
  assert.equal(r.status, 200);
  const { id } = await r.json();
  assert.match(id, /^[A-Za-z0-9_-]{20}$/);
  const g = await fetch(`${base}/api/v2/${id}`);
  assert.equal(g.status, 200);
  assert.deepEqual(Buffer.from(await g.arrayBuffer()), bytes());
  assert.equal((await fetch(`${base}/api/v2/nope`)).status, 404);
});

test("scenes put/get/404", async () => {
  assert.equal((await fetch(`${base}/api/scenes/room1`)).status, 404);
  const body = { sceneVersion: 42, iv: "aXY=", ciphertext: "Y2lwaGVy" };
  const p = await fetch(`${base}/api/scenes/room1`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.deepEqual(await p.json(), { ok: true });
  const g = await fetch(`${base}/api/scenes/room1`);
  assert.deepEqual(await g.json(), body);
  const bad = await fetch(`${base}/api/scenes/room1`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(bad.status, 400);
});

test("files put/get", async () => {
  for (const kind of ["rooms", "shareLinks"]) {
    const url = `${base}/api/files/${kind}/abc/file_1`;
    assert.equal((await fetch(url)).status, 404);
    const p = await fetch(url, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes() });
    assert.deepEqual(await p.json(), { ok: true });
    const g = await fetch(url);
    assert.equal(g.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.deepEqual(Buffer.from(await g.arrayBuffer()), bytes());
  }
  assert.equal((await fetch(`${base}/api/files/other/abc/f`)).status, 400);
});

test("path traversal rejected", async () => {
  for (const p of ["/api/v2/..%2f..%2fx", "/api/scenes/..%2fsecret", "/api/scenes/a.b", "/api/files/rooms/..%2f/x", "/api/files/rooms/a/b%2e%2e"]) {
    const r = await fetch(base + p);
    assert.equal(r.status, 400, p);
  }
  const r = await fetch(`${base}/api/files/rooms/a/..%2f..%2fx`, { method: "PUT", body: "x" });
  assert.equal(r.status, 400);
});

test("static + SPA fallback", async () => {
  const idx = await fetch(`${base}/`);
  assert.equal(await idx.text(), "<html>SPA</html>");
  assert.equal(idx.headers.get("cache-control"), "no-cache");
  const deep = await fetch(`${base}/some/room/path`);
  assert.equal(deep.status, 200);
  assert.equal(await deep.text(), "<html>SPA</html>");
  const a = await fetch(`${base}/assets/a.js`);
  assert.match(a.headers.get("cache-control"), /immutable/);
  assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
});

const once = (s, ev) => new Promise((res) => s.once(ev, (...a) => res(a)));

test("socket.io collab", async () => {
  const mk = () => connect(base, { transports: ["websocket"], forceNew: true });
  const a = mk();
  const [, ] = await once(a, "init-room");
  a.emit("join-room", "r1");
  await once(a, "first-in-room");
  const b = mk();
  await once(b, "init-room");
  const newUser = once(a, "new-user");
  const chA = once(a, "room-user-change");
  const chB = once(b, "room-user-change");
  b.emit("join-room", "r1");
  assert.deepEqual((await newUser)[0], b.id);
  for (const ch of [await chA, await chB]) {
    assert.deepEqual([...ch[0]].sort(), [a.id, b.id].sort());
  }
  // broadcast relayed to other only
  let echoed = false;
  b.on("client-broadcast", () => (echoed = true));
  const got = once(a, "client-broadcast");
  const data = Buffer.from([1, 2, 3]);
  const iv = new Uint8Array([9, 8, 7]);
  b.emit("server-broadcast", "r1", data, iv);
  const [d, v] = await got;
  assert.deepEqual(Buffer.from(d), data);
  assert.deepEqual(Buffer.from(v), Buffer.from(iv));
  const got2 = once(a, "client-broadcast");
  b.emit("server-volatile-broadcast", "r1", data, iv);
  await got2;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(echoed, false);
  // disconnect updates list
  const left = once(a, "room-user-change");
  b.disconnect();
  assert.deepEqual((await left)[0], [a.id]);
  a.disconnect();
});

test("socket.io ignores malformed events (no crash)", async () => {
  const a = connect(base, { transports: ["websocket"], forceNew: true });
  await once(a, "init-room");
  a.emit("user-follow", null);
  a.emit("user-follow", {});
  a.emit("user-follow", { userToFollow: { socketId: { x: 1 } }, action: "FOLLOW" });
  a.emit("join-room", null);
  a.emit("join-room", { x: 1 });
  a.emit("join-room", "ok-room");
  await once(a, "first-in-room");
  a.disconnect();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("socket.io messages over 1 MB are refused (excalidraw-room default)", async () => {
  const a = connect(base, { transports: ["websocket"], forceNew: true });
  await once(a, "init-room");
  const gone = once(a, "disconnect");
  a.emit("server-broadcast", "r-big", Buffer.alloc(2 * 1024 * 1024), new Uint8Array(12));
  await gone;
  a.close();
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("nosniff on every response", async () => {
  for (const p of ["/", "/healthz", "/api/config", "/api/v2/nope"]) {
    assert.equal((await fetch(base + p)).headers.get("x-content-type-options"), "nosniff", p);
  }
});

// ---------------------------------------------------------------- libraries
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const libJson = (extra = {}) =>
  JSON.stringify({ type: "excalidrawlib", version: 2, source: "test", libraryItems: [{ id: "i1", status: "unpublished", created: 1, name: "Box", elements: [] }], ...extra });

function submitForm({ lib = libJson(), png = PNG, fields = {} } = {}) {
  const f = new FormData();
  if (lib !== null) f.append("excalidrawLib", new Blob([lib], { type: "application/json" }));
  if (png !== null) f.append("previewImage", new Blob([png], { type: "image/png" }));
  f.append("previewImageType", "image/png");
  const all = { title: "My Lib", name: "My Lib", authorName: "Jane Doe", githubHandle: "", description: "desc", twitterHandle: "", website: "", ...fields };
  for (const [k, v] of Object.entries(all)) f.append(k, v);
  return f;
}
const submit = (opts) => fetch(`${base}/api/libraries/submit`, { method: "POST", body: submitForm(opts) });

let libSrv, libBase, libTmp;
before(async () => {
  libTmp = fs.mkdtempSync(path.join(os.tmpdir(), "exc-lib-"));
  const site = path.join(libTmp, "site");
  fs.mkdirSync(path.join(site, "libraries/up"), { recursive: true });
  fs.mkdirSync(path.join(site, "vendor"), { recursive: true });
  fs.mkdirSync(path.join(site, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(site, "index.html"), "<html>LIBSITE</html>");
  fs.writeFileSync(path.join(site, "scripts/secret.js"), "nope");
  fs.writeFileSync(path.join(site, "vendor/a.css"), "a{}");
  fs.writeFileSync(path.join(site, "libraries/up/x.excalidrawlib"), libJson());
  fs.writeFileSync(
    path.join(site, "libraries.json"),
    JSON.stringify([{ name: "Up", description: "", authors: [{ name: "U", url: "" }], source: "up/x.excalidrawlib", preview: "up/x.png", created: "2020-01-01", updated: "2020-01-01", version: 2, id: "up1" }]),
  );
  libSrv = await createServer({
    port: 0,
    staticDir: path.join(tmp, "static"),
    librariesDir: site,
    dataDir: path.join(libTmp, "data"),
    log: () => {},
  });
  libBase = `http://127.0.0.1:${libSrv.port}`;
});
after(async () => {
  await libSrv?.close();
  fs.rmSync(libTmp, { recursive: true, force: true });
});

test("libraries: site served at /libraries/, only whitelisted entries", async () => {
  const r = await fetch(`${libBase}/libraries/`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /LIBSITE/);
  const redirect = await fetch(`${libBase}/libraries?theme=dark`, { redirect: "manual" });
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get("location"), "/libraries/?theme=dark");
  assert.equal((await fetch(`${libBase}/libraries/vendor/a.css`)).status, 200);
  assert.equal((await fetch(`${libBase}/libraries/libraries/up/x.excalidrawlib`)).status, 200);
  assert.equal((await fetch(`${libBase}/libraries/scripts/secret.js`)).status, 404);
  assert.equal((await fetch(`${libBase}/libraries/nope.html`)).status, 404);
  // the app still works
  assert.match(await (await fetch(`${libBase}/some/route`)).text(), /SPA/);
});

test("libraries: missing LIBRARIES_DIR -> /libraries 404, app unaffected", async () => {
  const s = await createServer({
    port: 0,
    staticDir: path.join(tmp, "static"),
    librariesDir: path.join(libTmp, "does-not-exist"),
    dataDir: path.join(libTmp, "data2"),
    log: () => {},
  });
  try {
    const b = `http://127.0.0.1:${s.port}`;
    assert.equal((await fetch(`${b}/libraries/`)).status, 404);
    assert.equal((await fetch(`${b}/libraries/libraries.json`)).status, 404);
    assert.equal((await fetch(`${b}/api/libraries/submit`, { method: "POST", body: submitForm() })).status, 404);
    assert.match(await (await fetch(`${b}/`)).text(), /SPA/);
  } finally {
    await s.close();
  }
});

test("libraries: submit roundtrip, libraries.json merge, files served", async () => {
  const before = await (await fetch(`${libBase}/libraries/libraries.json`)).json();
  assert.equal(before.length, 1);

  const r = await fetch(`${libBase}/api/libraries/submit`, {
    method: "POST",
    body: submitForm({ fields: { name: "Robots & <b>Co</b>", githubHandle: "@Jane-D", website: "https://jane.example", twitterHandle: "@jane", description: "Hi" } }),
  });
  assert.equal(r.status, 200);
  const { url } = await r.json();
  assert.equal(url, `${libBase}/libraries/#jane-d-robots-b-co-b`);

  const list = await (await fetch(`${libBase}/libraries/libraries.json`)).json();
  assert.equal(list.length, 2);
  assert.deepEqual(list[0].id, "up1");
  const e = list[1];
  assert.deepEqual(Object.keys(e).sort(), ["authors", "created", "description", "id", "itemNames", "name", "preview", "source", "updated", "version"]);
  assert.equal(e.name, "Robots & <b>Co</b>");
  assert.equal(e.source, "jane-d/robots-b-co-b.excalidrawlib");
  assert.equal(e.preview, "jane-d/robots-b-co-b.png");
  assert.equal(e.version, 2);
  assert.deepEqual(e.itemNames, ["Box"]);
  assert.match(e.created, /^\d{4}-\d\d-\d\d$/);
  assert.match(e.id, /^[A-Za-z0-9]{11}$/);
  assert.deepEqual(e.authors, [{ name: "Jane Doe", github: "https://github.com/Jane-D", twitter: "https://twitter.com/jane", url: "https://jane.example/" }]);

  const lib = await fetch(`${libBase}/libraries/libraries/${e.source}`);
  assert.equal(lib.status, 200);
  assert.equal(JSON.parse(await lib.text()).type, "excalidrawlib");
  const png = await fetch(`${libBase}/libraries/libraries/${e.preview}`);
  assert.equal(png.status, 200);
  assert.deepEqual(Buffer.from(await png.arrayBuffer()), PNG);
  assert.equal((await fetch(`${libBase}/libraries/libraries/index.json`)).status, 404);

  // JPEG previews (what the app sends) keep their extension
  const rj = await fetch(`${libBase}/api/libraries/submit`, {
    method: "POST",
    body: submitForm({ png: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), fields: { name: "Jpeg Lib", githubHandle: "jane-d" } }),
  });
  assert.equal(rj.status, 200);
  const jl = (await (await fetch(`${libBase}/libraries/libraries.json`)).json()).at(-1);
  assert.equal(jl.preview, "jane-d/jpeg-lib.jpg");
  assert.equal((await fetch(`${libBase}/libraries/libraries/${jl.preview}`)).headers.get("content-type"), "image/jpeg");

  // same name again gets a unique slug, upstream entries are untouched
  const r2 = await fetch(`${libBase}/api/libraries/submit`, {
    method: "POST",
    body: submitForm({ fields: { name: "Robots & <b>Co</b>", githubHandle: "Jane-D" } }),
  });
  assert.equal(r2.status, 200);
  const list2 = await (await fetch(`${libBase}/libraries/libraries.json`)).json();
  assert.equal(list2.length, 4);
  assert.equal(list2[3].source, "jane-d/robots-b-co-b-2.excalidrawlib");
});

test("libraries: submit validation", async () => {
  const bad = async (opts, status, re) => {
    const r = await fetch(`${libBase}/api/libraries/submit`, { method: "POST", body: submitForm(opts) });
    assert.equal(r.status, status);
    assert.match((await r.json()).message, re);
  };
  await bad({ lib: null }, 400, /excalidrawLib/);
  await bad({ png: null }, 400, /previewImage/);
  await bad({ lib: "not json" }, 400, /JSON/);
  await bad({ lib: libJson({ type: "excalidraw" }) }, 400, /valid/);
  await bad({ lib: libJson({ libraryItems: [] }) }, 400, /valid/);
  await bad({ png: Buffer.from("GIF89a....") }, 400, /PNG or JPEG/);
  await bad({ fields: { name: "  " , title: ""} }, 400, /name/);
  await bad({ fields: { authorName: "" } }, 400, /author/);
  const big = libJson({ pad: "x".repeat(10 * 1024 * 1024 + 10) });
  await bad({ lib: big }, 413, /too large/);
  const notMultipart = await fetch(`${libBase}/api/libraries/submit`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  assert.equal(notMultipart.status, 400);
  const list = await (await fetch(`${libBase}/libraries/libraries.json`)).json();
  assert.equal(list.length, 4); // nothing was added by failed submits
});

test("libraries: traversal rejected / sanitized", async () => {
  for (const p of ["/libraries/libraries/..%2f..%2fdata%2flibraries%2findex.json", "/libraries/..%2fscripts%2fsecret.js"]) {
    const r = await fetch(`${libBase}${p}`);
    assert.ok([400, 403, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.doesNotMatch(await r.text(), /nope/);
  }
  const r = await fetch(`${libBase}/api/libraries/submit`, {
    method: "POST",
    body: submitForm({ fields: { githubHandle: "../../../etc", authorName: "../../x", name: "../../../evil" } }),
  });
  assert.equal(r.status, 200);
  const list = await (await fetch(`${libBase}/libraries/libraries.json`)).json();
  const e = list.at(-1);
  assert.match(e.source, /^[a-z0-9-]+\/[a-z0-9-]+\.excalidrawlib$/);
  const root = path.join(libTmp, "data/libraries");
  assert.ok(fs.existsSync(path.join(root, e.source)));
  assert.deepEqual(fs.readdirSync(libTmp).sort(), ["data", "data2", "site"]);
});

// ---------------------------------------------------------------- runtime config
async function withServer(env, fn, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exc-rc-"));
  const dataDir = path.join(dir, "data");
  const s = await createServer({ port: 0, staticDir: path.join(tmp, "static"), dataDir, env, log: () => {}, ...extra });
  try {
    await fn({ base: `http://127.0.0.1:${s.port}`, dataDir, dir, s });
  } finally {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const cfg = async (base, headers = {}) => {
  const r = await fetch(`${base}/api/config`, { headers });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  return r.json();
};

test("config: defaults", async () => {
  await withServer({}, async ({ base }) => {
    assert.deepEqual(await cfg(base, { "X-Forwarded-User": "ignored" }), {
      banner: null, shareNote: null, username: null, usernameLocked: false, persistence: true, collaboration: true,
    });
  });
});

test("config: banner defaults, colours, validation, limits", async () => {
  await withServer({ BANNER_TEXT: "QA" }, async ({ base }) => {
    assert.deepEqual((await cfg(base)).banner, { text: "QA", color: "#8b0000", textColor: "#ffffff", mode: "always" });
  });
  await withServer({ BANNER_TEXT: "PROD", BANNER_COLOR: "navy", BANNER_TEXT_COLOR: "#abc" }, async ({ base }) => {
    assert.deepEqual((await cfg(base)).banner, { text: "PROD", color: "navy", textColor: "#abc", mode: "always" });
  });
  for (const bad of ["red; background:url(http://evil)", "#12", "#12345g", "rgb(0,0,0)", "url(x)", "a b", "red}"]) {
    await withServer({ BANNER_TEXT: "X", BANNER_COLOR: bad, BANNER_TEXT_COLOR: bad }, async ({ base }) => {
      assert.deepEqual((await cfg(base)).banner, { text: "X", color: "#8b0000", textColor: "#ffffff", mode: "always" }, bad);
    });
  }
  await withServer({ BANNER_TEXT: "x".repeat(150) }, async ({ base }) => {
    assert.equal((await cfg(base)).banner.text.length, 100);
  });
  await withServer({ BANNER_TEXT: "   " }, async ({ base }) => {
    assert.equal((await cfg(base)).banner, null);
  });
  // text is passed through verbatim (the client renders it as text)
  await withServer({ BANNER_TEXT: "<b>QA</b>" }, async ({ base }) => {
    assert.equal((await cfg(base)).banner.text, "<b>QA</b>");
  });
});

test("config: banner mode", async () => {
  for (const [mode, want] of [[undefined, "always"], ["", "always"], ["sending", "sending"], [" SENDING ", "sending"], ["always", "always"], ["bogus", "always"]]) {
    await withServer({ BANNER_TEXT: "QA", ...(mode === undefined ? {} : { BANNER_MODE: mode }) }, async ({ base }) => {
      assert.equal((await cfg(base)).banner.mode, want, String(mode));
    });
  }
});

test("config: share note", async () => {
  const note = async (v) => {
    let out;
    await withServer(v === undefined ? {} : { SHARE_NOTE: v }, async ({ base }) => {
      out = (await cfg(base)).shareNote;
    });
    return out;
  };
  assert.equal(await note(undefined), null);
  assert.equal(await note(""), null);
  assert.equal(await note("  \n "), null);
  assert.equal(await note("  Hello  "), "Hello");
  assert.equal(await note("a\\nb\\n\\nc"), "a\nb\n\nc"); // literal backslash-n
  assert.equal(await note("a\nb\r\nc"), "a\nb\nc"); // real newlines kept
  assert.equal(await note("a\u0000b\u0007c\td\u001be"), "abcde"); // control chars (and tabs) stripped
  assert.equal(await note("<b>x</b>"), "<b>x</b>"); // verbatim, client renders text
  assert.equal((await note("x".repeat(800))).length, 500);
});

test("config: username header", async () => {
  await withServer({ USERNAME_HEADER: "X-Forwarded-User" }, async ({ base }) => {
    assert.deepEqual(await cfg(base), { banner: null, shareNote: null, username: null, usernameLocked: false, persistence: true, collaboration: true });
    let c = await cfg(base, { "x-forwarded-user": "  Ada Lovelace " });
    assert.equal(c.username, "Ada Lovelace");
    assert.equal(c.usernameLocked, true); // lock defaults to true
    c = await cfg(base, { "X-Forwarded-User": "J%C3%BCrgen%20M%C3%BCller" });
    assert.equal(c.username, "Jürgen Müller");
    c = await cfg(base, { "X-Forwarded-User": "bad%zzescape" });
    assert.equal(c.username, "bad%zzescape");
    c = await cfg(base, { "X-Forwarded-User": "a%0Ab%00c%1Fd" }); // control chars stripped
    assert.equal(c.username, "abcd");
    c = await cfg(base, { "X-Forwarded-User": "n".repeat(100) });
    assert.equal(c.username.length, 64);
    c = await cfg(base, { "X-Forwarded-User": "%20%20" });
    assert.deepEqual([c.username, c.usernameLocked], [null, false]);
  });
  await withServer({ USERNAME_HEADER: "X-Forwarded-User", USERNAME_HEADER_LOCK: "false" }, async ({ base }) => {
    const c = await cfg(base, { "X-Forwarded-User": "Ada" });
    assert.deepEqual([c.username, c.usernameLocked], ["Ada", false]);
  });
  await withServer({ USERNAME_HEADER: "", }, async ({ base }) => {
    assert.equal((await cfg(base, { "X-Forwarded-User": "Ada" })).username, null);
  });
});

test("persistence disabled: endpoints 404, DATA_DIR never created, libraries browse works", async () => {
  const site = path.join(libTmp, "site");
  await withServer({ DISABLE_PERSISTENCE: "true", BANNER_TEXT: "QA" }, async ({ base, dataDir, dir }) => {
    const c = await cfg(base);
    assert.equal(c.persistence, false);
    assert.equal(c.banner.text, "QA");
    const expect404 = async (url, init) => {
      const r = await fetch(`${base}${url}`, init);
      assert.equal(r.status, 404, url);
      assert.deepEqual(await r.json(), { error: "persistence disabled", message: "persistence disabled" }, url);
    };
    await expect404("/api/v2/post/", { method: "POST", body: bytes() });
    await expect404("/api/v2/abc");
    await expect404("/api/scenes/room1");
    await expect404("/api/scenes/room1", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
    await expect404("/api/files/shareLinks/abc/f1");
    await expect404("/api/files/shareLinks/abc/f1", { method: "PUT", body: bytes() });
    await expect404("/api/libraries/submit", { method: "POST", body: submitForm() });
    // library site: browse works, local index is not used
    assert.match(await (await fetch(`${base}/libraries/`)).text(), /LIBSITE/);
    const list = await (await fetch(`${base}/libraries/libraries.json`)).json();
    assert.deepEqual(list.map((e) => e.id), ["up1"]);
    assert.equal((await fetch(`${base}/libraries/libraries/up/x.excalidrawlib`)).status, 200);
    assert.match(await (await fetch(`${base}/some/route`)).text(), /SPA/);
    assert.equal(fs.existsSync(dataDir), false, "DATA_DIR must not be created");
    assert.deepEqual(fs.readdirSync(dir), []);
  }, { librariesDir: site });
});

test("persistence disabled: room files in memory, purged when the room empties", async () => {
  await withServer({ DISABLE_PERSISTENCE: "1", MEMORY_ROOM_GRACE_SECONDS: "0.2" }, async ({ base, dataDir }) => {
    const mk = () => connect(base, { transports: ["websocket"], forceNew: true });
    const a = mk();
    const b = mk();
    for (const s of [a, b]) await once(s, "init-room");
    a.emit("join-room", "memroom");
    await once(a, "first-in-room");
    const joined = once(a, "new-user");
    b.emit("join-room", "memroom");
    await joined;

    const url = `${base}/api/files/rooms/memroom/img1`;
    const put = await fetch(url, { method: "PUT", body: bytes() });
    assert.deepEqual(await put.json(), { ok: true });
    const g = await fetch(url);
    assert.equal(g.status, 200);
    assert.deepEqual(Buffer.from(await g.arrayBuffer()), bytes());
    assert.equal(fs.existsSync(dataDir), false);

    // one user leaves: room not empty, file stays
    const left = once(a, "room-user-change");
    b.disconnect();
    await left;
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await fetch(url)).status, 200);

    // last user leaves: purged after the grace period
    a.disconnect();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await fetch(url)).status, 200, "still there during the grace period");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await fetch(url)).status, 404);
  });
});

test("persistence disabled: a rejoin within the grace period keeps files; unjoined rooms are purged", async () => {
  await withServer({ DISABLE_PERSISTENCE: "true", MEMORY_ROOM_GRACE_SECONDS: "0.5" }, async ({ base }) => {
    const mk = () => connect(base, { transports: ["websocket"], forceNew: true });
    const a = mk();
    await once(a, "init-room");
    a.emit("join-room", "r2");
    await once(a, "first-in-room");
    const url = `${base}/api/files/rooms/r2/f`;
    await fetch(url, { method: "PUT", body: bytes() });
    a.disconnect();
    await new Promise((r) => setTimeout(r, 150));
    const a2 = mk();
    await once(a2, "init-room");
    a2.emit("join-room", "r2"); // reload: rejoin
    await once(a2, "first-in-room");
    await new Promise((r) => setTimeout(r, 800));
    assert.equal((await fetch(url)).status, 200);
    a2.disconnect();

    // upload to a room nobody joined: purged after the grace period
    await fetch(`${base}/api/files/rooms/ghost/f`, { method: "PUT", body: bytes() });
    assert.equal((await fetch(`${base}/api/files/rooms/ghost/f`)).status, 200);
    await new Promise((r) => setTimeout(r, 800));
    assert.equal((await fetch(`${base}/api/files/rooms/ghost/f`)).status, 404);
  });
});

test("persistence disabled: memory cap enforced", async () => {
  await withServer({ DISABLE_PERSISTENCE: "true", MEMORY_FILES_MAX_MB: "1" }, async ({ base }) => {
    const half = Buffer.alloc(600 * 1024, 1);
    const put = (id, body) => fetch(`${base}/api/files/rooms/cap/${id}`, { method: "PUT", body });
    assert.equal((await put("a", half)).status, 200);
    assert.equal((await put("b", half)).status, 507);
    assert.equal((await fetch(`${base}/api/files/rooms/cap/b`)).status, 404);
    // replacing an existing file with one of the same size is fine
    assert.equal((await put("a", half)).status, 200);
    // other room, small file still fits
    assert.equal((await fetch(`${base}/api/files/rooms/cap2/x`, { method: "PUT", body: bytes() })).status, 200);
  });
});

const noSocket = async (base) => {
  for (const q of ["EIO=4&transport=polling", "EIO=3&transport=polling"]) {
    assert.equal((await fetch(`${base}/socket.io/?${q}`)).status, 404, q);
  }
  const c = connect(base, { transports: ["polling"], forceNew: true, reconnection: false, timeout: 1500 });
  const err = await new Promise((resolve) => {
    c.once("connect", () => resolve(null));
    c.once("connect_error", resolve);
  });
  c.disconnect();
  assert.ok(err, "socket.io client must not connect");
};

test("collaboration disabled: config field, socket.io unreachable, room endpoints 404, share links work", async () => {
  await withServer({ DISABLE_COLLABORATION: "true" }, async ({ base, dataDir }) => {
    const c = await cfg(base);
    assert.equal(c.collaboration, false);
    assert.equal(c.persistence, true);
    await noSocket(base);
    const expect404 = async (url, init) => {
      const r = await fetch(`${base}${url}`, init);
      assert.equal(r.status, 404, url);
      assert.deepEqual(await r.json(), { error: "collaboration disabled", message: "collaboration disabled" }, url);
    };
    await expect404("/api/scenes/room1");
    await expect404("/api/scenes/room1", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
    await expect404("/api/files/rooms/abc/f1");
    await expect404("/api/files/rooms/abc/f1", { method: "PUT", body: bytes() });
    // share links are unaffected
    const r = await fetch(`${base}/api/v2/post/`, { method: "POST", body: bytes() });
    assert.equal(r.status, 200);
    const { id } = await r.json();
    assert.deepEqual(Buffer.from(await (await fetch(`${base}/api/v2/${id}`)).arrayBuffer()), bytes());
    assert.equal((await fetch(`${base}/api/files/shareLinks/abc/f1`, { method: "PUT", body: bytes() })).status, 200);
    assert.equal((await fetch(`${base}/api/files/shareLinks/abc/f1`)).status, 200);
    assert.ok(fs.existsSync(dataDir));
  });
});

test("collaboration enabled by default: config true, socket.io reachable", async () => {
  await withServer({ DISABLE_COLLABORATION: "false" }, async ({ base }) => {
    assert.equal((await cfg(base)).collaboration, true);
    assert.equal((await fetch(`${base}/socket.io/?EIO=4&transport=polling`)).status, 200);
  });
});

test("collaboration and persistence both disabled: fully local", async () => {
  await withServer({ DISABLE_COLLABORATION: "true", DISABLE_PERSISTENCE: "true" }, async ({ base, dataDir, dir }) => {
    const c = await cfg(base);
    assert.equal(c.collaboration, false);
    assert.equal(c.persistence, false);
    await noSocket(base);
    for (const [url, init, msg] of [
      ["/api/scenes/room1", undefined, "collaboration disabled"],
      ["/api/files/rooms/abc/f1", { method: "PUT", body: bytes() }, "collaboration disabled"],
      ["/api/v2/post/", { method: "POST", body: bytes() }, "persistence disabled"],
      ["/api/files/shareLinks/abc/f1", undefined, "persistence disabled"],
    ]) {
      const r = await fetch(`${base}${url}`, init);
      assert.equal(r.status, 404, url);
      assert.deepEqual(await r.json(), { error: msg, message: msg }, url);
    }
    assert.match(await (await fetch(`${base}/some/route`)).text(), /SPA/);
    assert.equal(fs.existsSync(dataDir), false);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});
