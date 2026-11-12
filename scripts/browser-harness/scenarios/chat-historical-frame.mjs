#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  CDP,
  DEFAULT_DIST,
  REPO_ROOT,
  artifactDir,
  attachPage,
  createWorkerSession,
  log,
  screenshot,
  sleep,
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
const longSample = fixture.samples[1];
const longView = JSON.parse(readFileSync(path.join(REPO_ROOT, "tests", "fixtures", "bilibili", "bv1q9he6seyx-view.json"), "utf8"));
const part2 = longView.data.pages.find((page) => page.page === 2);
const part2Sample = { ...longSample, cid: String(part2.cid), targetTime: 120 };
const targetSecond = Math.round(sample.targetTime);
const url = `https://www.bilibili.com/video/${sample.bvid}/`;
const fixtureDir = path.join(REPO_ROOT, "tests", "fixtures", "bilibili", "bilingual-walkthrough");
const bundles = JSON.parse(readFileSync(path.join(fixtureDir, "bundles.json"), "utf8"));
const bodies = JSON.parse(readFileSync(path.join(fixtureDir, "bodies.json"), "utf8"));
const longBody = {
  ...bodies[`${sample.bvid}-zh`],
  body: [
    ...bodies[`${sample.bvid}-zh`].body,
    { from: longSample.duration - 5, to: longSample.duration - 1, sid: 1000, location: 0, content: "长视频末尾字幕", music: 0 }
  ]
};
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

