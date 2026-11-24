#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDetachedReaderSmoke } from "./detached-reader-smoke.mjs";
import { runYoutubeSmoke } from "./youtube-smoke.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DIST_FIREFOX = path.join(REPO_ROOT, "dist-firefox");
const EVIDENCE_FILE = path.join(REPO_ROOT, ".scratch", "firefox-smoke", "evidence.json");
export const EXPECTED_EXTENSION_ID = "biliscript@edmund724.github.io";
export const MIN_FIREFOX_MAJOR = 153;

export const EXIT_PASS = 0;
export const EXIT_FAIL = 1;
export const EXIT_SKIPPED_NO_FIREFOX = 2;

function log(message) {
  console.log(`[smoke:firefox] ${message}`);
}

function getCandidateFirefoxPaths() {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || "";
    const userProfile = process.env.USERPROFILE || "";
    return [
      "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
      "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe",
      "C:\\Program Files\\Firefox Developer Edition\\firefox.exe",
      "C:\\Program Files\\Firefox Nightly\\firefox.exe",
      "D:\\Apps\\Firefox\\firefox.exe",
      path.join(localAppData, "Mozilla Firefox", "firefox.exe"),
      path.join(userProfile, "scoop", "apps", "firefox", "current", "firefox.exe")
    ];
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Firefox.app/Contents/MacOS/firefox",
      "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox",
      "/Applications/Firefox Nightly.app/Contents/MacOS/firefox",
      path.join(os.homedir(), "Applications", "Firefox.app", "Contents", "MacOS", "firefox")
    ];
  }
  return [
    "/usr/bin/firefox",
    "/usr/local/bin/firefox",
    "/snap/bin/firefox",
    "/usr/bin/firefox-esr"
  ];
}

function findFirefoxInPath() {
  const probeCmd = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(probeCmd, ["firefox"], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) {
    return null;
  }
  const firstLine = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine && fs.existsSync(firstLine) ? firstLine : null;
}

export function resolveFirefoxBinary() {
  const envBin = (process.env.FIREFOX_BIN || "").trim();
  if (envBin) {
    if (!fs.existsSync(envBin)) {
      return { found: false, explicitEnv: envBin, bin: null };
    }
    return { found: true, explicitEnv: envBin, bin: envBin };
  }

  for (const candidate of getCandidateFirefoxPaths()) {
    if (candidate && fs.existsSync(candidate)) {
      return { found: true, explicitEnv: null, bin: candidate };
    }
  }

  const fromPath = findFirefoxInPath();
  if (fromPath) {
    return { found: true, explicitEnv: null, bin: fromPath };
  }

  return { found: false, explicitEnv: null, bin: null };
}

export function allocateFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate ephemeral TCP port")));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function writeTempProfilePrefs(profileDir, marionettePort) {
  const prefs = [
    `user_pref("marionette.port", ${marionettePort});`,
    'user_pref("marionette.enabled", true);',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("startup.homepage_welcome_url", "about:blank");',
    'user_pref("startup.homepage_welcome_url.additional", "");',
    'user_pref("browser.aboutwelcome.enabled", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
    'user_pref("extensions.getAddons.cache.enabled", false);',
    'user_pref("app.update.enabled", false);',
    'user_pref("app.update.auto", false);',
    'user_pref("dom.disable_open_during_load", false);'
  ].join("\n");
  fs.writeFileSync(path.join(profileDir, "user.js"), prefs + "\n", "utf8");
}

export class MarionetteClient {
  constructor() {
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.nextMsgId = 1;
    this.pending = new Map();
    this.greeted = false;
    this.greetingPromise = null;
    this.greetingResolve = null;
    this.greetingReject = null;
  }

  async connect(port, timeoutMs = 20_000, childRef = null) {
    const deadline = Date.now() + timeoutMs;
    let lastErr = null;
    while (Date.now() < deadline) {
      if (childRef && childRef.exitCode !== null) {
        throw new Error(`Firefox exited early with code ${childRef.exitCode}`);
      }
      try {
        await this.connectOnce(port, Math.min(3000, deadline - Date.now()));
        return;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw new Error(`Timed out connecting to Marionette on 127.0.0.1:${port}: ${lastErr?.message || lastErr}`);
  }

  connectOnce(port, timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(new Error("Marionette greeting timeout"));
        }
      }, timeoutMs);

