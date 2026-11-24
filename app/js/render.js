// Drawing board items, used by the live board, thumbnails and PNG export.
// Items (besides ink, see ink-core.js):
//   note:  { t: "note",  id, x, y, w, h, color, text, fs }
//   text:  { t: "text",  id, x, y, w, text, fs, c }
//   image: { t: "image", id, x, y, w, h, img }   (img = image id in the store)

import { drawInk } from "./ink-core.js";

export const NOTE_COLORS = {
  yellow: "#fff3a6", green: "#c9f0b4", pink: "#ffc9e1", blue: "#bfe3ff", purple: "#dccbff", orange: "#ffd5a8", gray: "#e6e6e6",
};
export const FONT = '"Segoe UI", system-ui, -apple-system, Roboto, sans-serif';
const LINE = 1.3;

// ---------- text layout ----------
const wrapCache = new WeakMap();
const measureCtx = (typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas")).getContext("2d");
export function wrapText(text, fs, maxW) {
  measureCtx.font = `${fs}px ${FONT}`;
  const out = [];
  for (const para of (text || "").split("\n")) {
    if (!para) { out.push(""); continue; }
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      const tryLine = line + word;
      if (measureCtx.measureText(tryLine).width <= maxW || !line) {
        if (measureCtx.measureText(tryLine).width > maxW && !line) {
          // a single word wider than the box: break it
          let part = "";
          for (const ch of word) {
            if (measureCtx.measureText(part + ch).width > maxW && part) { out.push(part); part = ch; } else part += ch;
          }
          line = part;
        } else line = tryLine;
      } else { out.push(line.trimEnd()); line = word.trimStart(); }
    }
    out.push(line);
  }
  return out;
}
function layoutOf(it) {
  const key = it.text + "|" + it.fs + "|" + it.w;
  const c = wrapCache.get(it);
  if (c && c.key === key) return c;
  const pad = it.t === "note" ? it.fs * 0.7 : 0;
  const lines = wrapText(it.text, it.fs, Math.max(10, it.w - 2 * pad));
  const v = { key, lines, pad, h: Math.max(1, lines.length) * it.fs * LINE };
  wrapCache.set(it, v);
  return v;
}
export const textHeight = it => layoutOf(it).h;

// ---------- bounds and hit tests ----------
const boundsCache = new WeakMap();
export function bounds(it) {
  if (it.t !== "ink") {
    const h = it.t === "text" ? Math.max(it.fs * LINE, textHeight(it)) : it.h;
    return { x0: it.x, y0: it.y, x1: it.x + it.w, y1: it.y + h };
  }
  let b = boundsCache.get(it);
  if (b) return b;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of it.pts) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }
  const r = it.w / 2;
  b = { x0: x0 - r, y0: y0 - r, x1: x1 + r, y1: y1 + r };
  boundsCache.set(it, b);
  return b;
}
export function unionBounds(items) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of items) { const b = bounds(it); x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); }
  return items.length ? { x0, y0, x1, y1 } : null;
}
function distToSeg(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / L)) : 0;
  return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
}
// Is board point (x, y) on the item, within `slop` board units?
export function hits(it, x, y, slop) {
  const b = bounds(it);
  if (x < b.x0 - slop || x > b.x1 + slop || y < b.y0 - slop || y > b.y1 + slop) return false;
  if (it.t !== "ink") return true;
  const P = it.pts, r = it.w / 2 + slop;
  if (P.length === 1) return Math.hypot(x - P[0][0], y - P[0][1]) <= r;
  for (let i = 1; i < P.length; i++) if (distToSeg(x, y, P[i - 1], P[i]) <= r) return true;
  return false;
}

