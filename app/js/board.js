// The infinite board: camera, pointer input, tools, undo, and drawing.
//
// Pen handling follows InkNotes (see ink-core.js): raw ink while writing, Gaussian smoothing on
// lift, smoothed pressure, one pointer owns a stroke, palms/touch ignored for 600 ms after pen
// activity, and MPP light-pressure dropouts rejoined (not on Android).
// Fingers pan and pinch-zoom unless "Draw with touch" is on. A mouse draws with the left button
// and pans with the middle/right button or Space.

import { JOIN, PALM_MS, IS_ANDROID, gammaOf, smoothPx, smoothStroke, drawLiveSeg, drawTail, drawInk } from "./ink-core.js";
import { bounds, unionBounds, hits, drawItem, drawBackground, textHeight, NOTE_COLORS } from "./render.js";
import { shapeFromDrag, recognize, transformShape, shapeSamples, inPoly } from "./shapes.js";
import { Guides, snapAngle } from "./guides.js";

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const ZMIN = 0.05, ZMAX = 10;
const INK_TOOLS = new Set(["pen", "highlighter", "eraser"]);
const isEraseButton = e => e.pointerType === "pen" && ((e.buttons & 2) || (e.buttons & 32) || e.button === 5);

export function cloneItem(it) {
  const c = { ...it };
  if (it.pts) c.pts = it.pts.map(q => q.slice());
  return c;
}
export function transformItem(it, f) {   // f(x, y) -> [x, y]; k = size factor
  if (it.t === "shape") return transformShape(it, f);
  const c = cloneItem(it), k = f.k || 1;
  if (it.t === "ink") { c.pts = it.pts.map(q => { const [x, y] = f(q[0], q[1]); return [+x.toFixed(2), +y.toFixed(2), q[2], q[3]]; }); c.w = +(it.w * k).toFixed(3); }
  else {
    const [x, y] = f(it.x, it.y); c.x = x; c.y = y; c.w = it.w * k;
    if (it.h != null) c.h = it.h * k;
    if (it.fs != null) c.fs = +(it.fs * k).toFixed(2);
  }
  return c;
}

