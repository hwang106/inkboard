// node test/shapes.test.mjs — ink-to-shape on wobbly synthetic strokes.
import { recognize } from "../app/js/shapes.js";
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
const wob = (pts, a = 2) => pts.map(([x, y]) => [x + rnd() * a, y + rnd() * a, 0.5, 0]);
const poly = (C, n = 30) => { const out = []; for (let i = 0; i < C.length; i++) { const a = C[i], b = C[(i + 1) % C.length]; for (let k = 0; k < n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]); } out.push(C[0]); return out; };
const ell = (cx, cy, rx, ry, over = 1.05) => Array.from({ length: 90 }, (_, i) => { const t = i / 89 * Math.PI * 2 * over; return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)]; });
const cases = {
  circle: [ell(100, 100, 60, 60), "ellipse"],
  ellipse: [ell(100, 100, 90, 40), "ellipse"],
  "circle, short of closing": [ell(100, 100, 60, 60, 0.92), "ellipse"],
  square: [poly([[0, 0], [120, 0], [120, 120], [0, 120]]), "rect"],
  "tilted rect": [poly([[0, 0], [100, 30], [80, 100], [-20, 70]]), "rect"],
  triangle: [poly([[0, 100], [60, 0], [120, 100]]), "triangle"],
  line: [Array.from({ length: 40 }, (_, i) => [i * 5, i * 2]), "line"],
  "letter S": [Array.from({ length: 60 }, (_, i) => { const t = i / 59; return [40 * Math.sin(t * Math.PI * 2), t * 100]; }), null],
  "letter C": [ell(100, 100, 40, 50, 0.7), null],
  zigzag: [Array.from({ length: 40 }, (_, i) => [i * 5, (i % 8 < 4 ? i % 4 : 4 - (i % 4)) * 15]), null],
};
let bad = 0;
for (const [name, [pts, want]] of Object.entries(cases)) {
  const r = recognize({ pts: wob(pts), c: "#000", w: 3 }, 20);
  const got = r ? r.k : null, ok = got === want;
  if (!ok) bad++;
  console.log(ok ? "ok  " : "FAIL", name.padEnd(26), "->", got, r && r.k === "ellipse" ? `r=${r.rx.toFixed(0)},${r.ry.toFixed(0)}` : "");
}
process.exit(bad ? 1 : 0);
