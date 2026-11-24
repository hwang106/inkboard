// node test/import.test.mjs <file.whiteboard>...   Reads boards and prints what was imported.
import { readFileSync } from "node:fs";
import { importWhiteboard } from "../app/js/whiteboard-import.js";
let fail = 0;
for (const f of process.argv.slice(2)) {
  const t = Date.now();
  try {
    const r = importWhiteboard(readFileSync(f));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0, pmax = 0;
    for (const s of r.items) for (const q of s.pts) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); n++; pmax = Math.max(pmax, q[2]); }
    const colors = {}; for (const s of r.items) colors[s.b + " " + s.c] = (colors[s.b + " " + s.c] || 0) + 1;
    console.log(f, `${Date.now() - t} ms`, { strokes: r.strokeCount, points: n, pmax, bbox: [x0, y0, x1, y1].map(Math.round), bg: r.background, notImported: r.notImported, colors });
    if (!r.strokeCount) fail++;
  } catch (e) { console.log(f, "FAILED", e); fail++; }
}
process.exit(fail ? 1 : 0);
