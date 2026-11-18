import express from "express";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Server as SocketIO } from "socket.io";
import { mountLibraries } from "./libraries.js";
import { MemoryRoomFiles, buildConfig, disabled, readRuntimeEnv } from "./runtimeConfig.js";

const MAX_BYTES = 50 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const KINDS = new Set(["rooms", "shareLinks"]);
/** socket.io room ids (collab room ids, socket ids) */
const isRoomId = (v) => typeof v === "string" && v.length > 0 && v.length <= 256;
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Atomic write: temp file in same dir + rename.
 * @param {string} file
 * @param {Buffer|string} data
 */
async function atomicWrite(file, data) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, file);
  } catch (e) {
    await fs.promises.rm(tmp, { force: true });
    throw e;
  }
}

/** @param {string} file */
async function readOrNull(file) {
  try {
    return await fs.promises.readFile(file);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/**
 * `opts.env` replaces process.env for the runtime-config variables (BANNER_*, USERNAME_HEADER*, DISABLE_PERSISTENCE, DISABLE_COLLABORATION, MEMORY_FILES_MAX_MB, MEMORY_ROOM_GRACE_SECONDS).
 * @param {{port?: number, staticDir?: string, librariesDir?: string, dataDir?: string, corsOrigin?: string, env?: Record<string,string|undefined>, log?: (m:string)=>void}} [opts]
 * @returns {Promise<{server: http.Server, io: SocketIO | null, port: number, close: () => Promise<void>}>}
 */
export async function createServer(opts = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 3000);
  const staticDir = path.resolve(
    opts.staticDir ?? process.env.STATIC_DIR ?? path.join(here, "../../upstream/excalidraw-app/build"),
  );
  const librariesDir = path.resolve(
    opts.librariesDir ?? process.env.LIBRARIES_DIR ?? path.join(here, "../../libraries-upstream"),
  );
  const dataDir = path.resolve(opts.dataDir ?? process.env.DATA_DIR ?? "./data");
  const corsOrigin = opts.corsOrigin ?? process.env.CORS_ORIGIN;
  const log = opts.log ?? ((m) => console.log(m));

  const rc = readRuntimeEnv(opts.env ?? process.env);
  const memFiles = rc.persistence || !rc.collaboration
    ? null
    : new MemoryRoomFiles({ maxBytes: rc.memoryFilesMaxBytes, graceMs: rc.memoryRoomGraceMs });

  // with persistence disabled DATA_DIR is never created or written
  if (rc.persistence) {
    for (const d of ["links", "scenes", "files/rooms", "files/shareLinks"]) {
      fs.mkdirSync(path.join(dataDir, d), { recursive: true });
    }
  }

  const app = express();
  app.disable("x-powered-by");

  // uploaded blobs (share links, files, libraries) are served from the app's
  // origin: never let a browser sniff them into HTML/script (upstream's
  // vercel.json sent the same header)
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  if (corsOrigin) {
    app.use((req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", corsOrigin);
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      if (req.method === "OPTIONS") return res.sendStatus(204);
      next();
    });
  }

  app.use((req, res, next) => {
    const t = Date.now();
    res.on("finish", () => {
      if (req.path !== "/healthz") log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - t}ms`);
    });
    next();
  });

  app.get("/healthz", (req, res) => res.type("text/plain").send("ok"));

  // runtime config for the app (banner, username from header, persistence); never cached
  app.get("/api/config", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(buildConfig(rc, req.headers));
  });

  if (!rc.collaboration) {
    // room scenes and room files (live collaboration) are off; no socket.io either
    app.use(["/api/scenes", "/api/files/rooms"], disabled("collaboration"));
  }

  if (!rc.persistence) {
    // share links, room scenes, share-link files and library publishing are off
    app.use(
      ["/api/v2", "/api/scenes", "/api/files/shareLinks", "/api/libraries/submit"],
      disabled("persistence"),
    );
  }

  const raw = express.raw({ type: () => true, limit: MAX_BYTES });
  const json = express.json({ limit: MAX_BYTES });

  // Validate path params
  app.param(["id", "roomId", "kind", "fileId"], (req, res, next, val, name) => {
    if (!ID_RE.test(val) || (name === "kind" && !KINDS.has(val))) {
      return res.status(400).json({ error: `invalid ${name}` });
    }
    next();
  });

  // --- share links (json.excalidraw.com v2 compatible)
  app.post("/api/v2/post/", raw, async (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: "empty body" });
      }
      const id = crypto.randomBytes(15).toString("base64url");
      await atomicWrite(path.join(dataDir, "links", `${id}.bin`), req.body);
      res.json({ id });
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/v2/:id", async (req, res, next) => {
    try {
      const buf = await readOrNull(path.join(dataDir, "links", `${req.params.id}.bin`));
      if (!buf) return res.status(404).json({ error: "not found" });
      res.type("application/octet-stream").send(buf);
    } catch (e) {
      next(e);
    }
  });

  // --- scenes
  app.get("/api/scenes/:roomId", async (req, res, next) => {
    try {
      const buf = await readOrNull(path.join(dataDir, "scenes", `${req.params.roomId}.json`));
      if (!buf) return res.status(404).json({ error: "not found" });
      res.type("application/json").send(buf);
    } catch (e) {
      next(e);
    }
  });
  app.put("/api/scenes/:roomId", json, async (req, res, next) => {
    try {
      const { sceneVersion, iv, ciphertext } = req.body ?? {};
      if (typeof sceneVersion !== "number" || typeof iv !== "string" || typeof ciphertext !== "string") {
        return res.status(400).json({ error: "expected {sceneVersion:number, iv:string, ciphertext:string}" });
      }
      await atomicWrite(
        path.join(dataDir, "scenes", `${req.params.roomId}.json`),
        JSON.stringify({ sceneVersion, iv, ciphertext }),
      );
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // --- files
  const filePath = (p) => path.join(dataDir, "files", p.kind, p.id, `${p.fileId}.bin`);
  app.put("/api/files/:kind/:id/:fileId", raw, async (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: "empty body" });
      if (memFiles) {
        if (!memFiles.put(req.params.id, req.params.fileId, req.body)) {
          return res.status(507).json({ error: "memory file store full" });
        }
        // files uploaded for a room nobody is in would never be purged otherwise
        if (!io?.sockets.adapter.rooms.get(req.params.id)?.size) memFiles.roomEmptied(req.params.id);
        return res.json({ ok: true });
      }
      await atomicWrite(filePath(req.params), req.body);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/files/:kind/:id/:fileId", async (req, res, next) => {
    try {
      const buf = memFiles ? memFiles.get(req.params.id, req.params.fileId) : await readOrNull(filePath(req.params));
      if (!buf) return res.status(404).json({ error: "not found" });
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.type("application/octet-stream").send(buf);
    } catch (e) {
      next(e);
    }
  });

  // --- library site (/libraries/) + publish backend (/api/libraries/submit)
  mountLibraries(app, { librariesDir, dataDir, log, persistence: rc.persistence });

  app.use("/api", (req, res) => res.status(404).json({ error: "not found" }));

  // --- static + SPA fallback
  const noCache = /^(sw\.js|workbox-.*\.js|.*manifest.*|index\.html|registerSW\.js)$/;
  app.use(
    express.static(staticDir, {
      index: false,
      setHeaders(res, file) {
        const rel = path.relative(staticDir, file).split(path.sep).join("/");
        if (noCache.test(path.basename(file)) && !rel.startsWith("assets/")) {
          res.setHeader("Cache-Control", "no-cache");
        } else if (rel.startsWith("assets/")) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );
  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/socket.io")) return next();
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(staticDir, "index.html"), (err) => {
      if (err) res.status(404).type("text/plain").send("index.html not found");
    });
  });

  app.use((err, req, res, next) => {
    if (err?.type === "entity.too.large") return res.status(413).json({ error: "too large" });
    if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "bad json" });
    log(`error: ${err?.stack ?? err}`);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: "internal error" });
  });

  const server = http.createServer(app);

  // --- socket.io: mirrors excalidraw-room src/index.ts
  // not attached at all when collaboration is disabled (/socket.io/ is a plain 404)
  const io = rc.collaboration ? new SocketIO(server, {
    transports: ["websocket", "polling"],
    cors: {
      allowedHeaders: ["Content-Type", "Authorization"],
      origin: corsOrigin || false,
      credentials: true,
    },
    allowEIO3: true,
    // maxHttpBufferSize left at socket.io's default (1 MB), as in excalidraw-room:
    // only scene updates and cursors use the socket, images go through /api/files
  }) : null;

  io?.on("connection", (socket) => {
    log(`io: ${socket.id} connected`);
    io.to(`${socket.id}`).emit("init-room");

    // clients are untrusted: a malformed event must never throw (an async
    // handler's rejection would crash the process), so check shapes first
    socket.on("join-room", async (roomID) => {
      if (!isRoomId(roomID)) return;
      await socket.join(roomID);
      memFiles?.roomJoined(roomID);
      const sockets = await io.in(roomID).fetchSockets();
      if (sockets.length <= 1) {
        io.to(`${socket.id}`).emit("first-in-room");
      } else {
        socket.broadcast.to(roomID).emit("new-user", socket.id);
      }
      io.in(roomID).emit("room-user-change", sockets.map((s) => s.id));
    });

    socket.on("server-broadcast", (roomID, encryptedData, iv) => {
      socket.broadcast.to(roomID).emit("client-broadcast", encryptedData, iv);
    });

    socket.on("server-volatile-broadcast", (roomID, encryptedData, iv) => {
      socket.volatile.broadcast.to(roomID).emit("client-broadcast", encryptedData, iv);
    });

    socket.on("user-follow", async (payload) => {
      if (!isRoomId(payload?.userToFollow?.socketId)) return;
      const roomID = `follow@${payload.userToFollow.socketId}`;
      switch (payload.action) {
        case "FOLLOW": {
          await socket.join(roomID);
          const sockets = await io.in(roomID).fetchSockets();
          io.to(payload.userToFollow.socketId).emit("user-follow-room-change", sockets.map((s) => s.id));
          break;
        }
        case "UNFOLLOW": {
          await socket.leave(roomID);
          const sockets = await io.in(roomID).fetchSockets();
          io.to(payload.userToFollow.socketId).emit("user-follow-room-change", sockets.map((s) => s.id));
          break;
        }
      }
    });

    socket.on("disconnecting", async () => {
      for (const roomID of Array.from(socket.rooms)) {
        const otherClients = (await io.in(roomID).fetchSockets()).filter((s) => s.id !== socket.id);
        const isFollowRoom = roomID.startsWith("follow@");
        if (!isFollowRoom && otherClients.length > 0) {
          socket.broadcast.to(roomID).emit("room-user-change", otherClients.map((s) => s.id));
        }
        if (memFiles && !isFollowRoom && roomID !== socket.id && otherClients.length === 0) {
          memFiles.roomEmptied(roomID);
        }
        if (isFollowRoom && otherClients.length === 0) {
          io.to(roomID.replace("follow@", "")).emit("broadcast-unfollow");
        }
      }
    });

    socket.on("disconnect", () => {
      socket.removeAllListeners();
      socket.disconnect();
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, resolve);
  });
  const actualPort = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  log(`listening on :${actualPort} static=${staticDir} libraries=${librariesDir} data=${rc.persistence ? dataDir : "(persistence disabled)"}`);

  return {
    server,
    io,
    port: actualPort,
    async close() {
      memFiles?.close();
      if (io) await io.close(); // also closes the http server
      else await new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await createServer();
  const stop = async (sig) => {
    console.log(`${sig} received, shutting down`);
    const t = setTimeout(() => process.exit(1), 10000);
    t.unref();
    await s.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}
