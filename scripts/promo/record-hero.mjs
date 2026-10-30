import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {sleep, waitFor} from "../browser-harness/harness.mjs";
import {assertPromoCaptureClean, preparePromoCapture} from "./capture.mjs";
import {connectPage, PROMO_DIR, readSession} from "./lib.mjs";
import {encodeRecording, exportRecordingFrame, recordScene, withSessionPage} from "./recorder.mjs";

const QUICK_ACTION_SELECTOR = "#biliscript-player-ai-quick-action";
const HERO_BVID = "BV1mAam6tEL8";
const PROMPT_HEAD = "整理这期视频的内容";
const STREAM_START_TIMEOUT_MS = 60000;
const ANSWER_FLOW_MS = 4200;
// 源素材固定 18s（540 帧）：点击/展开/提示词 + 约 10s 模型思考段 + 4s 左右答案正文流出。
// 思考段由镜头内跳切压缩；render.mjs 的素材时长契约按源素材标注。
const HERO_HOOK_FRAMES = 540;
const DURATION_MENTION_PATTERN = /\d+(?:\.\d+)?\s*(?:minutes?|mins?|分钟|分)\b|\b\d{1,2}:\d{2}\b/;

async function prepareHeroCapture(cdp) {
  await preparePromoCapture(cdp);
  await cdp.evaluate(`(() => {
    let style = document.getElementById('biliscript-hero-capture-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'biliscript-hero-capture-style';
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = [
      '[class*="avatar"] { visibility: hidden !important; }',
      '#right-container, .right-container { visibility: hidden !important; }'
    ].join('\\n');
    return true;
  })()`);
  await cdp.evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
  const unclean = await cdp.evaluate(`(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.01;
    };
    return [...document.querySelectorAll('[class*="avatar"], #right-container, .right-container')]
      .filter((element) => !element.closest('#biliscript-reading-view') && visible(element))
      .map((element) => element.id || element.className || element.tagName)
      .slice(0, 12);
  })()`);
  if (unclean.length) throw new Error(`片头画面仍有头像或推荐栏：${JSON.stringify(unclean)}`);
  await assertPromoCaptureClean(cdp);
}

// 清掉该视频的整份 AI 分析缓存（数据键 + 分键索引 + 汇总清单里的分析族条目），
// 让分析链路重新实际执行；字幕缓存保持不动。同时只删除该视频的对话缓存条目，
// 清除前把 biliscript_ai_conversations_v1 原值备份到 .scratch，避免开面板时
// 先恢复上一轮已完成答案形成闪帧。
async function clearRecordingCaches(cdp) {
  const contexts = [];
  cdp.on("Runtime.executionContextCreated", (params) => contexts.push(params.context));
  await cdp.send("Page.reload");
  await waitFor("B 站页面重载完成", () => cdp.evaluate(`document.readyState === 'complete'`), {timeoutMs: 45000});
  const context = await waitFor(
    "扩展 content script 上下文",
    async () => contexts.find((item) => item.auxData?.type === "isolated" && String(item.name || "").includes("BiliScript")) || null,
    {timeoutMs: 30000}
  );
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(async () => {
      const bvid = ${JSON.stringify(HERO_BVID)};
      const all = await chrome.storage.local.get(null);
      const removed = Object.keys(all).filter((key) => {
        if (key.startsWith("biliscript_lvs_analysis_final_" + bvid)) return true;
        if (key.startsWith("biliscript_lvs_analysis_" + bvid)) return true;
        return key.startsWith("biliscript_cache_lru_index:") && key.includes(bvid) && key.includes("analysis");
      });
      if (removed.length) await chrome.storage.local.remove(removed);
      const manifest = all["biliscript_cache_lru_index"];
      const manifestKeys = [];
      if (manifest && typeof manifest === "object") {
        for (const family of Object.keys(manifest)) {
          if (!family.includes("analysis")) continue;
          if (manifest[family] && Object.prototype.hasOwnProperty.call(manifest[family], bvid)) {
            delete manifest[family][bvid];
            manifestKeys.push(family);
          }
        }
        if (manifestKeys.length) await chrome.storage.local.set({"biliscript_cache_lru_index": manifest});
      }
      const conversations = all["biliscript_ai_conversations_v1"];
      const removedConversationIds = [];
      if (Array.isArray(conversations)) {
        const keep = conversations.filter((item) => {
          const contextKey = String(item?.contextKey || "");
          const match = String(item?.contextRef?.bvid || "") === bvid || contextKey.includes(bvid);
          if (match) removedConversationIds.push(String(item?.id || item?.contextKey || ""));
          return !match;
        });
        if (removedConversationIds.length) {
          await chrome.storage.local.set({"biliscript_ai_conversations_v1": keep});
        }
      }
      return {
        removed,
        manifestKeys,
        removedConversationIds,
        conversationsBackup: conversations ?? null
      };
    })()`,
    contextId: context.id,
    awaitPromise: true,
    returnByValue: true
  });
  if (result?.exceptionDetails) {
    throw new Error(`清理录制缓存失败：${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
  }
  const value = result?.result?.value || {};
  if (value.conversationsBackup !== null && value.conversationsBackup !== undefined) {
    const evidenceDir = path.join(PROMO_DIR, "evidence");
    const backupPath = path.join(evidenceDir, "ai-conversations-backup.json");
    const serialized = JSON.stringify({exportedAt: new Date().toISOString(), bvid: HERO_BVID, value: value.conversationsBackup}, null, 2) + "\n";
    await mkdir(evidenceDir, {recursive: true});
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await writeFile(path.join(evidenceDir, `ai-conversations-backup-${stamp}.json`), serialized, "utf8");
    await writeFile(backupPath, serialized, "utf8");
    value.conversationsBackupPath = backupPath;
  }
  delete value.conversationsBackup;
  return value;
}

