// mermaid 冒烟静态服务器：为 scripts/mermaid-smoke/harness.html 提供 repo 根目录
// 的 HTTP 服务。harness 经 ESM import 拉取构建产物（extension/entry/chunks/
// mermaid-render.mjs 及其相对 chunk），file:// 下 CORS 禁止 ESM，必须走 HTTP；
// .mjs 需要 text/javascript MIME 才会按模块解析。手动/按需跑（不纳入 pnpm test）：
//   node scripts/mermaid-smoke/serve.mjs   # 然后经 kimi-webbridge 打开打印的 URL
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
