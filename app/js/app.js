import { BoardView, uid, cloneItem } from "./board.js";
import { IS_ANDROID, smoothPx } from "./ink-core.js";
import { renderBoard, unionBounds, NOTE_COLORS } from "./render.js";
import { SHAPE_KINDS } from "./shapes.js";
import { store, hooks } from "./store.js";
import { importWhiteboard } from "./whiteboard-import.js";
import { mergeBoards } from "./merge.js";
import { createComments } from "./comments.js";
import { Session, newCode, cleanCode, validCode, joinLink, PEOPLE_COLORS } from "./collab.js";

const el = Object.fromEntries([...document.querySelectorAll("[id]")].map(e => [e.id, e]));
const SETTINGS_KEY = "inkboard-settings-v1";

const PEN_COLORS = ["#1f1f1f", "#e71224", "#f7630c", "#ffc114", "#16c60c", "#0078d4", "#8764b8", "#ffffff"];
const HL_COLORS = ["#ffff00", "#00ff00", "#00ffff", "#ff00ff", "#ff8c00"];
const PEN_SIZES = [1.5, 2.5, 4, 6, 10];
const HL_SIZES = [10, 16, 24];
const BRUSHES = [["pen", "Plain"], ["galaxy", "Galaxy"], ["rainbow", "Rainbow"]];
const SHAPE_ICONS = {
  rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>', ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>',
  triangle: '<path d="M12 4l8.5 15h-17z"/>', diamond: '<path d="M12 3l8 9-8 9-8-9z"/>',
  line: '<path d="M4 19L20 5"/>', arrow: '<path d="M4 19L20 5M12 5h8v8"/>',
};
const BG_COLORS = ["#ffffff", "#f6f1e3", "#e8f1fb", "#eaf6e6", "#2b2b2b", "#1f3a2c"];

function readJSON(key) { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch (_) { return {}; } }
function writeJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (_) {} }

// Pen settings are per device (the Surface and the S25 Ultra want different smoothing).
const saved = readJSON(SETTINGS_KEY);
const settings = {
  tool: "pen", curve: 50, smooth: IS_ANDROID ? 0 : 60, touchInk: false, noteColor: "yellow", inkToShape: false,
  ...saved,
  shape: { k: "rect", color: PEN_COLORS[0], size: 2.5, fill: false, ...(saved.shape || {}) },
  pen: { color: PEN_COLORS[0], size: 2.5, brush: "pen", ...(saved.pen || {}) },
  highlighter: { color: HL_COLORS[0], size: 16, ...(saved.highlighter || {}) },
};
const saveSettings = () => writeJSON(SETTINGS_KEY, settings);
// Who I am on shared boards (per device; no account).
if (!settings.me || !settings.me.id) { settings.me = { id: uid(), name: "", color: PEOPLE_COLORS[Math.random() * PEOPLE_COLORS.length | 0] }; saveSettings(); }

const boards = new Map();
const images = new Map();
let current = null;

const view = new BoardView({
  canvas: el.canvas, editor: el.editor, settings: () => settings, images,
  loadImage: id => store.getImage(id),
  onChange: () => { if (current) { current.updated = Date.now(); saveSoon(); } syncHistory(); comments.render(); },
  onSelection: showSelection,
  onView: v => { el.zoomVal.textContent = Math.round(v.z * 100) + "%"; viewSaveSoon(); comments.render(); },
  onToolDone: () => setTool("select"),
  // live sharing
  onApplied: ch => { if (live) live.pushChanges(ch); },
  onEditText: it => { if (live) live.editText(it); },
  onPointer: p => { if (live) live.cursor(p); },
  onInk: s => { if (live) live.liveInk(s); },
  onComment: (x, y) => comments.startDraft(x, y),
  drawOverlay: (ctx, o) => { if (live) live.draw(ctx, o); },
});

const comments = createComments({
  el, view, toast: (...a) => toast(...a),
  me: () => ({ id: settings.me.id, name: settings.me.name || "Me", color: settings.me.color }),
  live: () => live,
  changed: () => { if (current) { current.updated = Date.now(); saveSoon(); } },
});
new ResizeObserver(() => comments.render()).observe(el.canvas);

// ---------- saving ----------
let saveTimer = 0, viewTimer = 0, dirty = false;   // dirty: an edit (not just a view change) waits to sync
function saveSoon() { dirty = true; if (live) live.pushMeta(); clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }
function viewSaveSoon() { if (!current) return; clearTimeout(viewTimer); viewTimer = setTimeout(saveNow, 1500); }
async function saveNow() {
  clearTimeout(saveTimer); clearTimeout(viewTimer);
  if (!current) return;
  try { await store.putBoard(current); if (sync && dirty) sync.soon(); dirty = false; }
  catch (err) { console.warn(err); toast("Couldn't save this board on the device. Check that the browser allows site storage."); }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveNow(); });
