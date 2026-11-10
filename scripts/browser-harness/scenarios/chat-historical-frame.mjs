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
const liveGemini = process.argv.includes("--gemini-live");
const geminiApiKey = liveGemini ? String(process.env.GEMINI_API_KEY || "").trim() : "";
const geminiModel = String(process.env.GEMINI_MODEL || "gemini-3.8-flash").trim();
const providerId = liveGemini ? "gemini-live-acceptance" : "historical-stub";
const OUT_DIR = artifactDir(path.join("scenarios", liveGemini ? `${NAME}-gemini-live` : NAME));
const fixture = JSON.parse(readFileSync(path.join(REPO_ROOT, "tests", "fixtures", "bilibili", "hidden-video-seek-probe.json"), "utf8"));
const sample = fixture.samples[0];
const targetSecond = Math.round(sample.targetTime);
const url = `https://www.bilibili.com/video/${sample.bvid}/`;
const fixtureDir = path.join(REPO_ROOT, "tests", "fixtures", "bilibili", "bilingual-walkthrough");
const bundles = JSON.parse(readFileSync(path.join(fixtureDir, "bundles.json"), "utf8"));
const bodies = JSON.parse(readFileSync(path.join(fixtureDir, "bodies.json"), "utf8"));
const prompt = liveGemini
  ? `请描述这个视频第 ${targetSecond} 秒的画面：人物正在做什么、场景中有什么、屏幕上有哪些文字？同时说明同一时刻的字幕内容。`
  : `请说明 ${sample.targetTime} 秒附近的内容，字幕不足时查看当时画面。`;
const evidence = {
  mode: liveGemini ? "gemini-live" : "controlled-stub",
  model: liveGemini ? geminiModel : "historical-vision",
  prompt,
  checks: [],
  requests: [],
  player: null,
  answer: ""
};

