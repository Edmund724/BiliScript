import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const port = Number(process.env.PORT ?? 8791);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const full = path.join(root, urlPath === "/" ? "scripts/mermaid-smoke/harness.html" : urlPath);
  if (!full.startsWith(root) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": mime[path.extname(full)] ?? "application/octet-stream" });
  fs.createReadStream(full).pipe(res);
});

server.listen(port, () => {
  console.log(`mermaid smoke server: http://localhost:${port}/scripts/mermaid-smoke/harness.html`);
});
