// tests/ui/settings-panel-search.test.ts
// 设置抽屉搜索节的免 Key 批次③文案与悬空链首提示：
// - spec §6.9 / §10：说明行承载 opt-in 常驻版（同一套词）、空态改六预设；
// - spec §6.8：activeSearchProviderId 指向不存在记录时出现条件提示行
//   「原选用平台已不可用，当前按默认链搜索」，用户改选即消失、不新增存储位。
//
// 文案断言可直接构建模板；提示行需要真实挂载（loadSettings 的搜索节渲染）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { buildSettingsHtml } from "../../extension/ui/settings-panel-html.js";

type SentMessage = { type: string } & Record<string, any>;
type MessageResponder = (message: SentMessage) => unknown;

function chromeStub(): { runtime: { sendMessage: ReturnType<typeof vi.fn> } } {
  return chrome as unknown as { runtime: { sendMessage: ReturnType<typeof vi.fn> } };
}

function installMessageBus(overrides: Record<string, MessageResponder> = {}) {
  const responders: Record<string, MessageResponder> = {
    "get-settings": () => ({ ok: true, settings: {} }),
    "ai-presets-list": () => ({ ok: false }),
    "asr-presets-list": () => ({ ok: false }),
    "ai-providers-list": () => ({ ok: true, providers: [] }),
    "asr-providers-list": () => ({ ok: true, providers: [] }),
    "search-providers-list": () => ({ ok: true, providers: [] }),
    "save-settings": () => ({ ok: true }),
    ...overrides
  };
  const sent: SentMessage[] = [];
  chromeStub().runtime.sendMessage = vi.fn((message: SentMessage, callback?: (response?: unknown) => void) => {
    sent.push(message);
    const respond = responders[message.type];
    callback?.(respond ? respond(message) : { ok: true });
    return undefined;
  });
  return sent;
}

async function mountPanel(busOverrides: Record<string, MessageResponder> = {}) {
  document.body.innerHTML = `
    <div id="biliscript-reading-view">
      <section id="biliscript-reading-settings-panel">
        <div id="biliscript-reading-settings-host"></div>
      </section>
    </div>
  `;
  const sent = installMessageBus(busOverrides);
  const panel = await import("../../extension/ui/settings-panel.js");
  panel.renderReaderSettingsPanel();
  const host = document.getElementById("biliscript-reading-settings-host")!;
  await vi.waitFor(() => {
    expect(chromeStub().runtime.sendMessage.mock.calls.some(([message]) => message.type === "search-providers-list")).toBe(true);
  });
  return { sent, host };
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
});

describe("设置页搜索节文案（spec §6.9）", () => {
  const html = buildSettingsHtml();

  it("说明行 = function calling 说明 + opt-in 常驻版（同一套词）", () => {
    expect(html).toContain("function calling");
    expect(html).toContain(
      "联网搜索会把查询词发往内置的免 Key 服务（Tavily / Firecrawl / AnySearch / Parallel）以及你配置过 Key 的搜索平台；关闭搜索开关可随时撤回。"
    );
    expect(html).not.toContain("当前选用平台提供搜索结果");
  });

  it("空态 = 六预设 + 四条免 Key 装上即可用；添加按钮与次数上限文案不变", () => {
    expect(html).toContain(
      "还没有配置搜索平台。点击下方添加按钮从预设创建（Firecrawl / Tavily / 豆包 / AnySearch / Parallel / Exa）——四条免 Key 预设装上即可用。"
    );
    expect(html).not.toContain("Tavily / Exa / Brave");
    expect(html).toContain('id="addSearchProviderBtn"');
    expect(html).toContain("单轮搜索次数上限");
  });
});

describe("设置页搜索节：悬空链首提示行（spec §6.8）", () => {
  const ITEM = {
    id: "search_tavily",
    presetId: "tavily",
    name: "Tavily",
    type: "tavily",
    baseUrl: "https://api.tavily.com",
    enabled: true,
    hasSavedKey: false
  };

  it("activeSearchProviderId 指向不存在记录 → 提示行出现；用户改选即消失", async () => {
    const { host } = await mountPanel({
      "get-settings": () => ({ ok: true, settings: { activeSearchProviderId: "search_ghost" } }),
      "search-providers-list": () => ({ ok: true, providers: [ITEM] })
    });
    const hint = host.querySelector<HTMLElement>("#searchProvidersDanglingHint")!;
    expect(hint).toBeTruthy();
    await vi.waitFor(() => {
      expect(hint.hidden).toBe(false);
    });
    expect(hint.textContent).toBe("原选用平台已不可用，当前按默认链搜索");

    const radio = host.querySelector<HTMLInputElement>("#searchProvidersList .search-provider-active-radio")!;
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
    expect(hint.hidden).toBe(true);
  });

  it("activeSearchProviderId 指向存在的记录（或无链首）→ 提示行不出现", async () => {
    const { host } = await mountPanel({
      "get-settings": () => ({ ok: true, settings: { activeSearchProviderId: "search_tavily" } }),
      "search-providers-list": () => ({ ok: true, providers: [ITEM] })
    });
    const hint = host.querySelector<HTMLElement>("#searchProvidersDanglingHint")!;
    expect(hint.hidden).toBe(true);
  });
});