addEventListener("pagehide", saveNow);

// ---------- boards list ----------
function fmtTime(ts) {
  const d = new Date(ts), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}
function renderHome() {
  const list = [...boards.values()].filter(b => !b.deleted).sort((a, b) => b.updated - a.updated);
  if (!list.length) {
    const p = document.createElement("p"); p.className = "empty";
    p.textContent = "No boards yet. Start a new board or import one from Microsoft Whiteboard.";
    el.boards.replaceChildren(p); return;
  }
  const cards = list.map(b => {
    const c = document.createElement("button");
    c.type = "button"; c.className = "card";
    const cv = document.createElement("canvas"); cv.setAttribute("aria-hidden", "true");
    const meta = document.createElement("span"); meta.className = "meta";
    const t = document.createElement("span"); t.className = "title"; t.textContent = b.name || "Untitled board";
    const tm = document.createElement("span"); tm.className = "time"; tm.textContent = fmtTime(b.updated);
    meta.append(t, tm); c.append(cv, meta);
    if (b.room) { const tag = document.createElement("span"); tag.className = "live-tag"; tag.textContent = "Shared"; c.append(tag); }
    c.onclick = () => openBoard(b.id);
    return c;
  });
  el.boards.replaceChildren(...cards);
  requestAnimationFrame(() => cards.forEach((c, i) => drawThumb(c.querySelector("canvas"), list[i])));
}
function drawThumb(cv, b) {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  renderBoard(cv.getContext("2d"), { ...b, pattern: "none" }, cv.width, cv.height, { pad: 10 * dpr, images, maxZoom: dpr });
}

function showHome() {
  saveNow(); view.endEdit(); stopLive();
  current = null;
  el.boardView.hidden = true; el.home.hidden = false;
  closePops();
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  document.title = "InkBoard";
  renderHome();
}
function openBoard(id) {
  const b = boards.get(id); if (!b || b.deleted) { showHome(); return; }
  current = b;
  el.home.hidden = true; el.boardView.hidden = false;
  el.boardName.value = b.name || "";
  document.title = (b.name || "Untitled board") + " – InkBoard";
  history.replaceState(null, "", "#board=" + encodeURIComponent(id));
  view.load(b);
  syncMenu(); syncHistory();
  if (b.room) startLive(b); else stopLive();
  comments.close(); el.commentsPanel.hidden = true;
}
function newBoard(fields = {}) {
  const now = Date.now();
  const b = { id: uid(), name: "Untitled board", created: now, updated: now, bg: "#ffffff", pattern: "none", view: null, items: [], ...fields };
  boards.set(b.id, b);
  return b;
}
el.newBoard.onclick = async () => { const b = newBoard(); await store.putBoard(b); openBoard(b.id); };
// New boards reach OneDrive once something is on them (an empty "Untitled board" stays local).
el.back.onclick = showHome;
el.boardName.addEventListener("input", () => {
  if (!current) return;
  current.name = el.boardName.value.slice(0, 80); current.updated = current.metaU = Date.now();
  document.title = (current.name || "Untitled board") + " – InkBoard";
  saveSoon();
});
el.boardName.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === "Escape") el.boardName.blur(); e.stopPropagation(); });

// ---------- import / export ----------
el.importBtn.onclick = () => el.importFile.click();
el.importFile.onchange = () => { const f = [...el.importFile.files]; el.importFile.value = ""; importFiles(f); };

const baseName = n => n.replace(/\.[^.]+$/, "") || "Imported board";
async function importFiles(files) {
  let opened = null;
  const notes = [];
  for (const f of files) {
    try {
      if (/\.inkboard$/i.test(f.name) || f.type === "application/json") {
        const b = await readInkboard(await f.text(), baseName(f.name));
        opened = b; notes.push(`Opened “${b.name}”.`);
      } else if (/\.whiteboard$/i.test(f.name)) {
        const r = importWhiteboard(new Uint8Array(await f.arrayBuffer()));
        const b = newBoard({ name: baseName(f.name), bg: r.background || "#ffffff", items: r.items.map(i => ({ ...i, id: uid() })) });
        await store.putBoard(b);
        opened = b;
        const left = Object.entries(r.notImported).map(([k, n]) => `${n} ${k}`).join(", ");
        notes.push(`Imported “${b.name}”: ${r.strokeCount} ink strokes.` + (left ? ` Not imported yet: ${left}.` : ""));
        if (left) console.info("Whiteboard objects InkBoard can't read yet:", r.notImported);
      } else if (f.type.startsWith("image/") && current) {
        await insertImages([f]);
      } else notes.push(`${f.name} isn't a Whiteboard or InkBoard file.`);
    } catch (err) {
      console.warn(err);
      notes.push(`Couldn't open ${f.name}: ${err.message || err}`);
    }
  }
  if (opened) openBoard(opened.id); else if (!current) renderHome();
  if (opened && sync) sync.soon();
  if (notes.length) toast(notes.join(" "), null, null, 10000);
}