async function createLiveDist() {
  const distDir = await mkdtemp(path.join(os.tmpdir(), "biliscript-gemini-dist-"));
  await cp(DEFAULT_DIST, distDir, { recursive: true });
  const manifestPath = path.join(distDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = [...new Set([
    ...(manifest.host_permissions || []),
    "https://generativelanguage.googleapis.com/*"
  ])];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return distDir;
}

async function installSubtitleFixtures(worker) {
  const { cdp, sessionId } = worker.handle;
  await cdp.evaluate("globalThis.__historicalFailPlayurl = false; globalThis.__historicalPlayurlDelayMs = 0; globalThis.__historicalPlayurlRequests = []", { sessionId });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId);
  cdp.on("Fetch.requestPaused", async (params) => {
    const requestUrl = params.request?.url || "";
    const requestId = params.requestId;
    let payload = null;
    if (/x\/player\/(?:wbi\/)?v2/.test(requestUrl)) {
      const request = new URL(requestUrl);
      const bvid = request.searchParams.get("bvid") || "";
      payload = bundles[bvid] || bundles[sample.bvid];
      if (!bundles[bvid] && bvid === longSample.bvid) {
        payload = {
          ...payload,
          data: {
            ...payload.data,
            aid: longView.data.aid,
            bvid,
            cid: Number(request.searchParams.get("cid")) || longSample.cid,
            subtitle: {
              ...payload.data.subtitle,
              subtitles: payload.data.subtitle.subtitles.map((track, index) => index === 0 ? {
                ...track,
                subtitle_url: "https://aisubtitle.hdslb.com/bfs/ai_subtitle/walkthrough-fixture/long-zh.json",
                subtitle_url_v2: "https://aisubtitle.hdslb.com/bfs/ai_subtitle/walkthrough-fixture/long-zh.json"
              } : track)
            }
          }
        };
      }
    } else if (/x\/player\/playurl/.test(requestUrl)) {
      await cdp.evaluate(`globalThis.__historicalPlayurlRequests.push(${JSON.stringify(requestUrl)})`, { sessionId });
      const shouldFail = await cdp.evaluate("globalThis.__historicalFailPlayurl === true", { sessionId });
      const delayMs = await cdp.evaluate("globalThis.__historicalPlayurlDelayMs || 0", { sessionId });
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (shouldFail) {
        payload = { code: -500, message: "受控历史帧接口失败" };
        await cdp.evaluate("globalThis.__historicalFailPlayurl = false", { sessionId });
      }
    } else {
      const match = /walkthrough-fixture\/([A-Za-z0-9-]+)\.json$/.exec(requestUrl);
      if (match?.[1] === "long-zh") payload = longBody;
      else if (match && bodies[match[1]]) payload = bodies[match[1]];
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
  await cdp.evaluate(`globalThis.__historicalFrameRequests = []; globalThis.__historicalFrameBehavior = ${JSON.stringify({ targetTime: sample.targetTime, mode: "success" })}`);
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

    const messages = body.messages || [];
    const lastTextUserIndex = messages.findLastIndex((message) => message.role === "user" && typeof message.content === "string");
    const isToolConversation = body.tools || messages.some((message) => message.role === "tool");
    const hasToolResult = messages.some((message, index) => message.role === "tool" && index > lastTextUserIndex);
    const behavior = await cdp.evaluate("globalThis.__historicalFrameBehavior");
    const content = body.messages?.[0]?.content?.includes("3 个")
      ? '["视频讲了什么？","有哪些关键结论？","如何应用这些结论？"]'
      : '{"summary":"受控回放概览","chapters":[],"keyQuotes":[]}';
    const finalContent = behavior.mode === "failure" ? "未获取画面，仅依据字幕作答" : "已结合字幕与历史画面作答";
    const chunks = isToolConversation && !hasToolResult
      ? [
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "history_e2e", type: "function", function: { name: "capture_video_frame_at_time", arguments: JSON.stringify({ targetTime: behavior.targetTime }) } }] }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
        ]
      : [
          { choices: [{ delta: { content: isToolConversation ? finalContent : content }, finish_reason: null }] },
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
  if (!body) return [];
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

async function setStubBehavior(offscreen, targetTime, mode = "success") {
  await offscreen.evaluate(`globalThis.__historicalFrameBehavior = ${JSON.stringify({ targetTime, mode })}`);
}

async function openChatPage(page, pageUrl) {
  await page.cdp.send("Page.navigate", { url: pageUrl });
  await waitFor("页面视频与扩展按钮", () => page.cdp.evaluate("document.querySelector('video')?.readyState >= 1 && !!document.getElementById('biliscript-script-button')"), { timeoutMs: 60000, intervalMs: 300 });
  await page.cdp.evaluate("document.getElementById('biliscript-script-button').click()");
  await waitFor("对话标签", () => page.cdp.evaluate("!!document.getElementById('biliscript-reading-tab-chat')"), { timeoutMs: 20000, intervalMs: 200 });
  await page.cdp.evaluate("document.getElementById('biliscript-reading-tab-chat').click()");
  await waitFor("对话输入框与模型", () => page.cdp.evaluate(`!!document.getElementById('biliscript-reading-chat-input') && document.getElementById('biliscript-reading-chat-model-select')?.value.includes(${JSON.stringify(providerId)})`), { timeoutMs: 20000, intervalMs: 200 });
  await sleep(1500);
}

async function askQuestion(page, text) {
  await page.cdp.evaluate(`(() => {
    const input = document.getElementById("biliscript-reading-chat-input");
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    globalThis.__historicalLifecycleAssistantCount = document.getElementById("biliscript-reading-chat-messages").querySelectorAll(".chat-msg-assistant").length;
  })()`);
  await waitFor("字幕就绪且发送键可用", () => page.cdp.evaluate("document.getElementById('biliscript-reading-chat-send-btn')?.disabled === false"), { timeoutMs: 60000, intervalMs: 200 });
  await page.cdp.evaluate("document.getElementById('biliscript-reading-chat-send-btn').click()");
}

async function waitQuestionAnswer(page, expected) {
  return waitFor("受控历史帧回答", () => page.cdp.evaluate(`(() => {
    const messages = document.getElementById("biliscript-reading-chat-messages");
    const send = document.getElementById("biliscript-reading-chat-send-btn");
    const assistants = messages.querySelectorAll(".chat-msg-assistant");
    if (assistants.length <= globalThis.__historicalLifecycleAssistantCount || send.classList.contains("is-stop")) return false;
    const answer = assistants[assistants.length - 1];
    const text = answer?.innerText || answer?.textContent || "";
    return text.includes(${JSON.stringify(expected)}) ? text : false;
  })()`), { timeoutMs: 60000, intervalMs: 300 });
}

async function runStubQuestion(page, offscreen, targetTime, mode = "success") {
  const requestStart = await offscreen.evaluate("globalThis.__historicalFrameRequests.length");
  await setStubBehavior(offscreen, targetTime, mode);
  await askQuestion(page, `请说明 ${targetTime} 秒附近的内容，字幕不足时查看当时画面。`);
  try {
    const answer = await waitQuestionAnswer(page, mode === "failure" ? "未获取画面" : "已结合字幕与历史画面作答");
    const requests = (await offscreen.evaluate("globalThis.__historicalFrameRequests.slice(" + requestStart + ")"))
      .filter((body) => body.tools || body.messages?.some((message) => message.role === "tool"));
    return { answer, requests, followup: requests[1] };
  } catch (error) {
    evidence.lifecycleDiagnostics = {
      targetTime,
      mode,
      requests: (await offscreen.evaluate("globalThis.__historicalFrameRequests.slice(" + requestStart + ")")).map(sanitizeRequest),
      page: await page.cdp.evaluate(`(() => ({
        text: document.getElementById("biliscript-reading-chat-messages")?.textContent || "",
        sendDisabled: document.getElementById("biliscript-reading-chat-send-btn")?.disabled,
        sendClass: document.getElementById("biliscript-reading-chat-send-btn")?.className,
        videos: Array.from(document.querySelectorAll("video")).map((video) => ({ currentTime: video.currentTime, paused: video.paused, readyState: video.readyState, networkState: video.networkState, hidden: video.dataset.biliscriptHistoricalFrame !== undefined, src: video.currentSrc.slice(0, 160) }))
      }))()`)
    };
    await screenshot(page.cdp, path.join(OUT_DIR, "lifecycle-failure.png")).catch(() => {});
    throw error;
  }
}

async function observePlayer(page, playing) {
  if (playing) {
    await page.cdp.evaluate("document.querySelector('video').play()");
    await waitFor("用户播放器播放中", () => page.cdp.evaluate("document.querySelector('video')?.paused === false"), { timeoutMs: 15000, intervalMs: 200 });
  }
  await page.cdp.evaluate(`(() => {
    globalThis.__historicalLifecyclePlayerCleanup?.();
    const player = document.querySelector("video");
    const record = { events: { seekEvents: 0, playEvents: 0, pauseEvents: 0 } };
    const onSeek = () => record.events.seekEvents++;
    const onPlay = () => record.events.playEvents++;
    const onPause = () => record.events.pauseEvents++;
    player.addEventListener("seeking", onSeek);
    player.addEventListener("play", onPlay);
    player.addEventListener("pause", onPause);
    const snapshot = () => ({ currentTime: player.currentTime, paused: player.paused, muted: player.muted, volume: player.volume, playbackRate: player.playbackRate });
    record.before = snapshot();
    record.snapshot = snapshot;
    record.startedAt = performance.now();
    globalThis.__historicalLifecyclePlayer = record;
    globalThis.__historicalLifecyclePlayerCleanup = () => {
      player.removeEventListener("seeking", onSeek);
      player.removeEventListener("play", onPlay);
      player.removeEventListener("pause", onPause);
    };
  })()`);
}

async function readPlayerEvidence(page) {
  return page.cdp.evaluate(`(() => {
    const record = globalThis.__historicalLifecyclePlayer;
    const player = document.querySelector("video");
    const rect = player.getBoundingClientRect();
    const result = {
      before: record.before,
      after: record.snapshot(),
      elapsedSeconds: (performance.now() - record.startedAt) / 1000,
      events: record.events,
      visible: rect.width > 0 && rect.height > 0 && getComputedStyle(player).visibility !== "hidden",
      hiddenRemaining: document.querySelectorAll("video[data-biliscript-historical-frame]").length
    };
    globalThis.__historicalLifecyclePlayerCleanup?.();
    globalThis.__historicalLifecyclePlayerCleanup = null;
    return result;
  })()`);
}

function playerUnaffected(player, playing) {
  if (!player?.visible || player.hiddenRemaining !== 0 || player.events.seekEvents !== 0 || player.events.playEvents !== 0 || player.events.pauseEvents !== 0) return false;
  if (player.before.muted !== player.after.muted || player.before.volume !== player.after.volume || player.before.playbackRate !== player.after.playbackRate) return false;
  if (!playing) return JSON.stringify(player.before) === JSON.stringify(player.after);
  const advance = player.after.currentTime - player.before.currentTime;
  return player.before.paused === false && player.after.paused === false && advance >= -0.1 && advance <= player.elapsedSeconds * player.before.playbackRate + 1.5;
}

if (!part2 || !longSample) {
  throw new Error("真机 fixture 必须包含长视频与第二分P");
}

if (liveGemini && !geminiApiKey) {
  await finishWithoutKey();
} else {
  let distDir = DEFAULT_DIST;
  try {
    if (liveGemini) distDir = await createLiveDist();
    await withBrowser({ autoplay: true, distDir }, async (context) => {
      const { browser } = context;
      const page = await attachPage(browser);
      context.cdps = [page.cdp];
      const worker = createWorkerSession({ pageCdp: page.cdp, browser, distDir });
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
      await sleep(1500);
      await page.cdp.evaluate(`(() => {
        const input = document.getElementById("biliscript-reading-chat-input");
        input.value = ${JSON.stringify(prompt)};
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const messages = document.getElementById("biliscript-reading-chat-messages");
        globalThis.__historicalFrameAssistantCount = messages.querySelectorAll(".chat-msg-assistant").length;
      })()`);
      await waitFor("字幕就绪且发送键可用", () => page.cdp.evaluate("document.getElementById('biliscript-reading-chat-send-btn')?.disabled === false"), { timeoutMs: 60000, intervalMs: 200 });
      await page.cdp.evaluate("document.getElementById('biliscript-reading-chat-send-btn').click()");

      let completion;
      try {
        completion = await waitFor("历史帧工具对话完成", () => page.cdp.evaluate(`(() => {
          const messages = document.getElementById("biliscript-reading-chat-messages");
          const send = document.getElementById("biliscript-reading-chat-send-btn");
          const assistants = messages.querySelectorAll(".chat-msg-assistant");
          if (assistants.length <= globalThis.__historicalFrameAssistantCount || send.classList.contains("is-stop")) return false;
          ${liveGemini ? "" : `if (!messages.textContent.includes("已结合字幕与历史画面作答")) return false;`}
          const answer = assistants[assistants.length - 1];
          const text = answer ? answer.innerText || answer.textContent || "" : "";
          const hasError = Boolean(answer?.querySelector(".chat-msg-error"));
          if (!text.trim() && !hasError) return false;
          return { answer: text, error: hasError };
        })()`), { timeoutMs: 150000, intervalMs: 500 });
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
      evidence.answer = completion.answer;
      evidence.answerError = completion.error;
      evidence.player = await page.cdp.evaluate(`(() => {
        const player = document.querySelector("video");
        return {
          before: globalThis.__historicalPlayerBefore,
          after: { currentTime: player.currentTime, paused: player.paused, muted: player.muted, volume: player.volume, playbackRate: player.playbackRate },
          events: globalThis.__historicalPlayerEvidence,
          hiddenRemaining: Array.from(document.querySelectorAll("video")).filter((video) => video.style.left === "-10000px").length
        };
      })()`);

      check("模型请求已发出", requests.length > 0, { answer: evidence.answer, answerError: evidence.answerError });
      if (!requests.length) return;
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
      const frameUi = await page.cdp.evaluate(`(() => {
        const cards = document.querySelectorAll(".chat-search-card");
        const card = cards[cards.length - 1];
        return {
          status: card?.getAttribute("data-status"),
          text: card?.textContent || "",
          times: Array.from(card?.querySelectorAll(".chat-video-frame-time") || []).map((node) => node.textContent),
          buttons: card?.querySelectorAll(".chat-video-frame-item .chat-image-open").length || 0
        };
      })()`);
      check("历史截帧卡显示实际数量与帧时间", frameUi.status === "done" && frameUi.text.includes("3 张画面") && frameUi.buttons === 3, frameUi);
      await page.cdp.evaluate("document.querySelector('.chat-video-frame-item .chat-image-open')?.click()");
      await waitFor("实际帧查看弹层", () => page.cdp.evaluate("document.querySelector('.chat-image-viewer-image')?.src.startsWith('data:image/jpeg;base64,')"));
      await screenshot(page.cdp, path.join(OUT_DIR, "historical-frame-viewer.png"));
      check("实际帧可打开查看", true);
      await page.cdp.evaluate("document.querySelector('.chat-image-viewer-close')?.click()");
      check("用户播放器未被移动或改变播放声音状态", JSON.stringify(evidence.player.before) === JSON.stringify(evidence.player.after) && evidence.player.events.seekEvents === 0 && evidence.player.events.playEvents === 0, evidence.player);
      check("隐藏视频已清理", evidence.player.hiddenRemaining === 0, evidence.player.hiddenRemaining);

      if (!liveGemini) {
        const longUrl = `https://www.bilibili.com/video/${longSample.bvid}/?p=1`;
        await openChatPage(page, longUrl);
        await observePlayer(page, true);
        const longResult = await runStubQuestion(page, offscreen, longSample.targetTime);
        const longPlayer = await readPlayerEvidence(page);
        await screenshot(page.cdp, path.join(OUT_DIR, "lifecycle-long-playing.png"));
        check("长视频播放中提问注入三张历史帧", extractImages(longResult.followup).length === 3, longResult.requests.map(sanitizeRequest));
        check("长视频取帧不影响播放进度、声音与可见画面", playerUnaffected(longPlayer, true), longPlayer);
        await page.cdp.evaluate("document.querySelector('video').pause()");

        await observePlayer(page, false);
        const stopRequestStart = await offscreen.evaluate("globalThis.__historicalFrameRequests.length");
        await setStubBehavior(offscreen, 2300);
        await worker.evaluate("globalThis.__historicalPlayurlDelayMs = 18000");
        await askQuestion(page, "请说明 2300 秒附近的画面。");
        await waitFor("截帧进行状态", () => page.cdp.evaluate("document.getElementById('biliscript-reading-chat-messages')?.textContent.includes('正在回看 38:20 附近画面…')"));
        await sleep(16000);
        const longWaitUi = await page.cdp.evaluate(`(() => ({
          running: document.getElementById("biliscript-reading-chat-messages")?.textContent.includes("正在回看 38:20 附近画面…"),
          slowNotice: document.getElementById("biliscript-reading-view")?.textContent.includes("模型响应较慢")
        }))()`);
        check("长等待显示截帧进度且不误报模型响应较慢", longWaitUi.running && !longWaitUi.slowNotice, longWaitUi);
        await waitFor("停止前隐藏视频在飞", () => page.cdp.evaluate("document.querySelectorAll('video[data-biliscript-historical-frame]').length === 1"), { timeoutMs: 30000, intervalMs: 50 });
        await page.cdp.evaluate("document.getElementById('biliscript-reading-chat-send-btn').click()");
        await waitFor("停止后回合与隐藏媒体收尾", () => page.cdp.evaluate("document.querySelectorAll('video[data-biliscript-historical-frame]').length === 0 && !document.getElementById('biliscript-reading-chat-send-btn').classList.contains('is-stop')"), { timeoutMs: 15000, intervalMs: 100 });
        const cancelled = await page.cdp.evaluate(`(() => {
          const cards = document.querySelectorAll(".chat-search-card");
          const card = cards[cards.length - 1];
          return card?.getAttribute("data-status") === "cancelled" && card?.textContent.includes("已取消");
        })()`);
        check("停止后截帧卡显示已取消", cancelled);
        await worker.evaluate("globalThis.__historicalPlayurlDelayMs = 0");
        const stopPlayer = await readPlayerEvidence(page);
        const stoppedRequests = await offscreen.evaluate("globalThis.__historicalFrameRequests.slice(" + stopRequestStart + ")");
        check("停止回答中止取帧且不向模型补入迟到画面", playerUnaffected(stopPlayer, false) && stoppedRequests.length === 1, { player: stopPlayer, requests: stoppedRequests.map(sanitizeRequest) });

        const switchRequestStart = await offscreen.evaluate("globalThis.__historicalFrameRequests.length");
        await setStubBehavior(offscreen, 2300);
        await worker.evaluate("globalThis.__historicalPlayurlDelayMs = 2000");
        await askQuestion(page, "请说明 2300 秒附近的画面。");
        await waitFor("换P前隐藏视频在飞", () => page.cdp.evaluate("document.querySelectorAll('video[data-biliscript-historical-frame]').length === 1"), { timeoutMs: 30000, intervalMs: 50 });
        const part2Url = `https://www.bilibili.com/video/${longSample.bvid}/?p=2`;
        await page.cdp.evaluate(`history.pushState({}, '', ${JSON.stringify(part2Url)})`);
        await waitFor("SPA 换P清理旧媒体", () => page.cdp.evaluate(`location.href.includes("p=2") && document.querySelectorAll('video[data-biliscript-historical-frame]').length === 0`), { timeoutMs: 15000, intervalMs: 100 });
        await worker.evaluate("globalThis.__historicalPlayurlDelayMs = 0");
        await page.cdp.evaluate("document.querySelector('video')?.pause()");
        await sleep(4000);
        await observePlayer(page, false);
        const part2Result = await runStubQuestion(page, offscreen, part2Sample.targetTime);
        const part2Player = await readPlayerEvidence(page);
        const playurls = await worker.evaluate("globalThis.__historicalPlayurlRequests || []");
        const switchedRequests = (await offscreen.evaluate("globalThis.__historicalFrameRequests.slice(" + switchRequestStart + ")"))
          .filter((body) => body.tools || body.messages?.some((message) => message.role === "tool"));
        const part2ToolText = part2Result.followup?.messages?.findLast((message) => message.role === "tool")?.content || "";
        await screenshot(page.cdp, path.join(OUT_DIR, "lifecycle-part2.png"));
        check("SPA 换分P后新取帧使用新 cid", new URL(playurls.at(-1)).searchParams.get("cid") === part2Sample.cid, playurls.slice(-3));
        check("旧回合结果不进入换P后的上下文", part2ToolText.includes("目标时间点 2:00") && !switchedRequests.some((body) => body.messages?.some((message) => typeof message.content === "string" && message.content.includes("目标时间点 38:20"))), switchedRequests.map(sanitizeRequest));
        check("分P新回合正常取三帧且播放器不受影响", extractImages(part2Result.followup).length === 3 && playerUnaffected(part2Player, false), { player: part2Player, requests: part2Result.requests.map(sanitizeRequest) });

        await observePlayer(page, false);
        await worker.evaluate("globalThis.__historicalFailPlayurl = true");
        const failureResult = await runStubQuestion(page, offscreen, 120, "failure");
        const failurePlayer = await readPlayerEvidence(page);
        const failureToolText = failureResult.followup?.messages?.findLast((message) => message.role === "tool")?.content || "";
        check("取帧失败以可读工具结果降级且不伪造画面", failureToolText.includes("受控历史帧接口失败") && extractImages(failureResult.followup).length === 0 && failureResult.answer.includes("未获取画面") && !failureResult.answer.includes("已结合"), { answer: failureResult.answer, requests: failureResult.requests.map(sanitizeRequest) });
        check("取帧失败仍清理媒体且不影响播放器", playerUnaffected(failurePlayer, false), failurePlayer);

        await observePlayer(page, false);
        const consecutiveFirst = await runStubQuestion(page, offscreen, 120);
        const consecutiveSecond = await runStubQuestion(page, offscreen, 130);
        const consecutivePlayer = await readPlayerEvidence(page);
        check("连续提问各自注入三帧且无残留媒体", extractImages(consecutiveFirst.followup).length === 3 && extractImages(consecutiveSecond.followup).length === 3 && playerUnaffected(consecutivePlayer, false), { player: consecutivePlayer, first: consecutiveFirst.requests.map(sanitizeRequest), second: consecutiveSecond.requests.map(sanitizeRequest) });

        await observePlayer(page, false);
        await setStubBehavior(offscreen, 140);
        await askQuestion(page, "请说明 140 秒附近的画面。");
        await waitFor("关闭前隐藏视频在飞", () => page.cdp.evaluate("document.querySelectorAll('video[data-biliscript-historical-frame]').length === 1"), { timeoutMs: 30000, intervalMs: 50 });
        await page.cdp.evaluate("document.getElementById('biliscript-reading-close-btn').click()");
        await waitFor("关闭会话清理媒体", () => page.cdp.evaluate("document.querySelectorAll('video[data-biliscript-historical-frame]').length === 0 && !document.getElementById('biliscript-reading-view').classList.contains('open')"), { timeoutMs: 15000, intervalMs: 100 });
        const closePlayer = await readPlayerEvidence(page);
        check("关闭会话中止取帧且不影响用户播放器", playerUnaffected(closePlayer, false), closePlayer);
        await page.cdp.evaluate("document.querySelectorAll('video,audio').forEach((media) => media.pause())");
      }
    });
  } catch (error) {
    check("场景无致命错误", false, { message: error.message, stack: String(error.stack || "").slice(0, 1200) });
  } finally {
    if (liveGemini && distDir !== DEFAULT_DIST) {
      await rm(distDir, { recursive: true, force: true });
    }
  }

  evidence.failed = evidence.checks.filter((item) => !item.ok).map((item) => item.name);
  await writeEvidence(OUT_DIR, evidence);
  if (evidence.failed.length) process.exitCode = 1;
}
