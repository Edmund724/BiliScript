import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_DIST = path.join(REPO_ROOT, "dist");

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  path.join(os.homedir(), "AppData", "Local", "Microsoft", "Edge", "Application", "msedge.exe")
];

export function resolveEdgePath(explicit) {
  if (explicit) return explicit;
  if (process.env.BILISCRIPT_EDGE) return process.env.BILISCRIPT_EDGE;
  const hit = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!hit) throw new Error(`找不到 Edge，可用 BILISCRIPT_EDGE 指定。试过：\n  ${EDGE_CANDIDATES.join("\n  ")}`);
  return hit;
}

const logLines = [];
export function log(msg) {
  const line = `${new Date().toISOString().slice(11, 23)} ${msg}`;
  logLines.push(line);
  console.log(line);
}
export function getLog() {
  return [...logLines];
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

export class CDP {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
  }

  static async connect(url, { timeoutMs = 15000 } = {}) {
    const client = new CDP(url);
    await client.open(timeoutMs);
    return client;
  }

  open(timeoutMs) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error(`CDP 连接超时：${this.url}`)), timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", (event) => {
        clearTimeout(timer);
        reject(new Error(`CDP 连接失败：${event?.message || "error"}`));
      });
      ws.addEventListener("message", (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.id !== undefined) {
          const entry = this.pending.get(msg.id);
          if (!entry) return;
          this.pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`));
          else entry.resolve(msg.result);
          return;
        }
        const list = this.handlers.get(msg.method);
        if (list) for (const fn of list) fn(msg.params, msg.sessionId);
      });
      ws.addEventListener("close", () => {
        this.closed = true;
        for (const [, entry] of this.pending) entry.reject(new Error("CDP 连接已关闭"));
        this.pending.clear();
      });
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  send(method, params = {}, sessionId, timeoutMs = 25000) {
    if (this.closed) return Promise.reject(new Error("CDP 连接已关闭"));
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时(${timeoutMs}ms)：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        method
      });
      this.ws.send(JSON.stringify(payload));
    });
  }

  async evaluate(expression, { sessionId, timeoutMs = 30000, awaitPromise = true } = {}) {
    const result = await this.send(
      "Runtime.evaluate",
      { expression, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: true },
      sessionId,
      timeoutMs
    );
    if (result?.exceptionDetails) {
      throw new Error(`求值异常：${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    }
    return result?.result?.value;
  }

  close() {
    try {
      this.ws?.close();
    } catch {}
  }
}

export async function waitFor(label, fn, { timeoutMs = 20000, intervalMs = 200 } = {}) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = { error: error.message };
    }
    await sleep(intervalMs);
  }
  throw new Error(`等待超时(${timeoutMs}ms)：${label}；最后一次=${JSON.stringify(last)?.slice(0, 200)}`);
}

export const DEFAULT_VIEWPORT = { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false };

export async function launchBrowser({
  distDir = DEFAULT_DIST,
  edgePath,
  headless = true,
  muted = true,
  autoplay = false,
  sync = false,
  viewport = DEFAULT_VIEWPORT,
  extraArgs = [],
  profilePrefix = "biliscript-harness-"
} = {}) {
  if (!existsSync(path.join(distDir, "manifest.json"))) {
    throw new Error(`dist 里没有 manifest.json：${distDir}（先跑 pnpm build）`);
  }
  const port = await freePort();
  const profileDir = await mkdtemp(path.join(os.tmpdir(), profilePrefix));
  const args = [
    ...(headless ? ["--headless=new"] : []),
    ...(muted ? ["--mute-audio"] : []),
    ...(autoplay ? ["--autoplay-policy=no-user-gesture-required"] : []),
    ...(sync ? [] : ["--disable-sync"]),
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${distDir}`,
    `--load-extension=${distDir}`,
    `--remote-debugging-port=${port}`,
    `--window-size=${viewport.width},${viewport.height}`,
    ...extraArgs,
    "about:blank"
  ];
  const exe = resolveEdgePath(edgePath);
  log(
    `启动 ${headless ? "headless " : ""}Edge（${muted ? "静音" : "未静音"}${autoplay ? " / 允许自动播放" : ""} / 同步${sync ? "开" : "关"}）：port=${port} profile=${profileDir}`
  );
  const child = spawn(exe, args, { detached: false, stdio: ["ignore", "pipe", "pipe"] });
  const browser = { child, pid: child.pid, exe, port, profileDir, version: null, args, muted, autoplay, sync };
  child.stderr.on("data", (d) => {
    const s = String(d).trim();
    if (s && !/DevTools listening|GCM|Registration response|voice_transcription/i.test(s)) log(`[edge] ${s.slice(0, 200)}`);
  });
  child.on("exit", (code) => log(`Edge 退出 code=${code}`));

  browser.version = await waitFor(
    "CDP /json/version",
    async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    },
    { timeoutMs: 30000, intervalMs: 300 }
  );
  log(`引擎：${browser.version.Browser}`);
  return browser;
}

export async function listTargets(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    const list = await res.json();
    return list.map((t) => ({ type: t.type, url: t.url, title: t.title, ws: Boolean(t.webSocketDebuggerUrl) }));
  } catch (error) {
    return [{ error: error.message }];
  }
}

export async function attachPage(browser, { viewport = DEFAULT_VIEWPORT } = {}) {
  const target = await waitFor(
    "页面 target",
    async () => {
      const res = await fetch(`http://127.0.0.1:${browser.port}/json/list`);
      const list = await res.json();
      return list.find((t) => t.type === "page");
    },
    { timeoutMs: 15000, intervalMs: 300 }
  );
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Log.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", viewport);
  return { cdp, target, viewport };
}

