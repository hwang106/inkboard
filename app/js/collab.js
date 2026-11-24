// Live collaboration: a board shared with a six-letter code. Everyone in the room edits one Yjs
// document kept by the InkBoard rooms server (worker/), sees each other's cursors, names and
// strokes as they're drawn. Nobody needs an account: the code is the key.
//
// The board stays an ordinary local board (saved on the device, synced to OneDrive); this file
// mirrors it into the room and back.
//   Y doc:  meta     Y.Map  name, bg, pattern, created, updated, closed
//           order    Y.Array of item ids (stacking order)
//           items    Y.Map  id -> Y.Map of the item's fields (note/text "text" is a Y.Text)
//           gone     Y.Map  id -> when it was deleted (same as board.gone)
//           comments Y.Map  id -> comment
//           reactions Y.Map "target|emoji|personId" -> { on, u, name }
//           images   Y.Map  image id -> bytes
import { Y, syncProtocol, awarenessProtocol, encoding, decoding } from "../vendor/yjs.mjs";
import { mergeBoards } from "./merge.js";
import { drawInk } from "./ink-core.js";
import { bounds } from "./render.js";

const MSG_SYNC = 0, MSG_AWARENESS = 1, MSG_RELAY = 2, MSG_SYNCED = 3;
export const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PEOPLE_COLORS = ["#e8590c", "#2b8a3e", "#1971c2", "#9c36b5", "#c2255c", "#0c8599", "#d9480f", "#5f3dc4"];
const IMAGE_MAX = 700_000;          // bigger pictures stay on the device that added them
const BATCH = 300_000;              // first upload of a board goes in pieces about this big
const REMOTE = Symbol("remote");

export function newCode() {
  const r = crypto.getRandomValues(new Uint8Array(6));
  return [...r].map(b => CODE_CHARS[b % 32]).join("");
}
export function cleanCode(s) { return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }
export const validCode = c => c.length === 6 && [...c].every(ch => CODE_CHARS.includes(ch));

function roomsBase() {
  try { const o = localStorage.getItem("inkboard-rooms"); if (o) return o.replace(/\/$/, ""); } catch (_) {}
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return "ws://127.0.0.1:8790";
  return "wss://inkboard-rooms.tasklist.workers.dev";
}
export const joinLink = code => location.origin + location.pathname + "#join=" + code;

const same = (a, b) => a === b || (typeof a === "object" && a && b && JSON.stringify(a) === JSON.stringify(b));

function diffText(yt, next) {
  const old = yt.toString();
  if (old === next) return;
  let p = 0; while (p < old.length && p < next.length && old[p] === next[p]) p++;
  let s = 0; while (s < old.length - p && s < next.length - p && old[old.length - 1 - s] === next[next.length - 1 - s]) s++;
  if (old.length - p - s) yt.delete(p, old.length - p - s);
  if (next.length - p - s) yt.insert(p, next.slice(p, next.length - s));
}
// Where a caret at `pos` in `old` ends up once the text is `next`.
function moveCaret(old, next, pos) {
  let p = 0; while (p < old.length && p < next.length && old[p] === next[p]) p++;
  if (pos <= p) return pos;
  let s = 0; while (s < old.length - p && s < next.length - p && old[old.length - 1 - s] === next[next.length - 1 - s]) s++;
  if (pos >= old.length - s) return pos + next.length - old.length;
  return p + (next.length - p - s);
}

