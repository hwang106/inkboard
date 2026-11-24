// Runs against a local room server: start `npm run dev` first (port 8790), then `npm test`.
// Two clients edit one room; a third joins later and must get everything; presence comes and goes.
import assert from "node:assert/strict";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

const BASE = process.env.ROOMS || "ws://127.0.0.1:8790";
const code = Array.from({ length: 6 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.random() * 32 | 0]).join("");
const wait = ms => new Promise(r => setTimeout(r, ms));

function client(name) {
  let synced = 0;
  const doc = new Y.Doc(), aw = new awarenessProtocol.Awareness(doc), relays = [];
  const ws = new WebSocket(`${BASE}/room/${code}`, { headers: { Origin: "http://localhost:5180" } });
  ws.binaryType = "arraybuffer";
  const send = (type, write) => { const e = encoding.createEncoder(); encoding.writeVarUint(e, type); write(e); if (ws.readyState === 1) ws.send(encoding.toUint8Array(e)); };
  ws.onmessage = ev => {
    const dec = decoding.createDecoder(new Uint8Array(ev.data)), t = decoding.readVarUint(dec);
    if (t === 0) {
      const e = encoding.createEncoder(); encoding.writeVarUint(e, 0);
      syncProtocol.readSyncMessage(dec, e, doc, "remote");
      if (encoding.length(e) > 1) ws.send(encoding.toUint8Array(e));
    } else if (t === 1) awarenessProtocol.applyAwarenessUpdate(aw, decoding.readVarUint8Array(dec), "remote");
    else if (t === 2) relays.push(decoding.readVarString(dec));
    else if (t === 3) synced++;
  };
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  opened.then(() => {
    send(0, e => syncProtocol.writeSyncStep1(e, doc));
    aw.setLocalStateField("user", { name });
  });
  doc.on("update", (u, origin) => { if (origin !== "remote") send(0, e => syncProtocol.writeUpdate(e, u)); });
  aw.on("update", ({ added, updated, removed }, origin) => {
    if (origin === "remote") return;
    const ids = added.concat(updated, removed);
    send(1, e => encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(aw, ids)));
  });
  return { get synced() { return synced; }, doc, aw, ws, opened, relays, relay: s => send(2, e => encoding.writeVarString(e, s)), names: () => [...aw.getStates().values()].map(s => s.user && s.user.name).filter(Boolean).sort() };
}

// Bad requests are refused
{
  const r = await fetch(BASE.replace("ws", "http") + "/room/" + code, { headers: { Origin: "https://evil.example" } });
  assert.equal(r.status, 403);
  const r2 = await fetch(BASE.replace("ws", "http") + "/room/0O0O0O", { headers: { Origin: "http://localhost:5180" } });
  assert.equal(r2.status, 400);
}

const a = client("Ana"), b = client("Ben");
await Promise.all([a.opened, b.opened]);
await wait(300);
a.doc.getMap("items").set("i1", "stroke from Ana");
b.doc.getMap("items").set("i2", "stroke from Ben");
const t = new Y.Text(); a.doc.getMap("items").set("note", t); t.insert(0, "hello");
await wait(500);
b.doc.getMap("items").get("note").insert(5, " world");
await wait(500);
assert.deepEqual([...a.doc.getMap("items").keys()].sort(), ["i1", "i2", "note"]);
assert.equal(a.doc.getMap("items").get("note").toString(), "hello world");
assert.deepEqual(a.names(), ["Ana", "Ben"]);
assert.deepEqual(b.names(), ["Ana", "Ben"]);

b.relay("live stroke");
await wait(300);
assert.deepEqual(a.relays, ["live stroke"]);
assert.deepEqual(b.relays, []);

// a late joiner gets the whole board and sees who's here
const c = client("Cy");
await c.opened; await wait(600);
assert.equal(c.doc.getMap("items").get("note").toString(), "hello world");
assert.equal(c.doc.getMap("items").get("i2"), "stroke from Ben");
assert.deepEqual(c.names(), ["Ana", "Ben", "Cy"]);

// leaving removes the cursor for everyone
b.ws.close(); await wait(600);
assert.deepEqual(a.names(), ["Ana", "Cy"]);
assert.deepEqual(c.names(), ["Ana", "Cy"]);

// lots of edits get merged into fewer rows; a newcomer still gets everything
const big = a.doc.getArray("big");
for (let i = 0; i < 450; i++) big.push(["x".repeat(3000) + i]);
await wait(2500);
const d = client("Di");
await d.opened; await wait(2500);
assert.equal(d.doc.getArray("big").length, 450);
assert.equal(d.doc.getMap("items").get("note").toString(), "hello world");
assert.ok(d.synced >= 1, "newcomer told it's synced");
assert.ok(c.synced >= 1);

a.ws.close(); c.ws.close(); d.ws.close();
console.log("room tests passed (room " + code + ")");
process.exit(0);
