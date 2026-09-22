// options-search-rows.js 行构建器契约：行渲染（Key 状态点 / 名称 / 预设 note
// 副行 / 选用 radio / 编辑 / 删除）、radio change 即时持久化
// activeSearchProviderId、删除报文 search-providers-delete、编辑回调转发
// providerId。shared/messaging.js 整体 mock，避免拖入 content script 依赖图。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { SEARCH_PROVIDER_PRESETS } from "../../extension/core/presets.js";

const { sendRuntimeMessageMock } = vi.hoisted(() => ({
  sendRuntimeMessageMock: vi.fn(async () => ({ ok: true }))
}));

vi.mock("../../extension/shared/messaging.js", () => ({
  sendRuntimeMessage: sendRuntimeMessageMock
}));

import {
  getActiveSearchProviderId,
  renderSearchProviders,
  setActiveSearchProvider
} from "../../extension/ui/options-search-rows.js";

function makeContainer() {
  document.body.innerHTML = '<div id="boc-reading-view"><section id="boc-reading-settings-panel"></section></div>';
  const listNode = document.createElement("div");
  const emptyNode = document.createElement("p");
  document.getElementById("boc-reading-view")!.append(listNode, emptyNode);
  return { listNode, emptyNode };
}

function fireChange(el: Element) {
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

const ITEMS = [
  { id: "search_1", presetId: "tavily", name: "Tavily", type: "tavily", baseUrl: "https://api.tavily.com", hasSavedKey: true },
  { id: "search_2", presetId: "brave", name: "Brave Search", type: "brave", baseUrl: "https://api.search.brave.com", hasSavedKey: false }
];

beforeEach(() => {
  resetModuleState();
  sendRuntimeMessageMock.mockClear();
});

describe("搜索平台行", () => {
  it("渲染主行 + 预设 note 副行（Brave 免费计划提示），无 note 的行无副行", () => {
    const { listNode, emptyNode } = makeContainer();
    renderSearchProviders(listNode, emptyNode, ITEMS, { presets: SEARCH_PROVIDER_PRESETS, activeId: "search_1" });
    const rows = listNode.querySelectorAll(".search-provider-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".provider-row-name")!.textContent).toBe("Tavily");
    expect(rows[0].querySelector(".provider-row-model")).toBeNull();
    expect(rows[1].querySelector(".provider-row-model")!.textContent).toContain("免费计划需绑信用卡");
    expect(emptyNode.hidden).toBe(true);
  });

  it("空列表显示空态", () => {
    const { listNode, emptyNode } = makeContainer();
    renderSearchProviders(listNode, emptyNode, [], { presets: SEARCH_PROVIDER_PRESETS, activeId: "" });
    expect(listNode.children).toHaveLength(0);
    expect(emptyNode.hidden).toBe(false);
  });

  it("选用 radio change 即时持久化 activeSearchProviderId 并同步选中态", async () => {
    const { listNode, emptyNode } = makeContainer();
    renderSearchProviders(listNode, emptyNode, ITEMS, { presets: SEARCH_PROVIDER_PRESETS, activeId: "" });
    const radios = listNode.querySelectorAll<HTMLInputElement>(".search-provider-active-radio");
    radios[1].checked = true;
    fireChange(radios[1]);
    await vi.waitFor(() => {
      expect(sendRuntimeMessageMock).toHaveBeenCalledWith({
        type: "save-settings",
        settings: { activeSearchProviderId: "search_2" }
      });
    });
    expect(radios[1].checked).toBe(true);
  });

  it("setActiveSearchProvider 同步选中态到指定 id", () => {
    const { listNode, emptyNode } = makeContainer();
    renderSearchProviders(listNode, emptyNode, ITEMS, { presets: SEARCH_PROVIDER_PRESETS, activeId: "" });
    setActiveSearchProvider(listNode, "search_1");
    const radios = listNode.querySelectorAll<HTMLInputElement>(".search-provider-active-radio");
    expect(radios[0].checked).toBe(true);
    expect(getActiveSearchProviderId(listNode)).toBe("search_1");
  });
});
