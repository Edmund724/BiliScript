// createSubtitleBodySlot（entry/offscreen-subtitle-slot.js）纯逻辑测试：
// 候选5「追问不重传字幕体」的 offscreen 单槽缓存——
// - 消息自带 subtitleBody → 覆盖槽（以消息 contextKey 为 key）；
// - 未携带 + 槽 key 匹配 → 从槽补写 msg.context.subtitleBody；
// - 未携带 + 无槽（= 文档重启后的新实例）/ key 不匹配 → 回「字幕体缺失」错误；
// - 无 context 的异常消息同样回缺失，不做猜测式兜底。

import { describe, expect, it } from "vitest";

import {
  SUBTITLE_BODY_MISSING_CODE,
  SUBTITLE_BODY_MISSING_MESSAGE,
  createSubtitleBodySlot,
  type ChatMessage,
  type SettleResult
} from "../../extension/entry/offscreen-subtitle-slot.js";

const BODY = [{ from: 0, to: 5, content: "第一句" }, { from: 5, to: 9, content: "第二句" }];

describe("createSubtitleBodySlot", () => {
  it("消息自带字幕体 → 覆盖槽并回 ok（contextKey 取消息 key）", () => {
    const slot = createSubtitleBodySlot();
    const context: Record<string, unknown> = { title: "T", subtitleBody: BODY };

    const result = slot.settle({ action: "chat", contextKey: "video:BV1|101", context });

    expect(result).toEqual({ ok: true, contextKey: "video:BV1|101" });
    // 全量路径不改动消息本体
    expect(context.subtitleBody).toBe(BODY);
  });

  it("未携带 + 槽 key 匹配 → 从槽补写（同一引用，ladder 拿到完整 context）", () => {
    const slot = createSubtitleBodySlot();
    slot.settle({ action: "chat", contextKey: "video:BV1|101", context: { title: "T", subtitleBody: BODY } });

    const followup: ChatMessage = { action: "chat", contextKey: "video:BV1|101", context: { title: "T" } };
    const result = slot.settle(followup);

    expect(result).toEqual({ ok: true, contextKey: "video:BV1|101" });
    expect(followup.context!.subtitleBody).toBe(BODY);
  });

  it("未携带 + 无槽（新实例 = offscreen 文档重启模拟）→ 回字幕体缺失错误", () => {
    const slot = createSubtitleBodySlot();

    const result = slot.settle({ action: "chat", contextKey: "video:BV1|101", context: { title: "T" } });

    expect(result).toEqual({
      ok: false,
      error: SUBTITLE_BODY_MISSING_MESSAGE,
      code: SUBTITLE_BODY_MISSING_CODE
    });
  });

  it("未携带 + 槽 key 不匹配 → 回缺失错误（不跨 key 复用旧字幕体）", () => {
    const slot = createSubtitleBodySlot();
    slot.settle({ action: "chat", contextKey: "video:BV1|101", context: { title: "T", subtitleBody: BODY } });

    const result = slot.settle({ action: "chat", contextKey: "video:BV2|202", context: { title: "T2" } });

    expect(result.ok).toBe(false);
    expect((result as Extract<SettleResult, { ok: false }>).code).toBe(SUBTITLE_BODY_MISSING_CODE);
  });

  it("多个不同 contextKey 并存时各自追问均可命中对应字幕体", () => {
    const slot = createSubtitleBodySlot();
    const bodyA = [{ from: 0, to: 5, content: "A" }];
    const bodyB = [{ from: 0, to: 5, content: "B" }];
    slot.settle({ action: "chat", contextKey: "video:BVA|1", context: { subtitleBody: bodyA } });
    slot.settle({ action: "chat", contextKey: "video:BVB|2", context: { subtitleBody: bodyB } });

    const followupA: ChatMessage = { action: "chat", contextKey: "video:BVA|1", context: { title: "A" } };
    const followupB: ChatMessage = { action: "chat", contextKey: "video:BVB|2", context: { title: "B" } };

    expect(slot.settle(followupA)).toEqual({ ok: true, contextKey: "video:BVA|1" });
    expect(slot.settle(followupB)).toEqual({ ok: true, contextKey: "video:BVB|2" });
    expect(followupA.context!.subtitleBody).toBe(bodyA);
    expect(followupB.context!.subtitleBody).toBe(bodyB);
  });

  it("超过 maxEntries 上限时按 LRU 淘汰最久未使用的条目，命中读取会刷新活跃度", () => {
    const slot = createSubtitleBodySlot({ maxEntries: 2 });
    const bodyA = [{ from: 0, to: 5, content: "A" }];
    const bodyB = [{ from: 0, to: 5, content: "B" }];
    const bodyC = [{ from: 0, to: 5, content: "C" }];

    slot.settle({ action: "chat", contextKey: "video:A|1", context: { subtitleBody: bodyA } });
    slot.settle({ action: "chat", contextKey: "video:B|2", context: { subtitleBody: bodyB } });
    // 读取 A 使 A 成为最近使用，B 变为最旧
    expect(slot.settle({ action: "chat", contextKey: "video:A|1", context: {} }).ok).toBe(true);
    // 写入 C 超过容量 2 → 淘汰 B，保留 A 与 C
    slot.settle({ action: "chat", contextKey: "video:C|3", context: { subtitleBody: bodyC } });

    const missB = slot.settle({ action: "chat", contextKey: "video:B|2", context: {} });
    expect(missB.ok).toBe(false);
    expect((missB as Extract<SettleResult, { ok: false }>).code).toBe(SUBTITLE_BODY_MISSING_CODE);

    const hitA: ChatMessage = { action: "chat", contextKey: "video:A|1", context: {} };
    const hitC: ChatMessage = { action: "chat", contextKey: "video:C|3", context: {} };
    expect(slot.settle(hitA).ok).toBe(true);
    expect(slot.settle(hitC).ok).toBe(true);
    expect(hitA.context!.subtitleBody).toBe(bodyA);
    expect(hitC.context!.subtitleBody).toBe(bodyC);
  });

  it("超过 maxTotalChars 上限时淘汰最旧条目，但单条超大时仍保底保留自身", () => {
    const slot = createSubtitleBodySlot({ maxTotalChars: 10 });
    const bodyA = [{ from: 0, to: 5, content: "123456" }];
    const bodyB = [{ from: 0, to: 5, content: "abcdef" }];
    const bodyOversized = [{ from: 0, to: 5, content: "0123456789AB" }];

    slot.settle({ action: "chat", contextKey: "video:A|1", context: { subtitleBody: bodyA } });
    // A(6) + B(6) = 12 > 10 → 淘汰 A，保留 B
    slot.settle({ action: "chat", contextKey: "video:B|2", context: { subtitleBody: bodyB } });

    expect(slot.settle({ action: "chat", contextKey: "video:A|1", context: {} }).ok).toBe(false);
    const hitB: ChatMessage = { action: "chat", contextKey: "video:B|2", context: {} };
    expect(slot.settle(hitB).ok).toBe(true);
    expect(hitB.context!.subtitleBody).toBe(bodyB);

    // 单条 12 字超过 10 上限 → 淘汰 B，保底保留当次刚写入的超大条目
    slot.settle({ action: "chat", contextKey: "video:BIG|3", context: { subtitleBody: bodyOversized } });
    expect(slot.settle({ action: "chat", contextKey: "video:B|2", context: {} }).ok).toBe(false);
    const hitBig: ChatMessage = { action: "chat", contextKey: "video:BIG|3", context: {} };
    expect(slot.settle(hitBig).ok).toBe(true);
    expect(hitBig.context!.subtitleBody).toBe(bodyOversized);
  });

  it("同 key 重复携带全量字幕体时更新内容并扣减旧字符数，不触发误淘汰", () => {
    const slot = createSubtitleBodySlot({ maxTotalChars: 10 });
    const bodyALarge = [{ from: 0, to: 5, content: "12345678" }];
    const bodyASmall = [{ from: 0, to: 5, content: "1234" }];
    const bodyB = [{ from: 0, to: 5, content: "abcde" }];

    slot.settle({ action: "chat", contextKey: "video:A|1", context: { subtitleBody: bodyALarge } });
    slot.settle({ action: "chat", contextKey: "video:A|1", context: { subtitleBody: bodyASmall } });
    slot.settle({ action: "chat", contextKey: "video:B|2", context: { subtitleBody: bodyB } });

    const hitA: ChatMessage = { action: "chat", contextKey: "video:A|1", context: {} };
    const hitB: ChatMessage = { action: "chat", contextKey: "video:B|2", context: {} };
    expect(slot.settle(hitA).ok).toBe(true);
    expect(slot.settle(hitB).ok).toBe(true);
    expect(hitA.context!.subtitleBody).toBe(bodyASmall);
    expect(hitB.context!.subtitleBody).toBe(bodyB);
  });

  it("context 缺失/非对象的异常消息 → 回字幕体缺失错误", () => {
    const slot = createSubtitleBodySlot();
    expect(slot.settle({ action: "chat", contextKey: "k" }).ok).toBe(false);
    expect(slot.settle({ action: "chat", contextKey: "k", context: "not-an-object" as unknown as Record<string, unknown> }).ok).toBe(false);
  });

  it("空数组字幕体也是有效携带（非视频上下文同样登记进槽）", () => {
    const slot = createSubtitleBodySlot();
    slot.settle({ action: "chat", contextKey: "url:https://x", context: { subtitleBody: [] } });

    const followup: ChatMessage = { action: "chat", contextKey: "url:https://x", context: { title: "非视频" } };
    const result = slot.settle(followup);

    expect(result.ok).toBe(true);
    expect(followup.context!.subtitleBody).toEqual([]);
  });
});