async function quickActionState(cdp) {
  return cdp.evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(QUICK_ACTION_SELECTOR)});
    if (!button) return null;
    const wrap = button.closest('.biliscript-player-ai-wrap');
    const rect = button.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
      opacity: Number(getComputedStyle(wrap).opacity),
      active: wrap.classList.contains('is-active')
    };
  })()`);
}

async function moveMouse(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", {type: "mouseMoved", x, y, button: "none"});
}

async function waitForIconShown(cdp) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await quickActionState(cdp);
    if (state?.active && state.opacity >= 0.2) return state;
    await sleep(24);
  }
  throw new Error("悬浮按钮没有在鼠标进入播放器后浮现");
}

async function chatState(cdp) {
  return cdp.evaluate(`(() => {
    const view = document.getElementById('biliscript-reading-view');
    const messages = document.getElementById('biliscript-reading-chat-messages');
    const activeTab = document.querySelector('#biliscript-reading-view .biliscript-reading-tab.is-active');
    const assistant = messages?.querySelector('.chat-msg-assistant');
    const stable = assistant?.querySelector('.chat-stream-stable');
    const tail = assistant?.querySelector('.chat-stream-tail');
    const finalBody = assistant?.querySelector('.chat-msg-assistant-body');
    const streamText = ((stable?.innerText || '') + '\\n' + (tail?.innerText || '')).trim();
    const body = stable || tail || finalBody;
    const viewRect = view?.getBoundingClientRect();
    const bodyRect = body?.getBoundingClientRect();
    const messagesRect = messages?.getBoundingClientRect();
    return {
      open: view?.classList.contains('open') || false,
      hidden: view?.getAttribute('aria-hidden') ?? null,
      ready: view?.getAttribute('data-biliscript-reader-ready') ?? null,
      opacity: view ? Number(getComputedStyle(view).opacity) : 0,
      panelRect: viewRect ? {x: viewRect.x, y: viewRect.y, width: viewRect.width, height: viewRect.height} : null,
      tab: activeTab?.textContent?.trim() || null,
      userText: messages?.querySelector('.chat-msg-user')?.innerText || '',
      userCount: messages?.querySelectorAll('.chat-msg-user').length || 0,
      assistantCount: messages?.querySelectorAll('.chat-msg-assistant').length || 0,
      streaming: !!assistant?.classList.contains('chat-msg-streaming'),
      thinkingLabel: assistant?.querySelector('.chat-thinking-label-text')?.textContent || '',
      thinkingText: assistant?.querySelector('.chat-thinking-text')?.innerText || '',
      answerLen: streamText.length,
      answerText: (streamText + '\\n' + (finalBody?.innerText || '')).trim(),
      finalLen: finalBody?.innerText?.length || 0,
      hasError: !!assistant?.querySelector('.chat-msg-error, .chat-search-card-error'),
      status: document.getElementById('biliscript-reading-status')?.innerText || '',
      scrollTop: messages?.scrollTop ?? null,
      scrollHeight: messages?.scrollHeight ?? null,
      clientHeight: messages?.clientHeight ?? null,
      answerTop: bodyRect && messagesRect ? bodyRect.top - messagesRect.top : null
    };
  })()`);
}

export async function record() {
  const events = [];
  let sourceUrl = "";
  try {
    return await withSessionPage(async ({cdp, target}) => {
      sourceUrl = target.url;
      await cdp.send("Page.setWebLifecycleState", {state: "active"});
      const cache = await clearRecordingCaches(cdp);
      await waitFor("B 站真实视频帧就绪", () => cdp.evaluate(`document.readyState === 'complete' && (document.querySelector('video')?.readyState || 0) >= 2`), {timeoutMs: 45000});
      if (await cdp.evaluate(`document.getElementById('biliscript-reading-view')?.getAttribute('aria-hidden') === 'false'`)) {
        await cdp.evaluate("document.getElementById('biliscript-reading-close-btn')?.click(); true");
        await waitFor("文摘面板关闭", () => cdp.evaluate(`document.getElementById('biliscript-reading-view')?.getAttribute('aria-hidden') !== 'false'`), {timeoutMs: 10000});
      }
      await waitFor("悬浮按钮就绪", () => cdp.evaluate(`!!document.querySelector(${JSON.stringify(QUICK_ACTION_SELECTOR)})`), {timeoutMs: 30000});
      await cdp.evaluate(`(() => {
        document.querySelectorAll('video,audio').forEach((media) => { try { media.pause(); } catch {} });
        const video = document.querySelector('video');
        if (video) video.currentTime = Math.min(5, Math.max(0, (video.duration || 6) - 1));
        scrollTo({top: 0, behavior: 'instant'});
        return true;
      })()`);
      // B 站播放器在 seek 后会在左下角弹「已为您定位至…」提示；等它自然消失再开录。
      await sleep(4800);
      // 录前把鼠标移出播放器并等待游标显隐计时器落定，保证首帧没有悬浮按钮。
      await cdp.evaluate(`document.querySelectorAll('.biliscript-player-ai-wrap.is-active').forEach((wrap) => wrap.classList.remove('is-active')); true`);
      await sleep(300);

      const recording = await recordScene(cdp, "00-hero-hook", async () => {
        const startedAt = Date.now();
        const mark = (type, extra = {}) => {
          const at = Number(((Date.now() - startedAt) / 1000).toFixed(3));
          const event = {type, at, frame: Math.round(at * 30), ...extra};
          events.push(event);
          return event;
        };
        mark("cache-cleared", {keys: cache.removed, manifestKeys: cache.manifestKeys, conversations: cache.removedConversationIds, conversationsBackup: cache.conversationsBackupPath});
        let durationMention = false;
        await sleep(550);
        // 鼠标从画面右侧进入播放器；进入后按钮由扩展的游标活动监听浮现。
        for (const [x, y] of [[1900, 540], [1720, 545], [1540, 551], [1430, 557], [1404, 562]]) {
          await moveMouse(cdp, x, y);
          await sleep(55);
        }
        const appeared = await waitForIconShown(cdp);
        mark("icon-appeared", {rect: appeared.rect});
        await moveMouse(cdp, appeared.x, appeared.y);
        await sleep(180);
        const hovered = await quickActionState(cdp);
        mark("icon-hover", {rect: hovered.rect});
        await sleep(220);
        const clickState = await quickActionState(cdp);
        mark("icon-click", {rect: clickState.rect, point: {x: clickState.x, y: clickState.y}});
        await cdp.send("Input.dispatchMouseEvent", {type: "mousePressed", x: clickState.x, y: clickState.y, button: "left", buttons: 1, clickCount: 1});
        await cdp.send("Input.dispatchMouseEvent", {type: "mouseReleased", x: clickState.x, y: clickState.y, button: "left", buttons: 0, clickCount: 1});

        const panelOpen = await waitFor("文摘面板展开并进入 AI 对话", async () => {
          const state = await chatState(cdp);
          return state?.open && state.hidden === "false" && state.ready === "1" && state.panelRect?.width > 0 ? state : null;
        }, {timeoutMs: 15000, intervalMs: 40});
        mark("panel-ready", {rect: panelOpen.panelRect, tab: panelOpen.tab});

        const promptSent = await waitFor("结构化总结指令自动发出", async () => {
          const state = await chatState(cdp);
          if (!state || state.tab !== "AI 对话") return null;
          if (!state.userText.trim().startsWith(PROMPT_HEAD)) return null;
          // 开面板时可能先恢复上一轮同题对话；以清场后（无完成态答案）的提示词气泡为准。
          if (state.finalLen > 200 || state.userCount !== 1 || state.assistantCount > 1) return null;
          return state;
        }, {timeoutMs: 20000, intervalMs: 50});
        mark("prompt-sent", {prompt: promptSent.userText.trim().slice(0, 120), status: promptSent.status});

        const answerStart = await waitFor("AI 总结答案开始流出", async () => {
          const state = await chatState(cdp);
          if (!state || state.hasError) return null;
          if (!durationMention && DURATION_MENTION_PATTERN.test(`${state.thinkingText}\n${state.answerText}`)) {
            durationMention = true;
            const source = DURATION_MENTION_PATTERN.test(state.thinkingText) ? "thinking" : "answer";
            const match = `${source === "thinking" ? state.thinkingText : state.answerText}`.match(DURATION_MENTION_PATTERN);
            mark("duration-mention", {source, text: match?.[0] || "", snippet: (source === "thinking" ? state.thinkingText : state.answerText).slice(0, 160)});
          }
          return state.streaming && state.answerLen > 0 ? state : null;
        }, {timeoutMs: STREAM_START_TIMEOUT_MS, intervalMs: 100});
        const answerStartEvent = mark("answer-start", {
          panel: answerStart.panelRect,
          answerTop: answerStart.answerTop,
          scrollTop: answerStart.scrollTop,
          thinkingLabel: answerStart.thinkingLabel
        });
        // 答案正文到达后，消息区由产品自动跟随滚动。记录首次滚动与 TL;DR 顶到
        // 消息区顶部的时刻（镜头推近取景用）；不额外写 scrollTop，避免反向跳动。
        // 录制至少覆盖固定 18s；若答案起得晚，则延长到答案流出满 4.2s。
        const flowEndsAt = Math.max(HERO_HOOK_FRAMES / 30 * 1000, answerStartEvent.at * 1000 + ANSWER_FLOW_MS);
        let scrollEvent = null;
        let alignedEvent = null;
        let answerDurationEvent = null;
        let final = answerStart;
        while (Date.now() - startedAt < flowEndsAt) {
          final = await chatState(cdp);
          if (!scrollEvent && final.scrollTop > 0) {
            scrollEvent = mark("chat-scrolled", {from: 0, to: final.scrollTop, auto: true});
          }
          if (!alignedEvent && final.scrollTop >= answerStart.answerTop - 8) {
            alignedEvent = mark("tl-dr-aligned", {scrollTop: final.scrollTop, answerTop: final.answerTop});
          }
          if (!answerDurationEvent && /时长|约\s*\d+\s*分\s*\d+\s*秒/.test(final.answerText)) {
            const match = final.answerText.match(/时长[^\n]{0,24}/);
            answerDurationEvent = mark("answer-duration-mention", {text: match?.[0] || "", snippet: final.answerText.slice(0, 200)});
          }
          if (final.hasError) throw new Error(`AI 对话出现错误态：${final.status || final.answerText.slice(0, 120)}`);
          await sleep(100);
        }
        if (!durationMention && DURATION_MENTION_PATTERN.test(final.answerText)) {
          mark("duration-mention", {source: "answer", text: final.answerText.match(DURATION_MENTION_PATTERN)?.[0] || "", snippet: final.answerText.slice(0, 160)});
        }
        if (final.hasError) throw new Error(`AI 对话出现错误态：${final.status || final.answerText.slice(0, 120)}`);
        if (/未配置平台|未配置|无字幕/.test(`${final.status} ${final.answerText.slice(0, 200)}`)) {
          throw new Error(`录制画面出现平台或字幕错误提示：${final.status}`);
        }
        if (!/TL;DR/i.test(final.answerText)) throw new Error("答案开头没有 TL;DR，无法作为推近落点");
        mark("answer-flowing", {answerLen: final.answerLen, scrollTop: final.scrollTop});
        return {events};
      }, {captureScale: 1, quality: 95, prepareCapture: prepareHeroCapture});
      const output = await encodeRecording(recording, "hero-hook.mp4", {frameCount: HERO_HOOK_FRAMES, preset: "medium", crf: 17});
      const answerStartEvent = events.find((event) => event.type === "answer-start");
      const panelFrameAt = Math.max(0, (answerStartEvent?.at ?? recording.duration - 2) + 1.8);
      const panel = await exportRecordingFrame(recording, "hero-panel.png", {at: panelFrameAt});
      return {sourceUrl, outputs: [output, panel], recordings: [recording.metadata], events};
    });
  } catch (error) {
    // 失败时保留现场，便于报告具体阻塞。
    try {
      const {cdp} = await connectPage(await readSession());
      try {
        const shot = await cdp.send("Page.captureScreenshot", {format: "png", fromSurface: true});
        const evidenceDir = path.join(PROMO_DIR, "evidence");
        await mkdir(evidenceDir, {recursive: true});
        await writeFile(path.join(evidenceDir, "hero-blocked.png"), Buffer.from(shot.data, "base64"));
        await writeFile(
          path.join(evidenceDir, "hero-blocked.json"),
          JSON.stringify({sourceUrl, error: String(error?.stack || error), events}, null, 2) + "\n",
          "utf8"
        );
      } finally {
        cdp.close();
      }
    } catch (captureError) {
      console.error(`录制失败后保存现场也失败：${captureError.message}`);
    }
    throw error;
  }
}
