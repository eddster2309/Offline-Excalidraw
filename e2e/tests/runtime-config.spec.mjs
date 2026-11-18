import fs from "node:fs";
import path from "node:path";
import { test, expect, openApp, drag, inkPixels, startSession, closeDialog, redPng, redPixels, STATIC_DIR } from "./fixtures.mjs";

test.beforeAll(() => {
  test.skip(!fs.existsSync(path.join(STATIC_DIR, "index.html")), `built app not found at ${STATIC_DIR}`);
});

test("H: environment banner, title untouched, canvas not covered", async ({ startServer, newPage }) => {
  const s = await startServer({ BANNER_TEXT: "QA", BANNER_MODE: "always" });
  const { page } = await newPage();
  await openApp(page, s.origin);

  const banner = page.getByTestId("environment-banner");
  await expect(banner).toHaveText("QA");
  await expect(banner).toHaveCSS("font-family", /sans-serif/);
  await expect(banner).toHaveCSS("font-size", "15px");
  await expect(page).not.toHaveTitle(/QA/);
  const box = await banner.boundingBox();
  expect(box).toMatchObject({ x: 0, y: 0, width: 1280 });
  expect(box.height).toBe(24);
  expect(await banner.evaluate((e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e).color])).toEqual([
    "rgb(139, 0, 0)",
    "rgb(255, 255, 255)",
  ]);

  // the editor is laid out below the banner and fits the viewport
  const editor = await page.locator(".excalidraw-app > .excalidraw").boundingBox();
  expect(editor.y).toBeGreaterThanOrEqual(24);
  expect(editor.y + editor.height).toBeLessThanOrEqual(800 + 1);
  // toolbar is clickable (not overlaid)
  const tool = page.locator('[data-testid="toolbar-rectangle"]');
  const tb = await tool.boundingBox();
  expect(tb.y).toBeGreaterThanOrEqual(24);
  await tool.click();
  await page.mouse.move(300, 300);
  await page.mouse.down();
  await page.mouse.move(420, 380, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => inkPixels(page)).toBeGreaterThan(300);

  // dark theme and a phone viewport keep the banner visible
  await page.keyboard.press("Alt+Shift+D");
  await expect(banner).toBeVisible();
  await page.setViewportSize({ width: 390, height: 700 });
  await expect(banner).toBeVisible();
  expect((await banner.boundingBox()).width).toBe(390);
  expect((await page.locator(".excalidraw-app > .excalidraw").boundingBox()).y).toBeGreaterThanOrEqual(24);
});

test("H1: environment banner on the library site (always mode)", async ({ startServer, newPage }) => {
  const s = await startServer({ BANNER_TEXT: "QA", BANNER_MODE: "always" });
  const { page } = await newPage();
  await page.goto(`${s.origin}/libraries/`);
  const banner = page.getByTestId("environment-banner");
  await expect(banner).toHaveText("QA");
  await expect(banner).toHaveCSS("font-family", /sans-serif/);
  await expect(banner).toHaveCSS("font-size", "15px");
  expect(await banner.evaluate((e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e).color])).toEqual([
    "rgb(139, 0, 0)",
    "rgb(255, 255, 255)",
  ]);
  expect(await banner.boundingBox()).toMatchObject({ x: 0, y: 0, height: 24 });
  // scrolls away with the page (not pinned)
  await page.mouse.wheel(0, 2000);
  await expect.poll(async () => (await banner.boundingBox()).y).toBeLessThan(0);

  // the site's dark theme (a CSS invert filter) must not recolour the banner
  await page.goto(`${s.origin}/libraries/?theme=dark`);
  await expect(page.locator("html")).toHaveClass(/theme--dark/);
  await expect(banner).toHaveText("QA");
  const filters = await banner.evaluate((e) => {
    const out = [];
    for (let n = e; n; n = n.parentElement) out.push(getComputedStyle(n).filter);
    return out;
  });
  expect(filters.every((f) => f === "none")).toBe(true);
  await expect(page.locator("body > nav")).toHaveCSS("filter", /invert/);
});

test("H1b: no banner on the library site when unset", async ({ server, newPage }) => {
  const { page } = await newPage();
  await page.goto(`${server.origin}/libraries/`);
  await expect(page.locator(".library")).not.toHaveCount(0);
  await expect(page.getByTestId("environment-banner")).toHaveCount(0);
});

