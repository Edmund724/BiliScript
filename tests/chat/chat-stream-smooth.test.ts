// tests/chat/chat-stream-smooth.test.ts
// 前端平滑插值队列（RAF Buffer）契约测试。
//
// 失败方式清单（每条对应下方用例）：
//   1. 步长不平滑：低积压时单帧一次性吐完全部字符，失去平滑打字感。
//   2. 延迟越滚越大：大 chunk 突发积压时未动态自适应加速，导致队列长期排队。
//   3. 终态丢字：队列中仍有字符时触发 finish，未进入 DOM 的字符被直接丢弃。
//   4. 停止态丢字：队列中仍有字符时触发 stop，返回文本丢失待出字内容。
//   5. 状态重置残留：reset 后挂起的 RAF 回调仍继续执行或残留旧队列污染新流。
//   6. 光标脱落：插值期间每帧重构 tailEl 导致 .chat-msg-cursor 光标未接回。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatStreamRenderer } from "../../extension/chat/chat-stream-render.js";
import { normalizeMarkdownForSectionPaste } from "../../extension/notes/paste.js";

function makeDeps(smoothStream = true) {
  const messages = document.createElement("div");
  return {
    messages,
    normalizeMarkdownForSectionPaste,
    getTimestampNavDeps: () => ({}),
    smoothStream
  };
}

describe("前端平滑插值队列（RAF Buffer）", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("低积压时按 2 字符/帧平滑出字，且光标持续接回末尾", async () => {
    const rafCallbacks: Array<() => void> = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb as () => void);
      return rafCallbacks.length;
    });

    const deps = makeDeps(true);
    const renderer = createChatStreamRenderer(deps);
    const turn = renderer.messageArea.appendAssistantMessage();

    // 灌入 6 个字符
    turn.appendToken("一二三四五六");
    expect(rafCallbacks).toHaveLength(1);

    const assistantEl = deps.messages.querySelector<HTMLElement>(".chat-msg-assistant")!;
    expect(assistantEl).toBeTruthy();

    // 帧 1：应输出 2 个字符（一二）
    const frame1 = rafCallbacks.shift()!;
    await frame1();
    expect(assistantEl.textContent).toContain("一二");
    expect(assistantEl.textContent).not.toContain("三");
    expect(assistantEl.querySelector(".chat-msg-cursor")).toBeTruthy();
    expect(rafCallbacks).toHaveLength(1); // 自动调度帧 2

    // 帧 2：应追加 2 个字符（三四）
    const frame2 = rafCallbacks.shift()!;
    await frame2();
    expect(assistantEl.textContent).toContain("一二三四");
    expect(assistantEl.textContent).not.toContain("五");
    expect(assistantEl.querySelector(".chat-msg-cursor")).toBeTruthy();
    expect(rafCallbacks).toHaveLength(1); // 自动调度帧 3

    // 帧 3：应追加最后 2 个字符（五六）
    const frame3 = rafCallbacks.shift()!;
    await frame3();
    expect(assistantEl.textContent).toContain("一二三四五六");
    expect(assistantEl.querySelector(".chat-msg-cursor")).toBeTruthy();
    expect(rafCallbacks).toHaveLength(0); // 队列清空，停止调度
  });

  it("大 chunk 突发积压时自适应加速出字，避免延迟无限滚大", async () => {
    const rafCallbacks: Array<() => void> = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb as () => void);
      return rafCallbacks.length;
    });

    const deps = makeDeps(true);
    const renderer = createChatStreamRenderer(deps);
    const turn = renderer.messageArea.appendAssistantMessage();

    // 突发 50 字符
    const burstText = "A".repeat(50);
    turn.appendToken(burstText);

    const assistantEl = deps.messages.querySelector<HTMLElement>(".chat-msg-assistant")!;

    // 帧 1：50 / 5 = 10 字符
    const frame1 = rafCallbacks.shift()!;
    await frame1();
    // tailEl 内纯文本应恰好为 10 字符（不含光标）
    const tailEl = assistantEl.querySelector(".chat-stream-tail")!;
    expect(tailEl.textContent?.replace(/\s+/g, "")).toHaveLength(10);
    expect(rafCallbacks).toHaveLength(1);

    // 帧 2：余 40 字符，40 / 5 = 8 字符
    const frame2 = rafCallbacks.shift()!;
    await frame2();
    expect(tailEl.textContent?.replace(/\s+/g, "")).toHaveLength(18);
  });

  it("插值未完成时触发 finish()：无缝直出全量终态文本，零丢字", async () => {
    const rafCallbacks: Array<() => void> = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb as () => void);
      return rafCallbacks.length;
    });

    const deps = makeDeps(true);
    const renderer = createChatStreamRenderer(deps);
    const turn = renderer.messageArea.appendAssistantMessage();

    turn.appendToken("前面的字还没出完");
    // 只执行一帧（2 字符）
    const frame1 = rafCallbacks.shift()!;
    await frame1();

    // 此时立即 finish
    const finalized = turn.finish();
    expect(finalized).toBe("前面的字还没出完");

    const bodyEl = deps.messages.querySelector<HTMLElement>(".chat-msg-assistant-body")!;
    expect(bodyEl.textContent?.trim()).toBe("前面的字还没出完");
  });

  it("插值未完成时触发 stop()：返回包含全量待出字文本，零丢字", async () => {
    const rafCallbacks: Array<() => void> = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb as () => void);
      return rafCallbacks.length;
    });

    const deps = makeDeps(true);
    const renderer = createChatStreamRenderer(deps);
    const turn = renderer.messageArea.appendAssistantMessage();

    turn.appendToken("中途用户按了停止生成");
    const frame1 = rafCallbacks.shift()!;
    await frame1();

    const stopResult = turn.stop("用户中断");
    expect(stopResult.raw).toBe("中途用户按了停止生成");
    expect(deps.messages.querySelector(".chat-msg-stopped")?.textContent).toBe("用户中断");
  });

  it("插值期间 reset()：取消挂起帧，清空队列与流式容器", async () => {
    const rafCallbacks: Array<() => void> = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb as () => void);
      return rafCallbacks.length;
    });

    const deps = makeDeps(true);
    const renderer = createChatStreamRenderer(deps);
    const turn = renderer.messageArea.appendAssistantMessage();

    turn.appendToken("需要被重置的内容");
    expect(rafCallbacks).toHaveLength(1);

    // 重置流式
    turn.reset();

    const assistantEl = deps.messages.querySelector<HTMLElement>(".chat-msg-assistant")!;
    expect(assistantEl.querySelector(".chat-stream-tail")).toBeNull();
    expect(assistantEl.querySelector(".chat-stream-stable")).toBeNull();

    // 若旧回调在此后被执行，代际校验应阻断其渲染
    const staleFrame = rafCallbacks.shift()!;
    await staleFrame();
    expect(assistantEl.querySelector(".chat-stream-tail")).toBeNull();
  });
});
