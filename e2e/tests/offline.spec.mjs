import fs from "node:fs";
import path from "node:path";
import { closeDialog, test, expect, openApp, drag, inkPixels, startSession, parseRoom, readServerScene, sceneTypes, STATIC_DIR } from "./fixtures.mjs";

test.beforeAll(() => {
  test.skip(!fs.existsSync(path.join(STATIC_DIR, "index.html")), `built app not found at ${STATIC_DIR}; run scripts/build.sh first`);
});

test("A: loads offline, draws, fonts local", async ({ server, newPage }) => {
  const { page } = await newPage();
  await openApp(page, server.origin);

  await drag(page, "r", [300, 300], [500, 420]);
  await page.keyboard.press("t");
  await page.mouse.click(600, 300);
  await page.keyboard.type("hello offline");
  await page.keyboard.press("Escape");

  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("excalidraw") || "[]").map((e) => e.type).sort()))
    .toEqual(["rectangle", "text"]);

  const families = await page.evaluate(() =>
    document.fonts.ready.then(() => [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/['"]/g, ""))),
  );
  expect(families).toContain("Excalifont");
  expect(await inkPixels(page)).toBeGreaterThan(500);
});

test("B: live collaboration between two contexts", async ({ server, newPage }) => {
  const c1 = await newPage();
  await openApp(c1.page, server.origin);
  await drag(c1.page, "r", [300, 300], [500, 420]);
  const roomUrl = await startSession(c1.page);
  const { roomId, roomKey } = parseRoom(roomUrl);

  // server persisted (encrypted) scene contains our rectangle
  await expect.poll(async () => sceneTypes(await readServerScene(server.dataDir, roomId, roomKey)), { timeout: 30_000 })
    .toContain("rectangle");

  const c2 = await newPage();
  await openApp(c2.page, roomUrl);
  await expect.poll(() => inkPixels(c2.page), { timeout: 30_000 }).toBeGreaterThan(300);

  // both clients are in the room: collaborator indicator shows up
  await expect(c1.page.locator(".CollabButton-collaborators")).toHaveText("2", { timeout: 20_000 });

  // c2 draws an ellipse in an empty area; c1 receives it
  const before = await inkPixels(c1.page);
  await drag(c2.page, "o", [700, 400], [900, 560]);
  await expect.poll(() => inkPixels(c1.page), { timeout: 30_000 }).toBeGreaterThan(before + 300);
});

test("C: shareable link round-trip", async ({ server, newPage }) => {
  const c1 = await newPage();
  await openApp(c1.page, server.origin);
  await drag(c1.page, "r", [300, 300], [500, 420]);
  await c1.page.locator(".collab-button").click();
  await c1.page.getByRole("button", { name: "Export to Link" }).click();
  const link = c1.page.locator(".ShareableLinkDialog input");
  await expect(link).toHaveValue(/#json=/);
  const url = await link.inputValue();
  await closeDialog(c1.page);
  expect(url.startsWith(server.origin)).toBe(true);

  const links = fs.readdirSync(path.join(server.dataDir, "links"));
  expect(links.length).toBeGreaterThan(0);

  const c2 = await newPage();
  await openApp(c2.page, url);
  await expect.poll(() => inkPixels(c2.page), { timeout: 30_000 }).toBeGreaterThan(300);
});

test("D: room scene persists on server for a late joiner", async ({ server, newPage }) => {
  const c1 = await newPage();
  await openApp(c1.page, server.origin);
  await drag(c1.page, "r", [300, 300], [500, 420]);
  const roomUrl = await startSession(c1.page);
  const { roomId } = parseRoom(roomUrl);
  await expect.poll(() => fs.existsSync(path.join(server.dataDir, "scenes", `${roomId}.json`)), { timeout: 30_000 }).toBe(true);
  await c1.context.close(); // nobody is connected any more

  const c3 = await newPage();
  await openApp(c3.page, roomUrl);
  await expect.poll(() => inkPixels(c3.page), { timeout: 30_000 }).toBeGreaterThan(300);
});

test("H: text-to-diagram opens the Mermaid dialog only (no AI chat)", async ({ server, newPage }) => {
  const { page } = await newPage();
  await openApp(page, server.origin);
  await page.keyboard.press("ControlOrMeta+/");
  await page.keyboard.type("Text to diagram");
  await page.keyboard.press("Enter");
  const dialog = page.locator(".ttd-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".dialog-mermaid-title")).toBeVisible();
  // no tab triggers, no chat panel / chat messages
  await expect(dialog.locator(".ttd-dialog-tab-trigger")).toHaveCount(0);
  await expect(dialog.locator(".chat-message, .ttd-chat-panel, [class*='chat-interface']")).toHaveCount(0);
});
