// InkBoard pen rules and drawing, carried over from InkNotes (tuned on a Galaxy S25 Ultra S Pen
// and a Surface MPP pen). The difference here: the board is infinite and zooms, so everything is
// in board units (1 unit = 1 screen px at 100% zoom). Rules that are about the hand (smoothing
// radius, join distances, eraser size) stay in screen pixels and are converted with the zoom.
//
// Ink item: { t: "ink", id, b: "pen"|"highlighter"|"galaxy"|"rainbow", c: "#rrggbb", a: alpha,
//             w: width at full pressure, g: pressure curve gamma, pts: [[x, y, pressure, ms]] }

export const IS_ANDROID = /Android/i.test(navigator.userAgent);

// Rejoining strokes split by very light pressure (MPP pens dip below the contact threshold).
// Off on Android: S Pen touchdowns start light, so joining only merged separate marks.
export const JOIN = { MS: 120, LIGHT_P: 0.15, LIGHT_WINDOW_MS: 40, MIN_LEN_PX: 15, MIN_MS: 80, MAX_TURN_COS: 0.64, STEP_PX: 10, PATH_PX: 24 };
export const PALM_MS = 600;   // touch is ignored this long after any pen activity

const clamp01 = v => Math.max(0, Math.min(1, v));
export const gammaOf = curve => Math.pow(2, (curve - 50) / 30);
export const smoothPx = v => 3 * v / 100;   // Smooth slider 0–100 → radius 0–3 screen px

// Narrow width range (40–100% of size) keeps handwriting even, like a fine pen.
export function widthOf(s, p, minW = 0) {
  return Math.max(s.w * (0.4 + 0.6 * Math.pow(clamp01(p), s.g || 1)), minW);
}

// Fine smoothing on lift: Gaussian average along the line. ~1.5–2 px removes MPP jitter
// while letter curves keep their shape. Ends stay where the pen touched.
export function smoothStroke(P, sigma) {
  const n = P.length; if (n < 3 || sigma <= 0) return P;
  const s = [0];
  for (let i = 1; i < n; i++) s.push(s[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const total = s[n - 1];
  return P.map((p, i) => {
    if (i === 0 || i === n - 1) return p;
    const sg = Math.min(sigma, s[i] / 2, (total - s[i]) / 2);
    if (sg < 1e-3) return p;
    let wx = 0, wy = 0, ws = 0;
    for (let j = i; j >= 0 && s[i] - s[j] <= 3 * sg; j--) {
      const w = Math.exp(-((s[i] - s[j]) ** 2) / (2 * sg * sg)); wx += w * P[j][0]; wy += w * P[j][1]; ws += w;
    }
    for (let j = i + 1; j < n && s[j] - s[i] <= 3 * sg; j++) {
      const w = Math.exp(-((s[j] - s[i]) ** 2) / (2 * sg * sg)); wx += w * P[j][0]; wy += w * P[j][1]; ws += w;
    }
    return [wx / ws, wy / ws, p[2], p[3]];
  });
}

// ---------- brushes ----------
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
// k > 0 lightens toward white, k < 0 darkens toward black.
function shade(rgb, k) { return `rgb(${rgb.map(v => Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k))).join(",")})`; }
function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return h >>> 0; }

// Colour of segment i (galaxy shimmers, rainbow walks the hues). `arc` is length so far.
function segColor(s, arc, rgb) {
  if (s.b === "rainbow") return `hsl(${(arc * 0.9) % 360},85%,52%)`;
  if (s.b === "galaxy") return shade(rgb, 0.05 + 0.3 * Math.sin(arc / (4 * s.w + 4)));
  return s.c;
}

// One segment of a pen stroke: quadratic through the midpoints, width from pressure.
export function drawSeg(ctx, s, i, minW, arc = 0) {
  const P = s.pts, a = i === 1 ? P[0] : mid(P[i - 2], P[i - 1]), b = mid(P[i - 1], P[i]), c = P[i - 1];
  ctx.strokeStyle = s.b === "pen" || !s.b ? s.c : segColor(s, arc, hexRgb(s.c));
  ctx.lineWidth = widthOf(s, c[2], minW);
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.quadraticCurveTo(c[0], c[1], b[0], b[1]); ctx.stroke();
}
export function drawTail(ctx, s, minW) {
  const P = s.pts, n = P.length;
  ctx.strokeStyle = ctx.fillStyle = s.b === "rainbow" || s.b === "galaxy" ? segColor(s, arcLen(P), hexRgb(s.c)) : s.c;
  if (n === 1) {
    ctx.beginPath(); ctx.arc(P[0][0], P[0][1], widthOf(s, P[0][2], minW) / 2, 0, Math.PI * 2); ctx.fill(); return;
  }
  const a = mid(P[n - 2], P[n - 1]);
  ctx.lineWidth = widthOf(s, P[n - 1][2], minW);
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(P[n - 1][0], P[n - 1][1]); ctx.stroke();
}
export function arcLen(P, upto = P.length - 1) {
  let L = 0; for (let i = 1; i <= upto; i++) L += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); return L;
}

