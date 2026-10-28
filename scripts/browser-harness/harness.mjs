// 真机验证薄层 —— 零依赖 CDP。
//
// 为什么手写 CDP：本机没有 Playwright/Puppeteer；Node 自带全局 fetch 与 WebSocket，
// 够连 http://127.0.0.1:<port>/json/list 拿到页面 / 服务工作线程的
// webSocketDebuggerUrl，直接说协议。
//
// 本文件只装备管道：起浏览器 → 连 target → 求值 / 等 / 截图 → 收摊。
// 场景自己的步骤、fixture、断言写在自己的 .mjs 里（见 README.md 与 smoke.mjs）。
//
// 硬约束：只杀自己 spawn 的进程（taskkill /PID <pid> /T /F，兜底按唯一 profile 路径
// 过滤）；端口与临时 profile 唯一；结束删 profile；工件只写到自己指定的 outDir。

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_DIST = path.join(REPO_ROOT, "dist");

// Edge 路径按候选链找，可用 BILISCRIPT_EDGE 覆盖。
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

// ===== 日志 =====
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

// ===== CDP 客户端 =====
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

// ===== 轮询等待 =====
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

// ===== 起浏览器 =====
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
  profilePrefix = "biliscript-harness-",
  profileDir: requestedProfileDir,
  detached = false
} = {}) {
  if (!existsSync(path.join(distDir, "manifest.json"))) {
    throw new Error(`dist 里没有 manifest.json：${distDir}（先跑 pnpm build）`);
  }
  const port = await freePort();
  const profileDir = requestedProfileDir || await mkdtemp(path.join(os.tmpdir(), profilePrefix));
  const args = [
    ...(headless ? ["--headless=new"] : []),
    // 无头实例没有窗口也没有标签静音入口：出声之后只能杀进程。扩展自己的
    // seekReadingTarget 会 video.play()（阅读视图点时间戳 = 暂停即播放），
    // B 站页面本身也可能自动播放，所以默认静音。要真声音传 muted: false。
    ...(muted ? ["--mute-audio"] : []),
    // 新 headless 是「真 Chrome」，默认要用户手势：不打招呼的话 video.play() 抛
    // NotAllowedError、AudioContext 停在 suspended。默认不改这个策略（那是产品行为），
    // 需要「像用户已经点过一下」的场景显式 autoplay: true。
    ...(autoplay ? ["--autoplay-policy=no-user-gesture-required"] : []),
    // 临时 profile **不等于**干净环境：本机 Edge 会用 Windows 账户自动登录，起跑之后云端
    // 会给同一个扩展 ID 回放一份 chrome.storage.sync（实测一次 13 个键，含
    // bilingualSubtitles: true→false 与 secondarySubtitleLang: ai-ja→ai-en），落在场景中途
    // 就把读数翻掉了：随机、且看起来完全像产品 bug。默认关掉「同步」这件事本身。
    // 关的是同步不是存储能力：`chrome.storage.sync` 照常读写，只是不出本机
    // （smoke 的 sw-storage-sync-works 就在真机上钉这一点）。要真同步行为传 sync: true。
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
  const child = spawn(exe, args, { detached, stdio: ["ignore", "pipe", "pipe"] });
  const browser = { child, pid: child.pid, exe, port, profileDir, ownsProfile: !requestedProfileDir, version: null, args, muted, autoplay, sync };
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

// ===== 连页面 =====
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

// 观察页面 console / 网络失败，返回两个可读数组。截断上限防止长跑爆内存。
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

// ===== 连扩展服务工作线程 =====
// SW 入口从 dist/manifest.json 的 background.service_worker 读，不硬编码：同 profile 里还有
// Edge 自带的 background.rollup.js（组件扩展），打错 worker 会让 SW 内的补丁静默失效。
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

  // 优先 /json/list（直接给出该 worker 自己的调试地址）
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

  // 兜底：页面连接上 Target.getTargets + attachToTarget(flatten)
  const targets = await pageCdp.send("Target.getTargets");
  const target = (targets.targetInfos || []).find((t) => t.type === "service_worker" && wanted(t));
  if (!target) {
    const all = await listTargets(browser.port);
    throw new Error(`找不到扩展服务工作线程 target（manifest 声明 ${entry}）。现有 target：${JSON.stringify(all)}`);
  }
  const attached = await pageCdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  return { cdp: pageCdp, sessionId: attached.sessionId, targetId: target.targetId, url: target.url, via: "attachToTarget", suffix };
}

// SW 侧求值句柄：createWorkerSession 统一管连接与重连。
export function createWorkerSession({ pageCdp, browser, distDir = DEFAULT_DIST, onReconnect } = {}) {
  let handle = null;

  function dropHandle() {
    try {
      handle?.cdp?.close?.();
    } catch {}
    handle = null;
  }

  // 连上并等到扩展上下文真的绑定。两段等待分开的原因（实测 Edge 154）：
  //   ① 连上的瞬间 SW 可能还没跑起来 → Runtime.enable 立刻返回，但 `typeof chrome` 是
  //      "undefined"（没有执行上下文）。
  //   ② SW 正在跑它的模块图时，发给它的 CDP 命令会**排队**，不是报错——这一窗口里
  //      Runtime.enable / Runtime.evaluate 会超时不返回，几秒后自己就好了。
  // 所以等期间只轮询、不判死：短超时探一下，吊住就再来一轮，整体给足 30s。
  async function connect() {
    handle = await attachExtensionWorker(pageCdp, browser, { distDir });
    const h = handle;
    // Runtime.enable 自己也在这个排队窗口里：超时给长一点，别把它当死连接。
    await h.cdp.send("Runtime.enable", {}, h.sessionId, 20000);
    await h.cdp.send("Runtime.runIfWaitingForDebugger", {}, h.sessionId, 5000).catch(() => {});
    try {
      await waitFor(
        "SW 扩展上下文就绪（typeof chrome === 'object'）",
        async () => {
          try {
            return (await h.cdp.evaluate("typeof chrome", { sessionId: h.sessionId, timeoutMs: 4000 })) === "object";
          } catch {
            return false; // 排队中，不是失败
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
    // MV3 SW 被回收后 target 会短暂从 /json/list 消失，等它现身再连。
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

  // 求值失败分两种，这里一律先丢连接再重连一次：
  //   ① SW 启动中/忙 → 命令排队超时（重连反而更快拿到一个已就绪的 SW）；
  //   ② target 已被 MV3 回收 → 旧 WebSocket 还开着但永不返回，只有重连能救。
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

// ===== 截图 =====
export async function screenshot(pageCdp, filePath) {
  const result = await pageCdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.from(result.data, "base64"));
  log(`截图 ${path.relative(REPO_ROOT, filePath)}`);
  return filePath;
}

// ===== 工件 =====
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

// ===== 收摊 =====
// taskkill /T 覆盖不到的兜底：浏览器重新 fork 后可能脱离进程树，此时按 profile 路径把还挂着
// 的进程找出来。三条实测要点（都踩过，第三次差点把自己宿主杀了）：
//   ① 用 .Contains() 而不是 -like：路径里的反斜杠在 -like 里是字面量，不能再转义一次
//      （写成 `\\` 就永远匹配不到任何东西，兜底静默失效）；.Contains() 还顺带免疫路径里
//      可能出现的 `[` `?` `*` 通配符。
//   ② 必须排除 $PID：这条命令自己的命令行里也有那串路径，不排除就会把自己
//      Stop-Process 掉，枚举半路中断、后面的进程杀不完。
//   ③ 必须再限制进程名（浏览器 exe）。把路径写进命令行的**不止**这些进程：一旦这段脚本
//      本身出现在某个祖先进程的命令行里（在 agent 宿主里跑就是这样），按路径裸匹配会把
//      宿主也连坐掉。两道条件都是字面量，交叉起来只可能命中自己 spawn 的浏览器。
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
  if (browser?.profileDir && browser.ownsProfile !== false) {
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
          // 删不掉就是还有进程占着它 ⇒ 补杀一轮再删。正常路径（taskkill 杀干净）不会走到这儿。
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

// 场景脚本通常长这样：
//   const browser = await launchBrowser();
//   const { cdp: pageCdp } = await attachPage(browser);
//   try { ... } finally { await teardown({ browser, cdps: [pageCdp] }); }
export async function withBrowser(options, fn) {
  const browser = await launchBrowser(options);
  const ctx = { browser };
  try {
    return await fn(ctx);
  } finally {
    await teardown({ browser, cdps: ctx.cdps || [] });
  }
}