// ---------- drawing ----------
export function drawBackground(ctx, { bg, pattern }, view, width, height) {
  // ctx in screen pixels (device). view: { x, y, z, dpr }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = bg || "#ffffff"; ctx.fillRect(0, 0, width, height);
  if (!pattern || pattern === "none") return;
  const k = view.z * view.dpr;
  let step = 40; while (step * k < 18) step *= 2; while (step * k > 80) step /= 2;
  const dark = luminance(bg || "#ffffff") < 0.45;
  ctx.fillStyle = ctx.strokeStyle = dark ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.13)";
  const sx = (-view.x % step) * k, sy = (-view.y % step) * k, s = step * k;
  const x0 = sx < 0 ? sx + s : sx, y0 = sy < 0 ? sy + s : sy;
  if (pattern === "dots") {
    const r = Math.max(1, 1.2 * view.dpr);
    for (let x = x0 - s; x < width + s; x += s) for (let y = y0 - s; y < height + s; y += s) ctx.fillRect(x - r / 2, y - r / 2, r, r);
  } else {
    ctx.lineWidth = Math.max(1, view.dpr * 0.75);
    ctx.beginPath();
    for (let x = x0 - s; x < width + s; x += s) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, height); }
    for (let y = y0 - s; y < height + s; y += s) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(width, Math.round(y) + 0.5); }
    ctx.stroke();
  }
}
export function luminance(hex) {
  const n = parseInt((hex || "#ffffff").slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}

// Context in board units. `opts`: { minW, images: Map, editing: id, z }
export function drawItem(ctx, it, opts) {
  if (it.t === "ink") { drawInk(ctx, it, opts.minW); return; }
  if (it.t === "note") {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.18)"; ctx.shadowBlur = 10 * (opts.z || 1) * (opts.dpr || 1); ctx.shadowOffsetY = 3 * (opts.z || 1) * (opts.dpr || 1);
    ctx.fillStyle = NOTE_COLORS[it.color] || NOTE_COLORS.yellow;
    roundRect(ctx, it.x, it.y, it.w, it.h, 4); ctx.fill();
    ctx.restore();
    if (opts.editing !== it.id) {
      const L = layoutOf(it);
      ctx.save();
      ctx.beginPath(); ctx.rect(it.x, it.y, it.w, it.h); ctx.clip();
      ctx.fillStyle = "#1b1b1f"; ctx.font = `${it.fs}px ${FONT}`; ctx.textBaseline = "top";
      L.lines.forEach((ln, i) => ctx.fillText(ln, it.x + L.pad, it.y + L.pad + i * it.fs * LINE + it.fs * 0.12));
      ctx.restore();
    }
    return;
  }
  if (it.t === "text") {
    if (opts.editing === it.id) return;
    const L = layoutOf(it);
    ctx.fillStyle = it.c || "#1b1b1f"; ctx.font = `${it.fs}px ${FONT}`; ctx.textBaseline = "top";
    L.lines.forEach((ln, i) => ctx.fillText(ln, it.x, it.y + i * it.fs * LINE + it.fs * 0.12));
    return;
  }
  if (it.t === "image") {
    const img = opts.images && opts.images.get(it.img);
    if (img && img !== "loading" && img !== "missing") ctx.drawImage(img, it.x, it.y, it.w, it.h);
    else {
      ctx.fillStyle = "rgba(127,127,127,0.15)"; ctx.fillRect(it.x, it.y, it.w, it.h);
      ctx.strokeStyle = "rgba(127,127,127,0.5)"; ctx.lineWidth = opts.minW; ctx.strokeRect(it.x, it.y, it.w, it.h);
    }
  }
}

// Draw a whole board scaled into a canvas (thumbnails, PNG export).
export function renderBoard(ctx, board, width, height, { pad = 16, images, maxZoom = 1.5 } = {}) {
  const b = unionBounds(board.items);
  let view;
  if (!b) view = { x: 0, y: 0, z: 1, dpr: 1 };
  else {
    const z = Math.min((width - 2 * pad) / Math.max(1, b.x1 - b.x0), (height - 2 * pad) / Math.max(1, b.y1 - b.y0), maxZoom);
    view = { x: b.x0 - (width / z - (b.x1 - b.x0)) / 2, y: b.y0 - (height / z - (b.y1 - b.y0)) / 2, z, dpr: 1 };
  }
  drawBackground(ctx, board, view, width, height);
  ctx.setTransform(view.z, 0, 0, view.z, -view.x * view.z, -view.y * view.z);
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (const it of board.items) drawItem(ctx, it, { minW: 0.6 / view.z, images, z: view.z });
  return view;
}