async function blobToDataURL(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
}
async function readInkboard(text, fallbackName) {
  const data = JSON.parse(text);
  if (data.format !== "inkboard" || !data.board) throw new Error("not an InkBoard copy");
  const map = new Map();
  for (const [oldId, url] of Object.entries(data.images || {})) {
    const id = uid(); map.set(oldId, id);
    await store.putImage(id, await (await fetch(url)).blob());
  }
  const src = data.board;
  const b = newBoard({
    name: src.name || fallbackName, bg: src.bg || "#ffffff", pattern: src.pattern || "none", view: src.view || null,
    items: (src.items || []).map(i => ({ ...i, id: uid(), ...(i.t === "image" ? { img: map.get(i.img) || i.img } : {}) })),
  });
  await store.putBoard(b);
  return b;
}
function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const safeName = n => (n || "board").replace(/[\\/:*?"<>|]+/g, "-").trim() || "board";
el.exportBoard.onclick = async () => {
  if (!current) return;
  closePops(); await saveNow();
  const imgs = {};
  for (const it of current.items) if (it.t === "image" && !imgs[it.img]) {
    const blob = await store.getImage(it.img); if (blob) imgs[it.img] = await blobToDataURL(blob);
  }
  const { id, ...board } = current;
  download(new Blob([JSON.stringify({ format: "inkboard", version: 1, board, images: imgs })], { type: "application/json" }), safeName(current.name) + ".inkboard");
};
el.exportPng.onclick = () => {
  if (!current) return;
  closePops();
  const b = unionBounds(current.items);
  if (!b) { toast("This board is empty."); return; }
  const pad = 40, bw = b.x1 - b.x0 + 2 * pad, bh = b.y1 - b.y0 + 2 * pad;
  const k = Math.min(2, 8000 / bw, 8000 / bh);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bw * k)); c.height = Math.max(1, Math.round(bh * k));
  renderBoard(c.getContext("2d"), current, c.width, c.height, { pad: pad * k, images, maxZoom: k });
  c.toBlob(blob => blob ? download(blob, safeName(current.name) + ".png") : toast("The board is too big to export as one image."), "image/png");
};

// drag and drop, on the home screen or a board
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer && e.dataTransfer.items || [])].some(i => i.kind === "file");
addEventListener("dragenter", e => { if (hasFiles(e)) { dragDepth++; el.drop.hidden = false; e.preventDefault(); } });
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; el.drop.hidden = true; } });
addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); });
addEventListener("drop", e => {
  dragDepth = 0; el.drop.hidden = true;
  const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
  if (!files.length) return;
  e.preventDefault();
  if (current && files.every(f => f.type.startsWith("image/"))) insertImages(files, view.toBoard(e.clientX, e.clientY));
  else importFiles(files);
});

// ---------- images ----------
async function shrinkImage(file, max = 2400) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const size = { w: bmp.width, h: bmp.height };
  if (k === 1 && file.size < 2.5e6) { bmp.close && bmp.close(); return { blob: file, ...size }; }
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  const blob = await new Promise(res => c.toBlob(res, "image/webp", 0.9));
  return { blob: blob || file, ...size };
}
async function insertImages(files, at) {
  if (!current) return;
  let [cx, cy] = at || view.center();
  const items = [];
  for (const f of files) {
    try {
      const { blob, w, h } = await shrinkImage(f);
      const id = uid();
      await store.putImage(id, blob);
      const z = view.view.z, maxW = view.cssW * 0.5 / z, maxH = view.cssH * 0.5 / z;
      const k = Math.min(1 / z, maxW / w, maxH / h);
      items.push({ t: "image", x: cx - w * k / 2, y: cy - h * k / 2, w: w * k, h: h * k, img: id });
      cx += 30 / z; cy += 30 / z;
    } catch (err) { console.warn(err); toast("Couldn't add that image. Try a PNG or JPEG."); }
  }
  if (items.length) { view.addItems(items); setTool("select"); }
}
el.addImage.onclick = () => el.imageFile.click();
el.imageFile.onchange = () => { const f = [...el.imageFile.files]; el.imageFile.value = ""; if (f.length) insertImages(f); };

