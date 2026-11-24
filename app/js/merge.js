// Merging two copies of a board (this device's and one from OneDrive), item by item.
//
// Every item carries `u`, the time it was last changed; `board.gone` maps deleted item ids to
// when they were deleted. Per item the latest change wins, so strokes added on the Surface and on
// the phone between syncs both survive. Board-level fields (name, background, comments...) come
// from whichever copy was edited last. Each device keeps its own view (where it was looking).

const GONE_KEEP_MS = 90 * 24 * 3600e3;   // forget deletions after 90 days

const byId = list => new Map((list || []).map(x => [x.id, x]));

function mergeList(a, b, gone, newerFirst) {
  const A = byId(a), B = byId(b), out = [];
  const order = newerFirst === "a" ? [...(a || []), ...(b || [])] : [...(b || []), ...(a || [])];
  const seen = new Set();
  for (const x of order) {
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    const pa = A.get(x.id), pb = B.get(x.id);
    const win = !pa ? pb : !pb ? pa : (pb.u || 0) > (pa.u || 0) ? pb : pa;
    if (gone[x.id] && gone[x.id] >= (win.u || 0)) continue;
    out.push(win);
  }
  return out;
}

// Reactions: per person and emoji, the latest change (on or off) wins.
function mergeReactions(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) if (!out[k] || ((v && v.u) || 0) > ((out[k] && out[k].u) || 0)) out[k] = v;
  return out;
}

// local: this device's board (may be undefined); remote: the copy from OneDrive.
// Returns { board, changedFromRemote } — changedFromRemote: the result differs from `remote`,
// so it needs uploading again.
export function mergeBoards(local, remote, now = Date.now()) {
  if (!local) return { board: remote, changedFromRemote: false };
  if (remote.deleted || local.deleted) {
    const win = (remote.updated || 0) >= (local.updated || 0) ? remote : local;
    return { board: { ...win, view: local.view }, changedFromRemote: win !== remote };
  }
  const gone = {};
  for (const g of [local.gone || {}, remote.gone || {}]) for (const [id, t] of Object.entries(g)) {
    if (now - t < GONE_KEEP_MS && !(gone[id] >= t)) gone[id] = t;
  }
  const remoteNewer = (remote.updated || 0) > (local.updated || 0);
  const meta = remoteNewer ? remote : local;
  const items = mergeList(local.items, remote.items, gone, remoteNewer ? "b" : "a");
  const comments = mergeList(local.comments, remote.comments, gone, remoteNewer ? "b" : "a");
  const board = {
    ...meta, items, comments, gone, view: local.view,
    reactions: mergeReactions(local.reactions, remote.reactions),
    updated: Math.max(local.updated || 0, remote.updated || 0),
  };
  const same = (x, y) => x.length === y.length && x.every((it, i) => it === y[i]);
  const changedFromRemote = !remoteNewer && (local.name !== remote.name || local.bg !== remote.bg || local.pattern !== remote.pattern)
    || !same(items, remote.items || []) || !same(comments, remote.comments || [])
    || Object.entries(board.reactions).some(([k, v]) => (remote.reactions || {})[k] !== v);
  if (changedFromRemote) board.updated = Math.max(board.updated, now);
  return { board, changedFromRemote };
}
