#!/usr/bin/env node
import path from "node:path";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import {
  CDP,
  REPO_ROOT,
  artifactDir,
  attachPage,
  createWorkerSession,
  log,
  waitFor,
  withBrowser,
  writeEvidence
} from "../harness.mjs";

const NAME = "chat-historical-frame";
const OUT_DIR = artifactDir(path.join("scenarios", NAME));
const fixture = JSON.parse(readFileSync(path.join(REPO_ROOT, "tests", "fixtures", "bilibili", "hidden-video-seek-probe.json"), "utf8"));
const sample = fixture.samples[0];
const url = `https://www.bilibili.com/video/${sample.bvid}/`;
const fixtureDir = path.join(REPO_ROOT, "tests", "fixtures", "bilibili", "bilingual-walkthrough");
const bundles = JSON.parse(readFileSync(path.join(fixtureDir, "bundles.json"), "utf8"));
const bodies = JSON.parse(readFileSync(path.join(fixtureDir, "bodies.json"), "utf8"));
const evidence = { checks: [], requests: [], player: null, answer: "" };

function check(name, ok, detail = null) {
  evidence.checks.push({ name, ok: Boolean(ok), detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(detail)?.slice(0, 500) || ""}`);
}

async function installSubtitleFixtures(worker) {
  const { cdp, sessionId } = worker.handle;
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId);
  cdp.on("Fetch.requestPaused", async (params) => {
    const requestUrl = params.request?.url || "";
    const requestId = params.requestId;
    let payload = null;
    if (/x\/player\/(?:wbi\/)?v2/.test(requestUrl) && requestUrl.includes(sample.bvid)) {
      payload = bundles[sample.bvid];
    } else {
      const match = /walkthrough-fixture\/([A-Za-z0-9-]+)\.json$/.exec(requestUrl);
      if (match && bodies[match[1]]) payload = bodies[match[1]];
    }
    try {
      if (payload) {
        await cdp.send("Fetch.fulfillRequest", {
          requestId,
          responseCode: 200,
          responseHeaders: [{ name: "content-type", value: "application/json" }],
          body: Buffer.from(JSON.stringify(payload), "utf8").toString("base64")
        }, sessionId);
      } else {
        await cdp.send("Fetch.continueRequest", { requestId }, sessionId);
      }
    } catch {}
  });
}

async function attachOffscreen(browser) {
  const target = await waitFor("offscreen target", async () => {
    const response = await fetch(`http://127.0.0.1:${browser.port}/json/list`);
    const targets = await response.json();
    return targets.find((item) => item.type !== "page" && item.url.endsWith("/entry/offscreen.html"));
  }, { timeoutMs: 20000, intervalMs: 200 });
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  return cdp;
}

async function installModelStub(cdp) {
  await cdp.evaluate("globalThis.__historicalFrameRequests = []; globalThis.__historicalFrameToolRequests = 0; globalThis.__historicalFrameDataUrl = null");
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/chat/completions", requestStage: "Request" }] });
  cdp.on("Fetch.requestPaused", async (params) => {
    const body = JSON.parse(params.request.postData || "{}");
    await cdp.evaluate("globalThis.__historicalFrameRequests.push(" + JSON.stringify(body) + ")");
    const isToolConversation = body.tools || body.messages?.some((message) => message.role === "tool");
    const toolRequestCount = isToolConversation
      ? await cdp.evaluate("++globalThis.__historicalFrameToolRequests")
      : 0;
    const content = body.messages?.[0]?.content?.includes("3 个")
      ? '["视频讲了什么？","有哪些关键结论？","如何应用这些结论？"]'
      : '{"summary":"受控回放概览","chapters":[],"keyQuotes":[]}';
    const chunks = toolRequestCount === 1
      ? [
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "history_e2e", type: "function", function: { name: "capture_video_frame_at_time", arguments: JSON.stringify({ targetTime: sample.targetTime }) } }] }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
        ]
      : [
          { choices: [{ delta: { content: toolRequestCount === 2 ? "已结合字幕与历史画面作答" : content }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] }
        ];
    if (toolRequestCount > 1) {
      const imageMessage = body.messages.find((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image_url"));
      const imagePart = imageMessage?.content.find((part) => part.type === "image_url");
      await cdp.evaluate("globalThis.__historicalFrameDataUrl = " + JSON.stringify(imagePart?.image_url?.url || null));
    }
    const stream = chunks.map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n";
    await cdp.send("Fetch.fulfillRequest", {
      requestId: params.requestId,
      responseCode: 200,
      responseHeaders: [{ name: "content-type", value: "text/event-stream" }],
      body: Buffer.from(stream, "utf8").toString("base64")
    });
  });
}

