// Comments (pinned threads with replies) and emoji reactions on items and comments.
//
// board.comments: [{ id, x, y, text, by: {id, name, color}, at, u, resolved?, parent? }]
//   a thread is a comment with x, y; replies carry `parent` instead.
// board.reactions: { "targetId|emoji|personId": { on, u, name } }
// Both work offline, sync to OneDrive with the board, and go live through the room when shared.
import { uid } from "./board.js";
import { bounds } from "./render.js";

export const EMOJIS = ["👍", "❤️", "😂", "🎉", "⭐", "👀", "✅", "❓"];

const initials = n => (n || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase() || "?";
function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
}
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "style") for (const [p, x] of Object.entries(v)) e.style.setProperty(p.replace(/[A-Z]/g, c => "-" + c.toLowerCase()), x);
    else if (k.startsWith("on")) e[k] = v;
    else if (k === "text") e.textContent = v;
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  e.append(...kids.filter(k => k != null));
  return e;
}

// el: the page's elements by id. view: BoardView. me(): {id, name, color}. live(): the room
// session or null. changed(): save the board.
export function createComments({ el, view, me, live, changed, toast }) {
  let openId = null, draft = null;   // draft: { x, y } of a comment being written

  const board = () => view.board;
  const list = () => board().comments || (board().comments = []);
  const threads = () => list().filter(c => !c.parent).sort((a, b) => a.at - b.at);
  const repliesOf = id => list().filter(c => c.parent === id).sort((a, b) => a.at - b.at);
  const find = id => list().find(c => c.id === id);

  function reactionsFor(target) {
    const out = new Map(), mine = me().id;
    for (const [k, v] of Object.entries(board().reactions || {})) {
      if (!v || !v.on) continue;
      const [t, emoji, who] = k.split("|");
      if (t !== target) continue;
      const r = out.get(emoji) || { n: 0, mine: false, names: [] };
      r.n++; r.names.push(v.name || "Someone"); if (who === mine) r.mine = true;
      out.set(emoji, r);
    }
    return out;
  }
  function setReaction(target, emoji, on) {
    const b = board(), key = `${target}|${emoji}|${me().id}`;
    const v = { on, u: Date.now(), name: me().name };
    (b.reactions || (b.reactions = {}))[key] = v;
    const L = live(); if (L) L.setReaction(key, v);
    changed(); render();
  }
  const toggleReaction = (target, emoji) => setReaction(target, emoji, !reactionsFor(target).get(emoji)?.mine);

  // ---------- writing ----------
  function post(text) {
    text = text.trim(); if (!text) return;
    const now = Date.now(), who = me();
    let c;
    if (draft) c = { id: uid(), x: draft.x, y: draft.y, text, by: who, at: now, u: now };
    else if (openId) c = { id: uid(), parent: openId, text, by: who, at: now, u: now };
    else return;
    list().push(c);
    const L = live(); if (L) L.setComment(c);
    if (draft) { draft = null; openId = c.id; }
    el.threadText.value = "";
    changed(); render();
  }
  function update(c, fields) {
    const n = { ...c, ...fields, u: Date.now() };
    const arr = list(), i = arr.indexOf(c); arr[i] = n;
    const L = live(); if (L) L.setComment(n);
    changed(); render();
  }
  function remove(c) {
    const b = board(), now = Date.now(), gone = b.gone || (b.gone = {});
    const ids = [c.id, ...repliesOf(c.id).map(r => r.id)];
    b.comments = list().filter(x => !ids.includes(x.id));
    const L = live();
    for (const id of ids) { gone[id] = now; if (L) L.deleteComment(id, now); }
    if (ids.includes(openId)) openId = null;
    changed(); render();
  }

  // ---------- pins and reaction badges over the canvas ----------
  function toScreen(x, y) { const v = view.view; return [(x - v.x) * v.z, (y - v.y) * v.z]; }
  function renderPins() {
    if (!board()) { el.pins.replaceChildren(); return; }
    const out = [];
    for (const c of threads()) {
      const [sx, sy] = toScreen(c.x, c.y), n = repliesOf(c.id).length;
      if (sx < -40 || sy < -40 || sx > view.cssW + 40 || sy > view.cssH + 40) continue;
      out.push(h("button", {
        type: "button", class: "pin" + (c.resolved ? " resolved" : "") + (c.id === openId ? " open" : ""),
        style: { left: sx + "px", top: sy + "px", "--c": c.by?.color || "#2b59c3" },
        title: `${c.by?.name || "Someone"}: ${c.text}`, "aria-label": `Comment from ${c.by?.name || "someone"}${n ? `, ${n} replies` : ""}`,
        onclick: e => { e.stopPropagation(); open(c.id); },
      }, h("span", { text: c.resolved ? "✓" : initials(c.by?.name) }), n ? h("b", { text: String(n + 1) }) : null));
    }
    if (draft) {
      const [sx, sy] = toScreen(draft.x, draft.y);
      out.push(h("span", { class: "pin open draft", style: { left: sx + "px", top: sy + "px", "--c": me().color } }, h("span", { text: "+" })));
    }
    // reactions on items
    const byTarget = new Map();
    for (const [k, v] of Object.entries(board().reactions || {})) if (v && v.on) { const t = k.split("|")[0]; byTarget.set(t, true); }
    if (byTarget.size) {
      const items = new Map(board().items.map(i => [i.id, i]));
      for (const t of byTarget.keys()) {
        const it = items.get(t); if (!it) continue;
        const b = bounds(it), [sx, sy] = toScreen(b.x1, b.y1);
        if (sx < -200 || sy < -40 || sx > view.cssW + 40 || sy > view.cssH + 40) continue;
        out.push(h("div", { class: "badges", style: { left: sx + "px", top: (sy + 6) + "px" } }, ...reactionButtons(t)));
      }
    }
    el.pins.replaceChildren(...out);
  }
  function reactionButtons(target) {
    return [...reactionsFor(target)].map(([emoji, r]) => h("button", {
      type: "button", class: "react" + (r.mine ? " mine" : ""), title: r.names.join(", "),
      "aria-label": `${emoji} ${r.n}${r.mine ? ", including you" : ""}`, "aria-pressed": String(r.mine),
      onclick: e => { e.stopPropagation(); toggleReaction(target, emoji); },
    }, emoji + " ", h("span", { text: String(r.n) })));
  }

  // ---------- the thread popover ----------
  function open(id) { draft = null; openId = id; el.commentsPanel.hidden = true; render(); el.threadText.focus({ preventScroll: true }); }
  function startDraft(x, y) { openId = null; draft = { x, y }; el.threadText.value = ""; render(); el.threadText.focus({ preventScroll: true }); }
  function close() { openId = null; draft = null; render(); }
  function placeThread() {
    const at = draft || (openId && find(openId));
    if (!at) { el.thread.hidden = true; return; }
    el.thread.hidden = false;
    const [sx, sy] = toScreen(at.x, at.y), w = el.thread.offsetWidth || 300, ht = el.thread.offsetHeight || 200;
    let left = sx + 22, top = sy - 20;
    if (left + w > view.cssW - 8) left = sx - w - 22;
    left = Math.max(8, Math.min(view.cssW - w - 8, left));
    top = Math.max(64, Math.min(view.cssH - ht - 76, top));
    el.thread.style.left = left + "px"; el.thread.style.top = top + "px";
  }
  function renderThread() {
    const root = openId && find(openId);
    if (openId && !root) openId = null;
    if (!openId && !draft) { el.thread.hidden = true; return; }
    const msgs = root ? [root, ...repliesOf(root.id)] : [];
    const mine = me().id;
    el.threadList.replaceChildren(...msgs.map(c => h("article", { class: "msg" },
      h("header", {},
        h("span", { class: "avatar", style: { background: c.by?.color || "#888" }, text: initials(c.by?.name) }),
        h("b", { text: c.by?.name || "Someone" }), h("time", { text: ago(c.at), title: new Date(c.at).toLocaleString() }),
        c.by?.id === mine ? h("button", { type: "button", class: "msg-del", title: c === root ? "Delete thread" : "Delete", "aria-label": "Delete comment",
          onclick: () => remove(c) }, "×") : null),
      h("p", { text: c.text }),
      h("div", { class: "msg-reacts" }, ...reactionButtons(c.id), emojiAdder(c.id)))));
    el.threadResolve.hidden = !root;
    if (root) el.threadResolve.textContent = root.resolved ? "Reopen" : "Resolve";
    el.threadText.placeholder = root ? "Reply" : "Add a comment";
    el.threadPost.textContent = root ? "Reply" : "Post";
    placeThread();
  }
  function emojiAdder(target) {
    const menu = h("div", { class: "emoji-menu", hidden: true }, ...EMOJIS.map(e => h("button", {
      type: "button", "aria-label": "React " + e, onclick: ev => { ev.stopPropagation(); toggleReaction(target, e); },
    }, e)));
    const btn = h("button", { type: "button", class: "react add", title: "Add a reaction", "aria-label": "Add a reaction",
      onclick: ev => { ev.stopPropagation(); menu.hidden = !menu.hidden; } }, "☺+");
    return h("span", { class: "adder" }, btn, menu);
  }

  // ---------- the list of all comments ----------
  function renderPanel() {
    const all = board() ? threads() : [];
    const open = all.filter(c => !c.resolved).length;
    el.commentsBtn.hidden = !all.length;
    el.commentsCount.textContent = open ? String(open) : "";
    if (el.commentsPanel.hidden) return;
    el.commentsList.replaceChildren(...(all.length ? all.map(c => h("button", {
      type: "button", class: "thread-row" + (c.resolved ? " resolved" : ""),
      onclick: () => { goTo(c); open_(c.id); },
    }, h("span", { class: "avatar", style: { background: c.by?.color || "#888" }, text: initials(c.by?.name) }),
      h("span", { class: "thread-text" }, h("b", { text: (c.by?.name || "Someone") + (c.resolved ? " · resolved" : "") }), h("span", { text: c.text })),
      h("span", { class: "thread-n", text: repliesOf(c.id).length ? String(repliesOf(c.id).length + 1) : "" }))) : [h("p", { class: "pop-hint", text: "No comments yet." })]));
  }
  const open_ = id => open(id);
  function goTo(c) {
    const v = view.view;
    view.setView(c.x - view.cssW / 2 / v.z, c.y - view.cssH / 2 / v.z, v.z);
  }

  function render() { renderPins(); renderThread(); renderPanel(); }

  // ---------- wiring ----------
  el.threadPost.onclick = () => post(el.threadText.value);
  el.threadText.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey || !e.shiftKey)) { e.preventDefault(); post(el.threadText.value); }
    if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  el.threadClose.onclick = close;
  el.threadResolve.onclick = () => { const c = openId && find(openId); if (c) { update(c, { resolved: !c.resolved }); if (!c.resolved) close(); } };
  el.commentsBtn.onclick = () => { el.commentsPanel.hidden = !el.commentsPanel.hidden; close(); renderPanel(); };
  el.commentsPanelClose.onclick = () => { el.commentsPanel.hidden = true; };
  // reactions from the selection bar
  el.selReact.onclick = e => { e.stopPropagation(); el.reactPop.hidden = !el.reactPop.hidden; };
  el.reactPop.replaceChildren(...EMOJIS.map(emoji => h("button", { type: "button", "aria-label": "React " + emoji, onclick: () => {
    const sel = view.selected(); if (!sel.length) return;
    const on = !sel.every(it => reactionsFor(it.id).get(emoji)?.mine);
    for (const it of sel) setReaction(it.id, emoji, on);
    el.reactPop.hidden = true;
  } }, emoji)));

  return {
    render, startDraft, close,
    get openId() { return openId; },
    isOpen: () => !!(openId || draft),
  };
}
