#!/usr/bin/env node
// 离线真机判据：七项阅读/音频偏好同源、默认值、Aa 设置深链与全局重置。

import path from "node:path";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import {
  DEFAULT_DIST,
  REPO_ROOT,
  artifactDir,
  attachPage,
  launchBrowser,
  log,
  screenshot,
  teardown,
  waitFor,
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
      export * as liveAudio from "./extension/live/live-audio-settings.ts";
      export { createLiveOverlayBinding } from "./extension/live/live-overlay-binding.ts";
      export { state } from "./extension/core/state.ts";
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
const browser = await launchBrowser({ muted: true });
const page = await attachPage(browser);

try {
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
      #biliscript-reading-view { position: relative; height: 620px; background: #181818; }
      #biliscript-reading-settings-panel { height: 600px; overflow-y: auto; }
    </style></head><body><main>
      <div id="player-container" class="bpx-player-container"></div>
      <div id="biliscript-reading-view" class="open" data-theme="dark" data-palette="flyme">
        <div id="biliscript-reading-settings-panel"><div id="biliscript-reading-settings-host"></div></div>
      </div>
    </main></body></html>`
  });

  await page.cdp.evaluate(`(() => {
    const listeners = new Set();
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
          addListener: (listener) => listeners.add(listener),
          removeListener: (listener) => listeners.delete(listener)
        }
      }
    };
    window.__firePreferenceChanges = (patch) => {
      Object.assign(window.__preferenceSettings, patch);
      const changes = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, { newValue: value }]));
      for (const listener of [...listeners]) listener(changes, "sync");
    };
  })()`);
  await page.cdp.evaluate(source);
  await page.cdp.evaluate(`(() => {
    let volume = 1;
    let speed = 1;
    let share = false;
    let priority = true;
    let liveState = "connected";
    window.__audioController = {
      getState: () => liveState,
      isMuted: () => false,
      getVolume: () => volume,
      setVolume: (value) => { volume = value; },
      getSpeed: () => speed,
      setSpeed: (value) => { speed = value; },
      isSharingVideoAudio: () => share,
      setShareVideoAudio: (value) => { share = value; },
      getVideoAudioStatus: () => "已获取音轨",
      isVoicePriority: () => priority,
      setVoicePriority: (value) => { priority = value; },
      stop: async () => { liveState = "idle"; }
    };
    window.__overlayBinding = ReadingAudioPreferences.createLiveOverlayBinding({
      getPlayerHost: () => document.getElementById("player-container"),
      getLiveController: () => window.__audioController
    });
    window.__unwatchAudio = ReadingAudioPreferences.liveAudio.watchLiveAudioSettings(
      () => window.__audioController,
      () => window.__overlayBinding.getOverlay()?.syncState()
    );
    window.__overlayBinding.handleStateChange("connected");
    ReadingAudioPreferences.settingsPanel.renderReaderSettingsPanel();
  })()`);
  await waitFor("设置面板渲染", () => page.cdp.evaluate(
    `document.querySelector('#biliscript-reading-settings-host')?.dataset.biliscriptSettingsRendered === '1'`
  ));

  const defaults = await page.cdp.evaluate(`(() => ({
    values: Object.fromEntries([
      "chatLineHeight", "chatParagraphSpacing", "speechVoiceVolume", "liveVoiceVolume", "liveVoiceSpeed"
    ].map((id) => [id, document.getElementById(id)?.value])),
    share: document.getElementById("liveShareVideoAudio")?.checked,
    priority: document.getElementById("liveVoicePriority")?.checked,
    speechLabel: document.querySelector('label[for="speechVoiceVolume"]')?.textContent,
    liveLabel: document.querySelector('label[for="liveVoiceVolume"]')?.textContent
  }))()`);
  check("R1-seven-defaults-and-distinct-names",
    defaults.values.chatLineHeight === "160" &&
    defaults.values.chatParagraphSpacing === "12" &&
    defaults.values.speechVoiceVolume === "100" &&
    defaults.values.liveVoiceVolume === "100" &&
    defaults.values.liveVoiceSpeed === "1" &&
    defaults.share === false && defaults.priority === true &&
    defaults.speechLabel === "对话朗读音量" && defaults.liveLabel === "伴看音量",
    defaults
  );

  await page.cdp.evaluate(`ReadingAudioPreferences.settingsPanel.openAppearanceSettings()`);
  await waitFor("Aa 深链聚焦", () => page.cdp.evaluate(
    `document.activeElement?.id === 'chatPreferencesHeading'`
  ));
  const deepLink = await page.cdp.evaluate(`(() => {
    const panel = document.getElementById('biliscript-reading-settings-panel');
    const heading = document.getElementById('chatPreferencesHeading');
    const rect = heading.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    return {
      focused: document.activeElement === heading,
      subgroup: heading.closest('[data-settings-subgroup]')?.dataset.settingsSubgroup,
      scrollTop: panel.scrollTop,
      visible: rect.top >= panelRect.top && rect.bottom <= panelRect.bottom,
      activeNav: document.querySelector('.biliscript-settings-nav-item[data-section="appearance"]')?.classList.contains('is-active')
    };
  })()`);
  check("R2-appearance-deep-link-scrolls-to-chat-subgroup",
    deepLink.focused && deepLink.subgroup === "chat" && deepLink.scrollTop > 0 && deepLink.visible && deepLink.activeNav,
    deepLink
  );
  await screenshot(page.cdp, path.join(OUT_DIR, "01-appearance-deep-link.png"));

  async function getMetrics(selector) {
    return page.cdp.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
    })()`);
  }

  async function click(selector) {
    const metrics = await getMetrics(selector);
    if (!metrics || metrics.width <= 0 || metrics.height <= 0) throw new Error(`不可点击: ${selector}`);
    await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: metrics.x, y: metrics.y, button: "none" });
    await page.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: metrics.x, y: metrics.y, button: "left", buttons: 1, clickCount: 1 });
    await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: metrics.x, y: metrics.y, button: "left", buttons: 0, clickCount: 1 });
  }

  await page.cdp.evaluate(`document.getElementById('liveVoiceVolume').scrollIntoView({ block: 'center' })`);
  const volume = await getMetrics("#liveVoiceVolume");
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: volume.x - volume.width / 4, y: volume.y, button: "left", buttons: 1, clickCount: 1 });
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: volume.x - volume.width / 4, y: volume.y, button: "left", buttons: 0, clickCount: 1 });
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
  check("R3-live-volume-shared-by-drawer-overlay-controller",
    sameSource.drawer === sameSource.overlay &&
    Math.abs(sameSource.controller * 100 - Number(sameSource.drawer)) <= 1 &&
    sameSource.saved.length === 1 && sameSource.saved[0].liveVoiceVolume === Number(sameSource.drawer),
    sameSource
  );

  await page.cdp.evaluate(`window.__firePreferenceChanges({
    chatLineHeight: 185,
    chatParagraphSpacing: 18,
    speechVoiceVolume: 45,
    liveVoiceVolume: 150,
    liveVoiceSpeed: 1.25,
    liveShareVideoAudio: true,
    liveVoicePriority: false
  })`);
  const external = await page.cdp.evaluate(`(() => ({
    values: Object.fromEntries([
      "chatLineHeight", "chatParagraphSpacing", "speechVoiceVolume", "liveVoiceVolume", "liveVoiceSpeed"
    ].map((id) => [id, document.getElementById(id)?.value])),
    share: document.getElementById('liveShareVideoAudio').checked,
    priority: document.getElementById('liveVoicePriority').checked,
    controller: {
      volume: window.__audioController.getVolume(),
      speed: window.__audioController.getSpeed(),
      share: window.__audioController.isSharingVideoAudio(),
      priority: window.__audioController.isVoicePriority()
    },
    overlaySpeed: document.querySelector('.live-overlay-speed-value').textContent
  }))()`);
  check("R4-external-storage-change-syncs-all-surfaces",
    external.values.chatLineHeight === "185" && external.values.chatParagraphSpacing === "18" &&
    external.values.speechVoiceVolume === "45" && external.values.liveVoiceVolume === "150" &&
    external.values.liveVoiceSpeed === "1.25" && external.share === true && external.priority === false &&
    external.controller.volume === 1.5 && external.controller.speed === 1.25 &&
    external.controller.share === true && external.controller.priority === false && external.overlaySpeed === "1.25×",
    external
  );

  await page.cdp.evaluate(`document.getElementById('biliscriptSettingsResetBtn').scrollIntoView({ block: 'center' })`);
  await click("#biliscriptSettingsResetBtn");
  await click(".confirm-dialog-confirm");
  await waitFor("全局重置保存", () => page.cdp.evaluate(
    `window.__preferenceSaves.some((patch) => patch.chatLineHeight === 160 && patch.liveVoiceSpeed === 1)`
  ));
  const reset = await page.cdp.evaluate(`(() => {
    const payload = window.__preferenceSaves.find((patch) => patch.chatLineHeight === 160 && patch.liveVoiceSpeed === 1);
    return {
      payload,
      controller: {
        volume: window.__audioController.getVolume(),
        speed: window.__audioController.getSpeed(),
        share: window.__audioController.isSharingVideoAudio(),
        priority: window.__audioController.isVoicePriority()
      }
    };
  })()`);
  check("R5-global-reset-covers-seven-without-platform-audio-key",
    reset.payload.speechVoiceVolume === 100 && reset.payload.liveVoiceVolume === 100 &&
    reset.payload.liveShareVideoAudio === false && reset.payload.liveVoicePriority === true &&
    reset.payload.readerTheme === "light" && !("liveLowBandwidth" in reset.payload) &&
    reset.controller.volume === 1 && reset.controller.speed === 1 &&
    reset.controller.share === false && reset.controller.priority === true,
    reset
  );

  await writeEvidence(OUT_DIR, {
    failed: checks.filter((entry) => !entry.ok).map((entry) => entry.name),
    checks
  });
  if (checks.some((entry) => !entry.ok)) process.exitCode = 1;
} finally {
  await teardown({ browser, cdps: [page.cdp] });
}
