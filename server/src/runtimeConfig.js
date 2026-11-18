/**
 * Runtime configuration (env vars read at container start) exposed to the app
 * through GET /api/config, plus the in-memory room file store used when
 * persistence is disabled.
 */

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const NAMED_COLOR = /^[a-zA-Z]{3,30}$/;
export const BANNER_TEXT_MAX = 100;
export const USERNAME_MAX = 64;
export const SHARE_NOTE_MAX = 500;
export const DEFAULT_BANNER_COLOR = "#8b0000";
export const DEFAULT_BANNER_TEXT_COLOR = "#ffffff";

const truthy = (v, dflt) => {
  if (v === undefined || v === null || String(v).trim() === "") return dflt;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
};

/** CSS colour: #rgb, #rrggbb or a named colour (letters only); otherwise the fallback. */
export function validColor(value, fallback) {
  const v = typeof value === "string" ? value.trim() : "";
  return HEX_COLOR.test(v) || NAMED_COLOR.test(v) ? v : fallback;
}

const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]", "g");

/** Strip control characters, trim, cap length (by code points). */
function cleanText(value, max) {
  const s = String(value)
    .replace(CONTROL_CHARS, "")
    .trim();
  return [...s].slice(0, max).join("").trim();
}

/**
 * Share-dialog note: literal "\\n" sequences become newlines, control chars
 * (except newlines) are stripped, trimmed, capped by code points; null if empty.
 */
function cleanNote(value, max) {
  const s = String(value ?? "")
    .replace(/\\n/g, "\n")
    .replace(/\r\n?/g, "\n")
    .replace(new RegExp("[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029]", "g"), "")
    .trim();
  return [...s].slice(0, max).join("").trim() || null;
}

/** Percent-decode if (validly) encoded; otherwise return the value as is. */
function decodeHeader(value) {
  if (!/%[0-9a-fA-F]{2}/.test(value)) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * @param {NodeJS.ProcessEnv | Record<string,string|undefined>} env
 */
export function readRuntimeEnv(env) {
  const bannerText = cleanText(env.BANNER_TEXT ?? "", BANNER_TEXT_MAX);
  return {
    banner: bannerText
      ? {
          text: bannerText,
          color: validColor(env.BANNER_COLOR, DEFAULT_BANNER_COLOR),
          textColor: validColor(env.BANNER_TEXT_COLOR, DEFAULT_BANNER_TEXT_COLOR),
        }
      : null,
    bannerMode: String(env.BANNER_MODE ?? "").trim().toLowerCase() === "sending" ? "sending" : "always",
    shareNote: cleanNote(env.SHARE_NOTE, SHARE_NOTE_MAX),
    usernameHeader: (env.USERNAME_HEADER ?? "").trim().toLowerCase() || null,
    usernameLocked: truthy(env.USERNAME_HEADER_LOCK, true),
    persistence: !truthy(env.DISABLE_PERSISTENCE, false),
    collaboration: !truthy(env.DISABLE_COLLABORATION, false),
    memoryFilesMaxBytes: Math.max(0, Number(env.MEMORY_FILES_MAX_MB ?? 256) || 256) * 1024 * 1024,
    memoryRoomGraceMs: Math.max(0, Number(env.MEMORY_ROOM_GRACE_SECONDS ?? 60)) * 1000,
  };
}

/** The JSON served at /api/config for one request. */
export function buildConfig(rc, headers) {
  let username = null;
  if (rc.usernameHeader) {
    const raw = headers[rc.usernameHeader];
    const first = Array.isArray(raw) ? raw[0] : raw;
    if (typeof first === "string") username = cleanText(decodeHeader(first), USERNAME_MAX) || null;
  }
  return {
    banner: rc.banner ? { ...rc.banner, mode: rc.bannerMode } : null,
    shareNote: rc.shareNote,
    username,
    usernameLocked: username !== null && rc.usernameLocked,
    persistence: rc.persistence,
    collaboration: rc.collaboration,
  };
}

/**
 * In-memory replacement for DATA_DIR/files/rooms while persistence is
 * disabled. Entries live per room and are dropped when the room is empty
 * (after a grace period to survive page reloads); total size is capped.
 */
export class MemoryRoomFiles {
  /**
   * @param {{maxBytes: number, graceMs: number}} opts
   */
  constructor({ maxBytes, graceMs }) {
    this.maxBytes = maxBytes;
    this.graceMs = graceMs;
    /** @type {Map<string, Map<string, Buffer>>} */
    this.rooms = new Map();
    /** @type {Map<string, NodeJS.Timeout>} */
    this.timers = new Map();
    this.bytes = 0;
  }

  /** @returns {boolean} false if the cap would be exceeded */
  put(roomId, fileId, buf) {
    const room = this.rooms.get(roomId) ?? new Map();
    const old = room.get(fileId)?.length ?? 0;
    if (this.bytes - old + buf.length > this.maxBytes) return false;
    room.set(fileId, buf);
    this.rooms.set(roomId, room);
    this.bytes += buf.length - old;
    return true;
  }

  get(roomId, fileId) {
    return this.rooms.get(roomId)?.get(fileId) ?? null;
  }

  /** the socket.io room became empty: purge after the grace period */
  roomEmptied(roomId) {
    if (!this.rooms.has(roomId)) return;
    this.cancelPurge(roomId);
    if (this.graceMs <= 0) return this.purge(roomId);
    const t = setTimeout(() => this.purge(roomId), this.graceMs);
    t.unref?.();
    this.timers.set(roomId, t);
  }

  /** somebody (re)joined: keep the files */
  roomJoined(roomId) {
    this.cancelPurge(roomId);
  }

  cancelPurge(roomId) {
    const t = this.timers.get(roomId);
    if (t) clearTimeout(t);
    this.timers.delete(roomId);
  }

  purge(roomId) {
    this.cancelPurge(roomId);
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const b of room.values()) this.bytes -= b.length;
    this.rooms.delete(roomId);
  }

  close() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

/**
 * 404 handler for an endpoint that is switched off by the runtime config.
 * `error` is what the app's fetch code reads, `message` what the library
 * publish dialog shows: same text in both.
 */
export const disabled = (what) => (req, res) => res.status(404).json({ error: `${what} disabled`, message: `${what} disabled` });