export function watchPage(pageCdp, { limit = 400 } = {}) {
  const consoleLog = [];
  const netLog = [];
  const push = (arr, entry) => {
    if (arr.length < limit) arr.push(entry);
  };
  pageCdp.on("Runtime.consoleAPICalled", (params) => {
    push(consoleLog, {
      type: params.type,
      text: (params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ").slice(0, 400)
    });
  });
  pageCdp.on("Log.entryAdded", (params) => {
    push(consoleLog, { type: `log:${params.entry.level}`, text: String(params.entry.text || "").slice(0, 400) });
  });
  pageCdp.on("Network.responseReceived", (params) => {
    push(netLog, { phase: "responseReceived", url: params.response.url, status: params.response.status, mimeType: params.response.mimeType });
  });
  pageCdp.on("Network.loadingFailed", (params) => {
    push(netLog, { phase: "loadingFailed", requestId: params.requestId, errorText: params.errorText, blockedReason: params.blockedReason || null });
  });
  return { consoleLog, netLog };
}

export function readWorkerEntry(distDir = DEFAULT_DIST) {
  const manifestPath = path.join(distDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entry = manifest?.background?.service_worker;
  if (!entry) throw new Error(`manifest.json 没有 background.service_worker：${manifestPath}`);
  return { entry, suffix: `/${entry}` };
}

export async function attachExtensionWorker(pageCdp, browser, { distDir = DEFAULT_DIST } = {}) {
  const { entry, suffix } = readWorkerEntry(distDir);
  const wanted = (t) => String(t.url || "").startsWith("chrome-extension://") && String(t.url || "").endsWith(suffix);

  try {
    const res = await fetch(`http://127.0.0.1:${browser.port}/json/list`);
    const list = await res.json();
    const target = list.find((t) => t.type === "service_worker" && wanted(t));
    if (target?.webSocketDebuggerUrl) {
      const cdp = await CDP.connect(target.webSocketDebuggerUrl);
      return { cdp, sessionId: null, targetId: target.targetId, url: target.url, via: "json-list", suffix };
    }
  } catch (error) {
    log(`/json/list 找 SW 失败：${error.message}`);
  }

  const targets = await pageCdp.send("Target.getTargets");
  const target = (targets.targetInfos || []).find((t) => t.type === "service_worker" && wanted(t));
  if (!target) {
    const all = await listTargets(browser.port);
    throw new Error(`找不到扩展服务工作线程 target（manifest 声明 ${entry}）。现有 target：${JSON.stringify(all)}`);
  }
  const attached = await pageCdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  return { cdp: pageCdp, sessionId: attached.sessionId, targetId: target.targetId, url: target.url, via: "attachToTarget", suffix };
}

export function createWorkerSession({ pageCdp, browser, distDir = DEFAULT_DIST, onReconnect } = {}) {
  let handle = null;

  function dropHandle() {
    try {
      handle?.cdp?.close?.();
    } catch {}
    handle = null;
  }

  async function connect() {
    handle = await attachExtensionWorker(pageCdp, browser, { distDir });
    const h = handle;
    await h.cdp.send("Runtime.enable", {}, h.sessionId, 20000);
    await h.cdp.send("Runtime.runIfWaitingForDebugger", {}, h.sessionId, 5000).catch(() => {});
    try {
      await waitFor(
        "SW 扩展上下文就绪（typeof chrome === 'object'）",
        async () => {
          try {
            return (await h.cdp.evaluate("typeof chrome", { sessionId: h.sessionId, timeoutMs: 4000 })) === "object";
          } catch {
            return false;
          }
        },
        { timeoutMs: 30000, intervalMs: 250 }
      );
    } catch (error) {
      dropHandle();
      throw error;
    }
    log(`SW 已连接（${h.via}）：${h.url}`);
    return handle;
  }

  function evalIn(expression, timeoutMs = 30000) {
    if (!handle) throw new Error("SW 未连接");
    return handle.cdp.evaluate(expression, { sessionId: handle.sessionId, timeoutMs });
  }

  async function ensureAlive() {
    if (handle && !handle.cdp.closed) return true;
    try {
      await waitFor(
        "扩展 SW target 重新出现",
        async () => {
          await connect();
          return true;
        },
        { timeoutMs: 45000, intervalMs: 300 }
      );
      if (onReconnect) await onReconnect(handle);
      return true;
    } catch (error) {
      log(`SW 重连失败：${error.message}`);
      return false;
    }
  }

  async function evaluate(expression, timeoutMs = 30000) {
    try {
      return await evalIn(expression, timeoutMs);
    } catch (error) {
      log(`SW 求值失败，重连重试：${error.message}`);
      dropHandle();
      if (!(await ensureAlive())) throw error;
      return await evalIn(expression, timeoutMs);
    }
  }

  return { connect, evaluate, ensureAlive, get handle() { return handle; } };
}

export async function screenshot(pageCdp, filePath) {
  const result = await pageCdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.from(result.data, "base64"));
  log(`截图 ${path.relative(REPO_ROOT, filePath)}`);
  return filePath;
}

export function artifactDir(name, { root = path.join(REPO_ROOT, ".scratch", "browser-harness") } = {}) {
  return path.join(root, name);
}

export async function writeEvidence(dir, evidence, { filename = "evidence.json" } = {}) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, filename);
  await writeFile(file, JSON.stringify(evidence, null, 2), "utf8");
  log(`工件：${path.relative(REPO_ROOT, file)}`);
  return file;
}