test("H2: custom colours, text rendered as text", async ({ startServer, newPage }) => {
  const s = await startServer({ BANNER_TEXT: "<img src=x onerror=alert(1)>", BANNER_MODE: "always", BANNER_COLOR: "navy", BANNER_TEXT_COLOR: "#ff0" });
  const { page } = await newPage();
  await openApp(page, s.origin);
  const banner = page.getByTestId("environment-banner");
  await expect(banner).toHaveText("<img src=x onerror=alert(1)>");
  expect(await banner.locator("img").count()).toBe(0);
  expect(await banner.evaluate((e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e).color])).toEqual([
    "rgb(0, 0, 128)",
    "rgb(255, 255, 0)",
  ]);
});

test("H3: sending mode: no banner on load, library site or merely open dialog", async ({ startServer, newPage }) => {
  const d = await startServer({ BANNER_TEXT: "QA" }); // default mode: always
  expect((await (await fetch(`${d.origin}/api/config`)).json()).banner.mode).toBe("always");
  const s = await startServer({ BANNER_TEXT: "QA", BANNER_MODE: "sending" });
  expect((await (await fetch(`${s.origin}/api/config`)).json()).banner.mode).toBe("sending");
  const { page } = await newPage();
  await openApp(page, s.origin);
  const banner = page.getByTestId("environment-banner");
  await expect(banner).toHaveCount(0);
  expect((await page.locator(".excalidraw-app > .excalidraw").boundingBox()).y).toBe(0);
  await page.locator(".collab-button").click();
  await expect(page.getByRole("button", { name: "Start session" })).toBeVisible();
  await expect(banner).toHaveCount(0);
  await closeDialog(page);
  await page.goto(`${s.origin}/libraries/`);
  await expect(page.locator(".library")).not.toHaveCount(0);
  await expect(banner).toHaveCount(0);
});

test("H4: sending mode: banner while a session is live, editor resizes below it, gone after stopping", async ({ startServer, newPage }) => {
  const s = await startServer({ BANNER_TEXT: "QA", BANNER_MODE: "sending" });
  const c1 = await newPage();
  await openApp(c1.page, s.origin);
  const banner1 = c1.page.getByTestId("environment-banner");
  const editor = c1.page.locator(".excalidraw-app > .excalidraw");
  await expect(banner1).toHaveCount(0);

  const roomUrl = await startSession(c1.page);
  await expect(banner1).toHaveText("QA");
  expect(await banner1.boundingBox()).toMatchObject({ x: 0, y: 0, height: 24 });
  await expect.poll(async () => (await editor.boundingBox()).y).toBeGreaterThanOrEqual(24);
  await expect.poll(async () => {
    const eb = await editor.boundingBox();
    return eb.y + eb.height;
  }).toBeLessThanOrEqual(801);
  // canvas re-measured: it fits the editor, toolbar is clickable and drawing works
  await expect.poll(async () => (await c1.page.locator("canvas.interactive").boundingBox()).y).toBeGreaterThanOrEqual(24);
  await expect.poll(async () => {
    const cb = await c1.page.locator("canvas.interactive").boundingBox();
    return cb.y + cb.height;
  }).toBeLessThanOrEqual(801);
  const tool = c1.page.locator('[data-testid="toolbar-rectangle"]');
  expect((await tool.boundingBox()).y).toBeGreaterThanOrEqual(24);
  await tool.click();
  await c1.page.mouse.move(300, 300);
  await c1.page.mouse.down();
  await c1.page.mouse.move(420, 380, { steps: 4 });
  await c1.page.mouse.up();
  await expect.poll(() => inkPixels(c1.page)).toBeGreaterThan(300);

  // a joiner via the room link sees the banner too
  const c2 = await newPage();
  await openApp(c2.page, roomUrl);
  await expect(c2.page.getByTestId("environment-banner")).toHaveText("QA");
  await expect(c1.page.locator(".CollabButton-collaborators")).toHaveText("2", { timeout: 20_000 });

  // stopping the session removes the banner and the editor is back at y=0
  c1.page.once("dialog", (d) => d.accept()); // "stop session? local scene is overwritten" confirm
  await c1.page.locator(".collab-button").click();
  await c1.page.getByRole("button", { name: "Stop session" }).click();
  await closeDialog(c1.page).catch(() => {});
  await expect(banner1).toHaveCount(0);
  const canvas = c1.page.locator("canvas.interactive");
  await expect.poll(async () => (await editor.boundingBox()).y).toBe(0);
  await expect.poll(async () => (await editor.boundingBox()).height).toBe(800);
  await expect.poll(async () => (await canvas.boundingBox()).y).toBe(0);
  await expect.poll(async () => (await canvas.boundingBox()).height).toBe(800);
});