function check(name, ok, detail = null) {
  evidence.checks.push({ name, ok: Boolean(ok), detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(detail)?.slice(0, 500) || ""}`);
}

async function finishWithoutKey() {
  check("真实模式从当前进程读取 GEMINI_API_KEY", false, { variable: "GEMINI_API_KEY" });
  evidence.failed = evidence.checks.filter((item) => !item.ok).map((item) => item.name);
  await writeEvidence(OUT_DIR, evidence);
  process.exitCode = 1;
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

async function installModelChannel(cdp) {
  await cdp.evaluate("globalThis.__historicalFrameRequests = []; globalThis.__historicalFrameToolRequests = 0");
  const urlPattern = liveGemini
    ? "*generativelanguage.googleapis.com/v1beta/models/*"
    : "*/chat/completions";
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern, requestStage: "Request" }] });
  cdp.on("Fetch.requestPaused", async (params) => {
    const body = JSON.parse(params.request.postData || "{}");
    await cdp.evaluate("globalThis.__historicalFrameRequests.push(" + JSON.stringify(body) + ")");
    if (liveGemini) {
      await cdp.send("Fetch.continueRequest", { requestId: params.requestId });
      return;
    }

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
    const stream = chunks.map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n";
    await cdp.send("Fetch.fulfillRequest", {
      requestId: params.requestId,
      responseCode: 200,
      responseHeaders: [{ name: "content-type", value: "text/event-stream" }],
      body: Buffer.from(stream, "utf8").toString("base64")
    });
  });
}

function toolNames(body) {
  if (liveGemini) {
    return body.tools?.flatMap((tool) => tool.functionDeclarations?.map((declaration) => declaration.name) || []) || [];
  }
  return body.tools?.map((tool) => tool.function.name) || [];
}

function sanitizePart(part) {
  if (part?.inlineData) {
    return {
      inlineData: {
        mimeType: part.inlineData.mimeType,
        bytes: Buffer.from(part.inlineData.data || "", "base64").length
      }
    };
  }
  if (part?.thoughtSignature) return { thoughtSignature: `<${part.thoughtSignature.length} chars>` };
  return part;
}

function sanitizeRequest(body) {
  if (liveGemini) {
    return {
      tools: toolNames(body),
      toolConfig: body.toolConfig,
      contents: body.contents?.map((content) => ({
        role: content.role,
        parts: content.parts?.map(sanitizePart) || []
      })) || []
    };
  }
  return {
    tools: toolNames(body),
    messages: body.messages?.map((message) => ({
      role: message.role,
      content: typeof message.content === "string"
        ? message.content
        : message.content.map((part) => part.type === "image_url"
          ? { type: "image_url", bytes: Buffer.from(part.image_url.url.slice(part.image_url.url.indexOf(",") + 1), "base64").length }
          : part),
      tool_call_id: message.tool_call_id
    })) || []
  };
}

function extractImages(body) {
  const images = [];
  if (liveGemini) {
    for (const content of body?.contents || []) {
      let caption = "";
      for (const part of content.parts || []) {
        if (typeof part.text === "string") caption = part.text;
        if (part.inlineData?.mimeType === "image/jpeg") {
          images.push({ caption, bytes: Buffer.from(part.inlineData.data || "", "base64") });
        }
      }
    }
    return images;
  }
  for (const message of body?.messages || []) {
    if (!Array.isArray(message.content)) continue;
    const caption = message.content.find((part) => part.type === "text")?.text || "";
    for (const part of message.content) {
      const dataUrl = part.type === "image_url" ? part.image_url?.url : "";
      if (dataUrl?.startsWith("data:image/jpeg;base64,")) {
        images.push({ caption, bytes: Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64") });
      }
    }
  }
  return images;
}

function findHistoricalCall(requests) {
  for (const body of requests.slice(1)) {
    for (const content of body.contents || []) {
      if (content.role !== "model") continue;
      for (const part of content.parts || []) {
        if (part.functionCall?.name === "capture_video_frame_at_time") return part.functionCall;
      }
    }
  }
  return null;
}

function findHistoricalResponse(body) {
  for (const content of body?.contents || []) {
    for (const part of content.parts || []) {
      if (part.functionResponse?.name === "capture_video_frame_at_time") return part.functionResponse;
    }
  }
  return null;
}

if (liveGemini && !geminiApiKey) {
  await finishWithoutKey();
} else {
  try {
    await withBrowser({ autoplay: true }, async (context) => {
      const { browser } = context;
      const page = await attachPage(browser);
      context.cdps = [page.cdp];
      const worker = createWorkerSession({ pageCdp: page.cdp, browser });
      await worker.ensureAlive();
      await installSubtitleFixtures(worker);
      const extensionId = await worker.evaluate("chrome.runtime.id");
      const provider = liveGemini
        ? {
            id: providerId,
            presetId: "gemini",
            name: "Gemini live acceptance",
            baseUrl: "https://generativelanguage.googleapis.com",
            models: [geminiModel],
            requiresKey: true,
            enabled: true,
            protocol: "gemini"
          }
        : {
            id: providerId,
            presetId: "custom",
            name: providerId,
            baseUrl: "https://api.bilibili.com",
            models: ["historical-vision"],
            requiresKey: false,
            enabled: true,
            protocol: "openai"
          };
      await worker.evaluate(`chrome.storage.sync.set(${JSON.stringify({
        activeAiProviderId: providerId,
        asrAutoFallback: false,
        webSearchEnabled: false,
        aiProviders: [provider]
      })})`);
      if (liveGemini) {
        await worker.evaluate(`chrome.storage.local.set(${JSON.stringify({ aiProviderKeys: { [providerId]: geminiApiKey } })})`);
      }

      await page.cdp.send("Page.navigate", { url: `chrome-extension://${extensionId}/entry/offscreen.html` });
      await waitFor("扩展页可发消息", () => page.cdp.evaluate("typeof chrome === 'object' && typeof chrome.runtime?.sendMessage === 'function'"));
      await page.cdp.evaluate("chrome.runtime.sendMessage({ type: 'ensure-offscreen-chat' })");
      const offscreen = await attachOffscreen(browser);
      context.cdps.push(offscreen);
      await installModelChannel(offscreen);

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
      await waitFor("对话模型选项", () => page.cdp.evaluate(`document.getElementById('biliscript-reading-chat-model-select')?.value.includes(${JSON.stringify(providerId)})`), { timeoutMs: 20000, intervalMs: 200 });
      await page.cdp.evaluate(`(() => {
        const input = document.getElementById("biliscript-reading-chat-input");
        input.value = ${JSON.stringify(prompt)};
        input.dispatchEvent(new Event("input", { bubbles: true }));
        globalThis.__historicalFrameAnswer = "";
        globalThis.__historicalFrameAnswerError = false;
        const messages = document.getElementById("biliscript-reading-chat-messages");
        const send = document.getElementById("biliscript-reading-chat-send-btn");
        const initialAssistantCount = messages.querySelectorAll(".chat-msg-assistant").length;
        const observer = new MutationObserver(() => {
          const assistants = messages.querySelectorAll(".chat-msg-assistant");
          const answer = assistants[assistants.length - 1];
          const text = answer ? answer.innerText || answer.textContent || "" : "";
          const hasError = Boolean(answer?.querySelector(".chat-msg-error"));
          if (assistants.length > initialAssistantCount && answer && !send.classList.contains("is-stop") && (text.trim() || hasError)) {
            globalThis.__historicalFrameAnswer = text;
            globalThis.__historicalFrameAnswerError = hasError;
            observer.disconnect();
          }
        });
        observer.observe(messages, { childList: true, subtree: true, characterData: true });
        observer.observe(send, { attributes: true, attributeFilter: ["class"] });
      })()`);
      await waitFor("字幕就绪且发送键可用", () => page.cdp.evaluate("document.getElementById('biliscript-reading-chat-send-btn')?.disabled === false"), { timeoutMs: 60000, intervalMs: 200 });
      await page.cdp.evaluate("document.getElementById('biliscript-reading-chat-send-btn').click()");

      try {
        await waitFor("历史帧工具对话完成", () => page.cdp.evaluate("Boolean(globalThis.__historicalFrameAnswer)"), { timeoutMs: 150000, intervalMs: 500 });
      } catch (error) {
        const rawRequests = await offscreen.evaluate("globalThis.__historicalFrameRequests || []");
        evidence.diagnostics = {
          requests: rawRequests.map(sanitizeRequest),
          imageCounts: rawRequests.map((body) => extractImages(body).length),
          page: await page.cdp.evaluate(`(() => ({
            text: document.getElementById("biliscript-reading-chat-messages")?.textContent || "",
            input: document.getElementById("biliscript-reading-chat-input")?.value,
            sendDisabled: document.getElementById("biliscript-reading-chat-send-btn")?.disabled,
            videos: Array.from(document.querySelectorAll("video")).map((video) => ({ src: video.currentSrc.slice(0, 180), currentTime: video.currentTime, paused: video.paused, readyState: video.readyState, hidden: video.style.visibility }))
          }))()`)
        };
        throw error;
      }
      const rawRequests = await offscreen.evaluate("globalThis.__historicalFrameRequests || []");
      const requests = rawRequests.filter((body) => liveGemini
        ? body.tools || body.contents?.some((content) => content.parts?.some((part) => part.functionCall || part.functionResponse))
        : body.tools || body.messages?.some((message) => message.role === "tool"));
      evidence.requests = requests.map(sanitizeRequest);
      const followup = requests[1];
      const images = extractImages(followup);
      await mkdir(OUT_DIR, { recursive: true });
      for (const [index, image] of images.entries()) {
        await writeFile(path.join(OUT_DIR, `historical-frame-${index + 1}.jpg`), image.bytes);
      }
      evidence.answer = await page.cdp.evaluate("globalThis.__historicalFrameAnswer");
      evidence.answerError = await page.cdp.evaluate("globalThis.__historicalFrameAnswerError");
      evidence.player = await page.cdp.evaluate(`(() => {
        const player = document.querySelector("video");
        return {
          before: globalThis.__historicalPlayerBefore,
          after: { currentTime: player.currentTime, paused: player.paused, muted: player.muted, volume: player.volume, playbackRate: player.playbackRate },
          events: globalThis.__historicalPlayerEvidence,
          hiddenRemaining: Array.from(document.querySelectorAll("video")).filter((video) => video.style.left === "-10000px").length
        };
      })()`);

      check("首请求自主工具面包含当前帧与历史帧", toolNames(requests[0]).includes("capture_current_video_frame") && toolNames(requests[0]).includes("capture_video_frame_at_time"), toolNames(requests[0]));
      if (liveGemini) {
        const call = findHistoricalCall(requests);
        const response = findHistoricalResponse(followup);
        const responseText = String(response?.response?.output || JSON.stringify(response?.response || ""));
        evidence.modelToolCall = call;
        check("Gemini 自主调用历史帧工具", Boolean(call), call);
        check("模型工具参数指向用户询问的第 41 秒", call?.args?.targetTime === targetSecond, call?.args);
        check("Gemini 工具调用模式为 AUTO", requests[0]?.toolConfig?.functionCallingConfig?.mode === "AUTO", requests[0]?.toolConfig);
        check("后续请求包含目标时间工具结果", responseText.includes("目标时间点 0:41"), response);
        check("后续请求按时间顺序包含三张分别标注的 JPEG", images.length === 3 && images.every((image, index) => image.caption.includes(`第 ${index + 1} 张，实际截图时间`) && /实际截图时间 \d+:\d{2}/.test(image.caption) && image.bytes.length > 1000), images.map((image) => ({ caption: image.caption, bytes: image.bytes.length })));
        check("Gemini 结合字幕与画面正常完成回答", evidence.answer.trim().length > 0 && !evidence.answerError, { answer: evidence.answer.slice(-1000), answerError: evidence.answerError });
      } else {
        const messages = followup?.messages || [];
        const toolMessage = messages.find((message) => message.role === "tool" && message.tool_call_id === "history_e2e");
        const expectedTimes = ["0:38", "0:40", "0:42"];
        check("后续请求包含目标时间工具结果", toolMessage?.content.includes("目标时间点 0:40"), toolMessage);
        check("后续请求按时间顺序包含三张分别标注的 JPEG", images.length === 3 && images.every((image, index) => image.caption.includes(`第 ${index + 1} 张，实际截图时间 ${expectedTimes[index]}`)) && images.every((image) => image.bytes.length > 1000), images.map((image) => ({ caption: image.caption, bytes: image.bytes.length })));
        check("对话依据字幕与画面完成", evidence.answer.includes("已结合字幕与历史画面作答"), evidence.answer.slice(-500));
      }
      check("用户播放器未被移动或改变播放声音状态", JSON.stringify(evidence.player.before) === JSON.stringify(evidence.player.after) && evidence.player.events.seekEvents === 0 && evidence.player.events.playEvents === 0, evidence.player);
      check("隐藏视频已清理", evidence.player.hiddenRemaining === 0, evidence.player.hiddenRemaining);
    });
  } catch (error) {
    check("场景无致命错误", false, { message: error.message, stack: String(error.stack || "").slice(0, 1200) });
  }

  evidence.failed = evidence.checks.filter((item) => !item.ok).map((item) => item.name);
  await writeEvidence(OUT_DIR, evidence);
  if (evidence.failed.length) process.exitCode = 1;
}
