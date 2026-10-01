// provider-family.js 搜索族行声明契约（候选 3 片 1 自 options-search-rows.js
// 收敛）：行渲染（Key 状态点三态 / 名称 / 额度形态徽章 / 预设 note 副行 /
// 选用 radio / 编辑 / 删除）、radio change 即时持久化 activeSearchProviderId、
// 删除报文 search-providers-delete。shared/messaging.js 整体 mock，避免拖入
// content script 依赖图。
//
// 免 Key（spec §6.1/§6.2/§6.3）：
// - 状态点第三态 keyless（判据 = f(preset.access, hasSavedKey)），free-quota
//   无 Key 恒 missing；
// - 徽章「免 Key」×4 / 「免费额度」×2 挂在行内名字之后，free-quota 有 Key 时
//   徽章不消失；副行仍只放 preset.note；
// - CSS 复用既有变量，不新增颜色。

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { SEARCH_PROVIDER_PRESETS } from "../../extension/core/presets.js";
import { createProviderFamilyRows } from "../../extension/ui/provider-family.js";

const { sendRuntimeMessageMock } = vi.hoisted(() => ({
  sendRuntimeMessageMock: vi.fn(async () => ({ ok: true }))
}));

vi.mock("../../extension/shared/messaging.js", () => ({
  sendRuntimeMessage: sendRuntimeMessageMock
}));

// 组合点工厂创建行绑定（与 settings-panel 同款接线）；搜索族的编辑回调
// 转发由 provider-row.test.ts 的 AI/ASR 用例守住同一工厂路径
const bindings = createProviderFamilyRows({ onRowEdit: () => {} });

function makeContainer() {
  document.body.innerHTML = '<div id="biliscript-reading-view"><section id="biliscript-reading-settings-panel"></section></div>';
  const listNode = document.createElement("div");
  const emptyNode = document.createElement("p");
  document.getElementById("biliscript-reading-view")!.append(listNode, emptyNode);
  return { listNode, emptyNode };
}