      this.socket = socket;
      this.buffer = Buffer.alloc(0);
      this.greeted = false;
      this.greetingPromise = new Promise((gRes, gRej) => {
        this.greetingResolve = gRes;
        this.greetingReject = gRej;
      });

      socket.on("data", (chunk) => this.onData(chunk));
      socket.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          reject(err);
        } else {
          this.failAll(err);
        }
      });
      socket.on("close", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("Marionette socket closed before greeting"));
        } else {
          this.failAll(new Error("Marionette socket closed"));
        }
      });

      this.greetingPromise.then(
        (greeting) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(greeting);
          }
        },
        (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            reject(err);
          }
        }
      );
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const colonIdx = this.buffer.indexOf(0x3a);
      if (colonIdx === -1) break;
      const lengthStr = this.buffer.subarray(0, colonIdx).toString("ascii");
      const byteLength = Number.parseInt(lengthStr, 10);
      if (!Number.isFinite(byteLength) || byteLength < 0) {
        this.failAll(new Error(`Invalid Marionette frame length: ${lengthStr}`));
        return;
      }
      const frameEnd = colonIdx + 1 + byteLength;
      if (this.buffer.length < frameEnd) break;
      const jsonText = this.buffer.subarray(colonIdx + 1, frameEnd).toString("utf8");
      this.buffer = this.buffer.subarray(frameEnd);

      let packet;
      try {
        packet = JSON.parse(jsonText);
      } catch (err) {
        this.failAll(new Error(`Invalid Marionette JSON: ${err.message}`));
        return;
      }
      this.handlePacket(packet);
    }
  }

  handlePacket(packet) {
    if (!this.greeted && packet && !Array.isArray(packet) && packet.applicationType) {
      this.greeted = true;
      this.greetingResolve?.(packet);
      return;
    }
    if (Array.isArray(packet) && packet[0] === 1) {
      const [, msgId, error, result] = packet;
      const waiter = this.pending.get(msgId);
      if (!waiter) return;
      this.pending.delete(msgId);
      clearTimeout(waiter.timer);
      if (error) {
        const errMsg = error.message || JSON.stringify(error);
        const err = new Error(`Marionette ${waiter.command} failed (${error.error || "error"}): ${errMsg}`);
        waiter.reject(err);
      } else {
        waiter.resolve(result);
      }
    }
  }

  failAll(err) {
    if (!this.greeted) {
      this.greetingReject?.(err);
    }
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.pending.clear();
  }

  send(command, params = {}, timeoutMs = 20_000) {
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new Error(`Cannot send ${command}: Marionette socket is closed`));
    }
    const msgId = this.nextMsgId++;
    const payload = JSON.stringify([0, msgId, command, params]);
    const frame = `${Buffer.byteLength(payload, "utf8")}:${payload}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msgId);
        reject(new Error(`Marionette command timed out after ${timeoutMs}ms: ${command}`));
      }, timeoutMs);
      this.pending.set(msgId, { command, resolve, reject, timer });
      this.socket.write(frame, "utf8");
    });
  }

  async setContext(context) {
    await this.send("Marionette:SetContext", { value: context });
  }

  async executeSync(script, argsList = [], timeoutMs = 20_000, options = {}) {
    const params = {
      script,
      args: argsList
    };
    if (typeof options.newSandbox === "boolean") {
      params.newSandbox = options.newSandbox;
    }
    const res = await this.send("WebDriver:ExecuteScript", params, timeoutMs);
    return res?.value;
  }

  async executeAsync(script, argsList = [], timeoutMs = 25_000, options = {}) {
    const params = {
      script,
      args: argsList,
      scriptTimeout: timeoutMs
    };
    if (typeof options.newSandbox === "boolean") {
      params.newSandbox = options.newSandbox;
    }
    const res = await this.send("WebDriver:ExecuteAsyncScript", params, timeoutMs + 5000);
    return res?.value;
  }

  async getWindowHandle() {
    const res = await this.send("WebDriver:GetWindowHandle", {});
    return res?.value ?? res;
  }

  async getWindowHandles() {
    const res = await this.send("WebDriver:GetWindowHandles", {});
    if (Array.isArray(res)) return res;
    if (Array.isArray(res?.value)) return res.value;
    return [];
  }

  close() {
    this.failAll(new Error("Marionette client closed"));
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.socket = null;
  }
}

export async function waitForChromeExtensionReady(client, extensionId) {
  await client.setContext("chrome");
  const result = await client.executeAsync(
    `
    const extensionId = arguments[0];
    const done = arguments[arguments.length - 1];
    (async () => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const policy = WebExtensionPolicy.getByID(extensionId);
        if (policy && policy.active && policy.mozExtensionHostname) {
          return {
            ok: true,
            id: policy.id,
            uuid: policy.mozExtensionHostname
          };
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return { ok: false, error: "Timed out waiting for WebExtensionPolicy: " + extensionId };
    })().then(done, (err) => done({ ok: false, error: String(err?.message || err) }));
    `,
    [extensionId]
  );
  if (!result?.ok) {
    throw new Error(result?.error || "Extension policy did not activate");
  }
  return result;
}

async function runExtensionChecksInContent(client, expectedVersion) {
  await client.setContext("content");

  const coreSuite = await client.executeAsync(
    `
    const expectedVersion = arguments[0];
    const done = arguments[arguments.length - 1];

    (async () => {
      const results = [];
      if (typeof browser === "undefined" || typeof chrome === "undefined") {
        throw new Error("Extension tab window (onboarding.html) missing WebExtension APIs");
      }

      // Check 1: Event Page startup + storage.local / storage.sync round-trip
      {
        const settingsResp = await browser.runtime.sendMessage({ type: "get-settings" });
        const bgWin = await browser.runtime.getBackgroundPage();
        const manifest = chrome.runtime.getManifest();
        const runtimeUrl = String(chrome.runtime.getURL(""));
        const hasOffscreenApi = typeof chrome?.offscreen !== "undefined";

        const localKey = "__biliscript_fx_smoke_local__";
        const localVal = "fx-local-" + Date.now();
        await browser.storage.local.set({ [localKey]: localVal });
        const localGot = await browser.storage.local.get(localKey);
        await browser.storage.local.remove(localKey);

        const syncKey = "__biliscript_fx_smoke_sync__";
        const syncVal = "fx-sync-" + Date.now();
        await browser.storage.sync.set({ [syncKey]: syncVal });
        const syncGot = await browser.storage.sync.get(syncKey);
        await browser.storage.sync.remove(syncKey);

        const ok =
          settingsResp?.ok === true &&
          Boolean(settingsResp?.settings) &&
          Boolean(bgWin) &&
          !hasOffscreenApi &&
          runtimeUrl.startsWith("moz-extension://") &&
          manifest?.version === expectedVersion &&
          localGot?.[localKey] === localVal &&
          syncGot?.[syncKey] === syncVal;

        results.push({
          name: "event-page-and-storage-roundtrip",
          ok,
          detail: {
            settingsOk: settingsResp?.ok === true,
            hasBgWindow: Boolean(bgWin),
            hasOffscreenApi,
            runtimeUrlPrefix: runtimeUrl.slice(0, 16),
            manifestVersion: manifest?.version,
            localMatch: localGot?.[localKey] === localVal,
            syncMatch: syncGot?.[syncKey] === syncVal
          }
        });
      }

      // Check 2: ensure-offscreen-chat mounts #biliscript-offscreen-iframe & offscreen port handshake
      {
        const ensureResp = await browser.runtime.sendMessage({ type: "ensure-offscreen-chat" });
        const bgWin = await browser.runtime.getBackgroundPage();
        const iframe = bgWin?.document?.getElementById("biliscript-offscreen-iframe") || null;
        const iframeOk =
          Boolean(iframe) &&
          iframe.hidden === true &&
          Boolean(iframe.contentWindow) &&
          String(iframe.src || "").endsWith("/entry/offscreen.html");

        let portReply = null;
        let portError = null;
        try {
          const port = chrome.runtime.connect({ name: "offscreen-chat" });
          portReply = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("offscreen-chat port handshake timeout")), 6000);
            port.onMessage.addListener((raw) => {
              clearTimeout(timer);
              resolve(raw);
            });
            port.onDisconnect.addListener(() => {
              clearTimeout(timer);
              reject(new Error("offscreen-chat port disconnected before reply"));
            });
            port.postMessage({ action: "chat", contextKey: "__fx_smoke_probe__" });
          });
          port.disconnect();
        } catch (err) {
          portError = String(err?.message || err);
        }

        const ok =
          ensureResp?.ok === true &&
          ensureResp?.ensured === true &&
          iframeOk &&
          portReply?.type === "error" &&
          portReply?.code === "subtitle-body-missing";

        results.push({
          name: "ensure-offscreen-iframe-and-port-handshake",
          ok,
          detail: {
            ensureResp,
            iframeFound: Boolean(iframe),
            iframeHidden: iframe?.hidden ?? null,
            iframeHasContentWindow: Boolean(iframe?.contentWindow),
            iframeSrc: iframe?.src ?? null,
            portReply,
            portError
          }
        });
      }

      // Check 3: declarativeNetRequest.updateSessionRules writes & cleans up Bilibili media rule
      {
        const prepResp = await browser.runtime.sendMessage({
          type: "offload-task",
          taskType: "asr-decode-prepare"
        });
        const ruleId = Number(prepResp?.ruleId) || 0;
        const rulesAfterAdd = await browser.declarativeNetRequest.getSessionRules();
        const addedRule = Array.isArray(rulesAfterAdd)
          ? rulesAfterAdd.find((r) => r.id === ruleId) || null
          : null;

        const cleanResp = await browser.runtime.sendMessage({
          type: "offload-task",
          taskType: "asr-decode-cleanup",
          ruleId
        });
        const rulesAfterRemove = await browser.declarativeNetRequest.getSessionRules();
        const stillPresent = Array.isArray(rulesAfterRemove)
          ? rulesAfterRemove.some((r) => r.id === ruleId)
          : true;

        const ok =
          prepResp?.ok === true &&
          ruleId > 0 &&
          addedRule?.action?.type === "modifyHeaders" &&
          Array.isArray(addedRule?.condition?.requestDomains) &&
          addedRule.condition.requestDomains.includes("bilivideo.com") &&
          cleanResp?.ok === true &&
          stillPresent === false;

        results.push({
          name: "dnr-session-rules-add-and-cleanup",
          ok,
          detail: {
            prepResp,
            addedRuleId: addedRule?.id ?? null,
            addedDomains: addedRule?.condition?.requestDomains ?? null,
            cleanResp,
            stillPresentAfterCleanup: stillPresent
          }
        });
      }

      // Check 4: official preset domain check-provider-origin returns granted: true
      {
        const officialResp = await browser.runtime.sendMessage({
          type: "check-provider-origin",
          origin: "https://api.siliconflow.cn/v1"
        });
        const localResp = await browser.runtime.sendMessage({
          type: "check-provider-origin",
          origin: "http://localhost:11434/v1"
        });

        const ok = officialResp?.granted === true && localResp?.granted === false;
        results.push({
          name: "check-provider-origin-preset-vs-custom",
          ok,
          detail: {
            siliconflowGranted: officialResp?.granted ?? null,
            localhostGranted: localResp?.granted ?? null
          }
        });
      }

      return { ok: true, results };
    })().then(done, (err) => done({ ok: false, error: String(err?.message || err), stack: String(err?.stack || "") }));
    `,
    [expectedVersion],
    35_000
  );

  if (!coreSuite?.ok) {
    return coreSuite;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const currentHandleRes = await client.send("WebDriver:GetWindowHandle", {});
  const originHandle = typeof currentHandleRes === "string" ? currentHandleRes : currentHandleRes?.value;
  const handlesBefore = new Set(await client.getWindowHandles());

  await client.executeSync(`
    window.__biliscriptFxSmokeGrant = { settled: false, res: null, err: null };
    browser.runtime
      .sendMessage({
        type: "request-provider-origins",
        baseUrls: ["http://localhost:11434/v1"]
      })
      .then(
        (res) => {
          window.__biliscriptFxSmokeGrant = { settled: true, res, err: null };
        },
        (err) => {
          window.__biliscriptFxSmokeGrant = {
            settled: true,
            res: null,
            err: String(err?.message || err)
          };
        }
      );
    return true;
  `);

  let popupHandle = null;
  let popupUrl = "";
  let popupOriginsText = "";
  const popupDeadline = Date.now() + 10_000;
  while (Date.now() < popupDeadline && !popupHandle) {
    const handlesNow = await client.getWindowHandles();
    for (const candidate of handlesNow) {
      if (handlesBefore.has(candidate)) continue;
      try {
        await client.send("WebDriver:SwitchToWindow", { handle: candidate });
        const href = String((await client.executeSync("return window.location.href;")) || "");
        if (href.includes("entry/permission-grant.html")) {
          popupHandle = candidate;
          popupUrl = href;
          break;
        }
      } catch {
      }
    }
    if (!popupHandle) {
      await sleep(100);
    }
  }

  if (popupHandle) {
    const docDeadline = Date.now() + 5000;
    while (Date.now() < docDeadline) {
      const probe = await client.executeSync(`
        const cancelBtn = document.getElementById("permissionGrantCancelBtn");
        const originsList = document.getElementById("permissionGrantOrigins");
        const ready =
          document.readyState === "complete" &&
          Boolean(cancelBtn) &&
          Boolean(originsList) &&
          String(originsList.textContent || "").includes("http://localhost/*");
        if (ready) {
          const originsText = String(originsList.textContent || "");
          cancelBtn.click();
          return { ready: true, originsText };
        }
        return { ready: false, originsText: "" };
      `);
      if (probe?.ready) {
        popupOriginsText = probe.originsText;
        break;
      }
      await sleep(80);
    }
  }

  if (originHandle) {
    await client.send("WebDriver:SwitchToWindow", { handle: originHandle });
  }

  let grantSettlement = null;
  let grantThrew = null;
  const settleDeadline = Date.now() + 8000;
  while (Date.now() < settleDeadline) {
    const state = await client.executeSync("return window.__biliscriptFxSmokeGrant || null;");
    if (state?.settled) {
      grantSettlement = state.res;
      grantThrew = state.err;
      break;
    }
    await sleep(80);
  }

  const check5Ok =
    Boolean(popupHandle) &&
    popupUrl.includes("entry/permission-grant.html") &&
    popupOriginsText.includes("http://localhost/*") &&
    grantThrew === null &&
    grantSettlement?.ok === false &&
    typeof grantSettlement?.error === "string" &&
    grantSettlement.error.length > 0;

  coreSuite.results.push({
    name: "unauthorized-custom-origin-popup-fallback",
    ok: check5Ok,
    detail: {
      popupOpened: Boolean(popupHandle),
      popupUrl,
      popupOriginsText,
      grantThrew,
      grantSettlement
    }
  });

  return coreSuite;
}

export async function killFirefoxAndCleanup(child, profileDir) {
  if (child && child.exitCode === null) {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGKILL");
      }
    } catch {
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  if (profileDir && fs.existsSync(profileDir)) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
}

function writeEvidence(payload) {
  fs.mkdirSync(path.dirname(EVIDENCE_FILE), { recursive: true });
  fs.writeFileSync(EVIDENCE_FILE, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

async function main(argv = process.argv.slice(2)) {
  const args = new Set(argv);
  if (args.has("--help") || args.has("-h")) {
    console.log(
      [
        "Usage: node scripts/firefox-smoke/smoke-firefox.mjs [--headed] [--core-only]",
        "",
        "Options:",
        "  --headed     Launch Firefox with a visible window (default: headless)",
        "  --core-only  Run only the 5 core extension checks (skip detached-reader and YouTube checks)",
        "  -h, --help   Show this help message",
        "",
        "Environment:",
        "  FIREFOX_BIN  Override Firefox executable path",
        "",
        "Exit codes:",
        "  0  All core, detached-reader, and YouTube checks passed",
        "  1  Missing dist-firefox build, invalid FIREFOX_BIN, or assertion/runtime failure",
        "  2  Firefox executable not found on this machine (skipped)"
      ].join("\n")
    );
    process.exit(EXIT_PASS);
  }

  const headed = args.has("--headed");
  const coreOnly = args.has("--core-only");
  const fx = resolveFirefoxBinary();
  if (!fx.found) {
    if (fx.explicitEnv) {
      log(`FAIL  FIREFOX_BIN points to non-existent executable: ${fx.explicitEnv}`);
      process.exit(EXIT_FAIL);
    }
    log("SKIP  Firefox 153+ binary was not detected on this machine.");
    log("      Install Firefox 153+ or set FIREFOX_BIN=/path/to/firefox and re-run:");
    log("      FIREFOX_BIN=\"C:\\Program Files\\Mozilla Firefox\\firefox.exe\" pnpm smoke:firefox");
    writeEvidence({
      status: "skipped",
      reason: "firefox-binary-not-found",
      timestamp: new Date().toISOString(),
      checks: []
    });
    process.exit(EXIT_SKIPPED_NO_FIREFOX);
  }

  const distManifestPath = path.join(DIST_FIREFOX, "manifest.json");
  if (!fs.existsSync(distManifestPath)) {
    log(`FAIL  Missing ${distManifestPath}. Run "pnpm build:firefox" first.`);
    process.exit(EXIT_FAIL);
  }
  const distManifest = JSON.parse(fs.readFileSync(distManifestPath, "utf8"));

  const marionettePort = await allocateFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "biliscript-fx-smoke-"));
  writeTempProfilePrefs(profileDir, marionettePort);

  const firefoxArgs = [
    "--marionette",
    "--no-remote",
    "--profile",
    profileDir,
    ...(headed ? [] : ["--headless"])
  ];

  log(`Launching Firefox: ${fx.bin} (headless=${!headed}, port=${marionettePort})`);
  const child = spawn(fx.bin, firefoxArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1"
    }
  });

  const stderrLines = [];
  child.stderr?.on("data", (chunk) => {
    if (stderrLines.length < 40) {
      stderrLines.push(String(chunk).trim());
    }
  });

  const client = new MarionetteClient();
  const evidence = {
    status: "error",
    firefoxBin: fx.bin,
    headed,
    timestamp: new Date().toISOString(),
    checks: []
  };

  try {
    await client.connect(marionettePort, 20_000, child);
    const session = await client.send("WebDriver:NewSession", { capabilities: {} });
    const browserVersion = String(session?.capabilities?.browserVersion || "");
    const majorVersion = Number.parseInt(browserVersion.split(".")[0] || "0", 10);
    evidence.browserVersion = browserVersion;
    log(`Connected Marionette session (Firefox ${browserVersion || "unknown"})`);
    if (Number.isFinite(majorVersion) && majorVersion > 0 && majorVersion < MIN_FIREFOX_MAJOR) {
      throw new Error(`Firefox version ${browserVersion} is below minimum ${MIN_FIREFOX_MAJOR}`);
    }

    const installed = await client.send("Addon:Install", {
      path: DIST_FIREFOX,
      temporary: true
    });
    const addonId = installed?.value;
    log(`Installed temporary add-on: ${addonId}`);
    if (addonId !== EXPECTED_EXTENSION_ID) {
      throw new Error(`Unexpected installed addon id: ${addonId}, expected ${EXPECTED_EXTENSION_ID}`);
    }

    const policyInfo = await waitForChromeExtensionReady(client, EXPECTED_EXTENSION_ID);
    await client.setContext("content");
    await client.send("WebDriver:Navigate", {
      url: `moz-extension://${policyInfo.uuid}/onboarding.html`
    });

    const suite = await runExtensionChecksInContent(
      client,
      String(distManifest.version || "")
    );
    if (!suite?.ok) {
      throw new Error(`Extension check runner failed: ${suite?.error || "unknown error"}\n${suite?.stack || ""}`);
    }

    evidence.checks = suite.results;
    let allPassed = true;
    for (const item of suite.results) {
      log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}  ${JSON.stringify(item.detail)}`);
      if (!item.ok) allPassed = false;
    }

    evidence.status = allPassed ? "passed" : "failed";
    writeEvidence(evidence);

    try {
      await client.send("WebDriver:DeleteSession", {}, 5000);
    } catch {
    }
    client.close();
    await killFirefoxAndCleanup(child, profileDir);

    if (!coreOnly) {
      const detached = await runDetachedReaderSmoke({
        firefoxBin: fx.bin,
        distDir: DIST_FIREFOX,
        headed,
        log
      });
      evidence.checks = [...evidence.checks, ...detached.checks];
      evidence.detachedReader = {
        ok: detached.ok,
        status: detached.status,
        error: detached.error || null
      };
      if (!detached.ok) allPassed = false;

      const youtube = await runYoutubeSmoke({
        firefoxBin: fx.bin,
        distDir: DIST_FIREFOX,
        headed,
        log
      });
      evidence.checks = [...evidence.checks, ...youtube.checks];
      evidence.youtube = {
        ok: youtube.ok,
        status: youtube.status,
        error: youtube.error || null
      };
      if (!youtube.ok) allPassed = false;

      evidence.status = allPassed ? "passed" : "failed";
      writeEvidence(evidence);
    }

    process.exit(allPassed ? EXIT_PASS : EXIT_FAIL);
  } catch (err) {
    evidence.status = "error";
    evidence.error = String(err?.message || err);
    evidence.stderrTail = stderrLines;
    writeEvidence(evidence);
    log(`FAIL  ${evidence.error}`);
    client.close();
    await killFirefoxAndCleanup(child, profileDir);
    process.exit(EXIT_FAIL);
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  await main();
}
