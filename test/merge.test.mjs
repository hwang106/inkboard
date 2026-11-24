// node test/merge.test.mjs — merging two devices' copies of a board.
import assert from "node:assert/strict";
import { mergeBoards } from "../app/js/merge.js";
const now = 1_000_000_000;
const base = { id: "b", name: "Plan", bg: "#fff", pattern: "none", updated: 100, items: [{ id: "s1", u: 10 }, { id: "s2", u: 20 }], gone: {} };

// both devices added a stroke: both kept, needs re-upload
let surface = { ...base, updated: 300, items: [...base.items, { id: "a", u: 300 }], view: { z: 1 } };
let phone = { ...base, updated: 250, items: [...base.items, { id: "p", u: 250 }], view: { z: 2 } };
let r = mergeBoards(surface, phone, now);
assert.deepEqual(r.board.items.map(i => i.id).sort(), ["a", "p", "s1", "s2"]);
assert.equal(r.changedFromRemote, true);
assert.deepEqual(r.board.view, { z: 1 }, "keeps this device's view");

// phone deleted s1, surface moved s2: s1 gone, s2 moved
surface = { ...base, updated: 400, items: [{ id: "s1", u: 10 }, { id: "s2", u: 400, x: 5 }] };
phone = { ...base, updated: 350, items: [{ id: "s2", u: 20 }], gone: { s1: 350 } };
r = mergeBoards(surface, phone, now);
assert.deepEqual(r.board.items.map(i => i.id), ["s1", "s2"].filter(id => id !== "s1"));
assert.equal(r.board.items[0].x, 5);

// an item edited after it was deleted elsewhere comes back (the later edit wins)
r = mergeBoards({ ...base, updated: 500, items: [{ id: "s1", u: 500 }] }, { ...base, updated: 400, items: [], gone: { s1: 400 } }, now);
assert.deepEqual(r.board.items.map(i => i.id), ["s1"]);

// nothing new here: no re-upload
r = mergeBoards({ ...base }, { ...base, updated: 120, name: "Plan 2" }, now);
assert.equal(r.changedFromRemote, false);
assert.equal(r.board.name, "Plan 2");

// board deleted elsewhere after the last local edit
r = mergeBoards({ ...base, updated: 100 }, { id: "b", deleted: true, updated: 200 }, now);
assert.equal(r.board.deleted, true);
// reactions: per person and emoji, the later change wins; comments merge like items
r = mergeBoards(
  { ...base, updated: 300, reactions: { "s1|👍|me": { on: false, u: 300 }, "s1|🎉|me": { on: true, u: 50 } }, comments: [{ id: "c1", u: 10, text: "a" }] },
  { ...base, updated: 200, reactions: { "s1|👍|me": { on: true, u: 100 }, "s1|❤️|you": { on: true, u: 150 } }, comments: [{ id: "c2", u: 20, text: "b" }] }, now);
assert.equal(r.board.reactions["s1|👍|me"].on, false);
assert.equal(r.board.reactions["s1|❤️|you"].on, true);
assert.equal(r.board.reactions["s1|🎉|me"].on, true);
assert.deepEqual(r.board.comments.map(c => c.id).sort(), ["c1", "c2"]);
assert.equal(r.changedFromRemote, true);
console.log("merge tests passed");