// ---------- tools ----------
function setTool(t) {
  settings.tool = t; saveSettings();
  el.boardView.dataset.tool = t;
  document.querySelectorAll("[data-tool]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.tool === t)));
  if (t !== "select") view.clearSelection();
}
document.querySelectorAll(".tools [data-tool]").forEach(b => b.addEventListener("click", () => {
  const t = b.dataset.tool;
  const again = settings.tool === t;
  setTool(t);
  if ((t === "pen" || t === "highlighter") && again) togglePop(el.penPop, () => buildPenPop(t));
  else if (t === "note" && again) togglePop(el.notePop, buildNotePop);
  else if (t === "shape" && (again || !settings.shapeSeen)) { settings.shapeSeen = true; saveSettings(); togglePop(el.shapePop, buildShapePop); }
  else closePops();
}));

function swatch(color, pressed, label, onclick, sq) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "swatch" + (sq ? " sq" : ""); b.style.background = color;
  b.setAttribute("aria-label", label); b.title = label; b.setAttribute("aria-pressed", String(pressed));
  b.onclick = onclick;
  return b;
}
function buildPenPop(kind) {
  const p = settings[kind], hl = kind === "highlighter";
  el.penColors.replaceChildren(...(hl ? HL_COLORS : PEN_COLORS).map(c => swatch(c, c === p.color, "Colour " + c, () => { p.color = c; saveSettings(); syncTools(); buildPenPop(kind); })));
  el.penSizes.replaceChildren(...(hl ? HL_SIZES : PEN_SIZES).map(s => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "size"; b.title = s + " px"; b.setAttribute("aria-label", "Thickness " + s);
    b.setAttribute("aria-pressed", String(s === p.size));
    const i = document.createElement("i"); const d = Math.min(26, Math.max(3, s * (hl ? 1 : 1.6)));
    i.style.width = i.style.height = d + "px"; b.append(i);
    b.onclick = () => { p.size = s; saveSettings(); buildPenPop(kind); };
    return b;
  }));
  el.penBrushes.hidden = hl; el.inkToShape.hidden = hl;
  el.inkToShape.setAttribute("aria-pressed", String(!!settings.inkToShape));
  if (!hl) el.penBrushes.replaceChildren(...BRUSHES.map(([id, name]) => {
    const b = document.createElement("button"); b.type = "button"; b.textContent = name;
    b.setAttribute("aria-pressed", String((p.brush || "pen") === id));
    b.onclick = () => { p.brush = id; saveSettings(); syncTools(); buildPenPop(kind); };
    return b;
  }));
}
el.inkToShape.onclick = () => {
  settings.inkToShape = !settings.inkToShape; saveSettings(); buildPenPop("pen");
  toast(settings.inkToShape ? "Ink to shape is on: circles, boxes, triangles and straight lines you draw become shapes." : "Ink to shape is off.");
};
function sizeButtons(sizes, current, pick) {
  return sizes.map(s => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "size"; b.title = s + " px"; b.setAttribute("aria-label", "Thickness " + s);
    b.setAttribute("aria-pressed", String(s === current));
    const i = document.createElement("i"); const d = Math.min(26, Math.max(3, s * 1.6));
    i.style.width = i.style.height = d + "px"; b.append(i);
    b.onclick = () => pick(s);
    return b;
  });
}
function buildShapePop() {
  const sh = settings.shape, redo = () => { saveSettings(); buildShapePop(); };
  el.shapeKinds.replaceChildren(...SHAPE_KINDS.map(([k, name]) => {
    const b = document.createElement("button");
    b.type = "button"; b.title = name; b.setAttribute("aria-label", name); b.setAttribute("aria-pressed", String(sh.k === k));
    b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">${SHAPE_ICONS[k]}</svg>`;
    b.onclick = () => { sh.k = k; redo(); };
    return b;
  }));
  el.shapeColors.replaceChildren(...PEN_COLORS.map(c => swatch(c, c === sh.color, "Colour " + c, () => { sh.color = c; redo(); })));
  el.shapeSizes.replaceChildren(...sizeButtons(PEN_SIZES, sh.size, s => { sh.size = s; redo(); }));
  el.shapeFill.setAttribute("aria-pressed", String(!!sh.fill));
  el.shapeFill.hidden = sh.k === "line" || sh.k === "arrow";
}
el.shapeFill.onclick = () => { settings.shape.fill = !settings.shape.fill; saveSettings(); buildShapePop(); };

// ruler and protractor
el.guidesBtn.onclick = () => togglePop(el.guidesPop, syncGuides);
function syncGuides() {
  el.rulerToggle.setAttribute("aria-pressed", String(!!view.guides.ruler));
  el.protToggle.setAttribute("aria-pressed", String(!!view.guides.prot));
  el.guidesBtn.setAttribute("aria-pressed", String(view.guides.any));
}
el.rulerToggle.onclick = () => { view.toggleGuide("ruler"); syncGuides(); };
el.protToggle.onclick = () => { view.toggleGuide("prot"); syncGuides(); };