try {
  await withBrowser({ autoplay: true }, async (context) => {
    const { browser } = context;
    const page = await attachPage(browser);
    context.cdps = [page.cdp];
    const worker = createWorkerSession({ pageCdp: page.cdp, browser });
    await worker.ensureAlive();
    await installSubtitleFixtures(worker);
    const extensionId = await worker.evaluate("chrome.runtime.id");
    await worker.evaluate(`chrome.storage.sync.set({
      activeAiProviderId: "historical-stub",
      asrAutoFallback: false,
      webSearchEnabled: false,
      aiProviders: [{
        id: "historical-stub",
        presetId: "custom",
        name: "historical-stub",
        baseUrl: "https://api.bilibili.com",
        models: ["historical-vision"],
        requiresKey: false,
        enabled: true,
        protocol: "openai"
      }]
    })`);

    await page.cdp.send("Page.navigate", { url: `chrome-extension://${extensionId}/entry/offscreen.html` });
    await waitFor("扩展页可发消息", () => page.cdp.evaluate("typeof chrome === 'object' && typeof chrome.runtime?.sendMessage === 'function'"));
    await page.cdp.evaluate("chrome.runtime.sendMessage({ type: 'ensure-offscreen-chat' })");
    const offscreen = await attachOffscreen(browser);
    context.cdps.push(offscreen);
    await installModelStub(offscreen);

    await page.cdp.send("Page.navigate", { url });
    await waitFor("页面视频与扩展按钮", () => page.cdp.evaluate("document.querySelector('video')?.readyState >= 1 && !!document.getElementById('biliscript-script-button')"), { timeoutMs: 60000, intervalMs: 300 });
    await page.cdp.evaluate(`(() => {
      const player = document.querySelector("video");
      player.pause();
      globalThis.__historicalPlayerEvidence = { seekEvents: 0, playEvents: 0, pauseEvents: 0 };
      player.addEventListener("seeking", () => globalThis.__historicalPlayerEvidence.seekEvents++);
      player.addEventListener("play", () => globalThis.__historicalPlayerEvidence.playEvents++);
      player.addEventListener("pause", () => globalThis.__historicalPlayerEvidence.pauseEvents++);
      globalThis.__historicalPlayerBefore = {
        currentTime: player.currentTime,
        paused: player.paused,
        muted: player.muted,
        volume: player.volume,
        playbackRate: player.playbackRate
      };
    })()`);

    await page.cdp.evaluate("document.getElementById('biliscript-script-button').click()");
    await waitFor("对话标签", () => page.cdp.evaluate("!!document.getElementById('biliscript-reading-tab-chat')"), { timeoutMs: 20000, intervalMs: 200 });
    await page.cdp.evaluate("document.getElementById('biliscript-reading-tab-chat').click()");
    await waitFor("对话输入框", () => page.cdp.evaluate("!!document.getElementById('biliscript-reading-chat-input')"), { timeoutMs: 20000, intervalMs: 200 });
    await waitFor("对话模型选项", () => page.cdp.evaluate("document.getElementById('biliscript-reading-chat-model-select')?.value.includes('historical-stub')"), { timeoutMs: 20000, intervalMs: 200 });
    await page.cdp.evaluate(`(() => {
      const input = document.getElementById("biliscript-reading-chat-input");
      input.value = ${JSON.stringify(`请说明 ${sample.targetTime} 秒附近的内容，字幕不足时查看当时画面。`)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      globalThis.__historicalFrameAnswer = "";
      const messages = document.getElementById("biliscript-reading-chat-messages");
      const observer = new MutationObserver(() => {
        if (messages.textContent.includes("已结合字幕与历史画面作答")) {
          globalThis.__historicalFrameAnswer = messages.textContent;
          observer.disconnect();
        }
      });
      observer.observe(messages, { childList: true, subtree: true, characterData: true });
    })()`);
    await waitFor("字幕就绪且发送键可用", () => page.cdp.evaluate("document.getElementById('biliscript-reading-chat-send-btn')?.disabled === false"), { timeoutMs: 60000, intervalMs: 200 });
    await page.cdp.evaluate("document.getElementById('biliscript-reading-chat-send-btn').click()");

    try {
      await waitFor("历史帧工具对话完成", () => page.cdp.evaluate("Boolean(globalThis.__historicalFrameAnswer)"), { timeoutMs: 150000, intervalMs: 500 });
    } catch (error) {
      evidence.diagnostics = {
        requests: await offscreen.evaluate("globalThis.__historicalFrameRequests || []"),
        dataUrlPresent: await offscreen.evaluate("Boolean(globalThis.__historicalFrameDataUrl)"),
        page: await page.cdp.evaluate(`(() => ({
          text: document.getElementById("biliscript-reading-chat-messages")?.textContent || "",
          input: document.getElementById("biliscript-reading-chat-input")?.value,
          sendDisabled: document.getElementById("biliscript-reading-chat-send-btn")?.disabled,
          videos: Array.from(document.querySelectorAll("video")).map((video) => ({ src: video.currentSrc.slice(0, 180), currentTime: video.currentTime, paused: video.paused, readyState: video.readyState, hidden: video.style.visibility }))
        }))()`)
      };
      throw error;
    }
    const requests = (await offscreen.evaluate("globalThis.__historicalFrameRequests || []")).filter((body) => body.tools || body.messages?.some((message) => message.role === "tool"));
    evidence.requests = requests.map((body) => ({
      tools: body.tools?.map((tool) => tool.function.name),
      messages: body.messages.map((message) => ({
        role: message.role,
        content: typeof message.content === "string" ? message.content : message.content.map((part) => part.type === "image_url" ? { type: "image_url", bytes: part.image_url.url.length } : part),
        tool_call_id: message.tool_call_id
      }))
    }));
    const dataUrl = await offscreen.evaluate("globalThis.__historicalFrameDataUrl");
    let imageBytes = 0;
    if (dataUrl?.startsWith("data:image/jpeg;base64,")) {
      const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
      imageBytes = bytes.length;
      await mkdir(OUT_DIR, { recursive: true });
      await writeFile(path.join(OUT_DIR, "historical-frame.jpg"), bytes);
    }
    evidence.answer = await page.cdp.evaluate("globalThis.__historicalFrameAnswer");
    evidence.player = await page.cdp.evaluate(`(() => {
      const player = document.querySelector("video");
      return {
        before: globalThis.__historicalPlayerBefore,
        after: { currentTime: player.currentTime, paused: player.paused, muted: player.muted, volume: player.volume, playbackRate: player.playbackRate },
        events: globalThis.__historicalPlayerEvidence,
        hiddenRemaining: Array.from(document.querySelectorAll("video")).filter((video) => video.style.left === "-10000px").length
      };
    })()`);

    check("首请求自主工具面包含当前帧与历史帧", evidence.requests[0]?.tools?.includes("capture_current_video_frame") && evidence.requests[0]?.tools?.includes("capture_video_frame_at_time"), evidence.requests[0]?.tools);
    const followup = requests[1]?.messages || [];
    const toolMessage = followup.find((message) => message.role === "tool" && message.tool_call_id === "history_e2e");
    const imageMessage = followup.find((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image_url"));
    check("后续请求包含目标时间工具结果", toolMessage?.content.includes("目标时间点 0:40"), toolMessage);
    check("后续请求包含实际截图时间与一张 JPEG", imageMessage?.content[0]?.text.includes("实际截图时间 0:40") && imageBytes > 1000, { imageMessage, imageBytes });
    check("对话依据字幕与画面完成", evidence.answer.includes("已结合字幕与历史画面作答"), evidence.answer.slice(-500));
    check("用户播放器未被移动或改变播放声音状态", JSON.stringify(evidence.player.before) === JSON.stringify(evidence.player.after) && evidence.player.events.seekEvents === 0 && evidence.player.events.playEvents === 0, evidence.player);
    check("隐藏视频已清理", evidence.player.hiddenRemaining === 0, evidence.player.hiddenRemaining);
  });
} catch (error) {
  check("场景无致命错误", false, { message: error.message, stack: String(error.stack || "").slice(0, 1200) });
}

evidence.failed = evidence.checks.filter((item) => !item.ok).map((item) => item.name);
await writeEvidence(OUT_DIR, evidence);
if (evidence.failed.length) process.exitCode = 1;