function fireChange(el: Element) {
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

// 六预设成员各一行（table order = 回退链顺序），hasSavedKey 默认 false
const ITEMS = [
  { id: "search_firecrawl", presetId: "firecrawl", name: "Firecrawl", type: "firecrawl", baseUrl: "https://api.firecrawl.dev", hasSavedKey: false },
  { id: "search_tavily", presetId: "tavily", name: "Tavily", type: "tavily", baseUrl: "https://api.tavily.com", hasSavedKey: false },
  { id: "search_doubao", presetId: "doubao", name: "豆包", type: "doubao", baseUrl: "https://open.feedcoopapi.com", hasSavedKey: false },
  { id: "search_anysearch", presetId: "anysearch", name: "AnySearch", type: "anysearch", baseUrl: "https://api.anysearch.com", hasSavedKey: false },
  { id: "search_parallel", presetId: "parallel", name: "Parallel", type: "parallel", baseUrl: "https://search.parallel.ai", hasSavedKey: false },
  { id: "search_exa", presetId: "exa", name: "Exa", type: "exa", baseUrl: "https://api.exa.ai", hasSavedKey: false }
];

function renderPresets(listNode: HTMLElement, emptyNode: HTMLElement, items: typeof ITEMS) {
  bindings.search.render(listNode, emptyNode, items, { presets: SEARCH_PROVIDER_PRESETS, activeId: "" });
  return Array.from(listNode.querySelectorAll<HTMLElement>(".search-provider-row"));
}

function dotOf(row: HTMLElement): HTMLElement {
  return row.querySelector<HTMLElement>(".provider-row-dot")!;
}

beforeEach(() => {
  resetModuleState();
  sendRuntimeMessageMock.mockClear();
});

describe("搜索平台行（provider-family.js 的搜索族声明）", () => {
  it("渲染主行 + 预设 note 副行（Exa 免费额度提示），无 note 的行无副行", () => {
    const { listNode, emptyNode } = makeContainer();
    const rows = renderPresets(listNode, emptyNode, ITEMS);
    expect(rows).toHaveLength(6);
    expect(rows[0].querySelector(".provider-row-name")!.textContent).toBe("Firecrawl");
    expect(rows[0].querySelector(".provider-row-model")).toBeNull();
    expect(rows[2].querySelector(".provider-row-model")!.textContent).toContain("每月 500 次免费（需在火山控制台申请 Key）");
    expect(rows[5].querySelector(".provider-row-model")!.textContent).toContain("每月 $10 赠送额度（新账户另赠 $10）");
    expect(emptyNode.hidden).toBe(true);
  });

  it("空列表显示空态", () => {
    const { listNode, emptyNode } = makeContainer();
    bindings.search.render(listNode, emptyNode, [], { presets: SEARCH_PROVIDER_PRESETS, activeId: "" });
    expect(listNode.children).toHaveLength(0);
    expect(emptyNode.hidden).toBe(false);
  });

  it("选用 radio change 即时持久化 activeSearchProviderId 并同步选中态", async () => {
    const { listNode, emptyNode } = makeContainer();
    bindings.search.render(listNode, emptyNode, ITEMS, { presets: SEARCH_PROVIDER_PRESETS, activeId: "" });
    const radios = listNode.querySelectorAll<HTMLInputElement>(".search-provider-active-radio");
    radios[1].checked = true;
    fireChange(radios[1]);
    await vi.waitFor(() => {
      expect(sendRuntimeMessageMock).toHaveBeenCalledWith({
        type: "save-settings",
        settings: { activeSearchProviderId: "search_tavily" }
      });
    });
    expect(radios[1].checked).toBe(true);
    expect(bindings.search.getActiveId!(listNode)).toBe("search_tavily");
  });
});

describe("搜索平台行：Key 状态点第三态（spec §6.1）", () => {
  it("keyless 无 Key → data-state=keyless + title「免 Key 可用」；有 Key → saved", () => {
    const { listNode, emptyNode } = makeContainer();
    const rows = renderPresets(listNode, emptyNode, [
      { ...ITEMS[0], hasSavedKey: false },
      { ...ITEMS[0], id: "search_firecrawl_keyed", hasSavedKey: true }
    ]);
    expect(dotOf(rows[0]).dataset.state).toBe("keyless");
    expect(dotOf(rows[0]).title).toBe("免 Key 可用");
    expect(dotOf(rows[1]).dataset.state).toBe("saved");
    expect(dotOf(rows[1]).title).toBe("已保存 API Key");
  });

  it("free-quota 无 Key 恒 missing（不享第三态）；有 Key → saved", () => {
    const { listNode, emptyNode } = makeContainer();
    const rows = renderPresets(listNode, emptyNode, [
      { ...ITEMS[2], hasSavedKey: false },
      { ...ITEMS[5], hasSavedKey: false },
      { ...ITEMS[2], id: "search_doubao_keyed", hasSavedKey: true }
    ]);
    expect(dotOf(rows[0]).dataset.state).toBe("missing");
    expect(dotOf(rows[0]).title).toBe("未保存 API Key");
    expect(dotOf(rows[1]).dataset.state).toBe("missing");
    expect(dotOf(rows[2]).dataset.state).toBe("saved");
  });
});

describe("搜索平台行：额度形态徽章（spec §6.2）", () => {
  it("徽章挂行内名字之后：免 Key ×4、免费额度 ×2", () => {
    const { listNode, emptyNode } = makeContainer();
    const rows = renderPresets(listNode, emptyNode, ITEMS);
    const expected = ["免 Key", "免 Key", "免费额度", "免 Key", "免 Key", "免费额度"];
    rows.forEach((row, index) => {
      const name = row.querySelector(".provider-row-name")!;
      const badge = name.nextElementSibling as HTMLElement | null;
      expect(badge?.classList.contains("provider-row-badge"), `第 ${index} 行徽章未紧随名字`).toBe(true);
      expect(badge!.textContent).toBe(expected[index]);
    });
  });

  it("徽章与「选用 / 编辑」同排（行内），不新开一行；副行仍只放 preset.note", () => {
    const { listNode, emptyNode } = makeContainer();
    const rows = renderPresets(listNode, emptyNode, ITEMS);
    const row = rows[5]; // Exa：有 note，free-quota
    const line = row.querySelector(".provider-row-line")!;
    expect(line.querySelector(".provider-row-badge")!.textContent).toBe("免费额度");
    expect(line.querySelector(".search-provider-active-radio")).toBeTruthy();
    expect(line.querySelector(".provider-row-edit")).toBeTruthy();
    // 徽章在 radio 与编辑按钮之前（紧随名字）
    const badgeOrder = Array.from(line.children).indexOf(line.querySelector<HTMLElement>(".provider-row-badge")!);
    expect(badgeOrder).toBeGreaterThan(Array.from(line.children).indexOf(line.querySelector<HTMLElement>(".provider-row-name")!));
    expect(line.nextElementSibling!.classList.contains("provider-row-model")).toBe(true);
    expect(line.nextElementSibling!.querySelector(".provider-row-badge")).toBeNull();
  });

  it("keyless 已配 Key → 徽章改「自带 Key」，不再自称「免 Key」", () => {
    const { listNode, emptyNode } = makeContainer();
    const rows = renderPresets(listNode, emptyNode, [
      { ...ITEMS[1], hasSavedKey: true },
      { ...ITEMS[1], id: "search_tavily_keyless", hasSavedKey: false }
    ]);
    expect(rows[0].querySelector(".provider-row-badge")!.textContent).toBe("自带 Key");
    expect(rows[1].querySelector(".provider-row-badge")!.textContent).toBe("免 Key");
  });

  it("free-quota 有 Key 时徽章不消失（徽章讲额度形态，不讲是否已配）", () => {
    const { listNode, emptyNode } = makeContainer();
    const rows = renderPresets(listNode, emptyNode, [
      { ...ITEMS[5], hasSavedKey: true },
      { ...ITEMS[2], hasSavedKey: true }
    ]);
    expect(rows[0].querySelector(".provider-row-badge")!.textContent).toBe("免费额度");
    expect(dotOf(rows[0]).dataset.state).toBe("saved");
    expect(rows[1].querySelector(".provider-row-badge")!.textContent).toBe("免费额度");
  });
});

describe("搜索平台行：状态点与徽章的样式（spec §6.1/§6.2）", () => {
  function readCss(): string {
    return readFileSync("extension/entry/styles/reader-settings-rows.css", "utf8");
  }

  it('[data-state="keyless"] 复用既有 success 变量，不新增颜色', () => {
    const css = readCss();
    const rule = /\[data-state="keyless"\]\s*\{([^}]*)\}/.exec(css);
    expect(rule, "CSS 缺 [data-state=\"keyless\"] 规则").toBeTruthy();
    const body = rule![1];
    expect(body).toContain("var(--biliscript-reader-success)");
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });

  it("徽章规则用既有变量、flex: 0 0 auto，不新增颜色", () => {
    const css = readCss();
    const rule = /\.provider-row-badge\s*\{([^}]*)\}/.exec(css);
    expect(rule, "CSS 缺 .provider-row-badge 规则").toBeTruthy();
    const body = rule![1];
    expect(body).toContain("flex: 0 0 auto");
    expect(body).toContain("var(--biliscript-reader-");
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });
});
