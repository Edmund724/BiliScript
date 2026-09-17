// 把 content.js 传来的 context 拼成 chat messages，并提供建议 chip 模板。

import { DEFAULT_AI_SYSTEM_PROMPT } from "../core/default-prompts.js";
import { SEGMENT_INPUT_CHARS } from "./budgeter.js";
import { buildSubtitlePrompt } from "./subtitle-prompt.js";
import type { AiContext, ChatMessage, HotComment } from "./types.js";

interface BuildMessagesInput {
  context?: AiContext | null;
  userPrompt?: unknown;
  history?: unknown[];
  systemPrompt?: unknown;
  // 联网搜索管线（spec §2.5）：开启时保留历史中的 assistant(tool_calls) 与 tool
  // 消息（多轮追问保持工具上下文，OpenAI 协议合法）；关闭时整体丢弃——无 tools
  // 的请求里出现 tool 消息部分平台会报 4xx。
  includeToolHistory?: boolean;
}

export function buildMessages({ context, userPrompt, history, systemPrompt, includeToolHistory }: BuildMessagesInput = {}): ChatMessage[] {
  const ctx = context || {};
  const sections: string[] = [];

  // 用户自定义系统提示词是主人格，排第一位（清空时回落内置默认——那条本身就是
  // 完整人设）；标题/字幕/评论等数据段随后，不再有独立的内置 mini 人设。
  const customSystemPrompt = String(systemPrompt || "").trim();
  sections.push(customSystemPrompt || DEFAULT_AI_SYSTEM_PROMPT);

  sections.push(
    `当前用户正在看一个视频，标题：「${ctx.title || "未知"}」`,
    `作者：${ctx.author || "未知"} | 上传日期：${ctx.uploadDate || "未知"}`
  );

  // 字幕只以 subtitleBody（原始条目）入协议，发送物由此现场渲染，与预算判定同源。
  // includeTimestampInBody 由 payload 透传（context-resolver / content 侧设置），
  // 缺失时 buildSubtitlePrompt 默认 true（与历史默认一致）。
  // 追问压缩路径的发送物是「分段小结 + 成稿笔记」而非逐字字幕，标签如实分流：
  // 误标「字幕全文」会让模型对时间戳引用与原话类问题过度自信。
  const compressedSummary = String(ctx.compressedSummaryMarkdown || "");
  const subtitleText = compressedSummary
    || buildSubtitlePrompt({
      body: ctx.subtitleBody,
      chapters: ctx.chapters,
      videoDuration: ctx.videoDuration,
      includeTimestampInBody: ctx.includeTimestampInBody
    });
  if (subtitleText) {
    sections.push(
      compressedSummary
        ? `以下是本视频此前的整理成果（分段小结与成稿笔记，非逐字字幕）：\n\n${subtitleText}`
        : `以下是视频的字幕全文：\n\n${subtitleText}`
    );
  } else {
    sections.push("（暂无字幕）");
  }

  if (Array.isArray(ctx.hotComments) && ctx.hotComments.length) {
    const commentBlock = ctx.hotComments
      .map(function (c: HotComment, i: number) { return `${i + 1}. ${c.uname || "匿名"}（赞 ${c.like || 0}）: ${c.message || ""}`; })
      .join("\n");
    sections.push(`以下是按热度排序的前 ${ctx.hotComments.length} 条热门评论：\n\n${commentBlock}`);
  }

  let historyMessages: ChatMessage[] = [];
  if (Array.isArray(history)) {
    historyMessages = history.filter(function (m: unknown) {
      const item = m as { role?: unknown; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown };
      if (!item) return false;
      // 联网轮（spec §2.5）：assistant(tool_calls) 与 tool 消息原样透传，
      // 多轮追问保持工具上下文。
      if (includeToolHistory) {
        if (item.role === "assistant" && Array.isArray(item.tool_calls) && item.tool_calls.length) {
          return true;
        }
        if (item.role === "tool" && typeof item.tool_call_id === "string" && typeof item.content === "string") {
          return true;
        }
      }
      // 关闭时（无 tools 轮）：tool 消息与空正文 assistant(tool_calls) 丢弃
      //（OpenAI 协议下无 tools 的 tool_calls 消息非法）；带正文的 assistant
      // 保留为普通 assistant。
      if (item.role === "tool") return false;
      if (item.role === "assistant" && !item.content && item.tool_calls != null) return false;
      return (item.role === "user" || item.role === "assistant") && typeof item.content === "string";
    }) as ChatMessage[];
  }

  const messages: ChatMessage[] = [
    { role: "system", content: sections.join("\n\n") },
    ...historyMessages,
    { role: "user", content: String(userPrompt || "") }
  ];
  return messages;
}

// 截断上限即单段输入预算（budgeter 的 SEGMENT_INPUT_CHARS）：与 Map-Reduce 的
// 「单段原始字幕字符上限」是同一个概念，不再各写一份 50000。
export function clipSubtitleForContext(markdown: unknown, maxChars: number = SEGMENT_INPUT_CHARS): string {
  const text = String(markdown || "");
  if (!text || text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n...（字幕过长，已截断）";
}