function buildNotePop() {
  el.noteColors.replaceChildren(...Object.entries(NOTE_COLORS).map(([name, c]) =>
    swatch(c, name === settings.noteColor, name + " note", () => { settings.noteColor = name; saveSettings(); buildNotePop(); }, true)));
}
function syncTools() {
  const pd = document.querySelector('[data-tool="pen"] .dot'), hd = document.querySelector('[data-tool="highlighter"] .dot');
  pd.style.background = settings.pen.brush === "rainbow" ? "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" : settings.pen.color;
  hd.style.background = settings.highlighter.color;
}
function togglePop(pop, build) {
  const open = pop.hidden;
  closePops();
  if (open) { build(); pop.hidden = false; }
}
function closePops() { el.penPop.hidden = el.notePop.hidden = el.shapePop.hidden = el.guidesPop.hidden = el.menu.hidden = el.reactPop.hidden = true; resetDelete(); }
document.addEventListener("pointerdown", e => {
  if (e.target === el.canvas && comments.isOpen()) comments.close();
  if (e.target.closest(".pop") || e.target.closest(".tools") || e.target.closest("#menuBtn") || e.target.closest("#selReact") || e.target.closest(".react-pop")) return;
  closePops();
}, true);

// ---------- selection bar ----------
function showSelection(items) {
  el.selBar.hidden = !items.length || !current;
  if (!items.length) return;
  const notes = items.filter(i => i.t === "note"), inks = items.filter(i => i.t === "ink" || i.t === "text");
  const sw = [];
  if (notes.length) for (const [name, c] of Object.entries(NOTE_COLORS))
    sw.push(swatch(c, notes.every(n => n.color === name), name + " note", () => view.restyleSelection(it => it.t === "note" ? (it.color = name, it) : null), true));
  else if (inks.length) for (const c of PEN_COLORS.slice(0, 7))
    sw.push(swatch(c, inks.every(n => (n.c || "#1b1b1f") === c), "Colour " + c, () => view.restyleSelection(it => (it.t === "ink" && it.b !== "highlighter") || it.t === "text" ? (it.c = c, it) : null)));
  el.selColors.replaceChildren(...sw);
  el.selColors.hidden = !sw.length;
}
el.selDel.onclick = () => view.deleteSelection();
el.selDup.onclick = () => view.duplicateSelection();

// ---------- menu ----------
el.menuBtn.onclick = () => togglePop(el.menu, syncMenu);
function syncMenu() {
  if (!current) return;
  el.bgColors.replaceChildren(...BG_COLORS.map(c => swatch(c, (current.bg || "#ffffff") === c, "Background " + c, () => {
    current.bg = c; current.updated = current.metaU = Date.now(); saveSoon(); view.requestRender(); syncMenu();
  })));
  el.bgPattern.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String((current.pattern || "none") === b.dataset.p)));
  el.smooth.value = settings.smooth; el.smoothVal.textContent = settings.smooth ? smoothPx(settings.smooth).toFixed(1) + " px" : "off";
  el.curve.value = settings.curve; el.curveVal.textContent = settings.curve < 40 ? "soft" : settings.curve > 60 ? "firm" : "even";
  el.touchInk.setAttribute("aria-pressed", String(settings.touchInk));
}
el.bgPattern.onclick = e => {
  const b = e.target.closest("button[data-p]"); if (!b || !current) return;
  current.pattern = b.dataset.p; current.updated = current.metaU = Date.now(); saveSoon(); view.requestRender(); syncMenu();
};
el.smooth.oninput = () => { settings.smooth = +el.smooth.value; saveSettings(); syncMenu(); };
el.curve.oninput = () => { settings.curve = +el.curve.value; saveSettings(); syncMenu(); };
el.touchInk.onclick = () => {
  settings.touchInk = !settings.touchInk; saveSettings(); syncMenu();
  toast(settings.touchInk ? "Fingers now draw. Use two fingers to move around." : "Only the pen and mouse draw now. Fingers move the board.");
};
let deleteArmed = 0;
function resetDelete() { clearTimeout(deleteArmed); deleteArmed = 0; el.deleteBoard.textContent = "Delete board"; el.deleteBoard.classList.remove("armed"); }
el.deleteBoard.onclick = async () => {
  if (!deleteArmed) { el.deleteBoard.textContent = "Select again to delete"; el.deleteBoard.classList.add("armed"); deleteArmed = setTimeout(resetDelete, 3000); return; }
  resetDelete();
  const b = current; if (!b) return;
  // A small tombstone stays behind so the deletion reaches your other devices.
  const imgs = b.items.filter(i => i.t === "image").map(i => i.img);
  const tomb = { id: b.id, name: b.name, created: b.created, updated: Date.now(), deleted: true, items: [] };
  boards.set(b.id, tomb); current = null;
  await store.putBoard(tomb); if (sync) sync.soon();
  showHome();
  toast(`Deleted “${b.name}”.`, "Undo", async () => {
    b.updated = Date.now(); boards.set(b.id, b); await store.putBoard(b); if (sync) sync.soon(); openBoard(b.id);
  });
  // images go once the undo window has passed
  setTimeout(() => { if (boards.get(b.id) === tomb) imgs.forEach(id => store.deleteImage(id).catch(() => {})); }, 12000);
};

