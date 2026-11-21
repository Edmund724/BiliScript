import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import type { CreateReaderChatFeedbackDeps } from "../../extension/reader/chat-notices.js";

let createReaderChatFeedback: typeof import("../../extension/reader/chat-notices.js").createReaderChatFeedback;

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  const module = await import("../../extension/reader/chat-notices.js");
  createReaderChatFeedback = module.createReaderChatFeedback;
});

function makeHarness() {
  const messages = document.createElement("div");
  const inputCard = document.createElement("div");
  document.body.append(messages, inputCard);
  interface InjectedTimer {
    id: number;
    fn: () => void;
    ms: number;
    cleared: boolean;
  }
  const timers: InjectedTimer[] = [];
  let timerSeq = 0;
  const suggestions = {
    render: vi.fn(),
    clear: vi.fn(),
    isPresent: vi.fn(() => true)
  };
  const deps = {
    messages,
    inputCard,
    setTimer: vi.fn((fn: () => void, ms: number) => {
      const handle: InjectedTimer = { id: ++timerSeq, fn, ms, cleared: false };
      timers.push(handle);
      return handle;
    }),
    clearTimer: vi.fn((handle: InjectedTimer) => {
      handle.cleared = true;
      const index = timers.indexOf(handle);
      if (index >= 0) {
        timers.splice(index, 1);
      }
    }),
    scrollToBottom: vi.fn(),
    suggestions,
    onOpenSettings: vi.fn()
  };
  const feedback = createReaderChatFeedback(deps as unknown as CreateReaderChatFeedbackDeps);
  const fireTimers = () => {
    [...timers].forEach((timer) => timer.fn());
  };
  return { messages, inputCard, deps, feedback, timers, fireTimers, suggestions };
}

