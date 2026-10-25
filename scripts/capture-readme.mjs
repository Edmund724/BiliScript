// README 功能截图：先运行 pnpm build，再运行 node scripts/capture-readme.mjs [输出目录]。
// 隔离 Edge + 固定演示数据；默认覆盖 docs/images/ 下 5 张 Flyme 浅色 2x 右栏截图。
import path from "node:path";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import {
  REPO_ROOT,
  attachPage,
  createWorkerSession,
  launchBrowser,
  sleep,
  teardown,
  waitFor
} from "./browser-harness/harness.mjs";

const SAMPLE = { bvid: "BV1mAam6tEL8", url: "https://www.bilibili.com/video/BV1mAam6tEL8/" };
const FIXTURE_DIR = path.join(REPO_ROOT, "tests", "fixtures", "bilibili", "bilingual-walkthrough");
const OUT_DIR = path.resolve(REPO_ROOT, process.argv[2] || path.join("docs", "images"));
const VIEWPORT = { width: 1600, height: 1100, deviceScaleFactor: 2, mobile: false };
const bundles = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "bundles.json"), "utf8"));
const bodies = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "bodies.json"), "utf8"));
const subtitleCopy = [
  "真正的进步，不只是模型记住了更多内容。",
  "更重要的是，它能否在复杂问题里保持清晰的推理。",
  "长上下文给了我们更大的工作空间。",
  "但空间越大，信息组织就越重要。",
  "如果关键线索被淹没，再长的窗口也无法替我们思考。",
  "所以，压缩率和理解力必须一起提升。",
  "好的工具应当帮我们找到重点，而不是制造更多噪声。",
  "这也是我们把章节、金句和对话放在一起的原因。",
  "你可以先读概览，再沿着时间戳回到原视频。",
  "遇到疑问时，继续追问，不必离开当前页面。",
  "阅读因此变成了一条连续的路径。",
  "从快速了解，到深入理解，再到自己的表达。"
];
const zh = bodies[`${SAMPLE.bvid}-zh`].body;
subtitleCopy.forEach((content, index) => { if (zh[index]) zh[index].content = content; });
const continuation = [
  "先建立整体结构，再决定哪些段落值得细读。",
  "时间戳让每个观点都能回到原始语境。",
  "重点引用保留了值得回看的表达。",
  "对话则把被动阅读变成主动探索。",
  "当信息有了层次，复杂内容也更容易掌握。",
  "这不是替代视频，而是提供另一条进入视频的路径。",
  "最终，我们记住的不是窗口长度，而是真正理解的内容。",
  "工具的边界越清晰，使用过程就越自然。"
];
zh.forEach((item, index) => { if (index >= subtitleCopy.length) item.content = continuation[(index - subtitleCopy.length) % continuation.length]; });
const quote = { from: 96, content: "好的工具应当帮我们找到重点，而不是制造更多噪声。" };
const overview = {
  chapters: [
    { from: 0, to: 180, title: "长上下文：更大的空间，不等于更好的理解", summary: "从上下文窗口的增长谈起，区分信息容量与真正有效的推理能力。" },
    { from: 180, to: 360, title: "压缩率与智能：模型需要学会取舍", summary: "为什么关键信息的组织、筛选与压缩，决定了长文本场景下的回答质量。" },
    { from: 360, to: 461, title: "从阅读到追问：让工具服务于理解", summary: "用章节建立结构，用金句保存重点，再通过连续对话把疑问说清楚。" }
  ],
  quotes: [quote]
};
let browser;
let pageCdp;
let worker;
let patchTimer;
let readerContextId = null;
const contexts = new Set();

function patchExpression() {
  return `(() => {
    const FIX = ${JSON.stringify({ bundles, bodies })};
    const g = globalThis;
    g.__readmeCapture = { bundles: FIX.bundles, bodies: FIX.bodies };
    const orig = g.__readmeCaptureOrig || (g.__readmeCaptureOrig = g.fetch.bind(g));
    g.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : ((input && input.url) || String(input));
      if (/x\\/player\\/(?:wbi\\/)?v2/.test(url)) {
        const bvid = (url.match(/bvid=([A-Za-z0-9]+)/) || [])[1] || '';
        return new Response(JSON.stringify(g.__readmeCapture.bundles[bvid] || { code: 0, data: { subtitle: { subtitles: [] } } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const m = url.match(/walkthrough-fixture\\/([A-Za-z0-9\\-]+)\\.json/);
      if (m) {
        const payload = g.__readmeCapture.bodies[m[1]];
        return new Response(JSON.stringify(payload || { body: [] }), { status: payload ? 200 : 404, headers: { 'content-type': 'application/json' } });
      }
      return orig(input, init);
    };
    return 'ready';
  })()`;
}

