#!/usr/bin/env node
// 对话回答朗读的真实页面回归：内容脚本没有 chrome.tts，按钮调用必须经 SW 完成。

import path from "node:path";
import { readFileSync } from "node:fs";
import {
  REPO_ROOT,
  artifactDir,
  attachPage,
  createWorkerSession,
  log,
  sleep,
  waitFor,
  withBrowser,
  writeEvidence
} from "../harness.mjs";

const OUT_DIR = artifactDir(path.join("scenarios", "chat-speech"));
const meta = JSON.parse(readFileSync(path.join(REPO_ROOT, "tests", "fixtures", "bilibili", "bilingual-walkthrough", "meta.json"), "utf8"));
const bvid = meta.sampleBvid;
const cid = String(meta.sampleCid);
const url = `https://www.bilibili.com/video/${bvid}/`;
const evidence = { checks: [], speech: null, page: null };

function check(name, ok, detail = null) {
  evidence.checks.push({ name, ok: Boolean(ok), detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
}

try {
  await withBrowser({}, async ({ browser }) => {
    const page = await attachPage(browser);
    await page.cdp.send("Page.navigate", { url });
    await waitFor("扩展按钮注入", async () => page.cdp.evaluate("!!document.getElementById('biliscript-script-button')"), { timeoutMs: 45000, intervalMs: 250 });
    await page.cdp.evaluate("document.querySelectorAll('video,audio').forEach((media) => media.pause())");

    const worker = createWorkerSession({ pageCdp: page.cdp, browser });
    await worker.ensureAlive();
    const conversation = {
      id: "chat-speech-e2e",
      title: "朗读测试-P1",
      contextKey: `video:${bvid}|${cid}`,
      contextTitle: "朗读测试",
      contextUrl: url,
      isVideoContext: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      contextRef: { bvid, cid, url, pageIndex: 1 },
      messages: [{ role: "assistant", content: "这是一段中文朗读测试。" }]
    };
    await worker.evaluate(`chrome.storage.local.set({ biliscript_ai_conversations_v1: [${JSON.stringify(conversation)}] })`);
    await worker.evaluate(`chrome.storage.sync.set({ asrAutoFallback: false, aiProviders: [{ id: "speech-stub", presetId: "custom", name: "speech-stub", baseUrl: "https://speech.invalid", models: ["speech-model"], requiresKey: false, enabled: true, protocol: "openai" }] })`);
    await worker.evaluate(`(() => {
      const events = globalThis.__chatSpeechEvidence = [];
      const originalGetVoices = chrome.tts.getVoices.bind(chrome.tts);
      chrome.tts.getVoices = async () => [
        { voiceName: "Microsoft Huihui Desktop", lang: "zh-CN", remote: false },
        ...(await originalGetVoices())
      ];
      const original = chrome.tts.speak.bind(chrome.tts);
      chrome.tts.speak = (text, options) => original(text, {
        ...options,
        onEvent: (event) => {
          events.push({ event, voiceName: options.voiceName, lang: options.lang });
          options.onEvent?.(event);
        }
      });
      return typeof chrome.tts.getVoices === "function";
    })()`);

    await page.cdp.evaluate("document.getElementById('biliscript-script-button').click()");
    await waitFor("对话标签", async () => page.cdp.evaluate("!!document.getElementById('biliscript-reading-tab-chat')"), { timeoutMs: 15000, intervalMs: 200 });
    await page.cdp.evaluate("document.getElementById('biliscript-reading-tab-chat').click()");
    await waitFor("历史对话", async () => page.cdp.evaluate("!!document.querySelector('.chat-history-open')"), { timeoutMs: 15000, intervalMs: 200 });
    await page.cdp.evaluate("document.querySelector('.chat-history-open').click()");
    await waitFor("朗读按钮", async () => page.cdp.evaluate("!!document.querySelector('.chat-msg-speak-btn:not([disabled])')"), { timeoutMs: 15000, intervalMs: 200 });
    await sleep(500);
    await page.cdp.evaluate("document.querySelector('.chat-msg-speak-btn').click()");

    let sawSpeaking = false;
    let last = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      last = await page.cdp.evaluate(`(() => {
        const button = document.querySelector('.chat-msg-speak-btn');
        return {
          label: button?.getAttribute('aria-label') || null,
          pressed: button?.getAttribute('aria-pressed') || null,
          notices: Array.from(document.querySelectorAll('.chat-context-notice')).map((node) => node.textContent.trim()).filter(Boolean)
        };
      })()`);
      if (last.label === "停止朗读") sawSpeaking = true;
      if (last.notices.some((text) => text.includes("无法朗读"))) break;
      if (sawSpeaking && last.label === "朗读回答") break;
      await sleep(50);
    }
    evidence.page = { sawSpeaking, last };
    evidence.speech = await worker.evaluate("globalThis.__chatSpeechEvidence || []");
    check("页面朗读进入播放态", sawSpeaking, evidence.page);
    check("页面朗读无设备错误", !last?.notices?.some((text) => text.includes("无法朗读")), last);
    check("朗读结束后按钮恢复", last?.label === "朗读回答" && last?.pressed === "false", last);
    check("SW 收到真实朗读事件", evidence.speech.some((item) => item.event.type === "start") && evidence.speech.some((item) => item.event.type === "end"), evidence.speech);
    check("优先选中 Natural 音色而非本地 SAPI 机械音", evidence.speech.some((item) => /Natural/i.test(item.voiceName || "")), evidence.speech);
  });
} catch (error) {
  check("场景无致命错误", false, { message: error.message });
}

evidence.failed = evidence.checks.filter((item) => !item.ok).map((item) => item.name);
await writeEvidence(OUT_DIR, evidence);
if (evidence.failed.length) process.exitCode = 1;
