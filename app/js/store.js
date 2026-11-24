// Boards and images live in this device's IndexedDB.
// board: { id, name, created, updated, bg, pattern, view: {x, y, z}, items: [...] }

const DB = "inkboard", VERSION = 1;
let dbp = null;
export const hooks = { onBlocked: null, onVersionChange: null };

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("boards")) db.createObjectStore("boards", { keyPath: "id" });
      if (!db.objectStoreNames.contains("images")) db.createObjectStore("images");
    };
    r.onblocked = () => hooks.onBlocked && hooks.onBlocked();
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => { db.close(); dbp = null; hooks.onVersionChange && hooks.onVersionChange(); };
      res(db);
    };
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
function tx(store, mode, fn) {
  return open().then(db => new Promise((res, rej) => {
    const t = db.transaction(store, mode), s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => res(out && "result" in out ? out.result : undefined);
    t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  }));
}
export const store = {
  allBoards: () => tx("boards", "readonly", s => s.getAll()),
  getBoard: id => tx("boards", "readonly", s => s.get(id)),
  putBoard: b => tx("boards", "readwrite", s => { s.put(b); }),
  deleteBoard: id => tx("boards", "readwrite", s => { s.delete(id); }),
  getImage: id => tx("images", "readonly", s => s.get(id)),
  putImage: (id, blob) => tx("images", "readwrite", s => { s.put(blob, id); }),
  deleteImage: id => tx("images", "readwrite", s => { s.delete(id); }),
};