async function click(expression) {
  const point = await pageCdp.evaluate(`(() => {
    const el = ${expression};
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  })()`);
  if (!point || !point.w || !point.h) throw new Error(`点击目标不可见：${expression}`);
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(300);
}

async function evalReader(expression) {
  if (!readerContextId) await waitFor("内容脚本上下文", async () => {
    for (const id of contexts) {
      const result = await pageCdp.send("Runtime.evaluate", { expression: `typeof chrome === 'object' && !!chrome.runtime?.getURL`, contextId: id, returnByValue: true }).catch(() => null);
      if (result?.result?.value) { readerContextId = id; return id; }
    }
    return null;
  }, { timeoutMs: 15000 });
  const result = await pageCdp.send("Runtime.evaluate", { expression, contextId: readerContextId, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

async function capture(name) {
  await pageCdp.evaluate(`(() => {
    document.querySelectorAll('video,audio').forEach(m => { try { m.pause(); } catch {} });
    const v = document.getElementById('biliscript-reading-view');
    if (!v || v.getAttribute('data-theme') !== 'light' || (v.getAttribute('data-palette') || 'flyme') !== 'flyme') throw new Error('主题不是 Flyme 浅色');
  })()`);
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 20, y: 20, button: "none" });
  await sleep(700);
  const clip = await pageCdp.evaluate(`(() => {
    const r = document.querySelector('.biliscript-reading-script-panel').getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height, scale: 1 };
  })()`);
  const result = await pageCdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false, clip });
  const file = path.join(OUT_DIR, name);
  await writeFile(file, Buffer.from(result.data, "base64"));
  console.log(`captured ${name} ${clip.width * 2}x${clip.height * 2}`);
}