// Highlighter: one even-width path, so it doesn't darken where it overlaps itself.
function highlighterPath(ctx, s) {
  const P = s.pts;
  ctx.beginPath(); ctx.moveTo(P[0][0], P[0][1]);
  if (P.length === 1) ctx.lineTo(P[0][0] + 0.01, P[0][1]);
  for (let i = 1; i < P.length; i++) { const m = mid(P[i - 1], P[i]); ctx.quadraticCurveTo(P[i - 1][0], P[i - 1][1], m[0], m[1]); }
  if (P.length > 1) ctx.lineTo(P[P.length - 1][0], P[P.length - 1][1]);
}

// Draw a finished ink item. Context is already in board units; lineCap/lineJoin round.
export function drawInk(ctx, s, minW) {
  const P = s.pts;
  ctx.save();
  if (s.a != null && s.a < 1) ctx.globalAlpha = s.a;
  if (s.b === "highlighter") {
    ctx.globalAlpha = 0.45; ctx.globalCompositeOperation = "multiply";
    ctx.strokeStyle = s.c; ctx.lineWidth = Math.max(s.w, minW);
    highlighterPath(ctx, s); ctx.stroke(); ctx.restore(); return;
  }
  let arc = 0;
  for (let i = 1; i < P.length; i++) {
    arc += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
    drawSeg(ctx, s, i, minW, arc);
  }
  drawTail(ctx, s, minW);
  if (s.b === "galaxy") sparkles(ctx, s);
  ctx.restore();
}

// Little stars along a galaxy stroke, always in the same places for the same stroke.
function sparkles(ctx, s) {
  const P = s.pts; if (P.length < 2) return;
  let seed = hash(s.id || String(P[0][0] * 7 + P[0][1]));
  const rnd = () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822519) >>> 0) / 4294967296);
  const step = Math.max(3, s.w * 1.6);
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  let carry = 0;
  for (let i = 1; i < P.length; i++) {
    const dx = P[i][0] - P[i - 1][0], dy = P[i][1] - P[i - 1][1], d = Math.hypot(dx, dy);
    carry += d;
    while (carry >= step) {
      carry -= step;
      if (rnd() > 0.45) continue;
      const t = 1 - carry / (d || 1), w = widthOf(s, P[i][2]) * 0.35;
      const x = P[i - 1][0] + dx * t + (rnd() - 0.5) * w * 2, y = P[i - 1][1] + dy * t + (rnd() - 0.5) * w * 2;
      ctx.beginPath(); ctx.arc(x, y, Math.max(0.25, s.w * (0.06 + rnd() * 0.1)), 0, Math.PI * 2); ctx.fill();
    }
  }
}

// Live drawing while the pen moves (highlighter shows as plain segments until lift).
export function drawLiveSeg(ctx, s, i, minW, arc) {
  ctx.save();
  if (s.b === "highlighter") {
    ctx.globalAlpha = 0.45; ctx.globalCompositeOperation = "multiply";
    const P = s.pts;
    ctx.strokeStyle = s.c; ctx.lineWidth = Math.max(s.w, minW);
    ctx.beginPath(); ctx.moveTo(P[i - 1][0], P[i - 1][1]); ctx.lineTo(P[i][0], P[i][1]); ctx.stroke();
  } else drawSeg(ctx, s, i, minW, arc);
  ctx.restore();
}