function killByProfilePath(profileDir, exePath) {
  const needle = profileDir.replace(/'/g, "''");
  const exeName = (exePath ? path.basename(exePath) : "msedge.exe").replace(/'/g, "''");
  const script =
    `Get-CimInstance Win32_Process ` +
    `| Where-Object { $_.ProcessId -ne $PID -and $_.Name -eq '${exeName}' -and $_.CommandLine -and $_.CommandLine.Contains('${needle}') } ` +
    `| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  return new Promise((resolve) => {
    const p = spawn("powershell", ["-NoProfile", "-Command", script], { stdio: "ignore" });
    p.on("exit", resolve);
    p.on("error", resolve);
    setTimeout(resolve, 8000);
  });
}

export async function teardown({ browser, cdps = [] } = {}) {
  try {
    for (const cdp of cdps) cdp?.close?.();
  } catch {}
  if (browser?.child && browser.pid) {
    log(`清理：taskkill /PID ${browser.pid} /T /F`);
    await new Promise((resolve) => {
      const k = spawn("taskkill", ["/PID", String(browser.pid), "/T", "/F"], { stdio: "ignore" });
      k.on("exit", resolve);
      k.on("error", resolve);
      setTimeout(resolve, 8000);
    });
  }
  if (browser?.profileDir) {
    await sleep(400);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await rm(browser.profileDir, { recursive: true, force: true, maxRetries: 3 });
        browser.profileRemoved = true;
        browser.profileRemoveError = null;
        break;
      } catch (error) {
        browser.profileRemoved = false;
        browser.profileRemoveError = error.message;
        if (attempt === 1) {
          log(`profile 删除失败，按 profile 路径补杀：${error.message}`);
          await killByProfilePath(browser.profileDir, browser.exe);
          await sleep(200);
        } else {
          log(`profile 仍未删除：${error.message}`);
        }
      }
    }
  }
}

export async function withBrowser(options, fn) {
  const browser = await launchBrowser(options);
  const ctx = { browser };
  try {
    return await fn(ctx);
  } finally {
    await teardown({ browser, cdps: ctx.cdps || [] });
  }
}
