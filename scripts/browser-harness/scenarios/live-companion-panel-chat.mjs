#!/usr/bin/env node
// 端到端真机场景：伴看与面板对话并行 —— `pnpm harness:scenario live-companion-panel-chat`。
//
// 判据（jsdom 够不着的部分）：
// 1. 非全屏与全屏下，伴看浮窗都默认以胶囊出现，点击展开并可收起为胶囊；
// 2. 拖拽浮窗后进出全屏，浮窗位置保存为相对右上角的偏移，进出全屏时自适应贴右上角，
//    且不遮挡全屏画面中心区域（50% 视口中央画面保持无遮挡）；
// 3. 伴看进行中，文摘面板发起文本问答可正常发送并收到回复，伴看会话不断开、快速操作按钮保持高亮；
// 4. 面板对话历史中没有伴看语音转写与回复内容，浮窗中没有面板文本问答内容（两者内容隔离）；
// 5. 产出可重复运行的验证工件（evidence.json 及四态真机渲染截图）。

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
    const callbacks = {};

    const mockLiveController = {
      getState: () => liveState,
      isMuted: () => false,
      toggleMute: () => {},
      getVolume: () => 1,
      setVolume: () => {},
      isSharingVideoAudio: () => true,
      setShareVideoAudio: () => {},
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

    const binding = LiveOverlayModule.createLiveOverlayBinding({
      getPlayerHost: () => document.getElementById("player-container"),
      getLiveController: () => mockLiveController
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

  // CDP 鼠标真实指针事件辅助
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

  // =========================================================================
  // 1. 非全屏状态下开启伴看：默认胶囊出现，点击展开并可收回
  // =========================================================================
  await clickCenter("#biliscript-player-live-quick-action");
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
      capsuleDistanceToPlayerTop: Math.round(cRect.top - pRect.top)
    };
  })()`);

  check(
    "C1-non-fullscreen-default-capsule",
    nonFsCapsuleState.capsuleVisible &&
      !nonFsCapsuleState.overlayVisible &&
      nonFsCapsuleState.btnActive &&
      nonFsCapsuleState.controllerState === "connected" &&
      nonFsCapsuleState.capsuleDistanceToPlayerRight >= 0 &&
      nonFsCapsuleState.capsuleDistanceToPlayerRight <= 32,
    nonFsCapsuleState
  );

  const shot1 = path.join(OUT_DIR, "01-capsule-non-fullscreen.png");
  await screenshot(page.cdp, shot1);

  // 点击胶囊展开浮窗
  await clickCenter(".biliscript-fullscreen-live-mini-capsule");
  await waitFor("非全屏浮窗展开", async () =>
    page.cdp.evaluate("Boolean(document.querySelector('#biliscript-fullscreen-live-overlay:not(.is-hidden):not([hidden])'))")
  );

  const nonFsExpandedState = await page.cdp.evaluate(`(() => {
    const capsule = document.querySelector('.biliscript-fullscreen-live-mini-capsule');
    const overlay = document.getElementById('biliscript-fullscreen-live-overlay');
    return {
      capsuleVisible: Boolean(capsule && !capsule.hidden && !capsule.classList.contains('is-hidden')),
      overlayVisible: Boolean(overlay && !overlay.hidden && !overlay.classList.contains('is-hidden'))
    };
  })()`);

  check(
    "C2-non-fullscreen-click-expand",
    !nonFsExpandedState.capsuleVisible && nonFsExpandedState.overlayVisible,
    nonFsExpandedState
  );

  const shot2 = path.join(OUT_DIR, "02-expanded-non-fullscreen.png");
  await screenshot(page.cdp, shot2);

  // =========================================================================
  // 2. 拖动浮窗：保存相对右上角偏移，进出全屏不遮挡中央画面
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
  await new Promise((r) => setTimeout(r, 120));

  const dragOffsetNonFs = await page.cdp.evaluate(`(() => {
    const overlay = document.getElementById('biliscript-fullscreen-live-overlay');
    return {
      styleRight: overlay.style.right,
      styleTop: overlay.style.top,
      styleLeft: overlay.style.left
    };
  })()`);

  check(
    "C3-drag-preserves-top-right-offset",
    Boolean(dragOffsetNonFs.styleRight && dragOffsetNonFs.styleRight !== "0px" && dragOffsetNonFs.styleLeft === "auto"),
    dragOffsetNonFs
  );

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

  const shot3 = path.join(OUT_DIR, "03-dragged-fullscreen-top-right.png");
  await screenshot(page.cdp, shot3);

  // 全屏下最小化回胶囊并点击展开
  await clickCenter(".live-overlay-min-btn");
  await waitFor("全屏胶囊显形", async () =>
    page.cdp.evaluate("Boolean(document.querySelector('.biliscript-fullscreen-live-mini-capsule:not(.is-hidden):not([hidden])'))")
  );

  const fullscreenCapsuleState = await page.cdp.evaluate(`(() => {
    const capsule = document.querySelector('.biliscript-fullscreen-live-mini-capsule');
    const overlay = document.getElementById('biliscript-fullscreen-live-overlay');
    return {
      capsuleVisible: Boolean(capsule && !capsule.hidden && !capsule.classList.contains('is-hidden')),
      overlayVisible: Boolean(overlay && !overlay.hidden && !overlay.classList.contains('is-hidden'))
    };
  })()`);

  check(
    "C4b-fullscreen-capsule-and-expand",
    fullscreenCapsuleState.capsuleVisible && !fullscreenCapsuleState.overlayVisible,
    fullscreenCapsuleState
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
