#!/usr/bin/env node
// 离线真机判据（仅保留 jsdom 够不着的两条 Chromium 几何/指针判据）：
// 1. Aa 深链在真实样式（吸顶导航栏 + scroll-margin-top）下触发有效滚动且标题不被遮挡；
// 2. 真实指针点击 #liveVoiceVolume range 轨道后，抽屉、伴看浮窗与控制器三端同源且仅保存一次。

import path from "node:path";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import {
  DEFAULT_DIST,
  REPO_ROOT,
  artifactDir,
  attachPage,
  log,
  screenshot,
  waitFor,
  withBrowser,
  writeEvidence
} from "../harness.mjs";

const NAME = "reading-audio-preferences";
const OUT_DIR = artifactDir(path.join("scenarios", NAME));
const checks = [];

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail).slice(0, 400)}`}`);
}

const css = [
  "tokens-primitive.css",
  "reader-gate.css",
  "reader.css",
  "reader-chat.css",
  "reader-settings-shell.css",
  "reader-settings-rows.css",
  "reader-settings-providers.css",
  "custom-select.css",
  "toggle-switch.css",
  "player-ai.css"
].map((file) => readFileSync(path.join(DEFAULT_DIST, "entry", "styles", file), "utf8")).join("\n");

const bundled = await build({
  stdin: {
    contents: `
      export * as settingsPanel from "./extension/ui/settings-panel.ts";
      export { createLiveOverlayBinding } from "./extension/live/live-overlay-binding.ts";
    `,
    resolveDir: REPO_ROOT
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "ReadingAudioPreferences",
  platform: "browser"
});
const source = bundled.outputFiles[0].text;

await withBrowser({ muted: true }, async (ctx) => {
  const page = await attachPage(ctx.browser);
  ctx.cdps = [page.cdp];

  await page.cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  });
  await page.cdp.send("Page.setDocumentContent", {
    frameId: page.target.id,
    html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
      ${css}
      * { box-sizing: border-box; }
      body { margin: 0; padding: 20px; background: #111; color: #eee; font-family: sans-serif; }
      main { display: grid; grid-template-columns: 720px 520px; gap: 20px; }
      #player-container { position: relative; height: 405px; background: #000; overflow: hidden; }
      #biliscript-reading-view { position: relative; height: 400px; background: #181818; }
      #biliscript-reading-settings-panel { height: 380px; overflow-y: auto; }
    </style></head><body><main>
      <div id="player-container" class="bpx-player-container"></div>
      <div id="biliscript-reading-view" class="open" data-theme="dark" data-palette="flyme">
        <section id="biliscript-reading-settings-panel" class="biliscript-reading-panel biliscript-reading-settings-panel">
          <div id="biliscript-reading-settings-host" class="biliscript-reading-settings-host"></div>
        </section>
      </div>
    </main></body></html>`
  });

  await page.cdp.evaluate(`(() => {
    window.__preferenceSettings = {};
    window.__preferenceSaves = [];
    const area = () => ({
      get: async () => ({}),
      set: async () => {},
      remove: async () => {}
    });
    window.chrome = {
      runtime: {
        lastError: null,
        getURL: () => "data:text/css,",
        sendMessage: (message, callback) => {
          if (message?.type === "get-settings") {
            callback?.({ ok: true, settings: { ...window.__preferenceSettings } });
          } else if (message?.type === "save-settings") {
            window.__preferenceSaves.push(message.settings);
            Object.assign(window.__preferenceSettings, message.settings || {});
            callback?.({ ok: true });
          } else if (message?.type?.endsWith("-providers-list")) {
            callback?.({ ok: true, providers: [] });
          } else {
            callback?.({ ok: true });
          }
        }
      },
      storage: {
        sync: area(),
        local: area(),
        onChanged: {
          addListener: () => {},
          removeListener: () => {}
        }
      }
    };
  })()`);
  await page.cdp.evaluate(source);
  await page.cdp.evaluate(`(() => {
    let volume = 1;
    let speed = 1;
    let share = false;
    let priority = true;
    let liveState = "connected";
    let controllerDeps = null;
    window.__audioController = {
      getState: () => liveState,
      isMuted: () => false,
      getVolume: () => volume,
      setVolume: (value) => {
        volume = value;
        controllerDeps?.onVolumeChange?.(value);
      },
      getSpeed: () => speed,
      setSpeed: (value) => { speed = value; },
      isSharingVideoAudio: () => share,
      setShareVideoAudio: (value) => { share = value; },
      getVideoAudioStatus: () => "已获取音轨",
      isVoicePriority: () => priority,
      setVoicePriority: (value) => { priority = value; },
      refreshTarget: async () => {},
      start: async () => true,
      stop: async () => { liveState = "idle"; }
    };
    window.__overlayBinding = ReadingAudioPreferences.createLiveOverlayBinding({
      getPlayerHost: () => document.getElementById("player-container"),
      createController: (deps) => {
        controllerDeps = deps;
        return window.__audioController;
      }
    });
    window.__overlayBinding.ensureController();
    controllerDeps.onStateChange("connected");
    ReadingAudioPreferences.settingsPanel.renderReaderSettingsPanel();
  })()`);
  await waitFor("设置面板渲染", () => page.cdp.evaluate(
    `document.querySelector('#biliscript-reading-settings-host')?.dataset.biliscriptSettingsRendered === '1'`
  ));

  async function clickAt(selector, offsetXRatio = 0.5) {
    const target = await page.cdp.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return { reason: "missing" };
      node.scrollIntoView({ block: "center" });
      const rect = node.getBoundingClientRect();
      const x = rect.left + rect.width * ${offsetXRatio};
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        width: rect.width,
        height: rect.height,
        x,
        y,
        hitOk: Boolean(hit && (hit === node || node.contains(hit))),
        hitTag: hit?.tagName || null,
        hitId: hit?.id || null,
        hitClass: typeof hit?.className === "string" ? hit.className : null
      };
    })()`);
    if (!target || target.width <= 0 || target.height <= 0 || !target.hitOk) {
      throw new Error(`不可点击 ${selector}: ${JSON.stringify(target)}`);
    }
    await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: target.x, y: target.y, button: "none" });
    await page.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: target.x, y: target.y, button: "left", buttons: 1, clickCount: 1 });
    await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", buttons: 0, clickCount: 1 });
  }

  // R1：Aa 深链进入「AI 对话与快捷动作」子页后真正滚动并避开吸顶导航栏
  await page.cdp.evaluate(`ReadingAudioPreferences.settingsPanel.openAppearanceSettings()`);
  await waitFor("Aa 深链聚焦", () => page.cdp.evaluate(
    `document.activeElement?.id === 'chatPreferencesHeading'`
  ));
  const deepLink = await page.cdp.evaluate(`(() => {
    const panel = document.getElementById('biliscript-reading-settings-panel');
    const heading = document.getElementById('chatPreferencesHeading');
    const rect = heading.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const navRect = document.querySelector('.biliscript-settings-nav-bar').getBoundingClientRect();
    return {
      focused: document.activeElement === heading,
      subgroup: heading.closest('[data-settings-subgroup]')?.dataset.settingsSubgroup,
      scrollTop: panel.scrollTop,
      scrollHeight: panel.scrollHeight,
      clientHeight: panel.clientHeight,
      headingTop: rect.top,
      headingBottom: rect.bottom,
      navBottom: navRect.bottom,
      panelTop: panelRect.top,
      panelBottom: panelRect.bottom,
      visible: rect.top >= panelRect.top && rect.top >= navRect.bottom && rect.bottom <= panelRect.bottom,
      subpageOpen:
        document.getElementById('biliscriptSettingsSubpageAiPrompt')?.hidden === false &&
        document.getElementById('biliscriptSettingsTitle')?.textContent?.trim() === 'AI 对话与快捷动作'
    };
  })()`);
  check("R1-appearance-deep-link-scrolls-without-sticky-occlusion",
    deepLink.focused &&
    deepLink.subgroup === "chat" &&
    deepLink.scrollTop > 0 &&
    deepLink.visible &&
    deepLink.subpageOpen,
    deepLink
  );
  await screenshot(page.cdp, path.join(OUT_DIR, "01-appearance-deep-link.png"));

  // R2：真实指针点击 #liveVoiceVolume 轨道同步抽屉、浮窗与控制器且仅保存一次
  await clickAt("#biliscript-reading-settings-back-btn");
  await waitFor("返回设置总览", () => page.cdp.evaluate(`document.getElementById('biliscriptSettingsRootView')?.hidden === false`));
  await clickAt("#openLiveSettingsBtn");
  await waitFor("打开实时伴看子页", () => page.cdp.evaluate(
    `document.getElementById('biliscriptSettingsSubpageLive')?.hidden === false && document.getElementById('liveVoiceVolume') !== null`
  ));

  await clickAt("#liveVoiceVolume", 0.25);
  await waitFor("抽屉音量同步浮窗", () => page.cdp.evaluate(`(() => {
    const value = document.getElementById('liveVoiceVolume').value;
    return value !== '100' && document.querySelector('.live-overlay-volume-slider:not(.live-overlay-speed-slider)').value === value;
  })()`));
  const sameSource = await page.cdp.evaluate(`(() => ({
    drawer: document.getElementById('liveVoiceVolume').value,
    overlay: document.querySelector('.live-overlay-volume-slider:not(.live-overlay-speed-slider)').value,
    controller: window.__audioController.getVolume(),
    saved: window.__preferenceSaves.filter((patch) => patch.liveVoiceVolume !== undefined)
  }))()`);
  check("R2-live-volume-pointer-syncs-drawer-overlay-controller",
    sameSource.drawer === sameSource.overlay &&
    Math.abs(sameSource.controller * 100 - Number(sameSource.drawer)) <= 1 &&
    sameSource.saved.length === 1 &&
    sameSource.saved[0].liveVoiceVolume === Number(sameSource.drawer),
    sameSource
  );
  await screenshot(page.cdp, path.join(OUT_DIR, "02-live-volume-sync.png"));

  await writeEvidence(OUT_DIR, {
    failed: checks.filter((entry) => !entry.ok).map((entry) => entry.name),
    checks
  });
  if (checks.some((entry) => !entry.ok)) process.exitCode = 1;
});
