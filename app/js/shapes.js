// Shapes, and turning a hand-drawn stroke into one ("ink to shape").
//
// Shape item: { t: "shape", id, k, c: line colour, w: line width, f: fill colour or null, ... }
//   k "ellipse": cx, cy, rx, ry, rot (radians)
//   k "line" | "arrow": pts [[x, y], [x, y]]
//   anything else ("rect", "triangle", "diamond", "poly"): pts = corners, closed

export const SHAPE_KINDS = [
  ["rect", "Rectangle"], ["ellipse", "Ellipse"], ["triangle", "Triangle"], ["diamond", "Diamond"], ["line", "Line"], ["arrow", "Arrow"],
];
const isOpen = s => s.k === "line" || s.k === "arrow";

// ---------- making shapes from a drag ----------
// (x0, y0) where the drag began, (x1, y1) where it is now; square: Shift held (or a perfect shape).
export function shapeFromDrag(kind, x0, y0, x1, y1, square, style) {
  let dx = x1 - x0, dy = y1 - y0;
  if (kind === "line" || kind === "arrow") {
    if (square) {   // snap to 15° steps
      const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12), L = Math.hypot(dx, dy);
      dx = Math.cos(a) * L; dy = Math.sin(a) * L;
    }
    return { t: "shape", k: kind, pts: [[x0, y0], [x0 + dx, y0 + dy]], ...style };
  }
  if (square) { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * m; dy = Math.sign(dy || 1) * m; }
  const ax = Math.min(x0, x0 + dx), ay = Math.min(y0, y0 + dy), w = Math.abs(dx), h = Math.abs(dy);
  if (kind === "ellipse") return { t: "shape", k: "ellipse", cx: ax + w / 2, cy: ay + h / 2, rx: w / 2, ry: h / 2, rot: 0, ...style };
  const P = kind === "triangle" ? [[ax + w / 2, ay], [ax + w, ay + h], [ax, ay + h]]
    : kind === "diamond" ? [[ax + w / 2, ay], [ax + w, ay + h / 2], [ax + w / 2, ay + h], [ax, ay + h / 2]]
    : [[ax, ay], [ax + w, ay], [ax + w, ay + h], [ax, ay + h]];
  return { t: "shape", k: kind, pts: P, ...style };
}

// ---------- geometry ----------
export function shapeBounds(s) {
  const r = s.w / 2 + (s.k === "arrow" ? arrowSize(s) : 0);
  if (s.k === "ellipse") {
    const c = Math.cos(s.rot || 0), n = Math.sin(s.rot || 0);
    const hw = Math.hypot(s.rx * c, s.ry * n), hh = Math.hypot(s.rx * n, s.ry * c);
    return { x0: s.cx - hw - r, y0: s.cy - hh - r, x1: s.cx + hw + r, y1: s.cy + hh + r };
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of s.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0: x0 - r, y0: y0 - r, x1: x1 + r, y1: y1 + r };
}
function distToSeg(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / L)) : 0;
  return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
}
export function inPoly(x, y, P) {
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    if ((P[i][1] > y) !== (P[j][1] > y) && x < ((P[j][0] - P[i][0]) * (y - P[i][1])) / (P[j][1] - P[i][1]) + P[i][0]) inside = !inside;
  }
  return inside;
}
export function shapeHits(s, x, y, slop) {
  const r = s.w / 2 + slop;
  if (s.k === "ellipse") {
    const c = Math.cos(-(s.rot || 0)), n = Math.sin(-(s.rot || 0));
    const u = (x - s.cx) * c - (y - s.cy) * n, v = (x - s.cx) * n + (y - s.cy) * c;
    const d = Math.hypot(u / Math.max(s.rx, 1e-6), v / Math.max(s.ry, 1e-6));
    if (s.f && d <= 1) return true;
    return Math.abs(d - 1) * Math.min(s.rx, s.ry) <= r || (Math.min(s.rx, s.ry) < r && d <= 1 + r / Math.max(s.rx, s.ry));
  }
  const P = s.pts, n = P.length;
  for (let i = 1; i < n; i++) if (distToSeg(x, y, P[i - 1], P[i]) <= r) return true;
  if (!isOpen(s)) {
    if (distToSeg(x, y, P[n - 1], P[0]) <= r) return true;
    if (s.f && inPoly(x, y, P)) return true;
  }
  return false;
}
export function transformShape(s, f) {   // f(x, y) -> [x, y]; f.k = size factor
  const c = { ...s }, k = f.k || 1;
  if (s.k === "ellipse") { [c.cx, c.cy] = f(s.cx, s.cy); c.rx = s.rx * k; c.ry = s.ry * k; }
  else c.pts = s.pts.map(([x, y]) => f(x, y).map(v => +v.toFixed(2)));
  c.w = +(s.w * k).toFixed(3);
  return c;
}
// Points to test against a lasso.
export function shapeSamples(s) {
  if (s.k !== "ellipse") return s.pts;
  const out = [], c = Math.cos(s.rot || 0), n = Math.sin(s.rot || 0);
  for (let i = 0; i < 16; i++) {
    const a = i / 16 * Math.PI * 2, u = Math.cos(a) * s.rx, v = Math.sin(a) * s.ry;
    out.push([s.cx + u * c - v * n, s.cy + u * n + v * c]);
  }
  return out;
}