export class BoardView {
  constructor({ canvas, editor, settings, images, loadImage, onChange, onSelection, onView, onToolDone, onApplied, onEditText, onPointer, onInk, onComment, drawOverlay }) {
    Object.assign(this, { canvas, editor, settings, images, loadImage, onChange, onSelection, onView, onToolDone, onApplied, onEditText, onPointer, onInk, onComment, drawOverlay });
    this.guides = new Guides();
    this.ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    this.board = null; this.view = { x: 0, y: 0, z: 1 }; this.dpr = 1; this.cssW = 1; this.cssH = 1;
    this.sel = new Set(); this.undoStack = []; this.redoStack = [];
    this.g = null; this.touches = new Map(); this.space = false;
    this.lastPenAt = -1e9; this.pEma = 0; this.t0 = 0; this.lastEnd = null; this.hoverTrail = [];
    this.editing = null; this.queued = false;
    canvas.addEventListener("pointerdown", e => this.down(e));
    canvas.addEventListener("pointermove", e => this.move(e));
    canvas.addEventListener("pointerup", e => this.up(e));
    canvas.addEventListener("pointercancel", e => this.up(e, true));
    canvas.addEventListener("lostpointercapture", e => { if (this.g && this.g.id === e.pointerId) this.up(e, true); });
    canvas.addEventListener("contextmenu", e => e.preventDefault());
    canvas.addEventListener("pointerleave", e => { if (this.onPointer && e.pointerType !== "touch" && !this.g) this.onPointer(null); });
    canvas.addEventListener("wheel", e => this.wheel(e), { passive: false });
    canvas.addEventListener("dblclick", e => {
      const [x, y] = this.toBoard(e.clientX, e.clientY), it = this.hitTop(x, y);
      if (it && (it.t === "note" || it.t === "text")) this.startEdit(it);
    });
    editor.addEventListener("input", () => this.editInput());
    editor.addEventListener("blur", () => this.endEdit());
    editor.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); editor.blur(); } e.stopPropagation(); });
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  // ---------- board and camera ----------
  load(board) {
    this.endEdit();
    this.board = board; this.sel.clear(); this.undoStack = []; this.redoStack = [];
    this.g = null; this.lastEnd = null;
    for (const it of board.items) if (it.t === "image") this.ensureImage(it.img);
    if (board.view) this.view = { ...board.view }; else this.pendingFit = true;   // fit once the canvas has a size
    this.resize();
    this.emitSel(); this.render(); if (this.onView) this.onView(this.view);
  }
  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1; this.cssW = Math.max(1, r.width); this.cssH = Math.max(1, r.height);
    const w = Math.round(this.cssW * this.dpr), h = Math.round(this.cssH * this.dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.guides.size = { w: this.cssW, h: this.cssH };
    if (this.pendingFit && r.width > 1 && r.height > 1) { this.pendingFit = false; this.fit(); }
    this.render(); this.placeEditor();
  }
  toBoard(cx, cy) {
    const r = this.canvas.getBoundingClientRect();
    return [(cx - r.left) / this.view.z + this.view.x, (cy - r.top) / this.view.z + this.view.y];
  }
  setView(x, y, z) {
    this.view = { x, y, z: Math.max(ZMIN, Math.min(ZMAX, z)) };
    if (this.board) this.board.view = { ...this.view };
    this.requestRender(); this.placeEditor();
    if (this.onView) this.onView(this.view);
  }
  zoomAt(sx, sy, factor) {   // sx, sy: CSS px inside the canvas
    const v = this.view, z = Math.max(ZMIN, Math.min(ZMAX, v.z * factor));
    const bx = sx / v.z + v.x, by = sy / v.z + v.y;
    this.setView(bx - sx / z, by - sy / z, z);
  }
  zoomBy(factor) { this.zoomAt(this.cssW / 2, this.cssH / 2, factor); }
  zoomTo(z) { this.zoomBy(z / this.view.z); }
  fit(items = this.board ? this.board.items : []) {
    const b = unionBounds(items);
    if (!b) { this.setView(-this.cssW / 2, -this.cssH / 2, 1); return; }
    const pad = 48, z = Math.max(ZMIN, Math.min(2, (this.cssW - 2 * pad) / Math.max(1, b.x1 - b.x0), (this.cssH - 2 * pad) / Math.max(1, b.y1 - b.y0)));
    this.setView((b.x0 + b.x1) / 2 - this.cssW / 2 / z, (b.y0 + b.y1) / 2 - this.cssH / 2 / z, z);
  }
  center() { return [this.view.x + this.cssW / 2 / this.view.z, this.view.y + this.cssH / 2 / this.view.z]; }

  // ---------- drawing ----------
  requestRender() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => { this.queued = false; this.render(); });
  }
  minW() { return 0.9 / this.view.z; }
  applyWorld() {
    const k = this.view.z * this.dpr;
    this.ctx.setTransform(k, 0, 0, k, -this.view.x * k, -this.view.y * k);
    this.ctx.lineCap = "round"; this.ctx.lineJoin = "round";
  }
  render() {
    if (!this.board) return;
    const { ctx, canvas, view } = this, g = this.g;
    drawBackground(ctx, this.board, { ...view, dpr: this.dpr }, canvas.width, canvas.height);
    this.applyWorld();
    const vx0 = view.x, vy0 = view.y, vx1 = view.x + this.cssW / view.z, vy1 = view.y + this.cssH / view.z;
    const opts = { minW: this.minW(), images: this.images, editing: this.editing && this.editing.id, z: view.z, dpr: this.dpr };
    const moving = g && (g.kind === "move" || g.kind === "scale") && g.started;
    for (const it of this.board.items) {
      const b = bounds(it);
      const sel = moving && this.sel.has(it.id);
      if (!sel && (b.x1 < vx0 || b.x0 > vx1 || b.y1 < vy0 || b.y0 > vy1)) continue;
      if (sel) {
        ctx.save();
        if (g.kind === "move") ctx.translate(g.dx, g.dy);
        else { ctx.translate(g.ax, g.ay); ctx.scale(g.k, g.k); ctx.translate(-g.ax, -g.ay); }
        drawItem(ctx, it, opts); ctx.restore();
      } else drawItem(ctx, it, opts);
    }
    if (g && g.kind === "ink" && g.stroke) drawInk(ctx, g.stroke, opts.minW);
    if (g && g.kind === "shape" && g.preview) drawItem(ctx, g.preview, opts);
    if (this.drawOverlay) { ctx.save(); this.drawOverlay(ctx, opts); ctx.restore(); }
    this.drawSelection();
    if (g && g.kind === "lasso" && g.pts.length > 1) {
      ctx.save();
      ctx.setLineDash([6 / view.z, 5 / view.z]); ctx.lineWidth = 1.5 / view.z; ctx.strokeStyle = "#2b59c3";
      ctx.fillStyle = "rgba(43,89,195,0.06)";
      ctx.beginPath(); g.pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath();
      ctx.fill(); ctx.stroke(); ctx.restore();
    }
    this.guides.draw(ctx, this.dpr, view.z, g && g.kind === "ink" && g.snapInfo);
  }
  selBounds() {
    if (!this.sel.size || !this.board) return null;
    let b = unionBounds(this.board.items.filter(i => this.sel.has(i.id)));
    const g = this.g;
    if (b && g && g.started) {
      if (g.kind === "move") b = { x0: b.x0 + g.dx, y0: b.y0 + g.dy, x1: b.x1 + g.dx, y1: b.y1 + g.dy };
      if (g.kind === "scale") b = { x0: g.ax, y0: g.ay, x1: g.ax + (b.x1 - g.ax) * g.k, y1: g.ay + (b.y1 - g.ay) * g.k };
    }
    return b;
  }
  drawSelection() {
    const b = this.selBounds(); if (!b) return;
    const { ctx } = this, z = this.view.z, pad = 6 / z;
    ctx.save();
    ctx.setLineDash([5 / z, 4 / z]); ctx.lineWidth = 1.5 / z; ctx.strokeStyle = "#2b59c3";
    ctx.strokeRect(b.x0 - pad, b.y0 - pad, b.x1 - b.x0 + 2 * pad, b.y1 - b.y0 + 2 * pad);
    ctx.setLineDash([]); ctx.fillStyle = "#ffffff"; ctx.lineWidth = 2 / z;
    ctx.beginPath(); ctx.arc(b.x1 + pad, b.y1 + pad, 7 / z, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  // ---------- history ----------
  // A change is { before, after } (items or null). apply() edits board.items; undo applies the
  // reverse changes in reverse order.
  // remote: changes that came from another device in a live session (not stamped or re-sent).
  apply(changes, { remote = false } = {}) {
    const items = this.board.items, now = Date.now();
    if (!remote) for (const c of changes) {
      // Edit times per item let OneDrive sync merge two devices' edits item by item.
      if (c.after) c.after.u = now;
      else if (c.before) (this.board.gone || (this.board.gone = {}))[c.before.id] = now;
    }
    for (const c of changes) {
      const id = (c.before || c.after).id;
      if (c.before && c.after) { const i = items.findIndex(x => x.id === id); if (i >= 0) items[i] = c.after; }
      else if (c.after) items.splice(c.index != null ? Math.min(c.index, items.length) : items.length, 0, c.after);
      else { const i = items.findIndex(x => x.id === id); if (i >= 0) { c.index = i; items.splice(i, 1); } }
    }
    if (!remote && this.onApplied) this.onApplied(changes);
  }
  commit(changes, { applied = false } = {}) {
    if (!changes.length) return;
    if (!applied) this.apply(changes);
    this.undoStack.push(changes); this.redoStack = [];
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.changed();
  }
  changed() {
    for (const id of [...this.sel]) if (!this.board.items.some(i => i.id === id)) this.sel.delete(id);
    this.emitSel(); this.requestRender();
    if (this.onChange) this.onChange();
  }
  undo() {
    if (this.g || !this.undoStack.length) return false;
    this.endEdit();
    const ch = this.undoStack.pop();
    this.apply(ch.slice().reverse().map(c => ({ before: c.after, after: c.before, index: c.index })));
    this.redoStack.push(ch); this.lastEnd = null; this.changed();
    return true;
  }
  redo() {
    if (this.g || !this.redoStack.length) return false;
    this.endEdit();
    const ch = this.redoStack.pop();
    this.apply(ch); this.undoStack.push(ch); this.changed();
    return true;
  }
  // The board's items were replaced from outside (OneDrive sync brought another device's edits).
  changedOutside() {
    for (const it of this.board.items) if (it.t === "image") this.ensureImage(it.img);
    for (const id of [...this.sel]) if (!this.board.items.some(i => i.id === id)) this.sel.delete(id);
    this.lastEnd = null;
    this.emitSel(); this.requestRender();
  }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  // ---------- selection ----------
  emitSel() { if (this.onSelection) this.onSelection(this.selected()); }
  selected() { return this.board ? this.board.items.filter(i => this.sel.has(i.id)) : []; }
  select(ids) { this.sel = new Set(ids); this.emitSel(); this.requestRender(); }
  selectAll() { this.select(this.board.items.map(i => i.id)); }
  clearSelection() { if (this.sel.size) this.select([]); }
  deleteSelection() {
    const items = this.selected(); if (!items.length) return;
    this.commit(items.map(i => ({ before: i, after: null })));
    this.select([]);
  }
  copySelection() { return this.selected().map(cloneItem); }
  addItems(items, { offset = 0, select = true } = {}) {
    const fresh = items.map(i => {
      const c = transformItem(i, (x, y) => [x + offset, y + offset]);
      c.id = uid(); return c;
    });
    this.commit(fresh.map(c => ({ before: null, after: c })));
    for (const c of fresh) if (c.t === "image") this.ensureImage(c.img);
    if (select) this.select(fresh.map(c => c.id));
    return fresh;
  }
  duplicateSelection() { const s = this.copySelection(); if (s.length) this.addItems(s, { offset: 24 / this.view.z }); }
  restyleSelection(fn) {   // fn(item) -> changed clone or null
    const ch = [];
    for (const it of this.selected()) { const c = fn(cloneItem(it)); if (c) ch.push({ before: it, after: c }); }
    this.commit(ch);
  }
  hitTop(x, y) {
    const slop = 6 / this.view.z, items = this.board.items;
    for (let i = items.length - 1; i >= 0; i--) if (hits(items[i], x, y, slop)) return items[i];
    return null;
  }

  // ---------- images ----------
  ensureImage(id) {
    if (!id || this.images.has(id)) return;
    this.images.set(id, "loading");
    this.loadImage(id).then(async blob => {
      if (!blob) { this.images.set(id, "missing"); return; }
      const bmp = await createImageBitmap(blob);
      this.images.set(id, bmp); this.requestRender();
    }).catch(() => this.images.set(id, "missing"));
  }

  // ---------- text editing ----------
  startEdit(it, { created = false } = {}) {
    this.endEdit();
    this.editing = { id: it.id, before: cloneItem(it), created };
    this.select([it.id]);
    const ed = this.editor;
    ed.value = it.text || "";
    ed.hidden = false; ed.dataset.kind = it.t;
    this.placeEditor();
    this.requestRender();
    ed.focus({ preventScroll: true }); ed.setSelectionRange(ed.value.length, ed.value.length);
  }
  editingItem() { return this.editing && this.board.items.find(i => i.id === this.editing.id); }
  placeEditor() {
    const it = this.editing && this.editingItem(), ed = this.editor;
    if (!it) return;
    const z = this.view.z, pad = it.t === "note" ? it.fs * 0.7 * z : 0;
    Object.assign(ed.style, {
      left: (it.x - this.view.x) * z + "px", top: (it.y - this.view.y) * z + "px",
      width: it.w * z + "px", height: (it.t === "note" ? it.h : Math.max(it.fs * 1.3, textHeight(it)) + it.fs * 0.4) * z + "px",
      fontSize: it.fs * z + "px", padding: pad + "px", color: it.t === "text" ? (it.c || "#1b1b1f") : "#1b1b1f",
    });
  }
  editInput() {
    const it = this.editingItem(); if (!it) return;
    it.text = this.editor.value;
    this.placeEditor(); this.requestRender();
    if (this.onEditText) this.onEditText(it);
  }
  endEdit() {
    const e = this.editing; if (!e) return;
    this.editing = null;
    const ed = this.editor; ed.hidden = true;
    if (document.activeElement === ed) ed.blur();
    const it = this.board && this.board.items.find(i => i.id === e.id);
    if (!it) return;
    const text = (it.text || "").replace(/\s+$/, "");
    it.text = text;
    if (it.t === "text" && !text.trim()) {
      // An empty text box goes away; one just made leaves no trace in undo.
      const top = this.undoStack[this.undoStack.length - 1];
      if (e.created && top && top.length === 1 && top[0].after === it) { this.undoStack.pop(); this.apply([{ before: it, after: null }]); this.changed(); }
      else this.commit([{ before: it, after: null }]);
      return;
    }
    if (text !== (e.before.text || "")) {
      // The item was edited in place; record it as before -> a fresh copy.
      const after = cloneItem(it), i = this.board.items.indexOf(it);
      this.board.items[i] = e.before;
      this.commit([{ before: e.before, after }]);
    } else this.requestRender();
  }

  // ---------- pointer input ----------
  down(e) {
    if (!this.board) return;
    const t = e.pointerType, set = this.settings();
    if (t === "pen") {
      this.lastPenAt = e.timeStamp;
      // A palm or finger gesture that started just before the pen: drop it.
      if (this.g && this.g.type !== "pen") this.cancelGesture();
    }
    const r = this.canvas.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (t === "touch") {
      if (this.g && this.g.type === "pen") return;                       // palms never act while the pen writes
      if (e.timeStamp - this.lastPenAt < PALM_MS) { e.preventDefault(); return; }
      this.touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (this.g && this.g.kind === "guide") {   // a second finger on the ruler: rotate it
        this.g.ptrs.set(e.pointerId, [sx, sy]); this.g.base = this.guideBase();
        try { this.canvas.setPointerCapture(e.pointerId); } catch (_) {}
        return;
      }
      if (this.touches.size >= 2) { this.startPinch(); return; }
    }
    if (this.g) return;   // one pointer owns the board at a time
    if (this.editing) this.endEdit();
    e.preventDefault();
    try { this.canvas.setPointerCapture(e.pointerId); } catch (_) {}
    const [x, y] = this.toBoard(e.clientX, e.clientY);
    const base = { id: e.pointerId, type: t, sx: e.clientX, sy: e.clientY, x, y, t0: e.timeStamp };
    // Fingers and the mouse move the ruler/protractor; the pen draws along them.
    const onGuide = t !== "pen" && !isEraseButton(e) && this.guides.hit(sx, sy);
    if (onGuide && !(t === "mouse" && e.button !== 0)) {
      this.g = { ...base, kind: "guide", which: onGuide, ptrs: new Map([[e.pointerId, [sx, sy]]]) };
      this.g.base = this.guideBase();
      return;
    }
    let tool = set.tool;
    if (t === "mouse" && (e.button === 1 || e.button === 2 || this.space)) tool = "hand";
    else if (t === "touch" && !set.touchInk && INK_TOOLS.has(tool)) tool = "hand";
    if (isEraseButton(e)) tool = "eraser";

    if (tool === "hand") { this.g = { ...base, kind: "pan", v0: { ...this.view } }; return; }
    if (tool === "eraser") { this.g = { ...base, kind: "erase", removed: [], last: [x, y] }; this.eraseAt(x, y, x, y); return; }
    if (tool === "pen" || tool === "highlighter") { this.startInk(e, base, x, y, tool); return; }
    if (tool === "note" || tool === "text" || tool === "comment") { this.g = { ...base, kind: "place", tool }; return; }
    if (tool === "shape") { this.g = { ...base, kind: "shape", preview: null }; return; }
    // select
    const sb = this.selBounds(), z = this.view.z;
    if (sb && Math.hypot(x - (sb.x1 + 6 / z), y - (sb.y1 + 6 / z)) < (t === "touch" ? 22 : 14) / z) {
      this.g = { ...base, kind: "scale", ax: sb.x0, ay: sb.y0, d0: Math.hypot(sb.x1 - sb.x0, sb.y1 - sb.y0) || 1, k: 1, started: false };
      return;
    }
    const hit = this.hitTop(x, y);
    const inSel = sb && x >= sb.x0 && x <= sb.x1 && y >= sb.y0 && y <= sb.y1 && this.sel.size > 1;
    if (hit || inSel) {
      const wasSelected = hit ? this.sel.has(hit.id) : true;
      if (hit && !wasSelected) this.select(e.shiftKey ? [...this.sel, hit.id] : [hit.id]);
      this.g = { ...base, kind: "move", dx: 0, dy: 0, started: false, hit, wasSelected };
      return;
    }
    if (!e.shiftKey) this.clearSelection();
    this.g = t === "touch" ? { ...base, kind: "pan", v0: { ...this.view } } : { ...base, kind: "lasso", pts: [[x, y]], add: e.shiftKey };
  }

  move(e) {
    if (e.pointerType === "pen") this.lastPenAt = e.timeStamp;
    if (e.pointerType === "touch" && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (this.g && this.g.kind === "pinch") { this.pinchMove(); return; }
    }
    const g = this.g;
    if (g && g.kind === "guide" && g.ptrs.has(e.pointerId)) {
      const r = this.canvas.getBoundingClientRect();
      g.ptrs.set(e.pointerId, [e.clientX - r.left, e.clientY - r.top]);
      this.guideMove(); return;
    }
    if (this.onPointer && e.pointerType !== "touch") this.onPointer(this.toBoard(e.clientX, e.clientY));
    if (!g) {
      // Pen hovering just after a light lift: keep the path for rejoining.
      if (this.lastEnd && e.pointerType === "pen" && !e.buttons) {
        const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const ev of evs.length ? evs : [e]) {
          if (ev.timeStamp - this.lastEnd.t > JOIN.MS) break;
          const [hx, hy] = this.toBoard(ev.clientX, ev.clientY); this.hoverTrail.push([hx, hy, ev.timeStamp]);
        }
      }
      return;
    }
    if (e.pointerId !== g.id) return;   // palms and other fingers
    const z = this.view.z;
    if (g.kind === "ink" || g.kind === "erase" || g.kind === "lasso") {
      let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      if (!evs.length) evs = [e];
      for (const ev of evs) {
        const [x, y] = g.snap ? this.snapped(g, ev) : this.toBoard(ev.clientX, ev.clientY);
        if (g.kind === "ink") this.addPoint(x, y, this.pressureOf(ev), ev.timeStamp);
        else if (g.kind === "erase") { this.eraseAt(g.last[0], g.last[1], x, y); g.last = [x, y]; }
        else { const l = g.pts[g.pts.length - 1]; if (Math.hypot(x - l[0], y - l[1]) * z > 3) g.pts.push([x, y]); }
      }
      if (g.kind === "lasso" || (g.kind === "ink" && g.snapInfo)) this.requestRender();
      return;
    }
    if (g.kind === "shape") {
      const [x, y] = this.toBoard(e.clientX, e.clientY);
      if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 3) return;
      const sh = this.settings().shape;
      g.preview = shapeFromDrag(sh.k, g.x, g.y, x, y, e.shiftKey, this.shapeStyle());
      this.requestRender(); return;
    }
    if (g.kind === "pan") {
      this.setView(g.v0.x - (e.clientX - g.sx) / g.v0.z, g.v0.y - (e.clientY - g.sy) / g.v0.z, g.v0.z);
      return;
    }
    const [x, y] = this.toBoard(e.clientX, e.clientY);
    if (!g.started && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > (e.pointerType === "touch" ? 8 : 4)) g.started = true;
    if (!g.started) return;
    if (g.kind === "move") { g.dx = x - g.x; g.dy = y - g.y; this.requestRender(); }
    else if (g.kind === "scale") {
      g.k = Math.max(0.05, Math.hypot(x - g.ax, y - g.ay) / (Math.hypot(g.x - g.ax, g.y - g.ay) || 1));
      this.requestRender();
    }
  }

  up(e, cancelled = false) {
    if (e.pointerType === "touch") {
      this.touches.delete(e.pointerId);
      if (this.g && this.g.kind === "pinch") { if (this.touches.size < 2) this.g = null; return; }
    }
    if (e.pointerType === "pen") this.lastPenAt = e.timeStamp;
    const g = this.g;
    if (g && g.kind === "guide" && g.ptrs.has(e.pointerId)) {
      g.ptrs.delete(e.pointerId);
      if (!g.ptrs.size) this.g = null; else g.base = this.guideBase();
      this.requestRender(); return;
    }
    if (!g || e.pointerId !== g.id) return;
    this.g = null;
    if (cancelled && g.kind === "ink") { if (this.onInk) this.onInk(null); this.requestRender(); return; }
    const [x, y] = this.toBoard(e.clientX, e.clientY);
    if (g.kind === "ink") { this.finishInk(e, g); if (this.onInk) this.onInk(null); }   // after the commit, so others never see a gap
    else if (g.kind === "erase") { if (g.removed.length) this.commit(g.removed, { applied: true }); }
    else if (g.kind === "lasso") this.finishLasso(g);
    else if (g.kind === "move") {
      if (g.started && (g.dx || g.dy)) {
        this.commit(this.selected().map(it => ({ before: it, after: transformItem(it, (px, py) => [px + g.dx, py + g.dy]) })));
      } else if (!g.started && g.hit && g.wasSelected && this.sel.size === 1 && (g.hit.t === "note" || g.hit.t === "text")) {
        this.startEdit(g.hit);
      }
      this.requestRender();
    } else if (g.kind === "scale") {
      if (g.started && g.k !== 1) {
        const f = (px, py) => [g.ax + (px - g.ax) * g.k, g.ay + (py - g.ay) * g.k]; f.k = g.k;
        this.commit(this.selected().map(it => ({ before: it, after: transformItem(it, f) })));
      }
      this.requestRender();
    } else if (g.kind === "shape") {
      if (g.preview && !cancelled) {
        const b = bounds(g.preview);
        if ((b.x1 - b.x0) * this.view.z > 6 || (b.y1 - b.y0) * this.view.z > 6) this.commit([{ before: null, after: { ...g.preview, id: uid() } }]);
      }
      this.requestRender();
    } else if (g.kind === "place" && !cancelled && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 12) {
      this.placeItem(g.tool, x, y);
    }
  }

  cancelGesture() {
    const g = this.g; if (!g) return;
    this.g = null;
    if (g.kind === "ink" && this.onInk) this.onInk(null);
    if (g.kind === "erase" && g.removed.length) this.commit(g.removed, { applied: true });
    try { this.canvas.releasePointerCapture(g.id); } catch (_) {}
    this.requestRender();
  }

  startPinch() {
    const prev = this.g;
    if (prev && prev.type === "touch") this.cancelGesture();
    else if (prev) return;   // the pen or mouse has the board
    const [a, b] = [...this.touches.values()];
    this.g = { kind: "pinch", type: "touch", id: -1, d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, m0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], v0: { ...this.view } };
  }
  pinchMove() {
    const g = this.g, [a, b] = [...this.touches.values()];
    if (!a || !b) return;
    const r = this.canvas.getBoundingClientRect();
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const z = Math.max(ZMIN, Math.min(ZMAX, g.v0.z * d / g.d0));
    const bx = (g.m0[0] - r.left) / g.v0.z + g.v0.x, by = (g.m0[1] - r.top) / g.v0.z + g.v0.y;
    this.setView(bx - (m[0] - r.left) / z, by - (m[1] - r.top) / z, z);
  }
  wheel(e) {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const onGuide = !e.ctrlKey && this.guides.hit(e.clientX - r.left, e.clientY - r.top);
    if (onGuide) { this.guides.rotate(onGuide, Math.sign(e.deltaY) * (e.shiftKey ? 15 : 1) * Math.PI / 180); this.requestRender(); return; }
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.cssH : 1;
    if (e.ctrlKey || e.metaKey) this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * unit * 0.0025));
    else {
      const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit, dy = (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * unit;
      this.setView(this.view.x + dx / this.view.z, this.view.y + dy / this.view.z, this.view.z);
    }
  }

  // ---------- ink ----------
  pressureOf(e) {
    if (e.pointerType === "mouse") return 0.5;
    if (e.pressure === 0 && e.buttons) return 0.5;
    return e.pressure;
  }
  startInk(e, base, x, y, tool) {
    const set = this.settings(), p = this.pressureOf(e);
    this.g = { ...base, kind: "ink" };
    if (tool === "pen" && this.resume(e, x, y, p)) return;
    this.t0 = e.timeStamp; this.pEma = p;
    const pen = tool === "highlighter" ? set.highlighter : set.pen;
    this.g.stroke = {
      t: "ink", id: uid(), b: tool === "highlighter" ? "highlighter" : pen.brush || "pen", c: pen.color, a: 1,
      w: +pen.size.toFixed(3), g: +gammaOf(set.curve).toFixed(3), pts: [[x, y, p, 0]],
    };
    // On or next to the ruler/protractor: the stroke follows its edge.
    if (this.guides.any) {
      const r = this.canvas.getBoundingClientRect();
      const snap = this.guides.snapFor(e.clientX - r.left, e.clientY - r.top, pen.size * this.view.z / 2);
      if (snap) {
        this.g.snap = snap;
        if (snap.kind === "arc") this.g.snapInfo = { kind: "arc", guide: snap.guide, startAng: snap.startAng, now: snap.startAng };
        const [sx, sy] = this.snapped(this.g, e);
        this.g.stroke.pts[0][0] = sx; this.g.stroke.pts[0][1] = sy;
      }
    }
    if (this.g.stroke.b === "highlighter") this.requestRender();
  }
  addPoint(x, y, p, ts) {
    const s = this.g.stroke;
    this.pEma += 0.35 * (p - this.pEma);   // smooth pressure so width doesn't jump
    const P = s.pts, q = P[P.length - 1], z = this.view.z;
    if (((x - q[0]) ** 2 + (y - q[1]) ** 2) * z * z < 0.25) return;
    P.push([x, y, this.pEma, Math.round(ts - this.t0)]);
    if (this.onInk) this.onInk(s);
    if (s.b === "highlighter") { this.requestRender(); return; }
    this.g.arc = (this.g.arc || 0) + Math.hypot(x - q[0], y - q[1]);
    if (this.queued) return;   // a full redraw is coming and will include this point
    this.applyWorld();
    drawLiveSeg(this.ctx, s, P.length - 1, this.minW(), this.g.arc);
  }
  finishInk(e, g) {
    const a = g.stroke; if (!a) return;
    const set = this.settings(), z = this.view.z;
    if (a.b !== "highlighter" && !this.queued) { this.applyWorld(); drawTail(this.ctx, a, this.minW()); }
    // How light was the ending, and was this a real line? (decides rejoining)
    const R = a.pts, tEnd = R[R.length - 1][3];
    let endP = 0, lenPx = 0;
    for (let i = R.length - 1; i >= 0 && R[i][3] >= tEnd - JOIN.LIGHT_WINDOW_MS; i--) endP = Math.max(endP, R[i][2]);
    for (let i = 1; i < R.length; i++) lenPx += Math.hypot(R[i][0] - R[i - 1][0], R[i][1] - R[i - 1][1]);
    lenPx *= z;
    if (set.smooth > 0 && a.b !== "highlighter" && !g.snap) a.pts = smoothStroke(a.pts, smoothPx(set.smooth) / z);
    a.pts = a.pts.map(q => [+q[0].toFixed(2), +q[1].toFixed(2), +q[2].toFixed(3), q[3]]);
    // Ink to shape: a stroke that looks like a shape becomes one.
    const shape = set.inkToShape && !g.snap && a.b === "pen" && !g.resumed ? recognize(a, 24 / z) : null;
    if (shape) { shape.id = a.id; this.commit([{ before: null, after: shape }]); this.lastEnd = null; this.hoverTrail = []; return; }
    this.commit([{ before: null, after: a }]);
    const isLine = !g.snap && lenPx >= JOIN.MIN_LEN_PX && tEnd >= JOIN.MIN_MS;
    this.lastEnd = !IS_ANDROID && isLine && e.pointerType === "pen" && a.b !== "highlighter" && endP <= JOIN.LIGHT_P
      ? { s: a, t: e.timeStamp, t0: this.t0 } : null;
    this.hoverTrail = [];
  }
  // Continue the previous stroke if this touchdown is really a light-pressure dropout.
  resume(e, x, y, p) {
    const L = this.lastEnd; this.lastEnd = null;
    const items = this.board.items;
    if (!L || e.pointerType !== "pen" || L.s !== items[items.length - 1]) return false;
    if (e.timeStamp - L.t > JOIN.MS || p > JOIN.LIGHT_P) return false;
    const q = L.s.pts[L.s.pts.length - 1], ppu = this.view.z;
    const chain = [[q[0], q[1]], ...this.hoverTrail, [x, y]];
    let len = 0;
    for (let i = 1; i < chain.length; i++) {
      const d = Math.hypot(chain[i][0] - chain[i - 1][0], chain[i][1] - chain[i - 1][1]) * ppu;
      if (d > JOIN.STEP_PX) return false;
      len += d;
    }
    if (len > JOIN.PATH_PX) return false;
    if (Math.hypot(x - q[0], y - q[1]) * ppu > 3) {
      const P = L.s.pts; let j = P.length - 1;
      while (j > 0 && Math.hypot(q[0] - P[j][0], q[1] - P[j][1]) * ppu < 10) j--;
      const ex = q[0] - P[j][0], ey = q[1] - P[j][1], bx = x - q[0], by = y - q[1];
      if ((ex * bx + ey * by) / ((Math.hypot(ex, ey) * Math.hypot(bx, by)) || 1) < JOIN.MAX_TURN_COS) return false;
    }
    items.pop();
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && top.length === 1 && top[0].after === L.s) this.undoStack.pop();
    this.g.stroke = L.s; this.g.resumed = true; this.t0 = L.t0; this.pEma = p;
    this.render();
    for (const [hx, hy, ht] of this.hoverTrail) this.addPoint(hx, hy, 0, ht);
    this.addPoint(x, y, p, e.timeStamp);
    this.hoverTrail = [];
    return true;
  }

  // Stroke eraser: removes whole ink strokes it touches (sampled along the eraser's path).
  eraseAt(x0, y0, x1, y1) {
    const g = this.g, r = 10 / this.view.z, items = this.board.items;
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (r * 0.7)));
    const found = [];
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]; if (it.t !== "ink" && it.t !== "shape") continue;
      for (let k = 0; k <= steps; k++) {
        const x = x0 + (x1 - x0) * k / steps, y = y0 + (y1 - y0) * k / steps;
        if (hits(it, x, y, r)) { found.push(it); break; }
      }
    }
    if (!found.length) return;
    const ch = found.map(it => ({ before: it, after: null }));
    this.apply(ch); g.removed.push(...ch);
    this.lastEnd = null; this.requestRender();
  }

  finishLasso(g) {
    const P = g.pts, z = this.view.z;
    let len = 0; for (let i = 1; i < P.length; i++) len += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
    if (len * z < 12) { this.requestRender(); return; }
    const picked = this.board.items.filter(it => {
      if (it.t === "ink") {
        const step = Math.max(1, Math.floor(it.pts.length / 40));
        let n = 0, inside = 0;
        for (let i = 0; i < it.pts.length; i += step) { n++; if (inPoly(it.pts[i][0], it.pts[i][1], P)) inside++; }
        return inside / n >= 0.5;
      }
      if (it.t === "shape") { const S = shapeSamples(it); return S.filter(q => inPoly(q[0], q[1], P)).length / S.length >= 0.5; }
      const b = bounds(it);
      return inPoly((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, P);
    }).map(i => i.id);
    this.select(g.add ? [...this.sel, ...picked] : picked);
  }

  shapeStyle() {
    const sh = this.settings().shape;
    return { c: sh.color, w: sh.size, f: sh.fill ? sh.color + "33" : null };
  }
  // Pointer event -> board point, pulled onto the guide edge this stroke follows.
  snapped(g, ev) {
    const r = this.canvas.getBoundingClientRect(), sx = ev.clientX - r.left, sy = ev.clientY - r.top;
    const [px, py] = g.snap.snap(sx, sy);
    if (g.snapInfo && g.snap.readout) g.snapInfo.now = g.snap.readout(sx, sy);
    return [px / this.view.z + this.view.x, py / this.view.z + this.view.y];
  }
  guideBase() {
    const g = this.g, gd = this.guides[g.which], P = [...g.ptrs.values()];
    return { gx: gd.x, gy: gd.y, ga: gd.a, P: P.map(q => q.slice()) };
  }
  guideMove() {
    const g = this.g, gd = this.guides[g.which], b = g.base, P = [...g.ptrs.values()];
    if (P.length === 1 || b.P.length === 1) {
      gd.x = b.gx + P[0][0] - b.P[0][0]; gd.y = b.gy + P[0][1] - b.P[0][1];
    } else {
      const m0 = [(b.P[0][0] + b.P[1][0]) / 2, (b.P[0][1] + b.P[1][1]) / 2], m1 = [(P[0][0] + P[1][0]) / 2, (P[0][1] + P[1][1]) / 2];
      const da = Math.atan2(P[1][1] - P[0][1], P[1][0] - P[0][0]) - Math.atan2(b.P[1][1] - b.P[0][1], b.P[1][0] - b.P[0][0]);
      // turn the guide around the starting midpoint, then follow the midpoint
      const c = Math.cos(da), s = Math.sin(da), dx = b.gx - m0[0], dy = b.gy - m0[1];
      gd.x = m1[0] + dx * c - dy * s; gd.y = m1[1] + dx * s + dy * c;
      gd.a = snapAngle(b.ga + da);
    }
    this.requestRender();
  }
  toggleGuide(kind) { const on = this.guides.toggle(kind); this.requestRender(); return on; }

  placeItem(tool, x, y) {
    if (tool === "comment") { if (this.onToolDone) this.onToolDone(); if (this.onComment) this.onComment(x, y); return; }
    const set = this.settings();
    let it;
    if (tool === "note") it = { t: "note", id: uid(), x: x - 110, y: y - 110, w: 220, h: 220, color: set.noteColor in NOTE_COLORS ? set.noteColor : "yellow", text: "", fs: 22 };
    else it = { t: "text", id: uid(), x, y: y - 16, w: 360, text: "", fs: 28, c: set.pen.color };
    this.commit([{ before: null, after: it }]);
    if (this.onToolDone) this.onToolDone();
    this.startEdit(it, { created: true });
  }
}
