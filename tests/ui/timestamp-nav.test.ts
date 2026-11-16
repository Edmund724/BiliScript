// timestamp-nav 对话时间戳跳转测试（arch-slim-2/08）：
// parseTimestampToSeconds 已归一到 shared/clock-text.ts 的 parseClock（容错单源），
// 哨兵语义保留在本模块——解不出返回 0（与章节目录的 -1 哨兵不同）。本文件断言
// 两条哨兵/容错路径的端到端行为：非法时刻「99:99」按 0 秒跳转（原实现会换算成
// 6039 秒，归一后拒绝），合法「1:02」按 62 秒跳转。
// 跳转经注入的窄接口 deps.seek 进程内直调（content script 无 tab 消息链，
// reader/chat-tab.ts 的 getTimestampNavDeps 直接包 seekReadingTarget），
// seek 返回 null（未绑定到视频）时降级为失败 notice。

import { describe, expect, it, vi, afterEach } from "vitest";
import { linkifyAssistantTimestamps } from "../../extension/ui/timestamp-nav.js";
import { TIMESTAMP_PATTERN } from "../../extension/ui/markdown.js";

function makeDeps() {
  return {
    contextUrl: "https://www.bilibili.com/video/BV1test000000/",
    seek: vi.fn((seconds: number) => seconds),
    notice: vi.fn()
  };
}

function linkifyAndClick(text: string): void {
  const container = document.createElement("div");
  container.textContent = text;
  document.body.append(container);
  linkifyAssistantTimestamps(container, makeDeps());
  const button = container.querySelector<HTMLButtonElement>(".chat-timestamp-link");
  if (!button) {
    throw new Error(`未生成时间戳按钮：${text}`);
  }
  button.click();
  container.remove();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("对话时间戳跳转（parseClock 归一 + nav 哨兵 0）", () => {
  it("非法时刻 99:99：严口径拒绝，保持纯文本不生成跳转按钮", () => {
    const deps = makeDeps();
    const container = document.createElement("div");
    container.textContent = "99:99 这里";
    document.body.append(container);
    linkifyAssistantTimestamps(container, deps);
    const button = container.querySelector<HTMLButtonElement>(".chat-timestamp-link");
    expect(button).toBeNull();
    expect(container.textContent).toBe("99:99 这里");
    container.remove();
  });

  it("合法时刻 00:00：按 0 秒跳转并设置完整无障碍名称", async () => {
    const deps = makeDeps();
    const container = document.createElement("div");
    container.textContent = "00:00 开场";
    document.body.append(container);
    linkifyAssistantTimestamps(container, deps);
    const button = container.querySelector<HTMLButtonElement>(".chat-timestamp-link")!;
    expect(button).not.toBeNull();
    expect(button.getAttribute("aria-label")).toBe("跳转到视频 00:00");
    button.click();
    container.remove();

    await vi.waitFor(() => expect(deps.seek).toHaveBeenCalledTimes(1));
    expect(deps.seek).toHaveBeenCalledWith(0);
  });

  it("合法时刻 1:02：按 62 秒跳转", async () => {
    const deps = makeDeps();
    const container = document.createElement("div");
    container.textContent = "1:02 这里";
    document.body.append(container);
    linkifyAssistantTimestamps(container, deps);
    const button = container.querySelector<HTMLButtonElement>(".chat-timestamp-link");
    expect(button).not.toBeNull();
    button!.click();
    container.remove();

    await vi.waitFor(() => expect(deps.seek).toHaveBeenCalledTimes(1));
    expect(deps.seek).toHaveBeenCalledWith(62);
  });

  it("seek 返回 null（reader 域内未绑定到视频）：降级为失败 notice", async () => {
    const deps = { ...makeDeps(), seek: vi.fn(() => null) };
    const container = document.createElement("div");
    container.textContent = "1:02 这里";
    document.body.append(container);
    linkifyAssistantTimestamps(container, deps);
    const button = container.querySelector<HTMLButtonElement>(".chat-timestamp-link");
    expect(button).not.toBeNull();
    button!.click();
    container.remove();

    await vi.waitFor(() =>
      expect(deps.notice).toHaveBeenCalledWith("时间跳转失败：视频时间跳转失败", 2600)
    );
    expect(deps.seek).toHaveBeenCalledWith(62);
  });

  it("isContextValid 返回 false 时拒绝跳转并给出跨视频提示", async () => {
    const deps = { ...makeDeps(), isContextValid: () => false };
    const container = document.createElement("div");
    container.textContent = "1:02 这里";
    document.body.append(container);
    linkifyAssistantTimestamps(container, deps);
    container.querySelector<HTMLButtonElement>(".chat-timestamp-link")!.click();
    container.remove();

    await vi.waitFor(() =>
      expect(deps.notice).toHaveBeenCalledWith("当前播放页与该对话所属视频不一致，无法跳转进度。", 2600)
    );
    expect(deps.seek).not.toHaveBeenCalled();
  });
});
