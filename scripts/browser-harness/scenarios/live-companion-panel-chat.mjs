#!/usr/bin/env node
// 端到端真机场景：伴看与面板对话并行 —— `pnpm harness:scenario live-companion-panel-chat`。
//
// 判据（jsdom 够不着的部分）：
// 1. 首次连接展开，非全屏与全屏下可收起为胶囊，指针/键盘展开、最小化与焦点往返；
// 2. 胶囊状态与麦克风文本、ARIA、最小目标，以及键盘静音和结束均可操作；
// 3. 音频弹层的原生/fallback 定位、视口翻转、全屏迁移、Esc/外点回焦、缺音轨提示、音量单次提交与设置入口；
// 4. 浮窗与胶囊拖拽后按 16px 安全间距就近吸附左右边缘，缩放后位置可达，减少动态下无吸附动画；
//    进出全屏不遮挡中央 50% 画面，宿主替换保留原节点、展开状态与伴看会话；
// 5. 伴看进行中，文摘面板发起文本问答可正常发送并收到回复，伴看会话不断开、快速操作按钮保持高亮；
// 6. 面板对话历史中没有伴看语音转写与回复内容，浮窗中没有面板文本问答内容（两者内容隔离）；
// 7. 产出可重复运行的验证工件（evidence.json 及四态真机渲染截图）。

import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
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

const NAME = "live-companion-panel-chat";
const OUT_DIR = artifactDir(path.join("scenarios", NAME));
const checks = [];

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail).slice(0, 300)}`}`);
  return Boolean(ok);
}

// 载入构建后的扩展真实生产样式，确保 CSS 变量、圆角、绝对定位与毛玻璃镜头真实参与 Chromium 几何排版
const cssFiles = [
  "tokens-primitive.css",
  "reader-gate.css",
  "reader.css",
  "reader-chat.css",
  "player-ai.css"
];
const css = cssFiles
  .map((file) => readFileSync(path.join(DEFAULT_DIST, "entry", "styles", file), "utf8"))
  .join("\n");

// 打包伴看浮窗与绑定运行时
const bundledOverlay = await build({
  entryPoints: [path.join(REPO_ROOT, "extension/live/live-overlay-binding.ts")],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "LiveOverlayModule",
  platform: "browser"
});
const liveOverlaySource = bundledOverlay.outputFiles[0].text;

const browser = await launchBrowser({ autoplay: true, muted: true });
const page = await attachPage(browser);

try {
  await page.cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false
  });

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>视频页伴看与面板对话并行仿真</title>
  <style>
    ${css}
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      padding: 24px;
      background: #0b0c10;
      color: #e6e6e6;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
      overflow: hidden;
      width: 1920px;
      height: 1080px;
    }
    .video-page-layout {
      display: flex;
      gap: 24px;
      width: 100%;
      height: calc(1080px - 48px);
    }
    .player-section {
      flex: 1;
      display: flex;
      flex-direction: column;
      position: relative;
    }
    .bpx-player-container {
      position: relative;
      width: 1000px;
      height: 562px;
      background: #000;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    }
    .bpx-player-container.is-fullscreen {
      position: fixed !important;
      inset: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      border-radius: 0 !important;
      z-index: 9999;
    }
    .bpx-player-video-wrap {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #666;
      font-size: 18px;
      background: radial-gradient(circle at center, #1e2230 0%, #08090d 100%);
    }
    .bpx-player-control-bottom {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 48px;
      background: linear-gradient(to top, rgba(0,0,0,0.85), transparent);
      display: flex;
      align-items: center;
      padding: 0 16px;
      gap: 12px;
      z-index: 10;
    }
    .side-panel-section {
      width: 440px;
      display: flex;
      flex-direction: column;
      position: relative;
    }
    #biliscript-script-button {
      margin-bottom: 12px;
      padding: 8px 16px;
      background: #00aeec;
      color: #fff;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      font-size: 14px;
      align-self: flex-start;
    }
    #biliscript-reading-view {
      position: relative;
      width: 100%;
      height: 800px;
      display: flex;
      flex-direction: column;
      border-radius: 8px;
    }
  </style>
