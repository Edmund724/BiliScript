import { describe, expect, it, vi } from "vitest";
import { buildSettingsHtml } from "../../extension/ui/settings-panel-html.js";
import { collectElements, debounce } from "../../extension/ui/settings/elements.js";

describe("settings/elements", () => {
  it("collectElements 在缺少模板必填节点时抛出包含节点 ID 的错误", () => {
    const host = document.createElement("div");
    host.innerHTML = buildSettingsHtml();
    host.querySelector("#biliscriptSettingsStatus")?.remove();

    expect(() => collectElements(host)).toThrow(/#biliscriptSettingsStatus/);
  });

  it("debounce 支持泛型参数透传、cancel 取消与 flush 立即触发", () => {
    vi.useFakeTimers();
    const calls: Array<[string, number]> = [];
    const fn = debounce((label: string, count: number) => {
      calls.push([label, count]);
    }, 100);

    fn("first", 1);
    fn("second", 2);
    expect(calls).toEqual([]);

    vi.advanceTimersByTime(99);
    expect(calls).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(calls).toEqual([["second", 2]]);

    fn("cancelled", 3);
    fn.cancel();
    vi.advanceTimersByTime(200);
    expect(calls).toEqual([["second", 2]]);

    fn("flushed", 4);
    fn.flush();
    expect(calls).toEqual([
      ["second", 2],
      ["flushed", 4]
    ]);
    vi.advanceTimersByTime(200);
    expect(calls).toHaveLength(2);
    vi.useRealTimers();
  });
});
