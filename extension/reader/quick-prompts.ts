// extension/reader/quick-prompts.ts
// 初始快捷问题的预热编排（reader 侧）：字幕就绪 → 解析激活平台 → 一次非流式短
// 调用（标题 + 字幕节选）→ 解析出三条问题写进内存缓存，供对话 tab 的建议区直接
// 取用（reader/chat-lists.ts）。这是「每个视频即时生成」的落实处：问题来自本视频
// 内容，不再是预设文案。
//
// 触发：reader/lifecycle.ts 的 subtitle-ready 通知与抓取落定对账（两处
// fire-and-forget）。幂等三重：缓存命中直接返回、同视频在飞复用同一 promise、
// 用户配了自定义问题连请求都不发。
//
// 失败一律静默（不写缓存也不抛错）：缺平台、读设置失败、网络失败、输出解析不出
// ——渲染侧会回落固定三条（chat/quick-prompts.ts 的 resolveInitialQuickPrompts），
// 预热失败不该在阅读界面上冒出任何错误提示，也不该阻塞字幕/概览任何既有链路。
//
// 成本：每个视频一次小请求（约 1.5k 字符素材 + 200 余 token 输出），同一视频只
// 算一次。请求经 offscreen 代发（content 侧跨域受网页 CORS 约束，与概览生成走
// 同一条 core/provider-http-offscreen 通道）。

import { buildContextKey } from "../ai/conversation.js";
import { resolveActiveProvider } from "../ai/active-provider.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { logWarn } from "../shared/logging.js";
import {
  QUICK_PROMPT_MAX_TOKENS,
  buildQuickPromptExcerpt,
  buildQuickPromptMessages,
  normalizePromptList,
  parseQuickPrompts
} from "../chat/quick-prompts.js";
import { readCachedQuickPrompts, writeCachedQuickPrompts } from "../chat/quick-prompt-cache.js";

// 预热入参：reader 侧只需给出视频身份 + 标题 + 字幕体（lifecycle 从 state.clip
// 取；本模块不 import reader 状态，便于单独测试）。
export interface QuickPromptSource {
  bvid?: unknown;
  cid?: unknown;
  aid?: unknown;
  title?: unknown;
  subtitleBody?: unknown;
}

// 同视频在飞的生成（键 = 上下文键）：字幕就绪通知与抓取落定对账可能先后触发，
// 复用同一 promise 即可，不重复花钱。
const inflight = new Map<string, Promise<void>>();

/**
 * 预热当前视频的初始快捷问题。返回编排 promise（调用方通常 void 掉；测试与
 * 去重方可以 await）。不满足前置（无视频身份 / 无字幕体 / 已有缓存 / 已在飞）
 * 时立即落定，不做任何请求。
 */
export function warmUpInitialQuickPrompts(source: QuickPromptSource): Promise<void> {
  const key = buildContextKey({ bvid: source?.bvid, cid: source?.cid, aid: source?.aid });
  const body = Array.isArray(source?.subtitleBody) ? source.subtitleBody : [];
  if (!key || !body.length) {
    return Promise.resolve();
  }
  if (readCachedQuickPrompts(key)) {
    return Promise.resolve();
  }
  const running = inflight.get(key);
  if (running) {
    return running;
  }
  let task: Promise<void>;
  task = generate(key, String(source?.title || ""), body)
    .catch(() => null)
    .then(() => {
      if (inflight.get(key) === task) {
        inflight.delete(key);
      }
    });
  inflight.set(key, task);
  return task;
}

async function generate(key: string, title: string, body: unknown[]): Promise<void> {
  try {
    // 用户配了自定义初始问题 → 根本不需要生成。读设置失败按「放弃生成」处理
    //（宁可用固定三条兜底，也不在配置未知的情况下花钱）。
    const settings = await sendRuntimeMessage({ type: "get-settings" }).catch(() => null);
    if (!settings?.ok) {
      return;
    }
    if (normalizePromptList(settings.settings?.aiInitialQuickPrompts).length) {
      return;
    }
    const provider = await resolveActiveProvider();
    // 动态 import：AI 客户端与 offscreen 代发通道只在真的要生成时装载
    //（与概览生成同一手法，reader chunk 保持轻）。
    const [{ chatCompletion }, { providerFetchViaOffscreen }] = await Promise.all([
      import("../ai/completion.js"),
      import("../core/provider-http-offscreen.js")
    ]);
    const text = await chatCompletion({
      provider,
      messages: buildQuickPromptMessages({ title, excerpt: buildQuickPromptExcerpt(body) }),
      stream: false,
      // 思考档位显式钉死 off（对齐概览生成的钉法）：生成三个短问题不需要思考，
      // 开了既慢又贵。
      thinkingLevel: "off",
      maxTokens: QUICK_PROMPT_MAX_TOKENS,
      // 预热是尽力而为：失败即回落固定三条，不重试（不为一屏 chip 反复花钱）。
      retries: 0,
      // content 侧没有扩展源 fetch（跨域服从网页 CORS）：模型调用交 offscreen 代发。
      fetchImpl: providerFetchViaOffscreen
    });
    const prompts = parseQuickPrompts(text);
    if (prompts.length) {
      writeCachedQuickPrompts(key, prompts);
    }
  } catch (error) {
    logWarn("[BILISCRIPT] quick prompt generation failed", { error });
  }
}
