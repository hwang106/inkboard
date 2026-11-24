import { BoardView, uid, cloneItem } from "./board.js";
import { IS_ANDROID, smoothPx } from "./ink-core.js";
import { renderBoard, unionBounds, NOTE_COLORS } from "./render.js";
import { store, hooks } from "./store.js";
import { importWhiteboard } from "./whiteboard-import.js";

const el = Object.fromEntries([...document.querySelectorAll("[id]")].map(e => [e.id, e]));
const SETTINGS_KEY = "inkboard-settings-v1";

const PEN_COLORS = ["#1f1f1f", "#e71224", "#f7630c", "#ffc114", "#16c60c", "#0078d4", "#8764b8", "#ffffff"];
const HL_COLORS = ["#ffff00", "#00ff00", "#00ffff", "#ff00ff", "#ff8c00"];
const PEN_SIZES = [1.5, 2.5, 4, 6, 10];
const HL_SIZES = [10, 16, 24];
const BRUSHES = [["pen", "Plain"], ["galaxy", "Galaxy"], ["rainbow", "Rainbow"]];
const BG_COLORS = ["#ffffff", "#f6f1e3", "#e8f1fb", "#eaf6e6", "#2b2b2b", "#1f3a2c"];

function readJSON(key) { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch (_) { return {}; } }
function writeJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (_) {} }

// Pen settings are per device (the Surface and the S25 Ultra want different smoothing).
const saved = readJSON(SETTINGS_KEY);
const settings = {
  tool: "pen", curve: 50, smooth: IS_ANDROID ? 0 : 60, touchInk: false, noteColor: "yellow",
  ...saved,
  pen: { color: PEN_COLORS[0], size: 2.5, brush: "pen", ...(saved.pen || {}) },
  highlighter: { color: HL_COLORS[0], size: 16, ...(saved.highlighter || {}) },
};
const saveSettings = () => writeJSON(SETTINGS_KEY, settings);

const boards = new Map();
const images = new Map();
let current = null;

const view = new BoardView({
  canvas: el.canvas, editor: el.editor, settings: () => settings, images,
  loadImage: id => store.getImage(id),
  onChange: () => { if (current) { current.updated = Date.now(); saveSoon(); } syncHistory(); },
  onSelection: showSelection,
  onView: v => { el.zoomVal.textContent = Math.round(v.z * 100) + "%"; viewSaveSoon(); },
  onToolDone: () => setTool("select"),
});

// ---------- saving ----------
let saveTimer = 0, viewTimer = 0;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }
function viewSaveSoon() { if (!current) return; clearTimeout(viewTimer); viewTimer = setTimeout(saveNow, 1500); }
async function saveNow() {
  clearTimeout(saveTimer); clearTimeout(viewTimer);
  if (!current) return;
  try { await store.putBoard(current); }
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
  const list = [...boards.values()].sort((a, b) => b.updated - a.updated);
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
  saveNow(); view.endEdit();
  current = null;
  el.boardView.hidden = true; el.home.hidden = false;
  closePops();
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  document.title = "InkBoard";
  renderHome();
}
function openBoard(id) {
  const b = boards.get(id); if (!b) { showHome(); return; }
  current = b;
  el.home.hidden = true; el.boardView.hidden = false;
  el.boardName.value = b.name || "";
  document.title = (b.name || "Untitled board") + " – InkBoard";
  history.replaceState(null, "", "#board=" + encodeURIComponent(id));
  view.load(b);
  syncMenu(); syncHistory();
}
function newBoard(fields = {}) {
  const now = Date.now();
  const b = { id: uid(), name: "Untitled board", created: now, updated: now, bg: "#ffffff", pattern: "none", view: null, items: [], ...fields };
  boards.set(b.id, b);
  return b;
}
el.newBoard.onclick = async () => { const b = newBoard(); await store.putBoard(b); openBoard(b.id); };
el.back.onclick = showHome;
el.boardName.addEventListener("input", () => {
  if (!current) return;
  current.name = el.boardName.value.slice(0, 80); current.updated = Date.now();
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
  el.penBrushes.hidden = hl;
  if (!hl) el.penBrushes.replaceChildren(...BRUSHES.map(([id, name]) => {
    const b = document.createElement("button"); b.type = "button"; b.textContent = name;
    b.setAttribute("aria-pressed", String((p.brush || "pen") === id));
    b.onclick = () => { p.brush = id; saveSettings(); syncTools(); buildPenPop(kind); };
    return b;
  }));
}
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
function closePops() { el.penPop.hidden = el.notePop.hidden = el.menu.hidden = true; resetDelete(); }
document.addEventListener("pointerdown", e => {
  if (e.target.closest(".pop") || e.target.closest(".tools") || e.target.closest("#menuBtn")) return;
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
    current.bg = c; current.updated = Date.now(); saveSoon(); view.requestRender(); syncMenu();
  })));
  el.bgPattern.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String((current.pattern || "none") === b.dataset.p)));
  el.smooth.value = settings.smooth; el.smoothVal.textContent = settings.smooth ? smoothPx(settings.smooth).toFixed(1) + " px" : "off";
  el.curve.value = settings.curve; el.curveVal.textContent = settings.curve < 40 ? "soft" : settings.curve > 60 ? "firm" : "even";
  el.touchInk.setAttribute("aria-pressed", String(settings.touchInk));
}
el.bgPattern.onclick = e => {
  const b = e.target.closest("button[data-p]"); if (!b || !current) return;
  current.pattern = b.dataset.p; current.updated = Date.now(); saveSoon(); view.requestRender(); syncMenu();
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
  const imgs = b.items.filter(i => i.t === "image").map(i => i.img);
  boards.delete(b.id); current = null;
  await store.deleteBoard(b.id);
  showHome();
  toast(`Deleted “${b.name}”.`, "Undo", async () => { boards.set(b.id, b); await store.putBoard(b); openBoard(b.id); });
  // images stay until the board is gone for good (after the undo window)
  setTimeout(() => { if (!boards.has(b.id)) imgs.forEach(id => store.deleteImage(id).catch(() => {})); }, 12000);
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
  else if (k === "escape") { view.clearSelection(); closePops(); }
  else if (k === " ") { if (!view.space) { view.space = true; el.boardView.classList.add("panning"); } e.preventDefault(); }
  else if (!mod && !e.altKey) {
    const t = { v: "select", p: "pen", h: "highlighter", e: "eraser", n: "note", t: "text" }[k];
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

// ---------- start ----------
async function init() {
  setTool(settings.tool === "select" || settings.tool === "hand" || settings.tool === "eraser" ? settings.tool : settings.tool === "highlighter" ? "highlighter" : "pen");
  syncTools();
  try { for (const b of await store.allBoards()) boards.set(b.id, b); }
  catch (err) {
    console.warn(err);
    el.storageNote.hidden = false;
    el.storageNote.textContent = "This browser is blocking site storage, so boards will be lost when it closes.";
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  const m = /^#board=(.+)$/.exec(location.hash);
  if (m && boards.has(decodeURIComponent(m[1]))) openBoard(decodeURIComponent(m[1]));
  else renderHome();
}
init();

if ("serviceWorker" in navigator && location.protocol.startsWith("http") && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
  navigator.serviceWorker.register("sw.js").catch(err => console.warn("Offline support unavailable:", err));
}