// ---------- undo, zoom ----------
function syncHistory() { el.undo.disabled = !view.canUndo; el.redo.disabled = !view.canRedo; }
el.undo.onclick = () => view.undo();
el.redo.onclick = () => view.redo();
el.zoomIn.onclick = () => view.zoomBy(1.25);
el.zoomOut.onclick = () => view.zoomBy(0.8);
el.zoomVal.onclick = () => view.zoomTo(1);
el.zoomFit.onclick = () => view.fit();

// ---------- keyboard and clipboard ----------
let clip = null;
const typing = e => e.target.closest && e.target.closest("input, textarea, [contenteditable]");
document.addEventListener("keydown", e => {
  if (!current || typing(e)) return;
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (mod && k === "z" && !e.shiftKey) { e.preventDefault(); view.undo(); }
  else if (mod && (k === "y" || (k === "z" && e.shiftKey))) { e.preventDefault(); view.redo(); }
  else if (mod && k === "a") { e.preventDefault(); setTool("select"); view.selectAll(); }
  else if (mod && k === "d") { e.preventDefault(); view.duplicateSelection(); }
  else if (mod && k === "c") { const s = view.copySelection(); if (s.length) clip = s; }
  else if (mod && k === "x") { const s = view.copySelection(); if (s.length) { clip = s; view.deleteSelection(); } }
  else if (mod && (k === "=" || k === "+")) { e.preventDefault(); view.zoomBy(1.25); }
  else if (mod && k === "-") { e.preventDefault(); view.zoomBy(0.8); }
  else if (mod && k === "0") { e.preventDefault(); view.zoomTo(1); }
  else if (k === "delete" || k === "backspace") view.deleteSelection();
  else if (k === "escape") { view.clearSelection(); closePops(); comments.close(); }
  else if (k === " ") { if (!view.space) { view.space = true; el.boardView.classList.add("panning"); } e.preventDefault(); }
  else if (!mod && !e.altKey) {
    const t = { v: "select", p: "pen", h: "highlighter", e: "eraser", n: "note", t: "text", s: "shape", c: "comment" }[k];
    if (t) setTool(t);
  }
});
document.addEventListener("keyup", e => { if (e.key === " ") { view.space = false; el.boardView.classList.remove("panning"); } });
document.addEventListener("paste", e => {
  if (!current || typing(e)) return;
  const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter(f => f.type.startsWith("image/"));
  if (files.length) { e.preventDefault(); insertImages(files); return; }
  if (clip) {
    e.preventDefault();
    view.addItems(clip.map(cloneItem), { offset: 24 / view.view.z });
    setTool("select");
  }
});

// ---------- messages ----------
let toastTimer = 0;
function toast(msg, action, fn, ms = 6000) {
  el.toastText.textContent = msg;
  el.toastAction.hidden = !action;
  if (action) { el.toastAction.textContent = action; el.toastAction.onclick = () => { el.toast.hidden = true; fn(); }; }
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
}
hooks.onBlocked = () => toast("InkBoard was updated. Close or reload any other InkBoard tabs to finish.");
hooks.onVersionChange = () => toast("InkBoard was updated in another tab. Reload this one to keep saving.", "Reload", () => location.reload(), 60000);