try {
  await mkdir(OUT_DIR, { recursive: true });
  browser = await launchBrowser({ viewport: VIEWPORT });
  const page = await attachPage(browser, { viewport: VIEWPORT });
  pageCdp = page.cdp;
  pageCdp.on("Runtime.executionContextCreated", ({ context }) => {
    if (context.auxData?.isDefault === false) contexts.add(context.id);
  });
  pageCdp.on("Runtime.executionContextDestroyed", ({ executionContextId }) => {
    contexts.delete(executionContextId);
    if (readerContextId === executionContextId) readerContextId = null;
  });
  worker = createWorkerSession({ pageCdp, browser, onReconnect: async (handle) => {
    await handle.cdp.evaluate(patchExpression(), { sessionId: handle.sessionId, timeoutMs: 30000 });
  } });
  await worker.ensureAlive();
  const swUrl = worker.handle.url;
  const extensionId = swUrl.match(/chrome-extension:\/\/([a-z]+)\//)[1];
  const readerUrl = `chrome-extension://${extensionId}/entry/chunks/reader.mjs`;
  const provider = {
    id: "readme-openrouter",
    presetId: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: ["openai/gpt-5.2", "anthropic/claude-sonnet-4.5", "google/gemini-3-pro-preview"],
    requiresKey: true,
    enabled: true
  };
  const conversation = {
    id: "readme-demo",
    title: "长文本为什么反而影响理解？",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    contextKey: "video:BV1mAam6tEL8|42393338874",
    contextTitle: "AI 与长上下文",
    contextUrl: SAMPLE.url,
    isVideoContext: true,
    pinnedContext: true,
    contextRef: { bvid: SAMPLE.bvid, cid: "42393338874", aid: "117370433574328", url: SAMPLE.url, title: "AI 与长上下文", isVideoContext: true },
    messages: [
      { role: "user", content: "长文本为什么反而影响理解？" },
      { role: "assistant", content: "关键不只是上下文有多长，而是模型能否从其中找出真正重要的信息。\n\n**核心矛盾：容量与压缩率**\n\n- 更长的窗口能容纳更多材料，但也会增加筛选和组织的负担。\n- 当关键线索被大量次要信息包围，模型就可能遗漏重点或混淆因果关系。\n- 因此，长文本能力需要与**信息压缩、结构组织和推理能力**一起提升。\n\n这也是概览先给出章节与金句的原因：先建立结构，再带着问题回到细节。" }
    ]
  };
  await worker.evaluate(`(async () => {
    await chrome.storage.local.set({ biliscript_ai_conversations_v1: [${JSON.stringify(conversation)}], biliscript_selected_provider: 'readme-openrouter\\u0001openai/gpt-5.2', biliscript_ai_thinking_level: 'high' });
    await chrome.storage.sync.set({ aiProviders: [${JSON.stringify(provider)}], readerTheme: 'light', readerPalette: 'flyme', aiThinkingLevel: 'high', readerWidth: 540 });
    return true;
  })()`);
  await worker.evaluate(patchExpression());
  patchTimer = setInterval(() => { void worker.evaluate(patchExpression()).catch(() => {}); }, 1500);
  patchTimer.unref?.();
  await pageCdp.send("Page.navigate", { url: SAMPLE.url });
  await waitFor("扩展按钮", () => pageCdp.evaluate(`!!document.getElementById('biliscript-script-button')`), { timeoutMs: 30000 });
  await worker.evaluate(patchExpression());
  await click(`document.getElementById('biliscript-script-button')`);
  await waitFor("字幕就绪", () => pageCdp.evaluate(`document.querySelectorAll('#biliscript-reading-subtitle .biliscript-reading-item').length >= 12`), { timeoutMs: 45000, intervalMs: 300 });
  await waitFor("中文字幕上屏", () => pageCdp.evaluate(`document.getElementById('biliscript-reading-subtitle')?.innerText.includes('真正的进步')`), { timeoutMs: 20000 });
  await pageCdp.evaluate(`document.querySelectorAll('video,audio').forEach(m => m.pause())`);
  await capture("demo-subtitle.png");

  await click(`document.getElementById('biliscript-reading-tab-overview')`);
  const render = `import(${JSON.stringify(readerUrl)}).then(m => m.renderReadingOverview({ phase: 'ready', analysis: ${JSON.stringify(overview)}, aiChapters: true, chapterSourceKind: 'auto', progressText: '', errorText: '', stripText: '', generatedFor: '' }))`;
  await evalReader(render);
  await sleep(300);
  await evalReader(render);
  await capture("demo-overview.png");

  await click(`document.querySelector('#biliscript-reading-overview-body .biliscript-reading-ov-quote-share')`);
  await waitFor("金句分享弹窗", () => pageCdp.evaluate(`!!document.querySelector('.biliscript-quote-share-host')`));
  await capture("demo-quote-share.png");
  await click(`document.querySelector('.biliscript-quote-share-close')`);

  await click(`document.getElementById('biliscript-reading-tab-chat')`);
  await waitFor("对话恢复", () => pageCdp.evaluate(`document.querySelectorAll('#biliscript-reading-chat-messages .chat-msg-assistant').length > 0`), { timeoutMs: 20000 }).catch(async (error) => {
    console.log(error.message);
    console.log(await pageCdp.evaluate(`({ text: document.getElementById('biliscript-reading-chat-messages')?.innerText, options: document.getElementById('biliscript-reading-chat-model-select')?.innerText, active: document.getElementById('biliscript-reading-tabbody-chat')?.className })`));
    console.log(await worker.evaluate(`chrome.storage.local.get(['aiProviders','biliscript_ai_conversations_v1'])`));
  });
  await capture("demo-ai-chat.png");
  await click(`document.getElementById('biliscript-reading-chat-model-chip')`);
  await waitFor("模型弹层", () => pageCdp.evaluate(`(() => { const p = document.getElementById('biliscript-reading-chat-model-panel'); return !!p && !p.hidden && !!p.querySelector('.chat-thinking-track'); })()`));
  await capture("demo-model-thinking.png");
} finally {
  if (patchTimer) clearInterval(patchTimer);
  if (pageCdp) await pageCdp.evaluate(`document.querySelectorAll('video,audio').forEach(m => { try { m.pause(); m.removeAttribute('src'); m.load(); } catch {} })`).catch(() => {});
  await teardown({ browser, cdps: [pageCdp] });
}
