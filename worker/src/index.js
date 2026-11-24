// InkBoard rooms: one Durable Object per share code. Each room keeps a Yjs document in its own
// SQLite storage and relays edits, presence (Yjs awareness) and live pen strokes between the
// people connected to it. Nobody signs in: knowing the code is what lets you in.
//
//   GET /room/ABC234  (WebSocket upgrade)   join a room
//   GET /             health check
//
// Messages are binary, y-websocket style: the first varUint says what follows.
//   0 sync      (y-protocols sync step 1 / step 2 / update)
//   1 awareness (y-protocols awareness update: cursors, names, who's typing)
//   2 relay     (passed to everyone else untouched: the stroke someone is drawing right now)
//   3 synced    (server -> client: you now have everything the room had when you asked)
//
// Storage is a list of Yjs updates. Now and then they're merged into fewer rows, each kept under
// ~800 KB, and a newcomer gets those rows one message at a time, so no single WebSocket message
// has to carry a whole big board.
import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

const MSG_SYNC = 0, MSG_AWARENESS = 1, MSG_RELAY = 2, MSG_SYNCED = 3;
const CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const MAX_PEOPLE = 40;
const COMPACT_AFTER = 400;            // rows before they're merged
const ROW_MAX = 800_000;              // merged rows stay under this (WebSocket and SQLite limits)
const MAX_DOC = 40_000_000;           // a room that grows past this stops taking edits
const IDLE_MS = 45 * 24 * 3600e3;     // rooms nobody opens for 45 days are deleted

