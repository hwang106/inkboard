// Reads Microsoft Whiteboard (.whiteboard) files into InkBoard items.
//
// What's inside a .whiteboard file (worked out from real boards, Nov 2026):
// - A binary container ("Microsoft.Prague", the old name of Microsoft's Fluid Framework) holding
//   gzip-compressed blobs: Fluid protocol data, op logs, and the board's summary.
// - The board itself is a legacy Fluid SharedTree summary, format 0.1.1:
//     { editHistory: { editChunks: [{ startRevision, chunk: [edit...] }] }, internedStrings, ... }
//   Whiteboard squashes history, so there is normally one edit that builds the whole tree
//   (a CompressedBuild change, then an Insert under the root). Other edits are replayed too.
// - Compressed nodes are arrays: [definition, identifier?, [payload]?, traits?] where definition
//   and trait labels index internedStrings (GUIDs), the identifier is omitted when it is the
//   previous one + 1, the payload is wrapped in a one-item array, and traits alternate
//   label, [children...].
// - Ink stroke points are a base64 blob of 16-byte big-endian records:
//   int32 x, int32 y (both × the stroke's scale, 1/128), int32 time in ms, float32 pressure 0–1.
//
// The schema GUIDs below name the parts we know. Anything else is counted as "not imported" so
// the person can see what was left out.

import { gunzipAt } from "./inflate.js";

const G = {
  // board
  ITEMS: "4c817bcf-4947-42fe-9596-5f997a251e28",
  SETTINGS: "baad3421-a44a-428b-bc1c-dee494937d2c",
  BG_COLOR: "aaf68956-6a34-431d-ac2a-15c38ca42523",
  // item (every object on the board)
  ITEM_INK: "bed7996a-2373-431e-bfad-00c81476ea30",
  ITEM_SCALE: "1e37d039-8954-480f-b3ef-f108d912159f",
  ITEM_CONTENT: "3e029a25-a671-459d-a63b-61ff015f3a5a",
  ITEM_ANCHOR: "4b3f84e2-9dca-46f8-820a-f811a2192764",
  ITEM_POS: "b4357ff6-6b4d-45cc-a7c2-7a8713bdbbc7",
  ITEM_ROTATION: "f9bdf754-ccb4-4619-bd7b-e35d79795029",
  // ink content
  STROKES: "5e6694f7-7269-430c-a714-5230e59ee5e9",
  // stroke
  STROKE_OFFSET: "2bfb0045-5cfe-45b8-b78a-1cebcc0e9942",
  STROKE_SIZE: "4f1980cb-3bda-4776-92f3-eac924fe69fa",
  SIZE_VALUE: "8ff51ca7-b64e-451e-a2c1-c6c887c26442",
  BRUSH: "52fe991e-8d68-4deb-95ff-d941d8e71bc1",
  BRUSH_KIND: "329eb598-ab0c-4920-93e6-d14af4f7b054",
  BRUSH_COLOR: "bc87b0fb-ea75-4ee2-80d6-a0e1f9b7dded",
  R: "0033d87c-9fef-4834-b670-9e8ce93d15fb",
  G: "57bf2883-0707-45fd-9e4a-b42375e52504",
  B: "f00a50ec-9987-43bb-82b7-4e7d7870087a",
  A: "75580d8b-cd96-4b84-afc4-705a9978e53b",
  POINTS: "81d2b267-2cb4-463a-9e4c-8f93942f9252",
  POINT_DATA: "1afc45c2-ec52-4245-8a13-aab35de7fc27",
  POINT_OFFSET: "2a7e8476-35c3-4d4e-b61c-9e05974d5d66",
  POINT_SCALE: "7cca656a-ad10-4d47-8dc3-976e24672c7e",
  // a 2-D point
  X: "2f1e094b-d5ef-4074-ac29-a8f0b1bc3ecb",
  Y: "2f1e094b-d5ef-4074-ac29-a8f0b1bc3ecc",
};

// Whiteboard draws a size-1 pen about this many board units wide at full pressure.
// (Estimated: the sample boards only used one pen size.)
const WB_PEN_UNITS = 2.2;

// ---------- finding the summary inside the container ----------
const td = new TextDecoder("utf-8", { fatal: false });

function* gzipBlobs(bytes) {
  for (let i = 0; i < bytes.length - 3; i++) {
    if (bytes[i] !== 0x1f || bytes[i + 1] !== 0x8b || bytes[i + 2] !== 8) continue;
    let r;
    try { r = gunzipAt(bytes, i); } catch (_) { continue; }
    yield r.data;
    i = r.end - 1;
  }
}

// A JSON object written straight into the file (not compressed), starting at `start`.
function rawJSONAt(bytes, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < bytes.length; i++) {
    const c = bytes[i];
    if (inStr) {
      if (esc) esc = false; else if (c === 0x5c) esc = true; else if (c === 0x22) inStr = false;
    } else if (c === 0x22) inStr = true;
    else if (c === 0x7b || c === 0x5b) depth++;
    else if (c === 0x7d || c === 0x5d) { if (--depth === 0) return td.decode(bytes.subarray(start, i + 1)); }
  }
  return null;
}

