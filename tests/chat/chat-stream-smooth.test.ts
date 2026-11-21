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

    turn.appendToken("一二三四五六");
    expect(rafCallbacks).toHaveLength(1);

    const assistantEl = deps.messages.querySelector<HTMLElement>(".chat-msg-assistant")!;
    expect(assistantEl).toBeTruthy();

    const frame1 = rafCallbacks.shift()!;
    await frame1();
    expect(assistantEl.textContent).toContain("一二");
    expect(assistantEl.textContent).not.toContain("三");
    expect(assistantEl.querySelector(".chat-msg-cursor")).toBeTruthy();
    expect(rafCallbacks).toHaveLength(1);

    const frame2 = rafCallbacks.shift()!;
    await frame2();
    expect(assistantEl.textContent).toContain("一二三四");
    expect(assistantEl.textContent).not.toContain("五");
    expect(assistantEl.querySelector(".chat-msg-cursor")).toBeTruthy();
    expect(rafCallbacks).toHaveLength(1);

    const frame3 = rafCallbacks.shift()!;
    await frame3();
    expect(assistantEl.textContent).toContain("一二三四五六");
    expect(assistantEl.querySelector(".chat-msg-cursor")).toBeTruthy();
    expect(rafCallbacks).toHaveLength(0);
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

    const burstText = "A".repeat(50);
    turn.appendToken(burstText);

    const assistantEl = deps.messages.querySelector<HTMLElement>(".chat-msg-assistant")!;

    const frame1 = rafCallbacks.shift()!;
    await frame1();
    const tailEl = assistantEl.querySelector(".chat-stream-tail")!;
    expect(tailEl.textContent?.replace(/\s+/g, "")).toHaveLength(10);
    expect(rafCallbacks).toHaveLength(1);

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
    const frame1 = rafCallbacks.shift()!;
    await frame1();

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

    turn.reset();

    const assistantEl = deps.messages.querySelector<HTMLElement>(".chat-msg-assistant")!;
    expect(assistantEl.querySelector(".chat-stream-tail")).toBeNull();
    expect(assistantEl.querySelector(".chat-stream-stable")).toBeNull();

    const staleFrame = rafCallbacks.shift()!;
    await staleFrame();
    expect(assistantEl.querySelector(".chat-stream-tail")).toBeNull();
  });
});
