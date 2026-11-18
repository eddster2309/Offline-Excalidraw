import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { disabled } from "./runtimeConfig.js";

export const MAX_LIBRARY_BYTES = 10 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/** @param {Buffer} buf @returns {"png"|"jpg"|null} sniffed from magic bytes, never from client input */
const previewKind = (buf) =>
  buf.subarray(0, 8).equals(PNG_MAGIC) ? "png" : buf.subarray(0, 3).equals(JPEG_MAGIC) ? "jpg" : null;
const LIB_EXT = ".excalidrawlib";

// Only these top-level entries of the upstream site checkout are served
// (the checkout also contains scripts, stats history, tooling, ...).
const SITE_ENTRIES = new Set([
  "index.html",
  "script.js",
  "style.css",
  "favicon.ico",
  "LICENSE",
  "stats.json",
  "total.json",
  "vendor",
  "libraries",
]);

/** @param {string} dir */
const isDir = (dir) => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

/** lowercase [a-z0-9-] slug, never empty */
export const slugify = (value, fallback, max = 60) => {
  const slug = String(value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || fallback;
};

/** same derivation as the site's script.js, used for the #anchor of a library */
export const siteLibraryId = (source) =>
  source.toLowerCase().replace(/\/|.excalidrawlib/g, (m) => (m === "/" ? "-" : ""));

const newId = () => {
  let id = "";
  while (id.length < 11) id += crypto.randomBytes(12).toString("base64").replace(/[^A-Za-z0-9]/g, "");
  return id.slice(0, 11);
};

const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** accepts only http(s) URLs, returns "" otherwise */
const httpUrl = (v) => {
  const s = text(v, 300);
  if (!s) return "";
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : "";
  } catch {
    return "";
  }
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Library site (/libraries/) + publish backend (/api/libraries/submit).
 *
 * @param {import("express").Express} app
 * @param {{librariesDir: string, dataDir: string, log: (m:string)=>void, persistence?: boolean}} opts
 */
export function mountLibraries(app, { librariesDir, dataDir, log, persistence = true }) {
  const siteAvailable = isDir(librariesDir) && fs.existsSync(path.join(librariesDir, "index.html"));
  const localDir = path.join(dataDir, "libraries");
  const indexFile = path.join(localDir, "index.json");
  // persistence disabled: read-only, DATA_DIR is never touched
  if (persistence) fs.mkdirSync(localDir, { recursive: true });
  if (!siteAvailable) log(`libraries: no site at ${librariesDir}; /libraries and publishing disabled`);

  const readLocalEntries = async () => {
    if (!persistence) return [];
    try {
      const data = JSON.parse(await fs.promises.readFile(indexFile, "utf8"));
      return Array.isArray(data) ? data : [];
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  };

  let upstreamCache = { mtime: -1, entries: [] };
  const readUpstreamEntries = async () => {
    const file = path.join(librariesDir, "libraries.json");
    try {
      const { mtimeMs } = await fs.promises.stat(file);
      if (mtimeMs !== upstreamCache.mtime) {
        const data = JSON.parse(await fs.promises.readFile(file, "utf8"));
        upstreamCache = { mtime: mtimeMs, entries: Array.isArray(data) ? data : [] };
      }
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      return [];
    }
    return upstreamCache.entries;
  };

  // serialize read-modify-write of the local index and slug allocation
  let queue = Promise.resolve();
  const exclusive = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  const notFound = (res, text = "not found") => res.status(404).type("text/plain").send(text);
  const noSite = (req, res) => notFound(res, "library site not installed");
  const persistenceDisabled = disabled("persistence");

  // ---------------------------------------------------------------- publish
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_LIBRARY_BYTES, files: 2, fields: 20, fieldSize: 64 * 1024, parts: 30 },
  }).fields([
    { name: "excalidrawLib", maxCount: 1 },
    { name: "previewImage", maxCount: 1 },
  ]);

  app.post(
    "/api/libraries/submit",
    (req, res, next) => {
      if (!persistence) return persistenceDisabled(req, res);
      if (!siteAvailable) return res.status(404).json({ message: "library site not installed" });
      upload(req, res, (err) => {
        if (!err) return next();
        if (err.code === "LIMIT_FILE_SIZE") return next(new HttpError(413, "library too large (max 10MB)"));
        if (err instanceof multer.MulterError) return next(new HttpError(400, `invalid upload: ${err.message}`));
        next(new HttpError(400, "invalid multipart request"));
      });
    },
    async (req, res, next) => {
      try {
        const body = req.body ?? {};
        const files = /** @type {Record<string, Express.Multer.File[]>} */ (req.files ?? {});
        const libFile = files.excalidrawLib?.[0];
        const previewFile = files.previewImage?.[0];
        if (!libFile) throw new HttpError(400, "missing excalidrawLib file");
        if (!previewFile) throw new HttpError(400, "missing previewImage file");

        const name = text(body.name, 100) || text(body.title, 100);
        const authorName = text(body.authorName, 100);
        const description = text(body.description, 1000);
        if (!name) throw new HttpError(400, "missing library name");
        if (!authorName) throw new HttpError(400, "missing author name");

        let lib;
        try {
          lib = JSON.parse(libFile.buffer.toString("utf8"));
        } catch {
          throw new HttpError(400, "excalidrawLib is not valid JSON");
        }
        if (
          !lib ||
          lib.type !== "excalidrawlib" ||
          ![1, 2].includes(lib.version) ||
          !Array.isArray(lib.libraryItems ?? lib.library) ||
          (lib.libraryItems ?? lib.library).length === 0
        ) {
          throw new HttpError(400, "excalidrawLib is not a valid, non-empty library");
        }
        // the app sends a JPEG preview; PNG is accepted too
        const previewExt = previewKind(previewFile.buffer);
        if (!previewExt) throw new HttpError(400, "previewImage must be a PNG or JPEG image");

        const handle = text(body.githubHandle, 100).replace(/^@/, "");
        const twitter = text(body.twitterHandle, 100).replace(/^@/, "");
        const authorDir = slugify(handle || authorName, "anonymous", 40);
        const baseSlug = slugify(name, "library", 60);

        const items = lib.libraryItems ?? lib.library;
        const itemNames = lib.version === 1 ? undefined : items.map((i) => (typeof i?.name === "string" ? i.name : "")).filter(Boolean);

        const author = { name: authorName };
        if (handle && /^[A-Za-z0-9-]{1,39}$/.test(handle)) author.github = `https://github.com/${handle}`;
        if (twitter && /^[A-Za-z0-9_]{1,15}$/.test(twitter)) author.twitter = `https://twitter.com/${twitter}`;
        author.url = httpUrl(body.website) || author.github || author.twitter || "";

        const entry = await exclusive(async () => {
          const entries = await readLocalEntries();
          const upstream = await readUpstreamEntries();
          const taken = new Set([...entries, ...upstream].map((e) => String(e.source).toLowerCase()));
          let slug = baseSlug;
          for (let n = 2; taken.has(`${authorDir}/${slug}${LIB_EXT}`); n++) slug = `${baseSlug}-${n}`;

          const dir = path.resolve(localDir, authorDir);
          if (path.dirname(dir) !== path.resolve(localDir)) throw new HttpError(400, "invalid author");
          await fs.promises.mkdir(dir, { recursive: true });
          const libPath = path.join(dir, `${slug}${LIB_EXT}`);
          const previewPath = path.join(dir, `${slug}.${previewExt}`);
          await fs.promises.writeFile(libPath, libFile.buffer);
          await fs.promises.writeFile(previewPath, previewFile.buffer);

          const day = new Date().toISOString().slice(0, 10);
          const e = {
            name,
            description,
            authors: [author],
            source: `${authorDir}/${slug}${LIB_EXT}`,
            preview: `${authorDir}/${slug}.${previewExt}`,
            created: day,
            updated: day,
            version: lib.version,
            ...(itemNames ? { itemNames } : {}),
            id: newId(),
          };
          entries.push(e);
          const tmp = `${indexFile}.${crypto.randomBytes(6).toString("hex")}.tmp`;
          await fs.promises.writeFile(tmp, JSON.stringify(entries, null, 2));
          await fs.promises.rename(tmp, indexFile);
          return e;
        });

        const proto = String(req.get("x-forwarded-proto") ?? req.protocol).split(",")[0].trim();
        const origin = `${proto === "https" ? "https" : "http"}://${req.get("host")}`;
        log(`libraries: published ${entry.source}`);
        res.json({ url: `${origin}/libraries/#${siteLibraryId(entry.source)}` });
      } catch (e) {
        next(e);
      }
    },
    (err, req, res, next) => {
      if (err instanceof HttpError) return res.status(err.status).json({ message: err.message });
      next(err);
    },
  );

  // ------------------------------------------------------------------- site
  app.use("/libraries", (req, res, next) => (siteAvailable ? next() : noSite(req, res)));

  app.get("/libraries", (req, res, next) => {
    if (req.path.endsWith("/")) return next();
    const q = req.originalUrl.indexOf("?");
    res.redirect(301, `/libraries/${q >= 0 ? req.originalUrl.slice(q) : ""}`);
  });

  // upstream catalog + locally published entries
  app.get("/libraries/libraries.json", async (req, res, next) => {
    try {
      const merged = [...(await readUpstreamEntries()), ...(await readLocalEntries())];
      res.setHeader("Cache-Control", "no-cache");
      res.type("application/json").send(JSON.stringify(merged));
    } catch (e) {
      next(e);
    }
  });

  // library files / previews: locally published first, then the upstream checkout
  const publishedFiles = express.static(localDir, { index: false, dotfiles: "ignore", fallthrough: true });
  app.use("/libraries/libraries", (req, res, next) => {
    if (req.path === "/index.json") return notFound(res);
    if (!persistence) return next();
    publishedFiles(req, res, next);
  });

  const site = express.static(librariesDir, { index: "index.html", dotfiles: "ignore", redirect: false });
  app.use("/libraries", (req, res, next) => {
    const first = req.path.split("/")[1] ?? "";
    if (first !== "" && !SITE_ENTRIES.has(first)) return notFound(res);
    if (first === "libraries.json") return res.status(404).end();
    site(req, res, next);
  });
  // anything else under /libraries is a real 404 (never the app's index.html)
  app.use("/libraries", (req, res) => notFound(res));
}