describe("showConversationContextNotice / removeConversationContextNotice", () => {
  it("追加通知条到消息区顶部，文本走 textContent（HTML 不被解析）", () => {
    const { messages, feedback } = makeHarness();

    feedback.showConversationContextNotice("<b>加粗</b>", 0);

    const notice = messages.querySelector(".chat-context-notice")!;
    expect(notice).not.toBeNull();
    expect(notice.textContent).toBe("<b>加粗</b>");
    expect(notice.querySelector("b")).toBeNull();
  });

  it("重复显示去重：旧通知条先移除", () => {
    const { messages, feedback } = makeHarness();

    feedback.showConversationContextNotice("第一条", 0);
    feedback.showConversationContextNotice("第二条", 0);

    const notices = messages.querySelectorAll(".chat-context-notice");
    expect(notices).toHaveLength(1);
    expect(notices[0].textContent).toBe("第二条");
  });

  it("autoHideMs > 0：挂自动消失定时器，触发后通知条移除", () => {
    const { messages, feedback, timers, deps, fireTimers } = makeHarness();

    feedback.showConversationContextNotice("会自动消失", 4000);

    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(4000);

    fireTimers();
    expect(deps.clearTimer).toHaveBeenCalledTimes(1);
    expect(messages.querySelector(".chat-context-notice")).toBeNull();
    expect(timers).toHaveLength(0);
  });

  it("autoHideMs 之前手动 remove：挂起定时器被取消", () => {
    const { messages, feedback, timers, deps } = makeHarness();

    feedback.showConversationContextNotice("先手动移除", 4000);
    feedback.removeConversationContextNotice();

    expect(deps.clearTimer).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(0);
    expect(messages.querySelector(".chat-context-notice")).toBeNull();
  });

  it("openSettingsAction：附「前往设置」链接，点击触发 onOpenSettings 回调", () => {
    const { feedback, messages, deps } = makeHarness();

    feedback.showConversationContextNotice("需要配置", 0, { openSettingsAction: true });

    const link = messages.querySelector(".chat-context-notice a")!;
    expect(link).not.toBeNull();
    expect(link.textContent).toBe("前往设置");
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(deps.onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("openSettingsAction 带目标：点击回传设置分区（ASR 配置类拦截直达 ASR 设置，票 04）", () => {
    const { feedback, messages, deps } = makeHarness();

    feedback.showConversationContextNotice("需要配置", 0, { openSettingsAction: true, settingsTarget: "asr" });

    messages
      .querySelector(".chat-context-notice a")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(deps.onOpenSettings).toHaveBeenCalledWith("asr");
  });

  it("spinner：插入加载动画 span 在文案最前（aria-hidden 空元素，不改文本）", () => {
    const { feedback, messages } = makeHarness();

    feedback.showConversationContextNotice("正在抓取字幕…", 0, { spinner: true });

    const notice = messages.querySelector(".chat-context-notice")!;
    const spinner = notice.querySelector(".chat-notice-spinner")!;
    expect(spinner).not.toBeNull();
    expect(spinner.getAttribute("aria-hidden")).toBe("true");
    expect(spinner.textContent).toBe("");
    expect(notice.firstChild).toBe(spinner);
    expect(notice.textContent).toBe("正在抓取字幕…");
  });

  it("spinner + openSettingsAction 同用：span 最前、链接照旧在末尾", () => {
    const { feedback, messages } = makeHarness();

    feedback.showConversationContextNotice("需要配置", 0, { openSettingsAction: true, spinner: true });

    const notice = messages.querySelector(".chat-context-notice")!;
    expect(notice.firstChild).toBe(notice.querySelector(".chat-notice-spinner"));
    const link = notice.querySelector("a")!;
    expect(link.textContent).toBe("前往设置");
    expect(notice.lastChild).toBe(link);
  });

  it("缺省不插 spinner（普通通知条保持纯文本节点）", () => {
    const { feedback, messages } = makeHarness();

    feedback.showConversationContextNotice("普通提示", 0);

    const notice = messages.querySelector(".chat-context-notice")!;
    expect(notice.querySelector(".chat-notice-spinner")).toBeNull();
  });

  it("输入区拦截卡：同时渲染自定义动作与前往设置，点击分别执行", () => {
    const { feedback, messages, inputCard, deps } = makeHarness();
    const onRetry = vi.fn();

    feedback.showConversationContextNotice("当前视频无字幕", 0, {
      placement: "input",
      action: { label: "重新抓取", onClick: onRetry },
      openSettingsAction: true,
      settingsTarget: "asr"
    });

    const notice = inputCard.querySelector<HTMLElement>(".chat-context-notice")!;
    expect(messages.querySelector(".chat-context-notice")).toBeNull();
    expect(notice.getAttribute("role")).toBe("alert");
    const links = notice.querySelectorAll("a");
    expect([...links].map((link) => link.textContent)).toEqual(["重新抓取", "前往设置"]);
    links[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    links[1].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(deps.onOpenSettings).toHaveBeenCalledWith("asr");

    feedback.removeConversationContextNotice();
    expect(inputCard.querySelector(".chat-context-notice")).toBeNull();
  });

  it("tone=success + dismissible=true：挂载成功态修饰与可关闭按钮", () => {
    const { feedback, messages } = makeHarness();

    feedback.showConversationContextNotice("平台已就绪，请确认发送。", 0, {
      tone: "success",
      dismissible: true
    });

    const notice = messages.querySelector<HTMLElement>(".chat-context-notice")!;
    expect(notice.classList.contains("is-success")).toBe(true);
    expect(notice.textContent).toContain("平台已就绪，请确认发送。");
    const closeBtn = notice.querySelector<HTMLButtonElement>(".chat-notice-close")!;
    expect(closeBtn).not.toBeNull();
    closeBtn.click();
    expect(messages.querySelector(".chat-context-notice")).toBeNull();
  });

  it("messages 与 input 槽隔离；removePersistentContextNotice 仅清无动作非成功常驻等待提示", () => {
    const { feedback, messages, inputCard } = makeHarness();

    feedback.showConversationContextNotice("临时 toast", 4000);
    feedback.showConversationContextNotice("输入框提示", 4000, { placement: "input" });
    expect(messages.querySelector(".chat-context-notice")?.textContent).toBe("临时 toast");
    expect(inputCard.querySelector(".chat-context-notice")?.textContent).toBe("输入框提示");

    feedback.removePersistentContextNotice();
    expect(messages.querySelector(".chat-context-notice")).not.toBeNull();
    expect(inputCard.querySelector(".chat-context-notice")).not.toBeNull();

    feedback.showConversationContextNotice("模型响应较慢，请稍候…", 0);
    feedback.removePersistentContextNotice();
    expect(messages.querySelector(".chat-context-notice")).toBeNull();
    expect(inputCard.querySelector(".chat-context-notice")).not.toBeNull();

    feedback.showConversationContextNotice("平台已就绪，请确认发送。", 0, { tone: "success" });
    feedback.removePersistentContextNotice();
    expect(messages.querySelector(".chat-context-notice")).not.toBeNull();

    feedback.removeConversationContextNotice();
    expect(messages.querySelector(".chat-context-notice")).toBeNull();
    expect(inputCard.querySelector(".chat-context-notice")).toBeNull();
  });
});

describe("showConversationContextError / removeCenteredState", () => {
  it("空文案 no-op：不追加节点也不滚动", () => {
    const { messages, feedback, deps } = makeHarness();

    feedback.showConversationContextError("   ");

    expect(messages.children).toHaveLength(0);
    expect(deps.scrollToBottom).not.toHaveBeenCalled();
  });

  it("追加居中错误块并滚动到底；先清既有通知条与居中块", () => {
    const { messages, feedback, deps } = makeHarness();
    feedback.showConversationContextNotice("旧通知", 0);

    feedback.showConversationContextError("读取失败");

    expect(messages.querySelectorAll(".chat-context-notice")).toHaveLength(0);
    const error = messages.querySelector(".chat-center-error")!;
    expect(error.textContent).toBe("读取失败");
    expect(deps.scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("removeCenteredState 只清居中块", () => {
    const { messages, feedback } = makeHarness();
    feedback.showConversationContextError("错误一");

    feedback.removeCenteredState();

    expect(messages.querySelectorAll(".chat-center-error")).toHaveLength(0);
  });
});

describe("removeSuggestions / isMessagesNearBottom", () => {
  it("removeSuggestions：调建议区属主的 clear（本模块不持建议区节点）", () => {
    const { feedback, suggestions } = makeHarness();

    feedback.removeSuggestions();

    expect(suggestions.clear).toHaveBeenCalledTimes(1);
  });

  it("isMessagesNearBottom：距底 <= 阈值（默认 56）为近底", () => {
    const { messages, feedback } = makeHarness();
    let scrollTopValue = 0;
    Object.defineProperty(messages, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value) => {
        scrollTopValue = value;
      }
    });
    Object.defineProperty(messages, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(messages, "clientHeight", { value: 900, configurable: true });

    expect(feedback.isMessagesNearBottom()).toBe(false);
    messages.scrollTop = 950;
    expect(feedback.isMessagesNearBottom()).toBe(true);
  });
});