function findSummaries(bytes) {
  const found = [];
  const MARK = '{"editHistory"';
  for (const data of gzipBlobs(bytes)) {
    if (data.length < MARK.length) continue;
    const head = td.decode(data.subarray(0, 64));
    if (!head.startsWith(MARK)) continue;
    try { found.push(JSON.parse(td.decode(data))); } catch (_) {}
  }
  if (!found.length) {
    const mark = new TextEncoder().encode(MARK);
    outer: for (let i = 0; i <= bytes.length - mark.length; i++) {
      for (let k = 0; k < mark.length; k++) if (bytes[i + k] !== mark[k]) continue outer;
      const s = rawJSONAt(bytes, i);
      if (s) try { found.push(JSON.parse(s)); } catch (_) {}
    }
  }
  return found;
}

// ---------- legacy SharedTree ----------
function decodeCompressed(arr, strings, state) {
  const label = v => (typeof v === "number" ? strings[v] : v);
  const node = a => {
    let i = 1, id;
    if (typeof a[i] === "number") { id = a[i++]; state.lastId = id; }
    else id = ++state.lastId;
    let payload, traits;
    for (; i < a.length; i++) {
      const r = a[i];
      if (Array.isArray(r) && r.length === 1 && payload === undefined && traits === undefined) payload = r[0];
      else traits = r;
    }
    const n = { def: label(a[0]), id, payload, traits: new Map() };
    if (traits) for (let k = 0; k < traits.length; k += 2) n.traits.set(label(traits[k]), traits[k + 1].map(node));
    return n;
  };
  return arr.map(node);
}
function decodePlain(arr) {
  const node = a => {
    const n = { def: a.definition, id: a.identifier, payload: a.payload, traits: new Map() };
    for (const [k, kids] of Object.entries(a.traits || {})) n.traits.set(k, kids.map(node));
    return n;
  };
  return arr.map(node);
}

function buildTree(summary) {
  const strings = summary.internedStrings || [];
  const label = v => (typeof v === "number" ? strings[v] : v);
  const root = { def: "root", id: 0, traits: new Map() };
  const byId = new Map([[0, root]]), parentOf = new Map();
  const detached = new Map(), state = { lastId: 0 };
  let skipped = 0;
  const index = (n, parent, lab) => {
    byId.set(n.id, n);
    if (parent) parentOf.set(n.id, { parent, label: lab });
    for (const [l, kids] of n.traits) for (const k of kids) index(k, n, l);
  };
  const traitOf = (parent, lab) => {
    if (!parent.traits.has(lab)) parent.traits.set(lab, []);
    return parent.traits.get(lab);
  };
  // Where a StablePlace lands: [trait array, index, parent, label]
  const place = p => {
    if (p.referenceSibling !== undefined) {
      const loc = parentOf.get(p.referenceSibling); if (!loc) return null;
      const arr = traitOf(loc.parent, loc.label), i = arr.indexOf(byId.get(p.referenceSibling));
      return [arr, p.side === 1 ? i + 1 : i, loc.parent, loc.label];
    }
    const t = p.referenceTrait; if (!t) return null;
    const parent = byId.get(t.parent); if (!parent) return null;
    const lab = label(t.label), arr = traitOf(parent, lab);
    return [arr, p.side === 1 ? 0 : arr.length, parent, lab];
  };
  const chunks = (summary.editHistory && summary.editHistory.editChunks) || [];
  for (const ch of chunks) {
    if (!Array.isArray(ch.chunk)) { skipped++; continue; }
    for (const edit of ch.chunk) for (const c of edit.changes || []) {
      try {
        if (c.type === 5) detached.set(c.destination, decodeCompressed(c.source, strings, state));
        else if (c.type === 2) detached.set(c.destination, decodePlain(c.source));
        else if (c.type === 0) {
          const nodes = detached.get(c.source); detached.delete(c.source);
          const at = nodes && place(c.destination);
          if (!at) { skipped++; continue; }
          at[0].splice(at[1], 0, ...nodes);
          for (const n of nodes) index(n, at[2], at[3]);
        } else if (c.type === 1) {
          const a = place(c.source.start), b = place(c.source.end);
          if (!a || !b || a[0] !== b[0]) { skipped++; continue; }
          const removed = a[0].splice(a[1], Math.max(0, b[1] - a[1]));
          if (c.destination !== undefined) detached.set(c.destination, removed);
        } else if (c.type === 3) {
          const n = byId.get(c.nodeToModify);
          if (n) n.payload = c.payload === null ? undefined : c.payload; else skipped++;
        }
      } catch (_) { skipped++; }
    }
  }
  return { root, skipped };
}

