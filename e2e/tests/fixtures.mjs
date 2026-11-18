import { test as base, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
export const STATIC_DIR = process.env.STATIC_DIR
  ? path.resolve(process.env.STATIC_DIR)
  : path.join(repo, "upstream/excalidraw-app/build");

export const LIBRARIES_DIR = process.env.LIBRARIES_DIR
  ? path.resolve(process.env.LIBRARIES_DIR)
  : path.join(repo, "libraries-upstream");

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

export const isLocalUrl = (u) => {
  let url;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:") return true;
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return false;
  return LOCAL_HOSTS.has(url.hostname);
};

export const test = base.extend({
  // Worker-scoped: one server for the whole run, temp data dir.
  server: [
    async ({}, use) => {
      if (!fs.existsSync(path.join(STATIC_DIR, "index.html"))) {
        throw new Error(`SKIP: no built app at ${STATIC_DIR} (run scripts/build.sh or set STATIC_DIR)`);
      }
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "excalidraw-e2e-"));
      const { createServer } = await import(pathToFileURL(path.join(repo, "server/src/server.js")).href);
      const s = await createServer({ port: 0, staticDir: STATIC_DIR, librariesDir: LIBRARIES_DIR, dataDir, log: () => {} });
      const origin = `http://127.0.0.1:${s.port}`;
      await use({ origin, dataDir, port: s.port });
      await s.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
    { scope: "worker" },
  ],

  // Starts extra servers with their own env (BANNER_TEXT, DISABLE_PERSISTENCE, ...) and an
  // empty, not-yet-created data dir. Usage: const s = await startServer({ BANNER_TEXT: "QA" }).
  startServer: async ({}, use) => {
    const started = [];
    await use(async (env = {}) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "excalidraw-e2e-env-"));
      const dataDir = path.join(root, "data"); // created by the server only if persistence is on
      const { createServer } = await import(pathToFileURL(path.join(repo, "server/src/server.js")).href);
      const s = await createServer({ port: 0, staticDir: STATIC_DIR, librariesDir: LIBRARIES_DIR, dataDir, env, log: () => {} });
      started.push({ s, root });
      return { origin: `http://127.0.0.1:${s.port}`, dataDir, port: s.port };
    });
    for (const { s, root } of started) {
      await s.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },

  // Creates browser contexts that abort every non-local request and record them.
  // At teardown, asserts nothing was blocked and no non-local websocket was opened.
  newPage: async ({ browser, server }, use) => {
    const blocked = [];
    const websockets = [];
    const contexts = [];
    const make = async (contextOptions = {}) => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        serviceWorkers: "block",
        ...contextOptions,
      });
      contexts.push(context);
      await context.route("**/*", (route) => {
        const u = route.request().url();
        if (isLocalUrl(u)) return route.continue();
        blocked.push(`${route.request().method()} ${u}`);
        return route.abort("blockedbyclient");
      });
      const page = await context.newPage();
      page.on("websocket", (ws) => {
        websockets.push(ws.url());
        if (!isLocalUrl(ws.url())) blocked.push(`WS ${ws.url()}`);
      });
      page.on("pageerror", (e) => console.log("[pageerror]", e.message));
      return { page, context };
    };
    await use(make);
    for (const c of contexts) await c.close().catch(() => {});
    if (blocked.length) console.log("BLOCKED EXTERNAL REQUESTS:\n" + [...new Set(blocked)].join("\n"));
    expect(blocked, `external requests attempted:\n${blocked.join("\n")}`).toEqual([]);
    for (const w of websockets) expect(isLocalUrl(w)).toBe(true);
  },
});

export { expect };

// ---- helpers

export async function openApp(page, url) {
  await page.goto(url);
  await page.locator("canvas.interactive").waitFor({ state: "visible" });
  // dismiss nothing; welcome screen does not block canvas input
}

export async function drag(page, tool, from, to) {
  await page.keyboard.press(tool);
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, { steps: 5 });
  await page.mouse.move(to[0], to[1], { steps: 5 });
  await page.mouse.up();
}

/** Number of pixels on the static canvas that differ from its top-left pixel (background). */
export function inkPixels(page) {
  return page.evaluate(() => {
    const c = document.querySelector("canvas.static");
    if (!c) return 0;
    const ctx = c.getContext("2d");
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
    const bg = [data[0], data[1], data[2], data[3]];
    let n = 0;
    for (let i = 0; i < width * height * 4; i += 4) {
      if (data[i] !== bg[0] || data[i + 1] !== bg[1] || data[i + 2] !== bg[2] || data[i + 3] !== bg[3]) n++;
    }
    return n;
  });
}

/** Start a live session from the UI and return the room URL. */
export async function startSession(page) {
  await page.locator(".collab-button").click();
  await page.getByRole("button", { name: "Start session" }).click();
  const link = page.locator(".ShareDialog__active__linkRow input");
  await expect(link).toHaveValue(/#room=[0-9a-f]{20},[A-Za-z0-9_-]{22}/);
  const url = await link.inputValue();
  await closeDialog(page);
  return url;
}

/** Close the open modal dialog (Escape first, then the close button if still there). */
export async function closeDialog(page) {
  const dialog = page.locator(".Modal");
  await page.keyboard.press("Escape");
  if (await dialog.isVisible().catch(() => false)) {
    await page.locator(".Dialog__close, .Modal__close").first().click({ timeout: 2000 }).catch(() => {});
  }
  if (await dialog.isVisible().catch(() => false)) {
    await page.mouse.click(5, 400); // click the backdrop
  }
  await expect(dialog).toBeHidden();
}

export const parseRoom = (url) => {
  const m = /#room=([0-9a-f]{20}),([A-Za-z0-9_-]{22})/.exec(url);
  if (!m) throw new Error(`not a room url: ${url}`);
  return { roomId: m[1], roomKey: m[2] };
};

/** Fetch scenes/<roomId>.json from DATA_DIR and decrypt it (AES-GCM, key = JWK "k"). */
export async function readServerScene(dataDir, roomId, roomKey) {
  const file = path.join(dataDir, "scenes", `${roomId}.json`);
  if (!fs.existsSync(file)) return null;
  const { iv, ciphertext } = JSON.parse(fs.readFileSync(file, "utf8"));
  const key = await crypto.subtle.importKey("jwk", { kty: "oct", k: roomKey, alg: "A128GCM", ext: true }, { name: "AES-GCM" }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(iv, "base64") }, key, Buffer.from(ciphertext, "base64"));
  return JSON.parse(new TextDecoder().decode(plain));
}

export const sceneTypes = (elements) => (elements ?? []).filter((e) => !e.isDeleted).map((e) => e.type);

/** A solid red w x h PNG (generated, no fixture file needed). */
export function redPng(w = 80, h = 60) {
  const crc = (buf) => {
    let c, crcv = 0xffffffff;
    for (const byte of buf) {
      c = (crcv ^ byte) & 0xff;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcv = (crcv >>> 8) ^ c;
    }
    return (crcv ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).fill(Buffer.from([255, 0, 0]))].map((b, i) => (i === 0 ? b : Buffer.concat(Array.from({ length: w }, () => Buffer.from([255, 0, 0]))))));
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Number of (almost) pure red pixels on the static canvas. */
export function redPixels(page) {
  return page.evaluate(() => {
    const c = document.querySelector("canvas.static");
    if (!c) return 0;
    const { data } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] > 230 && data[i + 1] < 30 && data[i + 2] < 30) n++;
    return n;
  });
}