// ---------- OneDrive sync ----------
// Shares InkNotes' Microsoft sign-in, passphrase and encrypted app folder (boards go in boards/).
// The sync code lives with InkNotes on the same website; where it isn't (a local test server),
// the sync button just stays hidden.
let sync = null, syncUI = null;
const imagesOfBoard = b => (b.items || []).filter(i => i.t === "image" && i.img).map(i => i.img);
async function mergeIn(remote) {
  // Wait for the pen to lift or typing to finish before changing the open board.
  for (let i = 0; i < 40 && current && current.id === remote.id && (view.g || view.editing); i++) await new Promise(r => setTimeout(r, 500));
  const local = boards.get(remote.id) || await store.getBoard(remote.id);
  const { board } = mergeBoards(local, remote);
  if (current && current.id === remote.id) {
    if (board.deleted) { boards.set(board.id, board); await store.putBoard(board); showHome(); toast(`“${local.name}” was deleted on another device.`); return; }
    for (const k of Object.keys(current)) if (!(k in board)) delete current[k];
    Object.assign(current, board, { view: current.view });
    view.changedOutside();
    if (live) live.reconcile();
    comments.render();
    el.boardName.value = current.name || "";
    await store.putBoard(current);
  } else {
    boards.set(board.id, board);
    await store.putBoard(board);
    if (!current) renderHome();
  }
}
function mirrorSync(st) {
  if (!syncUI) return;
  syncUI.render(st);
  for (const k of ["hidden", "title"]) el.syncBtn2[k] = el.syncBtn[k];
  el.syncBtn2.dataset.state = el.syncBtn.dataset.state;
  el.syncBtn2.setAttribute("aria-label", el.syncBtn.getAttribute("aria-label") || "OneDrive sync");
}
async function startSync() {
  let mod, ui;
  try { [mod, ui] = await Promise.all([import("/inknotes/js/sync.js"), import("/inknotes/js/sync-ui.js")]); }
  catch (_) { return; }
  sync = mod.createSync({
    folder: "boards", stateKey: "syncState:boards", images: true, imagesOf: imagesOfBoard,
    local: {
      // a brand-new empty "Untitled board" stays on this device until something is added
      all: async () => (await store.allBoards()).filter(b => b.deleted || b.items.length || b.name !== "Untitled board" || Object.keys(b.gone || {}).length),
      get: async () => undefined,   // every download goes through put(), which merges item by item
      put: mergeIn,
      getImage: id => store.getImage(id),
      putImage: (id, blob) => store.putImage(id, blob),
    },
  });
  syncUI = ui.mountSyncUI({ sync, button: el.syncBtn, appName: "your boards", toast, isMain: () => true, beforeSignIn: saveNow });
  el.syncBtn2.onclick = () => syncUI.open();
  await sync.start({ allowRedirect: true, onStatus: mirrorSync, onRedirect: saveNow, onPulled: () => { if (!current) renderHome(); } });
}

// ---------- live sharing ----------
// A shared board keeps its code in board.room; opening the board joins the room again.
let live = null;
const freshJoins = new Set();   // boards just made by Join, waiting for the room's contents
const meUser = () => ({ id: settings.me.id, name: settings.me.name || "Guest", color: settings.me.color });
const initials = n => (n || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase() || "?";
function avatar(p) {
  const a = document.createElement("span");
  a.className = "avatar"; a.style.background = p.color; a.textContent = initials(p.name); a.title = p.name;
  return a;
}
function startLive(b) {
  stopLive();
  const fresh = freshJoins.has(b.id);
  live = new Session({
    board: b, code: b.room, host: !!b.host, fresh, me: meUser(), view, store, toast,
    onStatus: renderPeople,
    onPeople: renderPeople,
    onMeta: () => {
      if (current !== b) return;
      if (document.activeElement !== el.boardName) el.boardName.value = b.name || "";
      document.title = (b.name || "Untitled board") + " – InkBoard";
      view.requestRender(); if (!el.menu.hidden) syncMenu();
    },
    onRemote: () => {
      comments.render();
      freshJoins.delete(b.id);
      b.updated = Date.now(); saveSoon();
    },
    onEnded: reason => {
      live = null;
      b.room = null; b.host = false; saveSoon(); renderPeople();
      toast(reason === "too-big" ? "This board got too big to share live. Your copy is still here." : "Sharing for this board has ended. Your copy stays on this device.", null, null, 9000);
    },
    onEmpty: () => {
      live = null;
      if (freshJoins.delete(b.id)) {
        boards.delete(b.id); store.deleteBoard(b.id).catch(() => {});
        if (current === b) { current = null; showHome(); }
        toast(`No board is being shared with the code ${b.room}. Check the code with the person sharing it.`, null, null, 9000);
      } else {
        b.room = null; b.host = false; saveSoon(); renderPeople();
        toast("Sharing for this board has ended. Your copy stays on this device.", null, null, 9000);
      }
    },
  });
  renderPeople();
}
function stopLive() {
  if (!live) return;
  live.stop(); live = null; renderPeople();
}
let peopleSig = "";
function renderPeople() {
  const ppl = live ? live.people() : [];
  const sig = JSON.stringify([live && live.state, live && live.code, ppl.map(p => [p.id, p.name, p.color])]);
  if (sig === peopleSig) return;
  peopleSig = sig;
  const shown = ppl.slice(0, 4).map(avatar);
  if (ppl.length > 4) { const m = avatar({ name: `${ppl.length - 4} more`, color: "" }); m.classList.add("more"); m.textContent = "+" + (ppl.length - 4); shown.push(m); }
  el.people.replaceChildren(...shown);
  if (live) el.shareBtn.dataset.live = live.state; else delete el.shareBtn.dataset.live;
  el.shareLabel.textContent = !live ? "Share" : live.state === "live" ? (ppl.length ? `Live · ${ppl.length + 1}` : "Live") : live.state === "offline" ? "Offline" : "Connecting…";
  el.shareBtn.title = live ? `Shared with code ${live.code}` : "Share this board live";
  if (el.shareDlg.open) fillShare();
}
function fillShare() {
  const on = !!live;
  el.shareStart.hidden = on; el.shareLive.hidden = !on;
  el.shareGo.hidden = on; el.shareStop.hidden = !on;
  el.shareTitle.textContent = on ? "Shared live" : "Share live";
  if (!on) { el.shareName.value = settings.me.name || ""; el.shareErr.hidden = true; return; }
  el.shareCode.textContent = live.code;
  el.shareLink.value = joinLink(live.code);
  el.shareStop.textContent = live.host ? "Stop sharing" : "Leave board";
  el.shareState.textContent = live.state === "live" ? "Connected. Changes reach everyone as you make them."
    : live.state === "offline" ? "Not connected right now. Your changes are kept and sent when the connection is back."
    : "Connecting…";
  const ppl = live.people();
  el.sharePeople.replaceChildren(...[{ ...meUser(), you: true }, ...ppl].map(p => {
    const r = document.createElement("div"); r.className = "person";
    const n = document.createElement("span"); n.textContent = p.name + (p.you ? " (you)" : "");
    r.append(avatar(p), n); return r;
  }));
}
el.shareBtn.onclick = () => { closePops(); fillShare(); el.shareDlg.showModal(); if (!live) el.shareName.focus(); };
el.shareClose.onclick = () => el.shareDlg.close();
el.shareGo.onclick = () => {
  const name = el.shareName.value.trim();
  if (!name) { el.shareErr.textContent = "Add your name so others know who's drawing."; el.shareErr.hidden = false; el.shareName.focus(); return; }
  if (!current) return;
  settings.me.name = name; saveSettings();
  current.room = newCode(); current.host = true; current.updated = Date.now();
  saveSoon(); startLive(current); fillShare();
};
el.shareName.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); el.shareGo.click(); } });
el.copyLink.onclick = async () => {
  try { await navigator.clipboard.writeText(el.shareLink.value); el.copyLink.textContent = "Copied"; setTimeout(() => { el.copyLink.textContent = "Copy link"; }, 1800); }
  catch (_) { el.shareLink.select(); }
};
el.shareStop.onclick = () => {
  if (!live || !current) return;
  const host = live.host;
  if (host) live.closeRoom(); else live.stop();
  live = null;
  current.room = null; current.host = false; current.updated = Date.now(); saveSoon();
  renderPeople(); el.shareDlg.close();
  toast(host ? "Stopped sharing. Others keep a copy of the board as it is now." : "You left the board. Your copy stays on this device.");
};