// ---------- reading Whiteboard's schema ----------
const kid = (n, lab) => (n && n.traits.get(lab) || [])[0];
const val = (n, lab, d) => { const k = kid(n, lab); return k && k.payload !== undefined ? k.payload : d; };
const pt = n => [+val(n, G.X, 0) || 0, +val(n, G.Y, 0) || 0];
const hex2 = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");

function b64bytes(s) {
  if (typeof atob === "function") { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  return new Uint8Array(Buffer.from(s, "base64"));
}

function readStroke(s, item) {
  const pts = kid(s, G.POINTS);
  const data = pts && val(pts, G.POINT_DATA);
  if (!data || typeof data.base64 !== "string") return null;
  const bytes = b64bytes(data.base64), dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const k = +val(pts, G.POINT_SCALE, 1 / 128) || 1 / 128;
  const [pox, poy] = pt(kid(pts, G.POINT_OFFSET)), [sox, soy] = pt(kid(s, G.STROKE_OFFSET));
  const { x0, y0, scale, cos, sin } = item;
  const out = [];
  let t0 = null;
  for (let i = 0; i + 16 <= bytes.length; i += 16) {
    const lx = (dv.getInt32(i) * k + pox + sox) * scale, ly = (dv.getInt32(i + 4) * k + poy + soy) * scale;
    const t = dv.getInt32(i + 8), p = dv.getFloat32(i + 12);
    if (t0 === null) t0 = t;
    out.push([+(x0 + lx * cos - ly * sin).toFixed(2), +(y0 + lx * sin + ly * cos).toFixed(2),
      +(Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : 0.5).toFixed(3), t - t0]);
  }
  if (!out.length) return null;
  const brush = kid(s, G.BRUSH), col = kid(brush, G.BRUSH_COLOR);
  const kind = String(val(brush, G.BRUSH_KIND, "plain"));
  const size = +val(kid(s, G.STROKE_SIZE), G.SIZE_VALUE, 1) || 1;
  return {
    t: "ink",
    b: kind === "galaxy" ? "galaxy" : kind === "rainbow" ? "rainbow" : kind === "highlighter" ? "highlighter" : "pen",
    c: "#" + hex2(val(col, G.R, 31)) + hex2(val(col, G.G, 31)) + hex2(val(col, G.B, 31)),
    a: Math.max(0, Math.min(1, +val(col, G.A, 1))),
    w: +(WB_PEN_UNITS * size * scale).toFixed(3), g: 1,
    pts: out,
  };
}

// Returns { items, background, notImported: { [kind]: count }, strokeCount }.
export function importWhiteboard(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const head = td.decode(bytes.subarray(0, 200)).replace(/\0/g, "");
  if (!head.includes("Prague")) throw new Error("This doesn't look like a Microsoft Whiteboard file.");
  const summaries = findSummaries(bytes);
  if (!summaries.length) throw new Error("Couldn't find the board's contents in this file.");
  // The latest summary (most history) wins.
  summaries.sort((a, b) => JSON.stringify(b.editHistory).length - JSON.stringify(a.editHistory).length);
  const { root, skipped } = buildTree(summaries[0]);
  const board = (root.traits.values().next().value || [])[0];
  if (!board) throw new Error("The board in this file is empty.");

  const items = [], notImported = {};
  const miss = k => { notImported[k] = (notImported[k] || 0) + 1; };
  for (const it of board.traits.get(G.ITEMS) || []) {
    if (it.def !== G.ITEM_INK) { miss("other object (" + it.def.slice(0, 8) + ")"); continue; }
    const [x0, y0] = pt(kid(it, G.ITEM_POS));
    const deg = +val(it, G.ITEM_ROTATION, 0) || 0, r = deg * Math.PI / 180;
    const geom = { x0, y0, scale: +val(it, G.ITEM_SCALE, 1) || 1, cos: Math.cos(r), sin: Math.sin(r) };
    const content = kid(it, G.ITEM_CONTENT);
    for (const s of (content && content.traits.get(G.STROKES)) || []) {
      const st = readStroke(s, geom);
      if (st) items.push(st); else miss("ink stroke without points");
    }
  }
  const bg = val(kid(board, G.SETTINGS), G.BG_COLOR);
  if (skipped) notImported["unreadable edits"] = skipped;
  return {
    items,
    background: typeof bg === "string" && /^#[0-9a-f]{6}$/i.test(bg) ? bg.toLowerCase() : null,
    notImported,
    strokeCount: items.filter(i => i.t === "ink").length,
  };
}

// For working out new object types: the decoded tree with GUID names, as plain JSON.
export function whiteboardOutline(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const s = findSummaries(bytes)[0];
  if (!s) return null;
  const plain = n => ({
    def: n.def, id: n.id,
    ...(n.payload !== undefined ? { payload: n.payload && n.payload.base64 ? `<${n.payload.base64.length} base64 chars>` : n.payload } : {}),
    ...(n.traits.size ? { traits: Object.fromEntries([...n.traits].map(([k, v]) => [k, v.map(plain)])) } : {}),
  });
  return plain(buildTree(s).root);
}