export class Session {
  // opts: { board, code, host, fresh, me, view, store, onStatus(state), onPeople(list), onMeta(),
  //         onRemote(), onEnded(reason), onEmpty(), toast }
  constructor(opts) {
    Object.assign(this, opts);
    this.doc = new Y.Doc();
    this.meta = this.doc.getMap("meta"); this.order = this.doc.getArray("order"); this.items = this.doc.getMap("items");
    this.goneY = this.doc.getMap("gone"); this.commentsY = this.doc.getMap("comments");
    this.reactionsY = this.doc.getMap("reactions"); this.imagesY = this.doc.getMap("images");
    this.aw = new awarenessProtocol.Awareness(this.doc);
    this.aw.setLocalState({ user: this.me, cursor: null, editing: null });
    this.ready = false; this.stopped = false; this.retry = 0; this.state = "connecting";
    this.dirty = new Set(); this.dirtyAll = false; this.rebuildQueued = false;
    this.live = new Map();           // id -> { stroke, by, t } strokes others are drawing right now
    this.sending = null;             // the stroke I'm drawing: { s, sent }
    this.tooBig = new Set();

    this.doc.on("update", (u, origin) => { if (origin !== REMOTE) this.send(MSG_SYNC, e => syncProtocol.writeUpdate(e, u)); });
    this.aw.on("update", ({ added, updated, removed }, origin) => {
      if (origin === REMOTE) return;
      const ids = added.concat(updated, removed);
      this.send(MSG_AWARENESS, e => encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.aw, ids)));
    });
    this.aw.on("change", () => { this.emitPeople(); this.view.requestRender(); });
    this.items.observeDeep((events, tr) => {
      if (tr.local) return;
      for (const ev of events) {
        if (ev.target === this.items) for (const k of ev.keysChanged) this.dirty.add(k);
        else if (ev.path.length) this.dirty.add(ev.path[0]);
      }
      this.queueRebuild();
    });
    for (const t of [this.order, this.goneY, this.meta, this.commentsY, this.reactionsY]) {
      t.observe((ev, tr) => { if (!tr.local) { this.dirtyAll = true; this.queueRebuild(); } });
    }
    this.imagesY.observe((ev, tr) => { if (!tr.local) for (const k of ev.keysChanged) this.saveImage(k); });
    this.ticker = setInterval(() => this.tick(), 400);
    this.onOnline = () => { if (!this.ws && !this.stopped) { clearTimeout(this.retryTimer); this.connect(); } };
    addEventListener("online", this.onOnline);
    this.connect();
  }

  // ---------- connection ----------
  setState(s) { if (this.state !== s) { this.state = s; this.onStatus && this.onStatus(s); } }
  connect() {
    if (this.stopped) return;
    this.setState(this.ready ? "reconnecting" : "connecting");
    let ws;
    try { ws = new WebSocket(`${roomsBase()}/room/${this.code}`); } catch (err) { this.scheduleRetry(); return; }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.send(MSG_SYNC, e => syncProtocol.writeSyncStep1(e, this.doc));
      this.aw.setLocalState({ ...this.aw.getLocalState() });   // announce myself again
    };
    ws.onmessage = ev => this.receive(new Uint8Array(ev.data));
    ws.onclose = ev => {
      if (this.ws !== ws) return;
      this.ws = null;
      // everyone else's cursor is stale now
      awarenessProtocol.removeAwarenessStates(this.aw, [...this.aw.getStates().keys()].filter(id => id !== this.doc.clientID), REMOTE);
      if (ev.code === 4009) { this.end("too-big"); return; }
      this.scheduleRetry();
    };
  }
  scheduleRetry() {
    if (this.stopped) return;
    this.setState("offline");
    const ms = Math.min(30000, 1000 * 2 ** this.retry++) * (0.75 + Math.random() * 0.5);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), ms);
  }
  send(type, write) {
    const ws = this.ws; if (!ws || ws.readyState !== 1) return;
    const e = encoding.createEncoder(); encoding.writeVarUint(e, type); write(e);
    ws.send(encoding.toUint8Array(e));
  }
  receive(buf) {
    const dec = decoding.createDecoder(buf), type = decoding.readVarUint(dec);
    if (type === MSG_SYNC) {
      const e = encoding.createEncoder(); encoding.writeVarUint(e, MSG_SYNC);
      syncProtocol.readSyncMessage(dec, e, this.doc, REMOTE);
      if (encoding.length(e) > 1 && this.ws) this.ws.send(encoding.toUint8Array(e));
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.aw, decoding.readVarUint8Array(dec), REMOTE);
    } else if (type === MSG_RELAY) {
      try { this.relayed(JSON.parse(decoding.readVarString(dec))); } catch (_) {}
    } else if (type === MSG_SYNCED) {
      this.setState("live");
      if (!this.ready) this.firstSync();
    }
  }
  stop() {
    if (this.stopped) return;
    this.flushLive(true);
    this.stopped = true; this.ready = false;
    clearInterval(this.ticker); clearTimeout(this.retryTimer); clearTimeout(this.liveTimer);
    removeEventListener("online", this.onOnline);
    awarenessProtocol.removeAwarenessStates(this.aw, [this.doc.clientID], "stop");
    const ws = this.ws; this.ws = null;
    if (ws) setTimeout(() => { try { ws.close(1000); } catch (_) {} }, 60);   // let the goodbye go out
    this.aw.destroy(); this.doc.destroy();
    this.live.clear();
  }
  // Host: end sharing for everyone (they keep their copies).
  closeRoom() {
    if (this.ready) this.meta.set("closed", Date.now());
    this.stop();
  }
  end(reason) { this.stop(); this.onEnded && this.onEnded(reason); }

  // ---------- first contact ----------
  firstSync() {
    const empty = !this.meta.get("created");
    if (empty && !this.host) { this.stop(); this.onEmpty && this.onEmpty(); return; }
    if (this.meta.get("closed") && !this.host) { this.end("closed"); return; }
    this.ready = true;
    for (const id of this.imagesY.keys()) this.saveImage(id, true);
    if (empty) this.uploadAll();
    else this.reconcile({ adopt: this.fresh });
    this.fresh = false;
    this.emitPeople();
  }
  // The room as a board object (the shape merge.js and the app use).
  roomBoard() {
    const ids = [], seen = new Set();
    for (const id of this.order.toArray()) if (!seen.has(id) && this.items.has(id)) { seen.add(id); ids.push(id); }
    for (const id of this.items.keys()) if (!seen.has(id)) ids.push(id);
    const m = this.meta.toJSON();
    return {
      ...this.board, name: m.name, bg: m.bg, pattern: m.pattern, created: m.created || this.board.created,
      updated: m.updated || 0, items: ids.map(id => this.itemFromY(id)), gone: this.goneY.toJSON(),
      comments: [...this.commentsY.values()], reactions: this.reactionsY.toJSON(),
    };
  }
  itemFromY(id) { return { ...this.items.get(id).toJSON(), id }; }

  // Host's first share: everything goes up, in pieces so no message is huge.
  uploadAll() {
    const b = this.board;
    this.doc.transact(() => {
      this.meta.set("created", Date.now());
      this.writeMeta();
      for (const [id, t] of Object.entries(b.gone || {})) this.goneY.set(id, t);
      for (const c of b.comments || []) this.commentsY.set(c.id, c);
      for (const [k, v] of Object.entries(b.reactions || {})) this.reactionsY.set(k, v);
    });
    let batch = [], size = 0;
    const flush = () => { if (!batch.length) return; const list = batch; batch = []; size = 0; this.doc.transact(() => { for (const it of list) this.writeItem(it); }); };
    for (const it of b.items) {
      batch.push(it); size += it.pts ? it.pts.length * 28 : 200;
      if (size > BATCH) flush();
    }
    flush();
    for (const it of b.items) if (it.t === "image") this.uploadImage(it.img);
  }

  // Bring the room and this device's copy together (after joining, reconnecting with a fresh
  // page, or OneDrive bringing in edits from another device). Per item, the latest edit wins.
  reconcile({ adopt = false } = {}) {
    if (!this.ready) return;
    const room = this.roomBoard(), local = this.board;
    const merged = adopt ? room : mergeBoards(local, room).board;
    const roomItems = new Map(room.items.map(i => [i.id, i]));
    const keep = new Set(merged.items.map(i => i.id));
    this.doc.transact(() => {
      if (!adopt) {
        // name and background: whichever side changed them last (metaU: when this device did)
        const differs = ["name", "bg", "pattern"].some(k => local[k] !== room[k]);
        if (differs && (local.metaU || 0) > (room.updated || 0)) this.writeMeta(local);
        for (const [id, t] of Object.entries(merged.gone || {})) if (this.goneY.get(id) !== t) this.goneY.set(id, t);
        for (const id of roomItems.keys()) if (!keep.has(id)) this.deleteItem(id);
        merged.items.forEach((it, i) => {
          const r = roomItems.get(it.id);
          if (!r || (it.u || 0) > (r.u || 0)) this.writeItem(it, i ? merged.items[i - 1].id : null);
        });
        for (const c of merged.comments || []) if (!same(this.commentsY.get(c.id), c)) this.commentsY.set(c.id, c);
        for (const id of this.commentsY.keys()) if (!(merged.comments || []).some(c => c.id === id)) this.commentsY.delete(id);
        for (const [k, v] of Object.entries(merged.reactions || {})) if (!same(this.reactionsY.get(k), v)) this.reactionsY.set(k, v);
      }
    });
    // and the room's view of things becomes the board's
    const old = new Map(local.items.map(i => [i.id, i]));
    const fromRoom = adopt ? room : this.roomBoard();
    local.items = fromRoom.items.map(i => { const o = old.get(i.id); return o && same(o, i) ? o : i; });
    Object.assign(local, { name: fromRoom.name, bg: fromRoom.bg, pattern: fromRoom.pattern, gone: fromRoom.gone, comments: fromRoom.comments, reactions: fromRoom.reactions });
    if (adopt) local.created = fromRoom.created;
    for (const it of local.items) if (it.t === "image" && !adopt) this.uploadImage(it.img);
    this.view.changedOutside();
    if (adopt) this.view.fit();
    this.onMeta && this.onMeta(); this.onRemote && this.onRemote();
  }

  // ---------- this device -> room ----------
  writeMeta(b = this.board) {
    for (const k of ["name", "bg", "pattern"]) if (this.meta.get(k) !== b[k]) this.meta.set(k, b[k]);
    this.meta.set("updated", Date.now());
  }
  pushMeta() {
    if (!this.ready) return;
    const b = this.board;
    if (["name", "bg", "pattern"].some(k => this.meta.get(k) !== b[k])) this.doc.transact(() => this.writeMeta());
  }
  writeItem(it, afterId) {
    let m = this.items.get(it.id);
    if (!m) {
      m = new Y.Map(); this.items.set(it.id, m);
      for (const [k, v] of Object.entries(it)) {
        if (v === undefined) continue;
        if (k === "text") { const t = new Y.Text(); m.set(k, t); if (v) t.insert(0, v); } else m.set(k, v);
      }
      const arr = this.order.toArray();
      if (!arr.includes(it.id)) {
        let at = arr.length;   // afterId: the item it goes on top of (null: bottom; undefined: top)
        if (afterId === null) at = 0;
        else if (afterId !== undefined) { const j = arr.indexOf(afterId); if (j >= 0) at = j + 1; }
        this.order.insert(at, [it.id]);
      }
      return;
    }
    for (const [k, v] of Object.entries(it)) {
      if (v === undefined) continue;
      if (k === "text") { const t = m.get("text"); if (t instanceof Y.Text) diffText(t, v || ""); else { const n = new Y.Text(); m.set("text", n); if (v) n.insert(0, v); } }
      else if (!same(m.get(k), v)) m.set(k, v);
    }
    for (const k of [...m.keys()]) if (!(k in it) || it[k] === undefined) m.delete(k);
  }
  deleteItem(id) {
    this.items.delete(id);
    const arr = this.order.toArray();
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] === id) this.order.delete(i, 1);
  }
  // BoardView.apply() -> here, for every local edit.
  pushChanges(changes) {
    if (!this.ready) return;   // the reconcile after connecting picks these up
    const items = this.board.items;
    this.doc.transact(() => {
      for (const c of changes) {
        if (c.after) {
          let afterId;
          if (!c.before) { const i = items.findIndex(x => x.id === c.after.id); afterId = i > 0 ? items[i - 1].id : i === 0 ? null : undefined; }
          this.writeItem(c.after, afterId);
          if (c.after.t === "image") this.uploadImage(c.after.img);
        } else if (c.before) {
          this.deleteItem(c.before.id);
          const t = this.board.gone && this.board.gone[c.before.id];
          if (t) this.goneY.set(c.before.id, t);
        }
      }
    });
  }
  // Typing in a note or text box, letter by letter.
  editText(it) {
    if (!this.ready) return;
    const m = this.items.get(it.id); if (!m) return;
    this.doc.transact(() => {
      const t = m.get("text");
      if (t instanceof Y.Text) diffText(t, it.text || ""); else { const n = new Y.Text(); m.set("text", n); n.insert(0, it.text || ""); }
    });
    this.aw.setLocalStateField("editing", it.id);
  }
  setComment(c) { if (this.ready) this.commentsY.set(c.id, c); }
  deleteComment(id, t) { if (this.ready) this.doc.transact(() => { this.commentsY.delete(id); this.goneY.set(id, t); }); }
  setReaction(key, v) { if (this.ready) this.reactionsY.set(key, v); }

  async uploadImage(id) {
    if (!id || this.imagesY.has(id) || this.tooBig.has(id)) return;
    const blob = await this.store.getImage(id).catch(() => null);
    if (!blob || this.stopped || this.imagesY.has(id)) return;
    if (blob.size > IMAGE_MAX) {
      this.tooBig.add(id);
      this.toast && this.toast("A picture on this board is too big to share live, so others see a placeholder.");
      return;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!this.stopped) this.imagesY.set(id, bytes);
  }
  async saveImage(id, onlyIfMissing) {
    const bytes = this.imagesY.get(id); if (!bytes) return;
    if (onlyIfMissing && await this.store.getImage(id).catch(() => null)) return;
    await this.store.putImage(id, new Blob([bytes]));
    const cur = this.view.images.get(id);
    if (cur !== undefined && typeof cur === "string") { this.view.images.delete(id); this.view.ensureImage(id); }
  }

  // ---------- room -> this device ----------
  queueRebuild() {
    if (this.rebuildQueued) return;
    this.rebuildQueued = true;
    setTimeout(() => this.rebuild(), 16);   // not rAF: background tabs must keep up too
  }
  rebuild() {
    this.rebuildQueued = false;
    if (this.stopped || !this.ready) { this.dirty.clear(); this.dirtyAll = false; return; }
    // Wait for the pen (or a drag) to finish; the board changes under nobody's hand.
    if (this.view.g) { setTimeout(() => this.queueRebuild(), 120); return; }
    const b = this.board, old = new Map(b.items.map(i => [i.id, i]));
    const ids = [], seen = new Set();
    for (const id of this.order.toArray()) if (!seen.has(id) && this.items.has(id)) { seen.add(id); ids.push(id); }
    for (const id of this.items.keys()) if (!seen.has(id)) ids.push(id);
    const editing = this.view.editing && this.view.editing.id;
    let editedText = null;
    b.items = ids.map(id => {
      const o = old.get(id);
      if (o && !this.dirty.has(id)) return o;
      const it = this.itemFromY(id);
      if (id === editing && o) editedText = [o.text || "", it.text || ""];
      return it;
    });
    for (const id of this.live.keys()) if (this.items.has(id)) this.live.delete(id);
    this.dirty.clear();
    if (this.dirtyAll) {
      this.dirtyAll = false;
      const m = this.meta.toJSON();
      for (const k of ["name", "bg", "pattern"]) if (m[k] !== undefined) b[k] = m[k];
      b.gone = this.goneY.toJSON();
      b.comments = [...this.commentsY.values()];
      b.reactions = this.reactionsY.toJSON();
      if (m.closed && !this.host) { this.end("closed"); this.view.changedOutside(); this.onRemote && this.onRemote(); return; }
      this.onMeta && this.onMeta();
    }
    // someone else typed in the box I'm editing: keep my caret where it was
    if (editedText && editedText[0] !== editedText[1]) {
      const ed = this.view.editor, [was, now] = editedText;
      const a = moveCaret(was, now, ed.selectionStart), z = moveCaret(was, now, ed.selectionEnd);
      ed.value = now; ed.setSelectionRange(a, z);
      this.view.placeEditor();
    }
    this.view.changedOutside();
    this.onRemote && this.onRemote();
  }

  // ---------- presence ----------
  people() {
    const out = new Map();
    for (const [cid, st] of this.aw.getStates()) {
      if (cid === this.doc.clientID || !st || !st.user) continue;
      if (st.user.id === this.me.id) continue;          // me in another tab
      out.set(st.user.id, { ...st.user, cid, cursor: st.cursor, editing: st.editing });
    }
    return [...out.values()];
  }
  emitPeople() { this.onPeople && this.onPeople(this.people()); }
  cursor(p) {
    if (this.stopped) return;
    this.pendingCursor = p ? [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10] : null;
    if (this.cursorTimer) return;
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = 0;
      if (!this.stopped) this.aw.setLocalStateField("cursor", this.pendingCursor);
    }, 50);
  }
  tick() {
    const st = this.aw.getLocalState(); if (!st) return;
    const editing = this.view.editing ? this.view.editing.id : null;
    if (st.editing !== editing) this.aw.setLocalStateField("editing", editing);
    // drop live strokes whose owner went quiet
    const now = performance.now();
    for (const [id, l] of this.live) if (now - l.t > 5000) { this.live.delete(id); this.view.requestRender(); }
  }

  // The stroke I'm drawing, sent a few times a second so others watch it appear.
  liveInk(stroke) {
    if (!this.ready) return;
    if (!stroke) { this.flushLive(true); return; }
    if (!this.sending || this.sending.s !== stroke) { this.flushLive(true); this.sending = { s: stroke, sent: 0 }; }
    if (!this.liveTimer) this.liveTimer = setTimeout(() => { this.liveTimer = 0; this.flushLive(false); }, 60);
  }
  flushLive(end) {
    const L = this.sending; if (!L) return;
    const s = L.s, pts = s.pts.slice(L.sent);
    if (pts.length || L.sent === 0) {
      const msg = { k: "ink", id: s.id, from: L.sent, pts };
      if (L.sent === 0) msg.s = { t: s.t, b: s.b, c: s.c, a: s.a, w: s.w, g: s.g };
      this.send(MSG_RELAY, e => encoding.writeVarString(e, JSON.stringify(msg)));
      L.sent = s.pts.length;
    }
    if (end) { this.send(MSG_RELAY, e => encoding.writeVarString(e, JSON.stringify({ k: "end", id: s.id }))); this.sending = null; clearTimeout(this.liveTimer); this.liveTimer = 0; }
  }
  relayed(m) {
    if (m.k === "ink") {
      let l = this.live.get(m.id);
      if (!l) { if (!m.s || this.items.has(m.id)) return; l = { stroke: { ...m.s, id: m.id, pts: [] } }; this.live.set(m.id, l); }
      if (m.from <= l.stroke.pts.length) l.stroke.pts.splice(m.from, l.stroke.pts.length - m.from, ...m.pts);
      l.t = performance.now();
      this.view.requestRender();
    } else if (m.k === "end") { if (this.live.delete(m.id)) this.view.requestRender(); }
  }

  // Drawn on top of the board (in board coordinates) every frame.
  draw(ctx, opts) {
    for (const { stroke } of this.live.values()) if (stroke.pts.length) drawInk(ctx, stroke, opts.minW);
    const z = opts.z, k = 1 / z;
    for (const p of this.people()) {
      if (p.editing) {
        const it = this.board.items.find(i => i.id === p.editing);
        if (it) {
          const b = bounds(it), pad = 5 * k;
          ctx.save(); ctx.strokeStyle = p.color; ctx.lineWidth = 2 * k; ctx.setLineDash([]);
          ctx.strokeRect(b.x0 - pad, b.y0 - pad, b.x1 - b.x0 + 2 * pad, b.y1 - b.y0 + 2 * pad);
          tag(ctx, p.name + " is typing", b.x0 - pad, b.y0 - pad - 22 * k, k, p.color);
          ctx.restore();
        }
      }
      if (!p.cursor) continue;
      const [x, y] = p.cursor;
      ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, 17); ctx.lineTo(4.5, 13); ctx.lineTo(8, 20.5); ctx.lineTo(10.5, 19.5); ctx.lineTo(7.2, 12.2); ctx.lineTo(13, 12); ctx.closePath();
      ctx.fillStyle = p.color; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.5; ctx.lineJoin = "round";
      ctx.fill(); ctx.stroke();
      ctx.restore();
      tag(ctx, p.name, x + 12 * k, y + 18 * k, k, p.color);
    }
  }
}

function tag(ctx, text, x, y, k, color) {
  ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
  ctx.font = "600 12px system-ui, -apple-system, 'Segoe UI', sans-serif";
  const w = ctx.measureText(text).width + 12;
  ctx.fillStyle = color;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(0, 0, w, 20, 6); else ctx.rect(0, 0, w, 20);
  ctx.fill();
  ctx.fillStyle = "#ffffff"; ctx.textBaseline = "middle"; ctx.fillText(text, 6, 10.5);
  ctx.restore();
}