function allowed(origin, env) {
  if (!origin) return false;
  return String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).includes(origin);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response("InkBoard rooms");
    const m = /^\/room\/([A-Za-z0-9]+)$/.exec(url.pathname);
    if (!m) return new Response("Not found", { status: 404 });
    const code = m[1].toUpperCase();
    if (!CODE.test(code)) return new Response("Bad code", { status: 400 });
    if (!allowed(req.headers.get("Origin"), env)) return new Response("Forbidden", { status: 403 });
    if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(req);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.doc = new Y.Doc();
    this.aw = new Map();               // awareness clientID -> { clock, state (JSON text) }, memory only
    this.lastTouch = 0;
    this.pending = 0;
    this.size = 0;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec("CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB)");
      for (const r of this.sql.exec("SELECT data FROM updates ORDER BY id")) {
        const u = new Uint8Array(r.data); this.size += u.length; this.pending++;
        Y.applyUpdate(this.doc, u, "load");
      }
    });
    this.doc.on("update", (update, origin) => {
      if (origin === "load") return;
      this.sql.exec("INSERT INTO updates (data) VALUES (?)", update);
      this.size += update.length;
      if (++this.pending > (this.compactAt || COMPACT_AFTER)) this.compact();
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      this.broadcast(encoding.toUint8Array(enc), origin);
    });
  }

  // Merge runs of small updates into rows of up to ROW_MAX bytes.
  compact() {
    const rows = [...this.sql.exec("SELECT data FROM updates ORDER BY id")].map(r => new Uint8Array(r.data));
    const out = [];
    let run = [], runSize = 0;
    const flush = () => { if (run.length) out.push(run.length > 1 ? Y.mergeUpdates(run) : run[0]); run = []; runSize = 0; };
    for (const u of rows) {
      if (runSize + u.length > ROW_MAX) flush();
      run.push(u); runSize += u.length;
    }
    flush();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM updates");
      for (const u of out) this.sql.exec("INSERT INTO updates (data) VALUES (?)", u);
    });
    this.pending = out.length;
    this.size = out.reduce((n, u) => n + u.length, 0);
    // Rows that couldn't be merged further: try again after more edits rather than every time.
    this.compactAt = this.pending + COMPACT_AFTER;
  }

  async fetch() {
    if (this.ctx.getWebSockets().length >= MAX_PEOPLE) return new Response("This board is full", { status: 429 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ ids: {} });
    // Say what we have (step 1) so the newcomer sends what we're missing, then who's here.
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    server.send(encoding.toUint8Array(enc));
    const here = this.awarenessMessage([...this.aw.keys()]);
    if (here) server.send(here);
    await this.touch();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data) {
    if (typeof data === "string") return;
    const buf = new Uint8Array(data);
    try {
      const dec = decoding.createDecoder(buf);
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) {
        if (this.size > MAX_DOC) { ws.close(4009, "This board is too big to share"); return; }
        const peek = decoding.clone(dec), step = decoding.readVarUint(peek);
        if (step === syncProtocol.messageYjsSyncStep1 && isEmptyStateVector(decoding.readVarUint8Array(peek))) {
          // A newcomer with nothing yet: send the stored rows one by one.
          for (const r of this.sql.exec("SELECT data FROM updates ORDER BY id")) {
            const e = encoding.createEncoder();
            encoding.writeVarUint(e, MSG_SYNC);
            syncProtocol.writeUpdate(e, new Uint8Array(r.data));
            ws.send(encoding.toUint8Array(e));
          }
        } else {
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, MSG_SYNC);
          syncProtocol.readSyncMessage(dec, enc, this.doc, ws);
          if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
        }
        if (step === syncProtocol.messageYjsSyncStep1) ws.send(Uint8Array.of(MSG_SYNCED));
      } else if (type === MSG_AWARENESS) {
        this.readAwareness(ws, decoding.readVarUint8Array(dec));
        this.broadcast(buf, ws);
      } else if (type === MSG_RELAY) {
        this.broadcast(buf, ws);
      }
    } catch (err) {
      console.warn("bad message", err && err.message);
    }
    await this.touch();
  }

  async webSocketClose(ws) { this.leave(ws); }
  async webSocketError(ws) { this.leave(ws); }

  // Awareness updates: [count, (clientID, clock, JSON state)...]. Remember the latest one per
  // client so newcomers see everyone, and which socket it came from so we can say goodbye for it.
  readAwareness(ws, update) {
    const dec = decoding.createDecoder(update);
    const att = ws.deserializeAttachment() || { ids: {} };
    for (let n = decoding.readVarUint(dec); n > 0; n--) {
      const id = decoding.readVarUint(dec), clock = decoding.readVarUint(dec), state = decoding.readVarString(dec);
      const prev = this.aw.get(id);
      if (prev && prev.clock > clock) continue;
      if (state === "null") { this.aw.delete(id); delete att.ids[id]; }
      else { this.aw.set(id, { clock, state }); att.ids[id] = clock; }
    }
    ws.serializeAttachment(att);
  }

  awarenessMessage(ids, gone = false, clocks = {}) {
    if (!ids.length) return null;
    const inner = encoding.createEncoder();
    encoding.writeVarUint(inner, ids.length);
    for (const id of ids) {
      const s = this.aw.get(+id);
      encoding.writeVarUint(inner, +id);
      encoding.writeVarUint(inner, gone ? (s ? s.clock : clocks[id] || 0) + 1 : s.clock);
      encoding.writeVarString(inner, gone ? "null" : s.state);
    }
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, encoding.toUint8Array(inner));
    return encoding.toUint8Array(enc);
  }

  leave(ws) {
    const att = ws.deserializeAttachment() || { ids: {} };
    const ids = Object.keys(att.ids || {});
    const bye = this.awarenessMessage(ids, true, att.ids);
    for (const id of ids) this.aw.delete(+id);
    if (bye) this.broadcast(bye, ws);
    try { ws.close(1000, "bye"); } catch (_) {}
  }

  broadcast(msg, except) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(msg); } catch (_) {}
    }
  }

  // Push the clean-up date back whenever the room is used (at most once an hour).
  async touch() {
    const now = Date.now();
    if (now - this.lastTouch < 3600e3) return;
    this.lastTouch = now;
    await this.ctx.storage.setAlarm(now + IDLE_MS);
  }

  async alarm() {
    if (this.ctx.getWebSockets().length) { await this.ctx.storage.setAlarm(Date.now() + IDLE_MS); return; }
    await this.ctx.storage.deleteAll();
  }
}

function isEmptyStateVector(sv) {
  return decoding.readVarUint(decoding.createDecoder(sv)) === 0;
}
