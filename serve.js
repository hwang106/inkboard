// Tiny local web server for developing InkBoard: node serve.js [--port=5180]
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "app");
const PORT = Number((process.argv.find(a => a.startsWith("--port=")) || "").slice(7)) || 5180;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end("Not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  });
}).listen(PORT, () => console.log(`InkBoard on http://localhost:${PORT}/`));