</head>
<body>
  <div class="video-page-layout">
    <div class="player-section">
      <div id="player-container" class="bpx-player-container" data-screen="normal">
        <div class="bpx-player-video-wrap">
          <video id="player-video" preload="none"></video>
          <div class="video-placeholder">Bilibili Player Simulated Video Scene</div>
        </div>
        <div class="bpx-player-control-bottom">
          <div id="biliscript-player-live-quick-action-wrap" class="bpx-player-ctrl-btn biliscript-player-live-quick-action-wrap">
            <button id="biliscript-player-live-quick-action" type="button" class="biliscript-player-live-quick-action" title="实时伴看" aria-label="实时伴看">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
    <div class="side-panel-section">
      <button id="biliscript-script-button" type="button">文摘面板</button>
      <div id="biliscript-reading-view" class="open" data-theme="dark" data-palette="flyme">
        <div class="biliscript-reading-nav" style="display:flex;gap:8px;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.08);">
          <button id="biliscript-reading-tab-subtitle" class="biliscript-reading-tab">字幕</button>
          <button id="biliscript-reading-tab-overview" class="biliscript-reading-tab">概览</button>
          <button id="biliscript-reading-tab-chat" class="biliscript-reading-tab is-active">对话</button>
        </div>
        <div id="biliscript-reading-tabbody-chat" class="biliscript-reading-tabbody is-active" style="display:flex;flex-direction:column;flex:1;overflow:hidden;">
          <div id="biliscript-reading-chat" class="biliscript-reading-chat" style="display:flex;flex-direction:column;height:100%;">
            <main id="biliscript-reading-chat-messages" class="chat-messages" style="flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:12px;"></main>
            <footer class="chat-footer" style="padding:12px;">
              <div class="chat-input-card">
                <textarea id="biliscript-reading-chat-input" rows="1" placeholder="回车发送，Shift+Enter 换行"></textarea>
                <div id="biliscript-reading-chat-input-bar" class="chat-input-bar">
                  <button id="biliscript-reading-chat-send-btn" type="button" class="chat-send-btn" title="发送" disabled>
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                  </button>
                </div>
              </div>
            </footer>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;

  await page.cdp.send("Page.setDocumentContent", {
    frameId: page.target.id,
    html
  });
  await page.cdp.evaluate(liveOverlaySource);

  // 初始化伴看绑定器与面板对话事件监听
  await page.cdp.evaluate(`(() => {
    let liveState = "idle";
    let muted = false;
    const callbacks = {};

    const mockLiveController = {
      getState: () => liveState,
      isMuted: () => muted,
      toggleMute: () => {
        muted = !muted;
      },
      getVolume: () => 1,
      setVolume: () => {},
      getSpeed: () => 1,
      setSpeed: () => {},
      isSharingVideoAudio: () => true,
      setShareVideoAudio: () => {},
      getVideoAudioStatus: () => "未检测到音轨",
      isVoicePriority: () => true,
      setVoicePriority: () => {},
      start: async () => {
        liveState = "connected";
        callbacks.onStateChange?.("connected");
        return true;
      },
      stop: async () => {
        liveState = "idle";
        callbacks.onStateChange?.("idle");
      }
    };

    window.__volumeSyncValues = [];
    window.__liveSettingsTargets = [];
    const binding = LiveOverlayModule.createLiveOverlayBinding({
      getPlayerHost: () => document.getElementById("player-container"),
      getLiveController: () => mockLiveController,
      onVolumeSync: (volume) => window.__volumeSyncValues.push(volume),
      onOpenLiveSettings: (target) => window.__liveSettingsTargets.push(target)
    });

    Object.assign(callbacks, binding.bindControllerCallbacks());

    window.__mockLiveController = mockLiveController;
    window.__liveBinding = binding;
    window.__callbacks = callbacks;

    // 播放器伴看快捷按钮点击：已激活则关闭，未激活则开启
    const quickBtn = document.getElementById("biliscript-player-live-quick-action");
    quickBtn.addEventListener("click", async () => {
      if (mockLiveController.getState() === "connected") {
        await mockLiveController.stop();
      } else {
        await binding.startOrRestoreCompanion();
      }
    });

    // 文摘面板文本对话
    const input = document.getElementById("biliscript-reading-chat-input");
    const sendBtn = document.getElementById("biliscript-reading-chat-send-btn");
    const messages = document.getElementById("biliscript-reading-chat-messages");

    input.addEventListener("input", () => {
      sendBtn.disabled = !input.value.trim();
    });

    window.__sendPanelChat = (text) => {
      const userBubble = document.createElement("div");
      userBubble.className = "chat-msg chat-msg-user";
      userBubble.textContent = text;
      messages.appendChild(userBubble);

      input.value = "";
      sendBtn.disabled = true;

      const assistantBubble = document.createElement("div");
      assistantBubble.className = "chat-msg chat-msg-assistant";
      assistantBubble.textContent = "面板文本问答回复：视频阐述了实时伴看与阅读面板各自独立运行的并行架构。";
      messages.appendChild(assistantBubble);
    };

    sendBtn.addEventListener("click", () => {
      if (input.value.trim()) {
        window.__sendPanelChat(input.value.trim());
      }
    });
  })()`);

  // CDP 真实指针与键盘输入辅助
  async function getElementMetrics(selector) {
    return page.cdp.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        cx: r.left + r.width / 2,
        cy: r.top + r.height / 2,
        width: r.width,
        height: r.height,
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom
      };
    })()`);
  }

  async function clickCenter(selector) {
    const info = await getElementMetrics(selector);
    if (!info) throw new Error("Element not found: " + selector);
    const px = Math.round(info.cx);
    const py = Math.round(info.cy);
    await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py, button: "none", clickCount: 0 });
    await page.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: px, y: py, button: "left", buttons: 1, clickCount: 1 });
    await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: px, y: py, button: "left", buttons: 0, clickCount: 1 });
    await new Promise((r) => setTimeout(r, 120));
  }

  async function pressKey(selector, key, code, windowsVirtualKeyCode) {
    await page.cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await page.cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      windowsVirtualKeyCode,
      nativeVirtualKeyCode: windowsVirtualKeyCode,
      text: key === "Enter" ? "\r" : key === " " ? " " : undefined,
      unmodifiedText: key === "Enter" ? "\r" : key === " " ? " " : undefined
    });
    await page.cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode,
      nativeVirtualKeyCode: windowsVirtualKeyCode
    });
    await new Promise((r) => setTimeout(r, 120));
  }

  // =========================================================================
  // 1. 非全屏首次连接展开，最小化后可用键盘展开
  // =========================================================================
  await clickCenter("#biliscript-player-live-quick-action");
  await waitFor("非全屏首次浮窗展开", async () =>
    page.cdp.evaluate("Boolean(document.querySelector('#biliscript-fullscreen-live-overlay:not(.is-hidden):not([hidden])'))")
  );
  check("C0-first-connection-expands-overlay", true);

  await clickCenter(".live-overlay-min-btn");
  await waitFor("非全屏胶囊就绪", async () =>
    page.cdp.evaluate("Boolean(document.querySelector('.biliscript-fullscreen-live-mini-capsule:not(.is-hidden):not([hidden])'))")
  );

  const nonFsCapsuleState = await page.cdp.evaluate(`(() => {
    const capsule = document.querySelector('.biliscript-fullscreen-live-mini-capsule');
    const overlay = document.getElementById('biliscript-fullscreen-live-overlay');
    const btn = document.getElementById('biliscript-player-live-quick-action');
    const player = document.getElementById('player-container');
    const cRect = capsule.getBoundingClientRect();
    const pRect = player.getBoundingClientRect();
    return {
      capsuleVisible: Boolean(capsule && !capsule.hidden && !capsule.classList.contains('is-hidden')),
      overlayVisible: Boolean(overlay && !overlay.hidden && !overlay.classList.contains('is-hidden')),
      btnActive: btn.classList.contains('is-active'),
      controllerState: window.__mockLiveController.getState(),
      capsuleDistanceToPlayerRight: Math.round(pRect.right - cRect.right),
      capsuleDistanceToPlayerTop: Math.round(cRect.top - pRect.top),
      capsuleTag: capsule.tagName,
      capsuleStatus: capsule.querySelector('.live-overlay-mini-status-text')?.textContent,
      capsuleMic: capsule.querySelector('.live-overlay-mini-mic-text')?.textContent,
      capsuleExpanded: capsule.getAttribute('aria-expanded'),
      capsuleControls: capsule.getAttribute('aria-controls'),
      capsuleLabel: capsule.getAttribute('aria-label'),
      capsuleWidth: cRect.width,
      capsuleHeight: cRect.height,
      overlayId: overlay.id
    };
  })()`);

  check(
    "C1-non-fullscreen-minimized-capsule",
    nonFsCapsuleState.capsuleVisible &&
      !nonFsCapsuleState.overlayVisible &&
      nonFsCapsuleState.btnActive &&
      nonFsCapsuleState.controllerState === "connected" &&
      nonFsCapsuleState.capsuleDistanceToPlayerRight >= 0 &&
      nonFsCapsuleState.capsuleDistanceToPlayerRight <= 32,
    nonFsCapsuleState
  );
  check(
    "C1b-capsule-text-aria-and-target",
    nonFsCapsuleState.capsuleTag === "BUTTON" &&
      nonFsCapsuleState.capsuleStatus === "正在伴看" &&
      nonFsCapsuleState.capsuleMic === "麦克风已开启" &&
      nonFsCapsuleState.capsuleExpanded === "false" &&
      nonFsCapsuleState.capsuleControls === nonFsCapsuleState.overlayId &&
      nonFsCapsuleState.capsuleLabel.includes("正在伴看") &&
      nonFsCapsuleState.capsuleLabel.includes("麦克风已开启") &&
      nonFsCapsuleState.capsuleWidth >= 24 &&
      nonFsCapsuleState.capsuleHeight >= 24,
    nonFsCapsuleState
  );

  const shot1 = path.join(OUT_DIR, "01-capsule-non-fullscreen.png");
  await screenshot(page.cdp, shot1);

  await pressKey(".biliscript-fullscreen-live-mini-capsule", "Enter", "Enter", 13);
  await waitFor("非全屏浮窗展开", async () =>
    page.cdp.evaluate("Boolean(document.querySelector('#biliscript-fullscreen-live-overlay:not(.is-hidden):not([hidden])'))")
  );

  const nonFsExpandedState = await page.cdp.evaluate(`(() => {
    const capsule = document.querySelector('.biliscript-fullscreen-live-mini-capsule');
    const overlay = document.getElementById('biliscript-fullscreen-live-overlay');
    const minButton = overlay.querySelector('.live-overlay-min-btn');
    return {
      capsuleVisible: Boolean(capsule && !capsule.hidden && !capsule.classList.contains('is-hidden')),
      overlayVisible: Boolean(overlay && !overlay.hidden && !overlay.classList.contains('is-hidden')),
      focusClass: document.activeElement?.className,
      minExpanded: minButton.getAttribute('aria-expanded'),
      minControls: minButton.getAttribute('aria-controls'),
      overlayId: overlay.id
    };
  })()`);

  check(
    "C2-non-fullscreen-keyboard-expand-and-focus",
    !nonFsExpandedState.capsuleVisible &&
      nonFsExpandedState.overlayVisible &&
      String(nonFsExpandedState.focusClass).includes("live-overlay-min-btn") &&
      nonFsExpandedState.minExpanded === "true" &&
      nonFsExpandedState.minControls === nonFsExpandedState.overlayId,
    nonFsExpandedState
  );

  await pressKey(".live-overlay-mic-btn", " ", "Space", 32);
  const keyboardMuteState = await page.cdp.evaluate(`(() => ({
    muted: window.__mockLiveController.isMuted(),
    pressed: document.querySelector('.live-overlay-mic-btn').getAttribute('aria-pressed'),
    capsuleMic: document.querySelector('.live-overlay-mini-mic-text').textContent
  }))()`);
  check(
    "C2b-keyboard-mute-syncs-accessible-state",
    keyboardMuteState.muted && keyboardMuteState.pressed === "true" && keyboardMuteState.capsuleMic === "麦克风已静音",
    keyboardMuteState
  );

  const shot2 = path.join(OUT_DIR, "02-expanded-non-fullscreen.png");
  await screenshot(page.cdp, shot2);

  await clickCenter(".live-overlay-audio-btn");
  const nativePopoverState = await page.cdp.evaluate(`(() => {
    const button = document.querySelector('.live-overlay-audio-btn');
    const popover = document.querySelector('.live-overlay-audio-popover');
    const status = document.querySelector('.live-overlay-audio-status');
    const share = document.querySelector('.live-overlay-share-switch');
    const rect = popover.getBoundingClientRect();
    return {
      expanded: button.getAttribute('aria-expanded'),
      controls: button.getAttribute('aria-controls'),
      popoverId: popover.id,
      hidden: popover.hidden,
      nativeOpen: popover.matches(':popover-open'),
      withinViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      missingTrackVisible: !status.hidden && status.textContent.includes('未采到视频音轨') && status.textContent.includes('仍可语音伴看'),
      shareChecked: share.getAttribute('aria-checked'),
      liveState: window.__mockLiveController.getState()
    };
  })()`);
  check(
    "C2c-native-audio-popover-and-missing-track-status",
    nativePopoverState.expanded === "true" &&
      nativePopoverState.controls === nativePopoverState.popoverId &&
      !nativePopoverState.hidden &&
      nativePopoverState.nativeOpen &&
      nativePopoverState.withinViewport &&
      nativePopoverState.missingTrackVisible &&
      nativePopoverState.shareChecked === "true" &&
      nativePopoverState.liveState === "connected",
    nativePopoverState
  );

  const volumeMetrics = await getElementMetrics(".live-overlay-volume-slider:not(.live-overlay-speed-slider)");
  const volumeX = Math.round(volumeMetrics.left + volumeMetrics.width * 0.25);
  const volumeY = Math.round(volumeMetrics.cy);
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: volumeX, y: volumeY, button: "none", clickCount: 0 });
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: volumeX, y: volumeY, button: "left", buttons: 1, clickCount: 1 });
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: volumeX, y: volumeY, button: "left", buttons: 0, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 120));
  const volumeCommitState = await page.cdp.evaluate(`(() => ({
    value: document.querySelector('.live-overlay-volume-slider:not(.live-overlay-speed-slider)').value,
    commits: window.__volumeSyncValues.slice(),
    liveState: window.__mockLiveController.getState()
  }))()`);
  check(
    "C2d-volume-pointer-gesture-commits-once",
    volumeCommitState.value !== "100" &&
      volumeCommitState.commits.length === 1 &&
      String(volumeCommitState.commits[0]) === volumeCommitState.value &&
      volumeCommitState.liveState === "connected",
    volumeCommitState
  );

  await pressKey(".live-overlay-volume-slider:not(.live-overlay-speed-slider)", "Escape", "Escape", 27);
  const escapeCloseState = await page.cdp.evaluate(`(() => ({
    hidden: document.querySelector('.live-overlay-audio-popover').hidden,
    expanded: document.querySelector('.live-overlay-audio-btn').getAttribute('aria-expanded'),
    focusReturned: document.activeElement === document.querySelector('.live-overlay-audio-btn'),
    liveState: window.__mockLiveController.getState()
  }))()`);
  check(
    "C2e-escape-closes-only-popover-and-restores-focus",
    escapeCloseState.hidden && escapeCloseState.expanded === "false" && escapeCloseState.focusReturned && escapeCloseState.liveState === "connected",
    escapeCloseState
  );

  await clickCenter(".live-overlay-audio-btn");
  await clickCenter(".video-placeholder");
  const outsideCloseState = await page.cdp.evaluate(`(() => ({
    hidden: document.querySelector('.live-overlay-audio-popover').hidden,
    focusReturned: document.activeElement === document.querySelector('.live-overlay-audio-btn'),
    liveState: window.__mockLiveController.getState()
  }))()`);
  check(
    "C2f-outside-click-closes-only-popover",
    outsideCloseState.hidden && outsideCloseState.focusReturned && outsideCloseState.liveState === "connected",
    outsideCloseState
  );

  await page.cdp.evaluate(`(() => {
    document.getElementById('player-container').style.height = '1000px';
    const overlay = document.getElementById('biliscript-fullscreen-live-overlay');
    overlay.style.top = '850px';
    overlay.style.right = '16px';
    overlay.style.left = 'auto';
  })()`);
  await clickCenter(".live-overlay-audio-btn");
  const flippedPopoverState = await page.cdp.evaluate(`(() => {
    const popover = document.querySelector('.live-overlay-audio-popover');
    const button = document.querySelector('.live-overlay-audio-btn');
    const popoverRect = popover.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    return {
      placement: popover.dataset.placement,
      flippedAbove: popoverRect.bottom <= buttonRect.top - 6,
      withinViewport: popoverRect.left >= 0 && popoverRect.top >= 0 && popoverRect.right <= innerWidth && popoverRect.bottom <= innerHeight
    };
  })()`);
  check(
    "C2g-audio-popover-flips-at-viewport-edge",
    flippedPopoverState.placement === "top" && flippedPopoverState.flippedAbove && flippedPopoverState.withinViewport,
    flippedPopoverState
  );
  await pressKey(".live-overlay-audio-btn", "Escape", "Escape", 27);

  await page.cdp.evaluate(`(() => {
    document.getElementById('player-container').style.height = '562px';
    document.getElementById('biliscript-fullscreen-live-overlay').style.top = '16px';
    document.querySelector('.live-overlay-audio-popover').showPopover = undefined;
  })()`);
  await clickCenter(".live-overlay-audio-btn");
  const fallbackPopoverState = await page.cdp.evaluate(`(() => {
    const popover = document.querySelector('.live-overlay-audio-popover');
    const rect = popover.getBoundingClientRect();
    return {
      parent: popover.parentElement === document.body ? 'body' : 'other',
      position: getComputedStyle(popover).position,
      hidden: popover.hidden,
      withinViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
    };
  })()`);
  check(
    "C2h-fixed-popover-fallback-avoids-player-clipping",
    fallbackPopoverState.parent === "body" && fallbackPopoverState.position === "fixed" && !fallbackPopoverState.hidden && fallbackPopoverState.withinViewport,
    fallbackPopoverState
  );

  await page.cdp.evaluate(`(() => {
    const host = document.getElementById('player-container');
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: host });
    host.classList.add('is-fullscreen');
    document.dispatchEvent(new Event('fullscreenchange'));
  })()`);
  await new Promise((r) => setTimeout(r, 150));
  const fallbackFullscreenState = await page.cdp.evaluate(`(() => {
    const host = document.getElementById('player-container');
    const popover = document.querySelector('.live-overlay-audio-popover');
    return {
      popoverInFullscreenHost: popover.parentElement === host,
      overlayInFullscreenHost: document.getElementById('biliscript-fullscreen-live-overlay').parentElement === host,
      open: !popover.hidden,
      liveState: window.__mockLiveController.getState()
    };
  })()`);
  check(
    "C2h2-fallback-follows-fullscreen-host",
    fallbackFullscreenState.popoverInFullscreenHost && fallbackFullscreenState.overlayInFullscreenHost && fallbackFullscreenState.open && fallbackFullscreenState.liveState === "connected",
    fallbackFullscreenState
  );
  await page.cdp.evaluate(`(() => {
    const host = document.getElementById('player-container');
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
    host.classList.remove('is-fullscreen');
    document.dispatchEvent(new Event('fullscreenchange'));
  })()`);
  await new Promise((r) => setTimeout(r, 150));
  const fallbackExitState = await page.cdp.evaluate(`(() => ({
    returnedToBody: document.querySelector('.live-overlay-audio-popover').parentElement === document.body,
    open: !document.querySelector('.live-overlay-audio-popover').hidden
  }))()`);
  check("C2h3-fallback-follows-fullscreen-exit", fallbackExitState.returnedToBody && fallbackExitState.open, fallbackExitState);
  await page.cdp.evaluate(`delete document.fullscreenElement`);

  await clickCenter(".video-placeholder");
  await page.cdp.evaluate(`delete document.querySelector('.live-overlay-audio-popover').showPopover`);

  await clickCenter(".live-overlay-header-settings-btn");
  const settingsEntryState = await page.cdp.evaluate(`(() => ({
    targets: window.__liveSettingsTargets.slice(),
    hidden: document.querySelector('.live-overlay-audio-popover').hidden,
    liveState: window.__mockLiveController.getState()
  }))()`);
  check(
    "C2i-header-settings-btn-opens-live-provider-settings",
    settingsEntryState.targets.length === 1 && settingsEntryState.targets[0] === "live" && settingsEntryState.hidden && settingsEntryState.liveState === "connected",
    settingsEntryState
  );

  // =========================================================================
  // 2. 拖动浮窗：就近吸附左右边缘，缩放后保持可达，进出全屏不遮挡中央画面
  // =========================================================================
  const headerInfo = await getElementMetrics(".live-overlay-header");
  const dragStartX = Math.round(headerInfo.cx);
  const dragStartY = Math.round(headerInfo.cy);
  const dragDeltaX = -100;
  const dragDeltaY = 50;
  const dragEndX = dragStartX + dragDeltaX;
  const dragEndY = dragStartY + dragDeltaY;

  // 通过 CDP dispatchMouseEvent 模拟真指针拖拽
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: dragStartX, y: dragStartY, button: "none", clickCount: 0 });
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: dragStartX, y: dragStartY, button: "left", buttons: 1, clickCount: 1 });
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: dragEndX, y: dragEndY, button: "left", buttons: 1, clickCount: 1 });
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: dragEndX, y: dragEndY, button: "left", buttons: 0, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 250));

  const dragOffsetNonFs = await page.cdp.evaluate(`(() => {
    const overlay = document.getElementById('biliscript-fullscreen-live-overlay');
    const host = document.getElementById('player-container');
    const overlayRect = overlay.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    return {
      styleRight: overlay.style.right,
      styleTop: overlay.style.top,
      styleLeft: overlay.style.left,
      distanceToRight: Math.round(hostRect.right - overlayRect.right),
      distanceToTop: Math.round(overlayRect.top - hostRect.top)
    };
  })()`);

  check(
    "C3-drag-snaps-right-safe-gap",
    dragOffsetNonFs.styleRight === "16px" &&
      dragOffsetNonFs.styleLeft === "auto" &&
      dragOffsetNonFs.distanceToRight === 16 &&
      dragOffsetNonFs.distanceToTop === 66,
    dragOffsetNonFs
  );

  await page.cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }]
  });
  const leftDragStart = await getElementMetrics(".live-overlay-header");
  const leftDragEndX = Math.round(leftDragStart.cx) - 700;
  const leftDragEndY = Math.round(leftDragStart.cy) + 30;
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(leftDragStart.cx), y: Math.round(leftDragStart.cy), button: "none", clickCount: 0 });
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(leftDragStart.cx), y: Math.round(leftDragStart.cy), button: "left", buttons: 1, clickCount: 1 });
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: leftDragEndX, y: leftDragEndY, button: "left", buttons: 1, clickCount: 1 });
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: leftDragEndX, y: leftDragEndY, button: "left", buttons: 0, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 80));

  const leftSnapState = await page.cdp.evaluate(`(() => {
    const overlay = document.getElementById('biliscript-fullscreen-live-overlay');
    const host = document.getElementById('player-container');
    const overlayRect = overlay.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    return {
      styleLeft: overlay.style.left,
      styleRight: overlay.style.right,
      distanceToLeft: Math.round(overlayRect.left - hostRect.left),
      animations: overlay.getAnimations().length
    };
  })()`);
  check(
    "C3b-left-snap-without-reduced-motion-animation",
    leftSnapState.styleLeft === "16px" &&
      leftSnapState.styleRight === "auto" &&
      leftSnapState.distanceToLeft === 16 &&
      leftSnapState.animations === 0,
    leftSnapState
  );
  await page.cdp.send("Emulation.setEmulatedMedia", { features: [] });

  await page.cdp.evaluate(`document.getElementById('player-container').style.width = '700px'`);
  await new Promise((r) => setTimeout(r, 200));
  const resizedSnapState = await page.cdp.evaluate(`(() => {
    const overlay = document.getElementById('biliscript-fullscreen-live-overlay');
    const host = document.getElementById('player-container');
    const overlayRect = overlay.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    return {
      hostWidth: Math.round(hostRect.width),
      styleLeft: overlay.style.left,
      distanceToLeft: Math.round(overlayRect.left - hostRect.left),
      withinHost: overlayRect.right <= hostRect.right && overlayRect.bottom <= hostRect.bottom
    };
  })()`);
  check(
    "C3c-resize-preserves-reachable-left-snap",
    resizedSnapState.hostWidth === 700 &&
      resizedSnapState.styleLeft === "16px" &&
      resizedSnapState.distanceToLeft === 16 &&
      resizedSnapState.withinHost,
    resizedSnapState
  );
  await page.cdp.evaluate(`document.getElementById('player-container').style.width = '1000px'`);
  await new Promise((r) => setTimeout(r, 200));

  // 进全屏模式（模拟 1920x1080 浏览器全屏或网页全屏）
  await page.cdp.evaluate(`(() => {
    const container = document.getElementById('player-container');
    container.classList.add('is-fullscreen');
    container.setAttribute('data-screen', 'web');
    window.__liveBinding.getOverlay().show();
  })()`);
  await new Promise((r) => setTimeout(r, 200));

  const fullscreenState = await page.cdp.evaluate(`(() => {
    const container = document.getElementById('player-container');
    const overlay = document.getElementById('biliscript-fullscreen-live-overlay');
    const cRect = container.getBoundingClientRect();
    const oRect = overlay.getBoundingClientRect();

    // 屏幕/播放器中心 50% 核心画面区域定义
    const centerZone = {
      left: cRect.width * 0.25,
      right: cRect.width * 0.75,
      top: cRect.height * 0.25,
      bottom: cRect.height * 0.75
    };

    // 判定浮窗包围盒是否侵入中央区域
    const overlapsCenter = !(
      oRect.right < centerZone.left ||
      oRect.left > centerZone.right ||
      oRect.bottom < centerZone.top ||
      oRect.top > centerZone.bottom
    );

    const distanceToContainerRight = Math.round(cRect.right - oRect.right);
    const distanceToContainerTop = Math.round(oRect.top - cRect.top);

    return {
      containerWidth: Math.round(cRect.width),
      containerHeight: Math.round(cRect.height),
      overlayRect: { left: Math.round(oRect.left), right: Math.round(oRect.right), top: Math.round(oRect.top), bottom: Math.round(oRect.bottom) },
      centerZone,
      overlapsCenter,
      distanceToContainerRight,
      distanceToContainerTop,
      styleRight: overlay.style.right,
      styleTop: overlay.style.top
    };
  })()`);

  check(
    "C4-fullscreen-center-not-obscured",
    fullscreenState.containerWidth === 1920 &&
      fullscreenState.containerHeight === 1080 &&
      !fullscreenState.overlapsCenter &&
      fullscreenState.distanceToContainerRight >= 0 &&
      fullscreenState.distanceToContainerTop >= 0,
    fullscreenState
  );

  const shot3 = path.join(OUT_DIR, "03-dragged-fullscreen-snapped.png");
  await screenshot(page.cdp, shot3);

  // 全屏下用键盘最小化回胶囊，再用指针展开
  await pressKey(".live-overlay-min-btn", "Enter", "Enter", 13);
  await waitFor("全屏胶囊显形", async () =>
    page.cdp.evaluate("Boolean(document.querySelector('.biliscript-fullscreen-live-mini-capsule:not(.is-hidden):not([hidden])'))")
  );

  const fullscreenCapsuleState = await page.cdp.evaluate(`(() => {
    const capsule = document.querySelector('.biliscript-fullscreen-live-mini-capsule');
    const overlay = document.getElementById('biliscript-fullscreen-live-overlay');
    return {
      capsuleVisible: Boolean(capsule && !capsule.hidden && !capsule.classList.contains('is-hidden')),
      overlayVisible: Boolean(overlay && !overlay.hidden && !overlay.classList.contains('is-hidden')),
      focused: document.activeElement === capsule,
      capsuleExpanded: capsule.getAttribute('aria-expanded'),
      capsuleMic: capsule.querySelector('.live-overlay-mini-mic-text')?.textContent
    };
  })()`);

  check(
    "C4b-fullscreen-keyboard-minimize-and-focus",
    fullscreenCapsuleState.capsuleVisible &&
      !fullscreenCapsuleState.overlayVisible &&
      fullscreenCapsuleState.focused &&
      fullscreenCapsuleState.capsuleExpanded === "false" &&
      fullscreenCapsuleState.capsuleMic === "麦克风已静音",
    fullscreenCapsuleState
  );

  const capsuleDragStart = await getElementMetrics(".biliscript-fullscreen-live-mini-capsule");
  const capsuleDragEndX = Math.round(capsuleDragStart.cx) + 1200;
  const capsuleDragY = Math.round(capsuleDragStart.cy);
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(capsuleDragStart.cx), y: capsuleDragY, button: "none", clickCount: 0 });
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(capsuleDragStart.cx), y: capsuleDragY, button: "left", buttons: 1, clickCount: 1 });
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: capsuleDragEndX, y: capsuleDragY, button: "left", buttons: 1, clickCount: 1 });
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: capsuleDragEndX, y: capsuleDragY, button: "left", buttons: 0, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 250));
  const capsuleDragState = await page.cdp.evaluate(`(() => {
    const capsule = document.querySelector('.biliscript-fullscreen-live-mini-capsule');
    const overlay = document.getElementById('biliscript-fullscreen-live-overlay');
    return {
      capsuleVisible: !capsule.hidden && !capsule.classList.contains('is-hidden'),
      overlayHidden: overlay.hidden && overlay.classList.contains('is-hidden'),
      styleRight: capsule.style.right,
      styleLeft: capsule.style.left,
      liveState: window.__mockLiveController.getState()
    };
  })()`);
  check(
    "C4c-capsule-drag-snaps-without-expanding",
    capsuleDragState.capsuleVisible &&
      capsuleDragState.overlayHidden &&
      capsuleDragState.styleRight === "16px" &&
      capsuleDragState.styleLeft === "auto" &&
      capsuleDragState.liveState === "connected",
    capsuleDragState
  );

  // 点击全屏胶囊重新展开
  await clickCenter(".biliscript-fullscreen-live-mini-capsule");
  await waitFor("全屏胶囊展开", async () =>
    page.cdp.evaluate("Boolean(document.querySelector('#biliscript-fullscreen-live-overlay:not(.is-hidden):not([hidden])'))")
  );

  // 退回非全屏模式
  await page.cdp.evaluate(`(() => {
    const container = document.getElementById('player-container');
    container.classList.remove('is-fullscreen');
    container.removeAttribute('data-screen');
    window.__liveBinding.getOverlay().show();
  })()`);
  await new Promise((r) => setTimeout(r, 200));

  const hostMigrationState = await page.cdp.evaluate(`(() => {
    const overlay = document.getElementById('biliscript-fullscreen-live-overlay');
    const capsule = document.querySelector('.biliscript-fullscreen-live-mini-capsule');
    window.__overlayBeforeHostSwap = overlay;
    window.__capsuleBeforeHostSwap = capsule;
    const oldHost = document.getElementById('player-container');
    const newHost = oldHost.cloneNode(true);
    newHost.querySelectorAll('#biliscript-fullscreen-live-overlay, .biliscript-fullscreen-live-mini-capsule').forEach((el) => el.remove());
    oldHost.replaceWith(newHost);
    return true;
  })()`);
  await waitFor("播放器宿主替换后迁移浮窗", async () => page.cdp.evaluate(`(() => {
    const host = document.getElementById('player-container');
    const overlay = document.getElementById('biliscript-fullscreen-live-overlay');
    const capsule = document.querySelector('.biliscript-fullscreen-live-mini-capsule');
    return host && overlay?.parentElement === host && capsule?.parentElement === host;
  })()`));
  const migratedState = await page.cdp.evaluate(`(() => {
    const overlay = document.getElementById('biliscript-fullscreen-live-overlay');
    const capsule = document.querySelector('.biliscript-fullscreen-live-mini-capsule');
    return {
      sameOverlay: overlay === window.__overlayBeforeHostSwap,
      sameCapsule: capsule === window.__capsuleBeforeHostSwap,
      expanded: !overlay.hidden && capsule.hidden,
      liveState: window.__mockLiveController.getState()
    };
  })()`);
  check(
    "C4d-host-replacement-preserves-nodes-presentation-and-session",
    hostMigrationState &&
      migratedState.sameOverlay &&
      migratedState.sameCapsule &&
      migratedState.expanded &&
      migratedState.liveState === "connected",
    migratedState
  );

  // =========================================================================
  // 3. 伴看进行中，文摘面板发起文本问答：两者互不冲突，会话不断开
  // =========================================================================
  const chatPrompt = "伴看进行中发起文本问答：请简述视频关键论点";
  await page.cdp.evaluate(`window.__sendPanelChat(${JSON.stringify(chatPrompt)})`);
  await new Promise((r) => setTimeout(r, 150));

  // 伴看流式注入语音转写与回复
  await page.cdp.evaluate(`(() => {
    window.__callbacks.onTranscript({
      kind: "input.done",
      text: "伴看语音提问：镜头里的人是谁？"
    });
    window.__callbacks.onTranscript({
      kind: "output.updated",
      runId: "run-e2e-1",
      turnId: "turn-e2e-1",
      text: "伴看实时语音解答：这是视频主讲人。"
    });
  })()`);
  await new Promise((r) => setTimeout(r, 150));

  const concurrencyState = await page.cdp.evaluate(`(() => {
    const liveState = window.__mockLiveController.getState();
    const overlay = document.getElementById('biliscript-fullscreen-live-overlay');
    const quickBtn = document.getElementById('biliscript-player-live-quick-action');
    const panelMessages = document.getElementById('biliscript-reading-chat-messages');
    const overlayMessages = overlay ? overlay.querySelector('.live-overlay-messages') : null;

    const panelText = panelMessages ? panelMessages.textContent || "" : "";
    const overlayText = overlayMessages ? overlayMessages.textContent || "" : "";

    return {
      liveState,
      overlayVisible: Boolean(overlay && !overlay.hidden && !overlay.classList.contains('is-hidden')),
      quickBtnActive: quickBtn.classList.contains('is-active'),
      panelText,
      overlayText
    };
  })()`);

  check(
    "C5-companion-session-persists-during-panel-chat",
    concurrencyState.liveState === "connected" && concurrencyState.overlayVisible && concurrencyState.quickBtnActive,
    { liveState: concurrencyState.liveState, overlayVisible: concurrencyState.overlayVisible }
  );

  check(
    "C6-panel-chat-response-received",
    concurrencyState.panelText.includes(chatPrompt) && concurrencyState.panelText.includes("面板文本问答回复"),
    { panelText: concurrencyState.panelText }
  );

  // =========================================================================
  // 4. 内容隔离：面板历史没有伴看内容，浮窗没有面板问答内容
  // =========================================================================
  check(
    "C7-panel-history-has-no-companion-content",
    !concurrencyState.panelText.includes("伴看语音提问") && !concurrencyState.panelText.includes("伴看实时语音解答"),
    { panelText: concurrencyState.panelText }
  );

  check(
    "C8-companion-overlay-has-no-panel-content",
    concurrencyState.overlayText.includes("伴看语音提问") &&
      concurrencyState.overlayText.includes("伴看实时语音解答") &&
      !concurrencyState.overlayText.includes(chatPrompt) &&
      !concurrencyState.overlayText.includes("面板文本问答回复"),
    { overlayText: concurrencyState.overlayText }
  );

  const shot4 = path.join(OUT_DIR, "04-companion-with-panel-chat.png");
  await screenshot(page.cdp, shot4);

  check(
    "C9-screenshots-generated",
    existsSync(shot1) && existsSync(shot2) && existsSync(shot3) && existsSync(shot4),
    { shot1, shot2, shot3, shot4 }
  );

  await pressKey(".live-overlay-close-btn", " ", "Space", 32);
  const keyboardStopState = await page.cdp.evaluate(`(() => {
    const overlay = document.getElementById('biliscript-fullscreen-live-overlay');
    const capsule = document.querySelector('.biliscript-fullscreen-live-mini-capsule');
    return {
      liveState: window.__mockLiveController.getState(),
      overlayHidden: overlay.hidden && overlay.hasAttribute('inert'),
      capsuleHidden: capsule.hidden && capsule.hasAttribute('inert')
    };
  })()`);
  check(
    "C10-keyboard-stop-hides-idle-overlay",
    keyboardStopState.liveState === "idle" && keyboardStopState.overlayHidden && keyboardStopState.capsuleHidden,
    keyboardStopState
  );

  await writeEvidence(OUT_DIR, {
    failed: checks.filter((c) => !c.ok).map((c) => c.name),
    checks,
    concurrencyState
  });

  if (checks.some((c) => !c.ok)) {
    process.exitCode = 1;
  }
} finally {
  await teardown({ browser, cdps: [page.cdp] });
}
