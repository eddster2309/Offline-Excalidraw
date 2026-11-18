import fs from "node:fs";
import path from "node:path";
import { test, expect, openApp, drag, closeDialog, STATIC_DIR, LIBRARIES_DIR } from "./fixtures.mjs";

test.beforeAll(() => {
  test.skip(!fs.existsSync(path.join(STATIC_DIR, "index.html")), `built app not found at ${STATIC_DIR}`);
  test.skip(!fs.existsSync(path.join(LIBRARIES_DIR, "index.html")), `library site not found at ${LIBRARIES_DIR}`);
});

const openLibrarySidebar = async (page) => {
  if (!(await page.locator(".layer-ui__library").isVisible())) {
    await page.locator(".default-sidebar-trigger").click();
  }
  await expect(page.locator(".layer-ui__library")).toBeVisible();
};

// a small upstream library with several named items
const LIB_ID = "lipis-polygons";
const LIB_FILE = path.join("lipis", "polygons.excalidrawlib");

test("E: browse libraries, install one, items show up in the library sidebar", async ({ server, newPage }) => {
  const { page, context } = await newPage();
  await openApp(page, server.origin);
  await openLibrarySidebar(page);
  const browse = page.locator(".library-menu-browse-button");
  await expect(browse).toBeVisible();
  await expect(browse).toHaveAttribute("href", /^\/libraries\/\?/);

  // "Browse libraries" opens the local site in a new tab
  const [site] = await Promise.all([context.waitForEvent("page"), browse.click()]);
  await site.waitForLoadState("domcontentloaded");
  expect(new URL(site.url()).origin).toBe(server.origin);
  expect(new URL(site.url()).pathname).toBe("/libraries/");
  await expect(site.locator(`#${LIB_ID}`)).toBeVisible({ timeout: 30_000 });
  await expect(site.locator(".library").nth(5)).toBeVisible();

  // the add link points back to the app with an absolute same-origin library url
  const add = site.locator(`#${LIB_ID} .install-library`);
  const href = await add.getAttribute("href");
  const hash = new URLSearchParams(new URL(href).hash.slice(1));
  expect(href.startsWith(`${server.origin}/#addLibrary=`)).toBe(true);
  expect(hash.get("addLibrary")).toBe(`${server.origin}/libraries/libraries/lipis/polygons.excalidrawlib`);
  expect(hash.get("token")).toBeTruthy();

  const libData = JSON.parse(fs.readFileSync(path.join(LIBRARIES_DIR, "libraries", LIB_FILE), "utf8"));
  const expected = (libData.libraryItems ?? libData.library).length;
  expect(expected).toBeGreaterThan(1);

  // The app tab is named (window.name), the site targets that tab, so installing
  // hands the library to the editor we came from; the tokens match -> no prompt.
  await add.click();
  await expect(page.locator(".library-unit__active")).toHaveCount(expected, { timeout: 30_000 });
  expect(new URL(page.url()).origin).toBe(server.origin);
  expect(page.url()).not.toContain("addLibrary"); // hash is cleaned up
  expect(context.pages().length).toBe(2); // no extra tab was opened

  // the library persists: a fresh load of the app still has the items
  await page.reload();
  await page.locator("canvas.interactive").waitFor({ state: "visible" });
  await openLibrarySidebar(page);
  await expect(page.locator(".library-unit__active")).toHaveCount(expected, { timeout: 30_000 });
});

test("F: a library from another origin cannot be installed via #addLibrary", async ({ server, newPage }) => {
  const { page } = await newPage();
  const dialogs = [];
  page.on("dialog", (d) => dialogs.push(d.message()));
  await openApp(page, `${server.origin}/#addLibrary=${encodeURIComponent("https://libraries.excalidraw.com/libraries/lipis/stars.excalidrawlib")}`);
  await expect(page.locator(".library-unit__active")).toHaveCount(0);
  // (the zero-external-requests fixture also asserts nothing was fetched)
});

test("G: publish a library, it shows up in the local catalog", async ({ server, newPage }) => {
  const { page, context } = await newPage();
  await openApp(page, server.origin);

  // draw something and add it to the library
  await drag(page, "r", [300, 300], [420, 380]);
  await page.keyboard.press("v");
  await page.keyboard.press("Control+a");
  await openLibrarySidebar(page);
  const adder = page.locator(".library-unit__adder").first();
  await expect(adder).toBeVisible();
  await adder.click({ force: true });
  await expect(page.locator(".library-unit__active")).toHaveCount(1);

  // select the item and open the publish dialog from the library menu
  await page.locator(".library-unit__active").first().hover();
  await page.locator(".library-unit .Checkbox").first().click();
  await page.locator('[data-testid="library-dropdown-menu"], .library-menu-dropdown-container button').first().click();
  await page.getByText(/Rename or publish/i).click();

  const dialog = page.locator(".publish-library");
  await expect(dialog).toBeVisible();
  await dialog.locator("input[placeholder]").first().fill("Test Box"); // item name
  await dialog.locator('input[name="authorName"]').fill("E2E Tester");
  await dialog.locator('input[name="githubHandle"]').fill("e2e-tester");
  await dialog.locator('input[name="name"]').fill("E2E Boxes");
  await dialog.locator('textarea[name="description"]').fill("A box published by the e2e test");
  await dialog.locator('button[type="submit"]').click();

  const success = page.locator(".publish-library-success");
  await expect(success).toBeVisible({ timeout: 30_000 });
  const link = success.locator("a");
  const url = await link.getAttribute("href");
  expect(url.startsWith(`${server.origin}/libraries/#`)).toBe(true);

  // stored on disk and listed in the merged catalog
  const catalog = await (await page.request.get(`${server.origin}/libraries/libraries.json`)).json();
  const entry = catalog.find((e) => e.name === "E2E Boxes");
  expect(entry).toBeTruthy();
  expect(entry.source).toBe("e2e-tester/e2e-boxes.excalidrawlib");
  expect(entry.preview).toBe("e2e-tester/e2e-boxes.jpg");
  expect(entry.authors[0].name).toBe("E2E Tester");
  expect(entry.description).toBe("A box published by the e2e test");
  expect(fs.existsSync(path.join(server.dataDir, "libraries", entry.source))).toBe(true);
  expect(url).toBe(`${server.origin}/libraries/#e2e-tester-e2e-boxes`);

  // the site shows it, with a working install link back to the app
  const site = await context.newPage();
  await site.goto(url);
  const card = site.locator("#e2e-tester-e2e-boxes");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.locator("img")).toHaveAttribute("src", /libraries\/e2e-tester\/e2e-boxes\.jpg/);
  await expect(card.locator(".install-library")).toHaveAttribute("href", new RegExp(`^${server.origin}/\\?addLibrary=`));
  const img = await site.request.get(`${server.origin}/libraries/libraries/${entry.preview}`);
  expect(img.status()).toBe(200);
});

test("G2: the site's ?target= parameter cannot inject HTML (same origin as the app)", async ({ server, newPage }) => {
  const { page } = await newPage();
  let dialogs = 0;
  page.on("dialog", (d) => {
    dialogs++;
    d.dismiss();
  });
  // double-encoded: upstream decoded the value after escaping it
  const payload = encodeURIComponent(encodeURIComponent('"><img src=x onerror=alert(1)>'));
  await page.goto(`${server.origin}/libraries/?target=${payload}`);
  await expect(page.locator(`#${LIB_ID}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("img[src=x]")).toHaveCount(0);
  await expect(page.locator(`#${LIB_ID} .install-library`)).toHaveAttribute("target", "_blank");
  expect(dialogs).toBe(0);
});