test("H5: library site has no banner in sending mode even when configured", async ({ startServer, newPage }) => {
  const s = await startServer({ BANNER_TEXT: "QA", BANNER_MODE: "sending" });
  const { page } = await newPage();
  await page.goto(`${s.origin}/libraries/`);
  await expect(page.locator(".library")).not.toHaveCount(0);
  await expect(page.getByTestId("environment-banner")).toHaveCount(0);
});

test("M: share note: multi-line, markup, text only, all dialog states, absent when unset", async ({ startServer, newPage, server }) => {
  const s = await startServer({ SHARE_NOTE: "**Bold** [red]Red text[/] and <b>x</b>\\nLine two <img src=x onerror=alert(1)>" });
  const { page } = await newPage();
  await openApp(page, s.origin);
  await page.locator(".collab-button").click();
  const note = page.getByTestId("share-note");
  await expect(note).toBeVisible();
  expect(await note.evaluate((e) => e.textContent)).toBe("Bold Red text and <b>x</b>\nLine two <img src=x onerror=alert(1)>");
  expect(await note.locator("b, img").count()).toBe(0);
  await expect(note.locator(".ShareDialog__note__text")).toHaveCSS("white-space", "pre-line");
  // styled as a warning: icon + warning surface (#fceeca in the light theme)
  await expect(note.locator(".ShareDialog__note__icon svg")).toBeVisible();
  await expect(note).toHaveCSS("background-color", "rgb(252, 238, 202)");
  const strong = note.locator("strong");
  await expect(strong).toHaveText("Bold");
  expect(Number(await strong.evaluate((e) => getComputedStyle(e).fontWeight))).toBeGreaterThanOrEqual(600);
  expect(await note.locator("span", { hasText: "Red text" }).evaluate((e) => getComputedStyle(e).color)).toBe("rgb(255, 0, 0)");
  // two lines
  const h = await note.evaluate((e) => e.getBoundingClientRect().height);
  expect(h).toBeGreaterThan(40);
  // the note sits near the top of the dialog content, above the Start session button
  const nb = await note.boundingBox();
  const sb = await page.getByRole("button", { name: "Start session" }).boundingBox();
  expect(nb.y).toBeLessThan(sb.y);
  await expect(page.getByRole("button", { name: "Export to Link" })).toBeVisible();
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page.locator(".ShareDialog__active__linkRow input")).toHaveValue(/#room=/);
  await expect(note).toBeVisible();
  await closeDialog(page);
  // dark theme
  await page.keyboard.press("Alt+Shift+D");
  await page.locator(".collab-button").click();
  await expect(note).toBeVisible();
  await closeDialog(page);

  // unset: absent
  const { page: p2 } = await newPage();
  await openApp(p2, server.origin);
  await p2.locator(".collab-button").click();
  await expect(p2.getByRole("button", { name: "Start session" })).toBeVisible();
  await expect(p2.getByTestId("share-note")).toHaveCount(0);
});

