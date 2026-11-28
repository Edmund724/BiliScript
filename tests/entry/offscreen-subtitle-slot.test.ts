import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MAX_SUBTITLE_SLOT_BYTES,
  estimateSubtitleBodyBytes,
  SUBTITLE_BODY_MISSING_CODE,
  SUBTITLE_BODY_MISSING_MESSAGE,
  SUBTITLE_ITEM_OVERHEAD_BYTES,
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
    expect(slot.settle({ action: "chat", contextKey: "video:A|1", context: {} }).ok).toBe(true);
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
    slot.settle({ action: "chat", contextKey: "video:B|2", context: { subtitleBody: bodyB } });

    expect(slot.settle({ action: "chat", contextKey: "video:A|1", context: {} }).ok).toBe(false);
    const hitB: ChatMessage = { action: "chat", contextKey: "video:B|2", context: {} };
    expect(slot.settle(hitB).ok).toBe(true);
    expect(hitB.context!.subtitleBody).toBe(bodyB);

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

  it("默认字节上限为 16 MB，超过 maxTotalBytes 时按 LRU 淘汰并保底保留当次超大条目", () => {
    expect(DEFAULT_MAX_SUBTITLE_SLOT_BYTES).toBe(16 * 1024 * 1024);

    const bodyA = Array.from({ length: 4 }, (_, i) => ({ from: i, to: i + 1, content: "a" }));
    const bodyB = Array.from({ length: 4 }, (_, i) => ({ from: i, to: i + 1, content: "b" }));
    const bodyHuge = Array.from({ length: 10 }, (_, i) => ({ from: i, to: i + 1, content: "x" }));
    const singleBytes = 4 * (SUBTITLE_ITEM_OVERHEAD_BYTES + 2);
    expect(estimateSubtitleBodyBytes(bodyA)).toBe(singleBytes);

    const slot = createSubtitleBodySlot({
      maxEntries: 8,
      maxTotalChars: 100_000,
      maxTotalBytes: singleBytes + 10
    });

    slot.settle({ action: "chat", contextKey: "video:A|1", context: { subtitleBody: bodyA } });
    slot.settle({ action: "chat", contextKey: "video:B|2", context: { subtitleBody: bodyB } });

    expect(slot.settle({ action: "chat", contextKey: "video:A|1", context: {} }).ok).toBe(false);
    const hitB: ChatMessage = { action: "chat", contextKey: "video:B|2", context: {} };
    expect(slot.settle(hitB).ok).toBe(true);
    expect(hitB.context!.subtitleBody).toBe(bodyB);

    slot.settle({ action: "chat", contextKey: "video:HUGE|3", context: { subtitleBody: bodyHuge } });
    expect(slot.settle({ action: "chat", contextKey: "video:B|2", context: {} }).ok).toBe(false);
    const hitHuge: ChatMessage = { action: "chat", contextKey: "video:HUGE|3", context: {} };
    expect(slot.settle(hitHuge).ok).toBe(true);
    expect(hitHuge.context!.subtitleBody).toBe(bodyHuge);
  });

  it("同 key 覆盖写入时扣减旧字节数，不触发误淘汰", () => {
    const bodyALarge = Array.from({ length: 4 }, (_, i) => ({ from: i, to: i + 1, content: "12345" }));
    const bodyASmall = [{ from: 0, to: 1, content: "1" }];
    const bodyB = [{ from: 0, to: 1, content: "2" }];
    const maxTotalBytes = estimateSubtitleBodyBytes(bodyASmall) + estimateSubtitleBodyBytes(bodyB);

    const slot = createSubtitleBodySlot({ maxTotalBytes });
    slot.settle({ action: "chat", contextKey: "video:A|1", context: { subtitleBody: bodyALarge } });
    slot.settle({ action: "chat", contextKey: "video:A|1", context: { subtitleBody: bodyASmall } });
    slot.settle({ action: "chat", contextKey: "video:B|2", context: { subtitleBody: bodyB } });

    expect(slot.settle({ action: "chat", contextKey: "video:A|1", context: {} }).ok).toBe(true);
    expect(slot.settle({ action: "chat", contextKey: "video:B|2", context: {} }).ok).toBe(true);
  });

  it("触发 LRU 淘汰时通过 onEvict 回传被驱逐的 key，覆盖写入同 key 不触发", () => {
    const onEvict = vi.fn();
    const slot = createSubtitleBodySlot({ maxEntries: 2, onEvict });

    slot.settle({ action: "chat", contextKey: "video:A|1", context: { subtitleBody: [{ from: 0, to: 1, content: "A1" }] } });
    slot.settle({ action: "chat", contextKey: "video:A|1", context: { subtitleBody: [{ from: 0, to: 1, content: "A2" }] } });
    slot.settle({ action: "chat", contextKey: "video:B|2", context: { subtitleBody: [{ from: 0, to: 1, content: "B1" }] } });
    expect(onEvict).not.toHaveBeenCalled();

    slot.settle({ action: "chat", contextKey: "video:C|3", context: { subtitleBody: [{ from: 0, to: 1, content: "C1" }] } });
    expect(onEvict).toHaveBeenCalledTimes(1);
    expect(onEvict).toHaveBeenCalledWith("video:A|1");
  });
});
