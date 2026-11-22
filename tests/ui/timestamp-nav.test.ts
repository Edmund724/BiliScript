import { describe, expect, it, vi, afterEach } from "vitest";
import { findSubtitlePreviewAtTime, linkifyAssistantTimestamps } from "../../extension/ui/timestamp-nav.js";

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

  it("时间戳链接剥离外围括号 [04:12] / 【04:12】 并返回去重引用计数", () => {
    const deps = makeDeps();
    const container = document.createElement("div");
    container.textContent = "开场见 [04:12]，补充见 【04:12】 与 08:30。";
    document.body.append(container);

    const uniqueCount = linkifyAssistantTimestamps(container, deps);
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".chat-timestamp-link")];

    expect(uniqueCount).toBe(2);
    expect(buttons.map((btn) => btn.textContent)).toEqual(["04:12", "04:12", "08:30"]);
    expect(container.textContent).toBe("开场见 04:12，补充见 04:12 与 08:30。");
    container.remove();
  });

  it("悬停/聚焦时间戳胶囊弹出原字幕预览 Tooltip，支持悬停浮层保活与 Esc 关闭", () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    host.className = "chat-messages";
    const body = document.createElement("div");
    body.textContent = "重点论述见 [04:12]";
    host.appendChild(body);
    document.body.appendChild(host);

    const subtitles = [
      { from: 250, to: 255, content: "这里讲的是流式渲染防抖的核心思路" },
      { from: 256, to: 262, content: "避免高度剧烈跳动" }
    ];
    const deps = {
      ...makeDeps(),
      tooltipContainer: host,
      getSubtitlePreview: (seconds: number) => findSubtitlePreviewAtTime(subtitles, seconds)
    };
    linkifyAssistantTimestamps(body, deps);
    const btn = body.querySelector<HTMLButtonElement>(".chat-timestamp-link")!;
    expect(btn.getAttribute("title")).toBeNull();

    btn.dispatchEvent(new window.Event("mouseenter"));
    const tooltip = host.querySelector<HTMLElement>("[data-chat-timestamp-tooltip]")!;
    expect(tooltip).toBeTruthy();
    expect(tooltip.getAttribute("role")).toBe("tooltip");
    expect(btn.getAttribute("aria-describedby")).toBe(tooltip.id);
    expect(tooltip.querySelector(".chat-timestamp-tooltip-time")?.textContent).toBe("4:10");
    expect(tooltip.querySelector(".chat-timestamp-tooltip-text")?.textContent).toContain("流式渲染防抖");

    btn.dispatchEvent(new window.Event("mouseleave"));
    tooltip.dispatchEvent(new window.Event("mouseenter"));
    vi.advanceTimersByTime(300);
    expect(host.querySelector("[data-chat-timestamp-tooltip]")).toBe(tooltip);

    host.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(host.querySelector("[data-chat-timestamp-tooltip]")).toBeNull();
    expect(btn.getAttribute("aria-describedby")).toBeNull();

    btn.click();
    expect(deps.seek).toHaveBeenCalledWith(252);

    vi.useRealTimers();
    host.remove();
  });

  it("findSubtitlePreviewAtTime 支持精确区间命中、邻近匹配与短句拼接", () => {
    const subtitles = [
      { from: 10, to: 12, content: "短句一" },
      { from: 13, to: 18, content: "紧随其后的补充说明" },
      { from: 100, to: 105, content: "远处的另一段字幕" }
    ];
    expect(findSubtitlePreviewAtTime(subtitles, 11)).toEqual({
      time: "0:10",
      text: "短句一 紧随其后的补充说明"
    });
    expect(findSubtitlePreviewAtTime(subtitles, 96)).toEqual({
      time: "1:40",
      text: "远处的另一段字幕"
    });
    expect(findSubtitlePreviewAtTime(subtitles, 50)).toBeNull();
  });
});