function openJoin(code = "") {
  el.joinCode.value = code; el.joinName.value = settings.me.name || ""; el.joinErr.hidden = true;
  el.joinDlg.showModal();
  (code ? el.joinName : el.joinCode).focus();
}
el.joinBtn.onclick = () => openJoin();
el.joinCancel.onclick = () => el.joinDlg.close();
el.joinForm.onsubmit = e => {
  e.preventDefault();
  const code = cleanCode(el.joinCode.value), name = el.joinName.value.trim();
  const err = m => { el.joinErr.textContent = m; el.joinErr.hidden = false; };
  if (!validCode(code)) return err("A code is 6 letters and numbers, like ABC234.");
  if (!name) return err("Add your name so others know who's drawing.");
  settings.me.name = name; saveSettings();
  el.joinDlg.close();
  const have = [...boards.values()].find(b => b.room === code && !b.deleted);
  if (have) { openBoard(have.id); return; }
  const b = newBoard({ name: "Shared board", room: code, host: false });
  freshJoins.add(b.id);
  openBoard(b.id);
};

// ---------- start ----------
async function init() {
  setTool(["select", "hand", "eraser", "highlighter", "shape"].includes(settings.tool) ? settings.tool : "pen");
  syncTools();
  try { for (const b of await store.allBoards()) boards.set(b.id, b); }
  catch (err) {
    console.warn(err);
    el.storageNote.hidden = false;
    el.storageNote.textContent = "This browser is blocking site storage, so boards will be lost when it closes.";
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  startSync().catch(err => console.warn("Sync unavailable:", err));
  const m = /^#board=(.+)$/.exec(location.hash), j = /^#join=([A-Za-z0-9]+)$/.exec(location.hash);
  if (m && boards.has(decodeURIComponent(m[1]))) openBoard(decodeURIComponent(m[1]));
  else renderHome();
  if (j) { history.replaceState(null, "", location.pathname + location.search); openJoin(cleanCode(j[1])); }
}
init();

if ("serviceWorker" in navigator && location.protocol.startsWith("http") && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
  navigator.serviceWorker.register("sw.js").catch(err => console.warn("Offline support unavailable:", err));
}

// For debugging from the browser console.
window.__inkboard = { view, settings, boards, get live() { return live; } };
