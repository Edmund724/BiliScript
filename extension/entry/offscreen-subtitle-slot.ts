// offscreen-subtitle-slot.ts — offscreen 聊天字幕体的「有界多槽 LRU 缓存」纯逻辑
//（支持多视频标签页并发对话 + 追问不重传字幕体）。
//
// 为什么存在：SP / 文摘面板侧每条追问消息原本都经 port 全量重发 context（含整份
// subtitleBody，长视频可达数 MB/条）。瘦身后发起侧只在 lastAckedContextKey
// 变化时携带字幕体，offscreen 用多槽 LRU 缓存按 contextKey 补齐后续消息；槽随
// 文档生灭——文档被回收后槽为空，发起侧会先收到 port 断连重置 lastAcked；
// 槽缺失或已被淘汰时回「字幕体缺失」错误让发起侧重发全文，不做跨 key 猜测式
// 兜底——宁可一次显式失败，不把上一个视频的字幕体接进当前追问。
//
// 纯逻辑放独立模块：entry/offscreen.ts 顶层挂满 chrome 事件监听，不可在
// Node 测试环境导入（与 offscreen-lifecycle.ts 同一套拆分手法，可测）。

export interface SubtitleBodyItem {
  from: number;
  to: number;
  content: string;
}

export type SubtitleBody = SubtitleBodyItem[];

export interface ChatMessage {
  context?: Record<string, unknown>;
  contextKey?: string;
  [key: string]: unknown;
}

export interface SettleOk {
  ok: true;
  contextKey: string;
}

export interface SettleError {
  ok: false;
  error: string;
  code: string;
}

export type SettleResult = SettleOk | SettleError;

export interface SubtitleBodySlotOptions {
  maxEntries?: number;
  maxTotalChars?: number;
}

export const DEFAULT_MAX_SUBTITLE_SLOTS = 8;
export const DEFAULT_MAX_SUBTITLE_SLOT_CHARS = 2_000_000;

// 槽缺失/被淘汰时回给发起侧的错误文案与类型化 code：发起侧据 code 重置
// lastAckedContextKey（下一条消息重发全文），文案仅用于展示。
export const SUBTITLE_BODY_MISSING_MESSAGE = "字幕体缺失，请重发一次";
export const SUBTITLE_BODY_MISSING_CODE = "subtitle-body-missing";

interface SlotEntry {
  subtitleBody: SubtitleBody;
  chars: number;
}

function countSubtitleBodyChars(body: unknown): number {
  if (!Array.isArray(body)) {
    return 0;
  }
  let total = 0;
  for (const item of body) {
    total += String((item as { content?: unknown } | null)?.content ?? "").length;
  }
  return total;
}

/**
 * 创建有界多槽 LRU 缓存。按 contextKey 索引保存多份字幕体，超出条数或字符软上限时
 * 淘汰最久未使用的条目（单条超大时至少保底保留当次刚写入的这一条）。
 * settle(msg) 处理一条 chat 消息的字幕体，返回：
 *   - { ok: true, contextKey }：字幕体已就绪（消息自带 → 登记/刷新至 LRU 队尾；
 *     消息未带 → 命中缓存后刷新至队尾并补写进 msg.context.subtitleBody）。
 *   - { ok: false, error, code }：未命中或已被淘汰，调用方应原样回错误。
 */
export function createSubtitleBodySlot(
  options: SubtitleBodySlotOptions = {}
): { settle(msg: ChatMessage): SettleResult } {
  const maxEntries = Math.max(
    1,
    Math.floor(Number(options.maxEntries ?? DEFAULT_MAX_SUBTITLE_SLOTS)) || DEFAULT_MAX_SUBTITLE_SLOTS
  );
  const rawMaxTotalChars = Number(options.maxTotalChars);
  const maxTotalChars = Number.isFinite(rawMaxTotalChars)
    ? Math.max(0, rawMaxTotalChars)
    : DEFAULT_MAX_SUBTITLE_SLOT_CHARS;

  const slots = new Map<string, SlotEntry>();
  let totalChars = 0;

  function settle(msg: ChatMessage): SettleResult {
    const context = msg?.context && typeof msg.context === "object" ? msg.context : null;
    if (!context) {
      return { ok: false, error: SUBTITLE_BODY_MISSING_MESSAGE, code: SUBTITLE_BODY_MISSING_CODE };
    }
    const contextKey = String(msg.contextKey || "");

    // 消息自带字幕体（发起侧 lastAcked 未命中时的全量路径）→ 覆盖并置顶（LRU 队尾）。
    // 用 !== undefined 判"是否携带"而非 Array.isArray：空数组也是有效携带，
    // 非视频上下文的 subtitleBody: [] 同样需要走一遍槽登记。
    if (context.subtitleBody !== undefined) {
      const chars = countSubtitleBodyChars(context.subtitleBody);
      const existing = slots.get(contextKey);
      if (existing) {
        totalChars -= existing.chars;
        slots.delete(contextKey);
      }
      slots.set(contextKey, {
        subtitleBody: context.subtitleBody as SubtitleBody,
        chars
      });
      totalChars += chars;
      while (slots.size > maxEntries || (slots.size > 1 && totalChars > maxTotalChars)) {
        const oldestKey = slots.keys().next().value;
        if (oldestKey === undefined) {
          break;
        }
        const oldest = slots.get(oldestKey);
        slots.delete(oldestKey);
        if (oldest) {
          totalChars -= oldest.chars;
        }
      }
      return { ok: true, contextKey };
    }

    // 未携带 → 按 contextKey 查槽并刷新 LRU 位置。不跨 key 猜测兜底。
    const entry = slots.get(contextKey);
    if (entry && Array.isArray(entry.subtitleBody)) {
      slots.delete(contextKey);
      slots.set(contextKey, entry);
      context.subtitleBody = entry.subtitleBody;
      return { ok: true, contextKey };
    }
    return { ok: false, error: SUBTITLE_BODY_MISSING_MESSAGE, code: SUBTITLE_BODY_MISSING_CODE };
  }

  return { settle };
}