test("I: no banner when unset", async ({ server, newPage }) => {
  const { page } = await newPage();
  await openApp(page, server.origin);
  await expect(page.getByTestId("environment-banner")).toHaveCount(0);
  await expect(page).not.toHaveTitle(/^\[/);
  const editor = await page.locator(".excalidraw-app > .excalidraw").boundingBox();
  expect(editor.y).toBe(0);
});

test("J: username from header is the collab name and read-only", async ({ startServer, newPage }) => {
  const s = await startServer({ USERNAME_HEADER: "X-Forwarded-User" });
  const c1 = await newPage({ extraHTTPHeaders: { "X-Forwarded-User": "Alice%20Anderson" } });
  await openApp(c1.page, s.origin);
  // a name saved locally earlier is overridden
  await drag(c1.page, "r", [300, 300], [500, 420]);
  const roomUrl = await startSession(c1.page);

  await c1.page.locator(".collab-button").click();
  const name = c1.page.locator(".ShareDialog__username input");
  await expect(name).toHaveValue("Alice Anderson");
  await expect(name).toHaveAttribute("readonly", "");
  await expect(c1.page.locator(".ShareDialog__username")).toHaveAttribute("title", /organisation/);
  await name.evaluate((e) => e.removeAttribute("readonly"));
  await name.fill("Mallory");
  await closeDialog(c1.page);

  const c2 = await newPage({ extraHTTPHeaders: { "X-Forwarded-User": "Bob" } });
  await openApp(c2.page, roomUrl);
  await expect(c2.page.locator(".CollabButton-collaborators")).toHaveText("2", { timeout: 20_000 });
  // c2 sees the other collaborator under the header name, not the tampered one
  await c2.page.locator(".collab-button").click();
  await expect(c2.page.locator(".ShareDialog__username input")).toHaveValue("Bob");
  await closeDialog(c2.page);
  await c2.page.locator(".UserList .Avatar:not(.is-current-user)").first().hover();
  await expect(c2.page.getByText("Alice Anderson")).toBeVisible();
  await expect(c2.page.getByText("Mallory")).toHaveCount(0);
});

test("K: unlocked username is only a default", async ({ startServer, newPage }) => {
  const s = await startServer({ USERNAME_HEADER: "X-Forwarded-User", USERNAME_HEADER_LOCK: "false" });
  const { page } = await newPage({ extraHTTPHeaders: { "X-Forwarded-User": "Carol" } });
  await openApp(page, s.origin);
  await startSession(page);
  await page.locator(".collab-button").click();
  const name = page.locator(".ShareDialog__username input");
  await expect(name).toHaveValue("Carol");
  await expect(name).not.toHaveAttribute("readonly", "");
  await name.fill("Caroline");
  await expect(name).toHaveValue("Caroline");
});

test("L: persistence disabled: no share link, image collab works, nothing on disk", async ({ startServer, newPage }) => {
  const s = await startServer({ DISABLE_PERSISTENCE: "true", MEMORY_ROOM_GRACE_SECONDS: "5" });
  const errors = [];
  const c1 = await newPage();
  c1.page.on("response", (r) => {
    if (r.url().includes("/api/scenes") || r.url().includes("/api/v2")) errors.push(`${r.status()} ${r.url()}`);
  });
  await openApp(c1.page, s.origin);

  // share dialog: live collaboration only, no "Export to Link"
  await c1.page.locator(".collab-button").click();
  await expect(c1.page.getByRole("button", { name: "Start session" })).toBeVisible();
  await expect(c1.page.getByRole("button", { name: "Export to Link" })).toHaveCount(0);
  await expect(c1.page.locator(".ShareDialog__separator")).toHaveCount(0);
  await closeDialog(c1.page);

  await drag(c1.page, "r", [300, 250], [450, 350]);
  const roomUrl = await startSession(c1.page);

  // insert an image by dropping a PNG file on the canvas
  const b64 = redPng(120, 90).toString("base64");
  const dataTransfer = await c1.page.evaluateHandle((b64) => {
    const dt = new DataTransfer();
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    dt.items.add(new File([bytes], "red.png", { type: "image/png" }));
    return dt;
  }, b64);
  await c1.page.dispatchEvent("canvas.interactive", "drop", { dataTransfer, clientX: 700, clientY: 400, bubbles: true });
  await expect.poll(() => redPixels(c1.page), { timeout: 20_000 }).toBeGreaterThan(5000);

  // a second user joins: gets the scene from the peer (socket) and the image via the in-memory file store
  const c2 = await newPage();
  await openApp(c2.page, roomUrl);
  await expect(c1.page.locator(".CollabButton-collaborators")).toHaveText("2", { timeout: 20_000 });
  await expect.poll(() => inkPixels(c2.page), { timeout: 30_000 }).toBeGreaterThan(300);
  await expect.poll(() => redPixels(c2.page), { timeout: 30_000 }).toBeGreaterThan(5000);

  // and live edits still flow
  const before = await inkPixels(c1.page);
  await drag(c2.page, "o", [900, 200], [1100, 330]);
  await expect.poll(() => inkPixels(c1.page), { timeout: 30_000 }).toBeGreaterThan(before + 300);

  expect(fs.existsSync(s.dataDir)).toBe(false);
  // scene saves are skipped silently: the app never calls /api/scenes or /api/v2
  expect(errors).toEqual([]);
  // the persistence-only endpoints are really off
  const r = await fetch(`${s.origin}/api/v2/post/`, { method: "POST", body: "x" });
  expect(r.status).toBe(404);
});

// every request/websocket of a page, to prove no collaboration traffic ever happens
const watchCollab = (page) => {
  const seen = { websockets: [], socketRequests: [] };
  page.on("websocket", (ws) => seen.websockets.push(ws.url()));
  page.on("request", (r) => {
    if (r.url().includes("/socket.io")) seen.socketRequests.push(r.url());
  });
  return seen;
};

test("N: collaboration disabled: share dialog has only the link section, no socket", async ({ startServer, newPage }) => {
  const s = await startServer({ DISABLE_COLLABORATION: "true", SHARE_NOTE: "Careful" });
  expect((await (await fetch(`${s.origin}/api/config`)).json()).collaboration).toBe(false);
  const { page } = await newPage();
  const seen = watchCollab(page);
  await openApp(page, s.origin);
  await drag(page, "r", [300, 300], [500, 420]);

  await page.locator(".collab-button").click();
  await expect(page.getByTestId("share-note")).toHaveText("Careful");
  await expect(page.getByRole("button", { name: "Start session" })).toHaveCount(0);
  await expect(page.getByText("Live collaboration")).toHaveCount(0);
  await expect(page.locator(".ShareDialog__separator")).toHaveCount(0);
  await page.getByRole("button", { name: "Export to Link" }).click();
  const link = page.locator(".ShareableLinkDialog input");
  await expect(link).toHaveValue(/#json=/);
  await closeDialog(page);

  // the live collaboration entries are gone from the main menu and command palette
  await page.locator(".dropdown-menu-button").first().click();
  await expect(page.getByTestId("collab-button")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+/");
  await page.locator(".command-palette-dialog input").fill("collab");
  await expect(page.locator(".command-palette-dialog").getByText("Live collaboration")).toHaveCount(0);
  await page.keyboard.press("Escape");

  expect(seen.websockets).toEqual([]);
  expect(seen.socketRequests).toEqual([]);
});

test("O: collaboration disabled: #room link keeps the local scene, shows a message, hash removed, no socket", async ({ startServer, newPage }) => {
  const s = await startServer({ DISABLE_COLLABORATION: "true", BANNER_TEXT: "QA", BANNER_MODE: "sending" });
  const { page } = await newPage();
  const seen = watchCollab(page);
  await openApp(page, s.origin);
  await drag(page, "r", [300, 300], [500, 420]);
  await expect.poll(() => inkPixels(page)).toBeGreaterThan(300);
  await page.waitForTimeout(500); // let the local save debounce run

  await page.goto(`${s.origin}/#room=0123456789abcdef0123,abcdefghijklmnopqrstuv`);
  await page.locator("canvas.interactive").waitFor({ state: "visible" });
  await expect(page.getByText("Live collaboration is disabled on this server.")).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  await expect.poll(() => inkPixels(page), { timeout: 15_000 }).toBeGreaterThan(300); // local scene kept
  await expect(page.getByTestId("environment-banner")).toHaveCount(0); // sending mode: never
  await expect(page.locator(".collab-button")).toBeVisible(); // persistence is still on

  await page.reload();
  await page.locator("canvas.interactive").waitFor({ state: "visible" });
  await expect(page.getByText("Live collaboration is disabled on this server.")).toHaveCount(0);

  // a fresh load straight from a room link behaves the same
  const fresh = await newPage();
  const seen2 = watchCollab(fresh.page);
  await openApp(fresh.page, `${s.origin}/#room=0123456789abcdef0123,abcdefghijklmnopqrstuv`);
  await expect(fresh.page.getByText("Live collaboration is disabled on this server.")).toBeVisible();
  await expect.poll(() => new URL(fresh.page.url()).hash).toBe("");
  expect(seen2.websockets).toEqual([]);
  expect(seen2.socketRequests).toEqual([]);
  expect(seen.websockets).toEqual([]);
  expect(seen.socketRequests).toEqual([]);
});

test("P: collaboration and persistence disabled: no Share button, drawing persists locally", async ({ startServer, newPage }) => {
  const s = await startServer({ DISABLE_COLLABORATION: "true", DISABLE_PERSISTENCE: "true" });
  const { page } = await newPage();
  const seen = watchCollab(page);
  await openApp(page, s.origin);
  await expect(page.locator(".collab-button")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Share" })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 700 });
  await expect(page.locator(".collab-button")).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 800 });

  await drag(page, "r", [300, 300], [500, 420]);
  await expect.poll(() => inkPixels(page)).toBeGreaterThan(300);
  await page.waitForTimeout(800); // local save is debounced
  await page.reload();
  await page.locator("canvas.interactive").waitFor({ state: "visible" });
  await expect.poll(() => inkPixels(page), { timeout: 15_000 }).toBeGreaterThan(300);
  await expect(page.locator(".collab-button")).toHaveCount(0);
  expect(fs.existsSync(s.dataDir)).toBe(false);
  expect(seen.websockets).toEqual([]);
  expect(seen.socketRequests).toEqual([]);
});