// ---------- drawing ----------
const arrowSize = s => Math.max(10, s.w * 3.5);
function fillStyle(s) { return s.f; }
export function drawShape(ctx, s, minW) {
  ctx.save();
  ctx.lineWidth = Math.max(s.w, minW); ctx.strokeStyle = s.c; ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.beginPath();
  if (s.k === "ellipse") ctx.ellipse(s.cx, s.cy, Math.max(s.rx, 0.01), Math.max(s.ry, 0.01), s.rot || 0, 0, Math.PI * 2);
  else {
    s.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (!isOpen(s)) ctx.closePath();
  }
  if (s.f && !isOpen(s)) { ctx.fillStyle = fillStyle(s); ctx.fill(); }
  ctx.stroke();
  if (s.k === "arrow") {
    const [a, b] = s.pts, ang = Math.atan2(b[1] - a[1], b[0] - a[0]), L = arrowSize(s);
    ctx.beginPath();
    ctx.moveTo(b[0] - L * Math.cos(ang - 0.45), b[1] - L * Math.sin(ang - 0.45));
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(b[0] - L * Math.cos(ang + 0.45), b[1] - L * Math.sin(ang + 0.45));
    ctx.stroke();
  }
  ctx.restore();
}

// ---------- ink to shape ----------
function resample(P, n) {
  const d = [0];
  for (let i = 1; i < P.length; i++) d.push(d[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const L = d[d.length - 1], out = [];
  let j = 1;
  for (let i = 0; i < n; i++) {
    const t = L * i / (n - 1);
    while (j < P.length - 1 && d[j] < t) j++;
    const seg = d[j] - d[j - 1] || 1, k = (t - d[j - 1]) / seg;
    out.push([P[j - 1][0] + (P[j][0] - P[j - 1][0]) * k, P[j - 1][1] + (P[j][1] - P[j - 1][1]) * k]);
  }
  return { pts: out, len: L };
}
// Douglas–Peucker on an open path: indexes of the kept points.
function dp(P, eps, a = 0, b = P.length - 1, keep = new Set([0, P.length - 1])) {
  let best = -1, bi = -1;
  for (let i = a + 1; i < b; i++) { const d = distToSeg(P[i][0], P[i][1], P[a], P[b]); if (d > best) { best = d; bi = i; } }
  if (best > eps) { keep.add(bi); dp(P, eps, a, bi, keep); dp(P, eps, bi, b, keep); }
  return keep;
}
function polyError(P, C) {
  let e = 0;
  for (const p of P) {
    let m = Infinity;
    for (let i = 0; i < C.length; i++) m = Math.min(m, distToSeg(p[0], p[1], C[i], C[(i + 1) % C.length]));
    e += m;
  }
  return e / P.length;
}
const snapAngle = (a, step, tol) => { const s = Math.round(a / step) * step; return Math.abs(a - s) < tol ? s : a; };
const DEG = Math.PI / 180;

// Find corners of a closed loop: rotate the loop to start at the point farthest from the
// centroid (always a corner on a polygon), then simplify.
function corners(P, eps) {
  const n = P.length - 1;   // last point repeats the first
  let cx = 0, cy = 0; for (let i = 0; i < n; i++) { cx += P[i][0]; cy += P[i][1]; } cx /= n; cy /= n;
  let far = 0, fd = -1;
  for (let i = 0; i < n; i++) { const d = Math.hypot(P[i][0] - cx, P[i][1] - cy); if (d > fd) { fd = d; far = i; } }
  const R = [];
  for (let i = 0; i <= n; i++) R.push(P[(far + i) % n]);
  const keep = [...dp(R, eps)].sort((a, b) => a - b).map(i => R[i]);
  keep.pop();   // the closing point
  // merge corners that ended up very close together
  const out = [];
  for (const p of keep) if (!out.length || Math.hypot(p[0] - out[out.length - 1][0], p[1] - out[out.length - 1][1]) > eps * 1.5) out.push(p);
  if (out.length > 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= eps * 1.5) out.pop();
  return out;
}

// Turn a stroke (points [[x, y, ...]]) into a shape, or null. minLen: smallest stroke (board units).
export function recognize(stroke, minLen) {
  const raw = stroke.pts;
  if (raw.length < 4) return null;
  const { pts: P, len } = resample(raw, 72);
  if (len < minLen) return null;
  const style = { c: stroke.c, w: +Math.max(1, stroke.w * 0.75).toFixed(2), f: null };
  const a = P[0], b = P[P.length - 1], gap = Math.hypot(b[0] - a[0], b[1] - a[1]);

  // Straight line: ends far apart compared with the path, and nothing strays from the chord.
  if (gap / len > 0.93) {
    let dev = 0; for (const p of P) dev = Math.max(dev, distToSeg(p[0], p[1], a, b));
    if (dev < Math.max(3, gap * 0.06)) {
      let ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      ang = snapAngle(ang, 45 * DEG, 4 * DEG);
      const L = gap;
      return { t: "shape", k: "line", pts: [[a[0], a[1]], [a[0] + Math.cos(ang) * L, a[1] + Math.sin(ang) * L]], ...style };
    }
    return null;
  }
  if (gap > len * 0.2) return null;   // an open squiggle, not a closed shape
  const loop = [...P.slice(0, -1), P[0]];

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of loop) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const diag = Math.hypot(x1 - x0, y1 - y0);
  if (diag < minLen * 0.3) return null;

  // Ellipse: principal axes of the points, size from their extent along each axis.
  let mx = 0, my = 0; for (const [x, y] of loop) { mx += x; my += y; } mx /= loop.length; my /= loop.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of loop) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
  let rot = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ellipseOf = rot => {
    const c = Math.cos(rot), n = Math.sin(rot);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of loop) { const u = x * c + y * n, v = -x * n + y * c; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2, rx = (u1 - u0) / 2, ry = (v1 - v0) / 2;
    let err = 0;
    for (const [x, y] of loop) { const u = x * c + y * n - uc, v = -x * n + y * c - vc; err += Math.abs(Math.hypot(u / rx, v / ry) - 1); }
    return { cx: uc * c - vc * n, cy: uc * n + vc * c, rx, ry, rot, err: err / loop.length };
  };
  let E = ellipseOf(rot);

  const C = corners(loop, diag * 0.07);
  const pErr = C.length >= 3 ? polyError(loop, C) / diag : Infinity;

  if ((C.length === 3 || C.length === 4) && pErr < 0.035 && E.err > 0.06) {
    if (C.length === 4) {
      // Close to a rectangle? Square it up (and level it when nearly level).
      const angs = C.map((p, i) => { const q = C[(i + 1) % 4], r = C[(i + 3) % 4];
        const v1 = [q[0] - p[0], q[1] - p[1]], v2 = [r[0] - p[0], r[1] - p[1]];
        return Math.acos((v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) || 1)); });
      if (angs.every(t => Math.abs(t - Math.PI / 2) < 14 * DEG)) {
        let o = Math.atan2(C[1][1] - C[0][1], C[1][0] - C[0][0]);
        o = ((o % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
        o = snapAngle(o, Math.PI / 2, 7 * DEG);
        const c = Math.cos(o), n = Math.sin(o);
        let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
        for (const [x, y] of C) { const u = x * c + y * n, v = -x * n + y * c; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
        // the corners are on the drawn line; the box through the mean of each side reads truer
        const pts = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => [+(u * c - v * n).toFixed(2), +(u * n + v * c).toFixed(2)]);
        return { t: "shape", k: "rect", pts, ...style };
      }
    }
    return { t: "shape", k: C.length === 3 ? "triangle" : "poly", pts: C.map(p => [+p[0].toFixed(2), +p[1].toFixed(2)]), ...style };
  }
  if (E.err < 0.075) {
    if (Math.abs(E.rx - E.ry) / Math.max(E.rx, E.ry) < 0.12) { const r = (E.rx + E.ry) / 2; E.rx = E.ry = r; E.rot = 0; }
    else {
      const s = snapAngle(E.rot, Math.PI / 2, 8 * DEG);
      if (s !== E.rot) E = ellipseOf(s);
    }
    return { t: "shape", k: "ellipse", cx: E.cx, cy: E.cy, rx: E.rx, ry: E.ry, rot: E.rot, ...style };
  }
  if (C.length >= 5 && C.length <= 6 && pErr < 0.025) return { t: "shape", k: "poly", pts: C.map(p => [+p[0].toFixed(2), +p[1].toFixed(2)]), ...style };
  return null;
}
