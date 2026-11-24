import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { installSettingsPanelBus, type BusMessage, type BusResponder } from "../helpers/settings-panel-bus.js";
import { buildSettingsHtml } from "../../extension/ui/settings-panel-html.js";
import { renderReaderSettingsPanel } from "../../extension/ui/settings-panel.js";
import { flushMicrotasks, resetSettingsPanelState, waitForFast } from "../helpers/reset-settings-panel-state.js";

type SentMessage = BusMessage;
type MessageResponder = BusResponder<SentMessage>;

type SyncStorageMock = { get: Mock; set: Mock; remove: Mock };

function syncStorage(): SyncStorageMock {
  return (chrome as unknown as { storage: { sync: SyncStorageMock } }).storage.sync;
}

const SMART_ID = "__smart__";

const SEARCH_ITEMS = [
  { id: "search_firecrawl", presetId: "firecrawl", name: "Firecrawl", type: "firecrawl", baseUrl: "https://api.firecrawl.dev", enabled: true, hasSavedKey: false },
  { id: "search_tavily", presetId: "tavily", name: "Tavily", type: "tavily", baseUrl: "https://api.tavily.com", enabled: true, hasSavedKey: false },
  { id: "search_doubao", presetId: "doubao", name: "豆包", type: "doubao", baseUrl: "https://open.feedcoopapi.com", enabled: true, hasSavedKey: false },
  { id: "search_anysearch", presetId: "anysearch", name: "AnySearch", type: "anysearch", baseUrl: "https://api.anysearch.com", enabled: true, hasSavedKey: false },
  { id: "search_parallel", presetId: "parallel", name: "Parallel", type: "parallel", baseUrl: "https://search.parallel.ai", enabled: true, hasSavedKey: false },
  { id: "search_exa", presetId: "exa", name: "Exa", type: "exa", baseUrl: "https://api.exa.ai", enabled: true, hasSavedKey: false }
];

const DEFAULT_ORDER_IDS = [
  "search_exa",
  "search_doubao",
  "search_tavily",
  "search_firecrawl",
  "search_anysearch",
  "search_parallel"
];

function searchList(host: HTMLElement): HTMLElement {
  return host.querySelector<HTMLElement>("#searchProvidersList")!;
}

function recordRows(host: HTMLElement): HTMLElement[] {
  return Array.from(searchList(host).querySelectorAll<HTMLElement>(".search-provider-row")).filter(
    (row) => row.querySelector(".provider-row-drag-handle") !== null
  );
}
function recordRowIds(host: HTMLElement): string[] {
  return recordRows(host).map((row) => row.dataset.providerId || "");
}

function smartRow(host: HTMLElement): HTMLElement | null {
  return searchList(host).querySelector<HTMLElement>(`[data-provider-id="${SMART_ID}"]`);
}

function smartRadio(host: HTMLElement): HTMLInputElement {
  return smartRow(host)!.querySelector<HTMLInputElement>(".search-provider-active-radio")!;
}

function installRowRects(list: HTMLElement): void {
  list.querySelectorAll<HTMLElement>(".search-provider-row").forEach((row) => {
    row.getBoundingClientRect = () => {
      const index = Array.from(list.querySelectorAll(".search-provider-row")).indexOf(row);
      const top = index * 40;
      return {
        top,
        bottom: top + 40,
        height: 40,
        y: top,
        x: 0,
        left: 0,
        right: 100,
        width: 100,
        toJSON: () => ({})
      } as DOMRect;
    };
  });
}

function dragPointer(type: string, clientY: number): PointerEvent {
  return new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientY, pointerId: 1 });
}

function handleOf(host: HTMLElement, recordId: string): HTMLElement {
  return searchList(host).querySelector<HTMLElement>(
    `[data-provider-id="${recordId}"] .provider-row-drag-handle`
  )!;
}

async function waitForSearchRows(host: HTMLElement, count: number): Promise<void> {
  await waitForFast(() => {
    expect(recordRows(host)).toHaveLength(count);
  });
}

function chromeStub(): { runtime: { sendMessage: ReturnType<typeof vi.fn> } } {
  return chrome as unknown as { runtime: { sendMessage: ReturnType<typeof vi.fn> } };
}

function installMessageBus(overrides: Record<string, MessageResponder> = {}): SentMessage[] {
  return installSettingsPanelBus<SentMessage>({ ...overrides }).sent;
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
  await renderReaderSettingsPanel();
  const host = document.getElementById("biliscript-reading-settings-host")!;
  expect(chromeStub().runtime.sendMessage.mock.calls.some(([message]) => message.type === "search-providers-list")).toBe(true);
  return { sent, host };
}

beforeEach(() => {
  resetSettingsPanelState();
  const sync = syncStorage();
  sync.get.mockReset();
  sync.get.mockResolvedValue({});
  sync.set.mockReset();
  sync.set.mockResolvedValue(undefined);
  sync.remove.mockReset();
  sync.remove.mockResolvedValue(undefined);
});

describe("设置页搜索节文案（spec §6.9）", () => {
  const html = buildSettingsHtml();

  it("不再包含冗余的 function calling 与隐私常驻说明行", () => {
    expect(html).not.toContain("function calling");
    expect(html).not.toContain("内置的免 Key 服务");
    expect(html).not.toContain("当前选用平台提供搜索结果");
  });

  it("空态精简为暂无已配置平台；添加按钮与次数上限文案不变", () => {
    expect(html).toContain("暂无已配置平台");
    expect(html).not.toContain("点击下方添加按钮从预设创建");
    expect(html).toContain('id="addSearchProviderBtn"');
    expect(html).toContain("单轮搜索次数上限");
  });

  it("付费开关行（GLOSSARY「付费平台」）：默认关文案 + 开关壳结构在搜索节内", () => {
    expect(html).toContain("允许智能搜索使用付费平台");
    expect(html).toContain('id="allowPaidSearchProviders" type="checkbox" class="biliscript-toggle-input"');
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
    await waitForFast(() => {
      expect(hint.hidden).toBe(false);
    });
    expect(hint.textContent).toBe("原选用的平台已不可用，当前按默认顺序搜索");

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

  it("哨兵不算悬空（§12.1 / §10 第 82 行）：activeId = __smart__ → 提示行不出现", async () => {
    const { host } = await mountPanel({
      "get-settings": () => ({ ok: true, settings: { activeSearchProviderId: SMART_ID } }),
      "search-providers-list": () => ({ ok: true, providers: [ITEM] })
    });
    await waitForSearchRows(host, 1);
    expect(host.querySelector<HTMLElement>("#searchProvidersDanglingHint")!.hidden).toBe(true);
  });

  it("空串（存量未手选）不算悬空 → 提示行不出现", async () => {
    const { host } = await mountPanel({
      "get-settings": () => ({ ok: true, settings: { activeSearchProviderId: "" } }),
      "search-providers-list": () => ({ ok: true, providers: [ITEM] })
    });
    await waitForSearchRows(host, 1);
    expect(host.querySelector<HTMLElement>("#searchProvidersDanglingHint")!.hidden).toBe(true);
  });
});

describe("设置页搜索节：「智能」虚拟条目（spec §6.10 / §10 第 80 行）", () => {
  it("恒为列表首个子元素：记录行的行类 / 哨兵 id / 名字「智能」/ 副行说明 / 无把手 / 无编辑删除", async () => {
    const { host } = await mountPanel({
      "search-providers-list": () => ({ ok: true, providers: SEARCH_ITEMS })
    });
    await waitForSearchRows(host, 6);

    const list = searchList(host);
    const first = list.children[0] as HTMLElement;
    expect(first.dataset.providerId).toBe(SMART_ID);
    expect(first.classList.contains("search-provider-row")).toBe(true);
    expect(first.querySelector(".provider-row-name")!.textContent).toBe("智能");

    const model = first.querySelector<HTMLElement>(".provider-row-model")!;
    expect(model.textContent).toContain("按顺序回退");
    expect(model.textContent).toContain("跳过");

    expect(first.querySelector(".provider-row-drag-handle")).toBeNull();
    expect(first.querySelector(".provider-row-edit")).toBeNull();
    expect(first.querySelector(".provider-row-remove")).toBeNull();
    expect(first.querySelector(".provider-row-dot")).toBeNull();
    expect(first.querySelector(".provider-row-badge")).toBeNull();
    expect(first.querySelector(".search-provider-active-radio")).toBeTruthy();
  });

  it("零记录时智能行仍在（模式不是平台），空态文案照常显示", async () => {
    const { host } = await mountPanel({
      "search-providers-list": () => ({ ok: true, providers: [] })
    });
    await waitForFast(() => {
      expect(smartRow(host)).toBeTruthy();
    });
    expect(recordRowIds(host)).toEqual([]);
    expect(host.querySelector<HTMLElement>("#searchProvidersEmpty")!.hidden).toBe(false);
  });

  it("哨兵选中态渲染：activeId = __smart__ → 智能行 radio 选中、记录行全不选中", async () => {
    const { host } = await mountPanel({
      "get-settings": () => ({ ok: true, settings: { activeSearchProviderId: SMART_ID } }),
      "search-providers-list": () => ({ ok: true, providers: SEARCH_ITEMS })
    });
    await waitForSearchRows(host, 6);

    expect(smartRadio(host).checked).toBe(true);
    const recordRadios = recordRows(host).map(
      (row) => row.querySelector<HTMLInputElement>(".search-provider-active-radio")!
    );
    expect(recordRadios.some((radio) => radio.checked)).toBe(false);
  });

  it("选中智能行 → 即时持久化哨兵 activeSearchProviderId = __smart__", async () => {
    const { sent, host } = await mountPanel({
      "search-providers-list": () => ({ ok: true, providers: SEARCH_ITEMS })
    });
    await waitForSearchRows(host, 6);

    const radio = smartRadio(host);
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));

    await waitForFast(() => {
      expect(sent).toContainEqual({
        type: "save-settings",
        settings: { activeSearchProviderId: SMART_ID }
      });
    });
  });
});

describe("设置页搜索节：列表渲染顺序（spec §12.2 / 票 15 §6 第 61–65 行）", () => {
  it("自定义 order 优先，未入组记录按内置默认序排在其后", async () => {
    syncStorage().get.mockResolvedValue({ searchProviderOrder: ["search_tavily", "search_firecrawl"] });
    const { host } = await mountPanel({
      "search-providers-list": () => ({ ok: true, providers: SEARCH_ITEMS })
    });
    await waitForSearchRows(host, 6);

    expect(recordRowIds(host)).toEqual([
      "search_tavily",
      "search_firecrawl",
      "search_exa",
      "search_doubao",
      "search_anysearch",
      "search_parallel"
    ]);
  });

  it("无自定义顺序 → 全部按内置默认序（不是后端 / 预设表序）", async () => {
    const { host } = await mountPanel({
      "search-providers-list": () => ({ ok: true, providers: SEARCH_ITEMS })
    });
    await waitForSearchRows(host, 6);

    expect(recordRowIds(host)).toEqual(DEFAULT_ORDER_IDS);
  });

  it("脏 order（未知 id / 非数组 / 重复 id / 元素非字符串）整体作废 → 内置默认序，渲染不炸", async () => {
    const dirtyValues: unknown[] = [["search_ghost"], "nope", ["search_tavily", "search_tavily"], ["search_tavily", 7]];
    for (const dirty of dirtyValues) {
      syncStorage().get.mockResolvedValue({ searchProviderOrder: dirty });
      const { host } = await mountPanel({
        "search-providers-list": () => ({ ok: true, providers: SEARCH_ITEMS })
      });
      await waitForSearchRows(host, 6);
      expect(recordRowIds(host), `脏值 ${JSON.stringify(dirty)} 应整体作废`).toEqual(DEFAULT_ORDER_IDS);
    }
  });
});

describe("设置页搜索节：列表集合语义（管理面列出全部记录，链成员资格是另一层）", () => {
  it("停用记录（enabled:false）仍渲染行——停用只影响链成员资格，不是从列表消失", async () => {
    const { host } = await mountPanel({
      "search-providers-list": () => ({
        ok: true,
        providers: [{ ...SEARCH_ITEMS[0], enabled: false }]
      })
    });
    await waitForSearchRows(host, 1);
    expect(recordRowIds(host)).toEqual(["search_firecrawl"]);
  });

  it("free-quota 无 Key 记录（豆包 hasSavedKey:false）仍渲染行，状态点 missing", async () => {
    const { host } = await mountPanel({
      "search-providers-list": () => ({
        ok: true,
        providers: [{ ...SEARCH_ITEMS[2], hasSavedKey: false }]
      })
    });
    await waitForSearchRows(host, 1);
    expect(recordRowIds(host)).toEqual(["search_doubao"]);
    expect(recordRows(host)[0].querySelector(".provider-row-dot")!.getAttribute("data-state")).toBe(
      "missing"
    );
  });

  it("同 presetId 双记录渲染两行（去重只在链解析侧，列表按记录展示）", async () => {
    const picked = {
      ...SEARCH_ITEMS[0],
      id: "firecrawl-picked",
      name: "Firecrawl（自备 Key）",
      hasSavedKey: true
    };
    const { host } = await mountPanel({
      "search-providers-list": () => ({ ok: true, providers: [...SEARCH_ITEMS.slice(0, 1), picked, ...SEARCH_ITEMS.slice(1)] })
    });
    await waitForSearchRows(host, 7);
    expect(recordRowIds(host)).toEqual([
      "search_exa",
      "search_doubao",
      "search_tavily",
      "search_firecrawl",
      "firecrawl-picked",
      "search_anysearch",
      "search_parallel"
    ]);
  });
});

describe("设置页搜索节：拖拽落库（spec §6.10 / §10 第 78–79 行）", () => {
  it("跨行落定写 searchProviderOrder = DOM 记录行 id 顺序，逐项相等且不含哨兵", async () => {
    const { host } = await mountPanel({
      "search-providers-list": () => ({ ok: true, providers: SEARCH_ITEMS })
    });
    await waitForSearchRows(host, 6);
    installRowRects(searchList(host));

    const handle = handleOf(host, "search_exa");
    handle.dispatchEvent(dragPointer("pointerdown", 60));
    handle.dispatchEvent(dragPointer("pointermove", 130));
    handle.dispatchEvent(dragPointer("pointerup", 130));

    const expected = [
      "search_doubao",
      "search_exa",
      "search_tavily",
      "search_firecrawl",
      "search_anysearch",
      "search_parallel"
    ];
    await waitForFast(() => {
      expect(syncStorage().set).toHaveBeenCalled();
    });
    expect(syncStorage().set).toHaveBeenCalledWith({ searchProviderOrder: expected });
    expect(expected).not.toContain(SMART_ID);
    expect(recordRowIds(host)).toEqual(expected);
  });

  it("位移 < 4px 不写库（点一下把手）", async () => {
    const { host } = await mountPanel({
      "search-providers-list": () => ({ ok: true, providers: SEARCH_ITEMS })
    });
    await waitForSearchRows(host, 6);
    installRowRects(searchList(host));

    const handle = handleOf(host, "search_exa");
    handle.dispatchEvent(dragPointer("pointerdown", 60));
    handle.dispatchEvent(dragPointer("pointermove", 62));
    handle.dispatchEvent(dragPointer("pointerup", 62));

    await flushMicrotasks();
    expect(syncStorage().set).not.toHaveBeenCalled();
    expect(recordRowIds(host)).toEqual(DEFAULT_ORDER_IDS);
  });

  it("写库失败（sync.set reject）回滚列表顺序并在状态条报错", async () => {
    syncStorage().set.mockRejectedValue(new Error("QUOTA_BYTES"));
    const { host } = await mountPanel({
      "search-providers-list": () => ({ ok: true, providers: SEARCH_ITEMS })
    });
    await waitForSearchRows(host, 6);
    installRowRects(searchList(host));

    const handle = handleOf(host, "search_exa");
    handle.dispatchEvent(dragPointer("pointerdown", 60));
    handle.dispatchEvent(dragPointer("pointermove", 130));
    handle.dispatchEvent(dragPointer("pointerup", 130));

    await waitForFast(() => {
      expect(host.querySelector<HTMLElement>("#biliscriptSettingsStatus")?.dataset.error).toBe("true");
    });
    expect(recordRowIds(host)).toEqual(DEFAULT_ORDER_IDS);
  });
});

describe("设置页搜索节：「恢复默认顺序」（spec §6.10 / §12.3 / §10 第 77 行）", () => {
  it("按钮在模板里（搜索节、添加平台按钮旁）", () => {
    const html = buildSettingsHtml();
    expect(html).toContain('id="resetSearchProviderOrderBtn"');
    expect(html).toContain("恢复默认顺序");
  });

  it("无自定义顺序 → 按钮禁用", async () => {
    const { host } = await mountPanel({
      "search-providers-list": () => ({ ok: true, providers: SEARCH_ITEMS })
    });
    await waitForSearchRows(host, 6);

    expect(host.querySelector<HTMLButtonElement>("#resetSearchProviderOrderBtn")!.disabled).toBe(true);
  });

  it("点击 = sync.remove 该键（set 零调用），随后顺序回到内置默认序、按钮转禁用", async () => {
    syncStorage().get.mockResolvedValue({ searchProviderOrder: ["search_tavily"] });
    const { host } = await mountPanel({
      "search-providers-list": () => ({ ok: true, providers: SEARCH_ITEMS })
    });
    await waitForSearchRows(host, 6);

    const button = host.querySelector<HTMLButtonElement>("#resetSearchProviderOrderBtn")!;
    expect(button.disabled).toBe(false);
    expect(recordRowIds(host)[0]).toBe("search_tavily");

    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    await waitForFast(() => {
      expect(syncStorage().remove).toHaveBeenCalledWith("searchProviderOrder");
    });
    expect(syncStorage().set).not.toHaveBeenCalled();
    await waitForFast(() => {
      expect(recordRowIds(host)).toEqual(DEFAULT_ORDER_IDS);
    });
    expect(button.disabled).toBe(true);
  });
});

describe("搜索平台列表平铺展示与模式控件切换", () => {
  function modeNote(host: HTMLElement): HTMLElement {
    return host.querySelector<HTMLElement>(".search-chain-mode-note")!;
  }
  function footerBar(host: HTMLElement): HTMLElement {
    return host.querySelector<HTMLElement>(".search-chain-footer-bar")!;
  }
  function paidToggleRow(host: HTMLElement): HTMLElement {
    return host.querySelector<HTMLInputElement>("#allowPaidSearchProviders")!.closest(".biliscript-toggle-row")!;
  }

  it("平铺展示搜索平台列表：无折叠触发器与折叠体", async () => {
    const { host } = await mountPanel({
      "search-providers-list": () => ({ ok: true, providers: SEARCH_ITEMS })
    });
    await waitForSearchRows(host, 6);

    expect(host.querySelector("#toggleSearchChainBtn")).toBeNull();
    expect(host.querySelector("#searchChainContainer")).toBeNull();
    expect(host.querySelector("#searchChainActiveSummary")).toBeNull();
    expect(searchList(host).closest("[hidden]")).toBe(host.querySelector("#biliscriptSettingsSubpageSearch"));
  });

  it("智能模式：不显示多余解释文本，恢复默认、付费准入、拖拽把手全部在位", async () => {
    const { host } = await mountPanel({
      "search-providers-list": () => ({ ok: true, providers: SEARCH_ITEMS })
    });
    await waitForSearchRows(host, 6);

    expect(modeNote(host).hidden).toBe(true);
    expect(modeNote(host).textContent).toBe("");
    expect(footerBar(host).hidden).toBe(false);
    expect(paidToggleRow(host).hidden).toBe(false);
    expect(searchList(host).classList.contains("search-chain-single-mode")).toBe(false);
    expect(recordRows(host).every((row) => row.querySelector(".provider-row-drag-handle"))).toBe(true);
  });

  it("智能模式 + 付费准入开关切换即时落库", async () => {
    const { sent, host } = await mountPanel({
      "get-settings": () => ({ ok: true, settings: { allowPaidSearchProviders: true } }),
      "search-providers-list": () => ({ ok: true, providers: SEARCH_ITEMS })
    });
    await waitForSearchRows(host, 6);

    const toggle = host.querySelector<HTMLInputElement>("#allowPaidSearchProviders")!;
    expect(toggle.checked).toBe(true);
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForFast(() => {
      expect(sent).toContainEqual({ type: "save-settings", settings: { allowPaidSearchProviders: false } });
    });
  });

  it("单平台模式：显示不回退提示、恢复默认/付费准入/拖拽把手隐藏；切回智能恢复", async () => {
    const { host } = await mountPanel({
      "search-providers-list": () => ({ ok: true, providers: SEARCH_ITEMS })
    });
    await waitForSearchRows(host, 6);

    const tavilyRadio = searchList(host).querySelector<HTMLInputElement>(
      '[data-provider-id="search_tavily"] .search-provider-active-radio'
    )!;
    tavilyRadio.checked = true;
    tavilyRadio.dispatchEvent(new Event("change", { bubbles: true }));

    expect(modeNote(host).hidden).toBe(false);
    expect(modeNote(host).textContent).toBe("已单选平台：只使用选中的平台搜索，失败不会切换到其他平台。");
    expect(footerBar(host).hidden).toBe(true);
    expect(paidToggleRow(host).hidden).toBe(true);
    expect(searchList(host).classList.contains("search-chain-single-mode")).toBe(true);
    expect(recordRows(host).every((row) => row.querySelector(".provider-row-drag-handle") !== null)).toBe(true);

    smartRadio(host).checked = true;
    smartRadio(host).dispatchEvent(new Event("change", { bubbles: true }));
    expect(modeNote(host).hidden).toBe(true);
    expect(modeNote(host).textContent).toBe("");
    expect(footerBar(host).hidden).toBe(false);
    expect(paidToggleRow(host).hidden).toBe(false);
    expect(searchList(host).classList.contains("search-chain-single-mode")).toBe(false);
  });
});

describe("票 06：单轮搜索次数上限两种模式均可见且生效", () => {
  const TAVILY = SEARCH_ITEMS[1];

  it("单平台模式下次数上限仍可见，改动照常落库", async () => {
    const { sent, host } = await mountPanel({
      "get-settings": () => ({ ok: true, settings: { activeSearchProviderId: "search_tavily" } }),
      "search-providers-list": () => ({ ok: true, providers: [TAVILY] })
    });
    await waitForSearchRows(host, 1);

    const container = host.querySelector<HTMLElement>("#webSearchMaxToolCallsContainer")!;
    expect(container.hidden).toBe(false);

    const slider = host.querySelector<HTMLInputElement>("#webSearchMaxToolCalls")!;
    slider.value = "8";
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForFast(() => {
      expect(sent).toContainEqual({ type: "save-settings", settings: { webSearchMaxToolCalls: 8 } });
    });
  });

  it("智能模式下次数上限同样可见、同样生效", async () => {
    const { sent, host } = await mountPanel({
      "search-providers-list": () => ({ ok: true, providers: [TAVILY] })
    });
    await waitForSearchRows(host, 1);

    const container = host.querySelector<HTMLElement>("#webSearchMaxToolCallsContainer")!;
    expect(container.hidden).toBe(false);

    const slider = host.querySelector<HTMLInputElement>("#webSearchMaxToolCalls")!;
    slider.value = "3";
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForFast(() => {
      expect(sent).toContainEqual({ type: "save-settings", settings: { webSearchMaxToolCalls: 3 } });
    });
  });
});

describe("票 06：模式切换保留原排序与付费偏好", () => {
  it("智能 ↔ 单平台来回切换不写 searchProviderOrder、不动付费准入开关、顺序不变", async () => {
    syncStorage().get.mockResolvedValue({ searchProviderOrder: ["search_tavily", "search_firecrawl"] });
    const { sent, host } = await mountPanel({
      "get-settings": () => ({
        ok: true,
        settings: { activeSearchProviderId: "search_tavily", allowPaidSearchProviders: true }
      }),
      "search-providers-list": () => ({ ok: true, providers: SEARCH_ITEMS })
    });
    await waitForSearchRows(host, 6);

    expect(recordRowIds(host)).toEqual([
      "search_tavily",
      "search_firecrawl",
      "search_exa",
      "search_doubao",
      "search_anysearch",
      "search_parallel"
    ]);
    expect(host.querySelector<HTMLInputElement>("#allowPaidSearchProviders")!.checked).toBe(true);

    const radio = smartRadio(host);
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForFast(() => {
      expect(sent).toContainEqual({ type: "save-settings", settings: { activeSearchProviderId: SMART_ID } });
    });

    expect(syncStorage().set).not.toHaveBeenCalled();
    expect(syncStorage().remove).not.toHaveBeenCalled();
    expect(recordRowIds(host)[0]).toBe("search_tavily");
    expect(host.querySelector<HTMLInputElement>("#allowPaidSearchProviders")!.checked).toBe(true);
    expect(
      sent.some(
        (message) =>
          message.type === "save-settings" &&
          typeof message.settings === "object" &&
          message.settings !== null &&
          "allowPaidSearchProviders" in message.settings
      )
    ).toBe(false);

    const tavilyRadio = searchList(host).querySelector<HTMLInputElement>(
      '[data-provider-id="search_tavily"] .search-provider-active-radio'
    )!;
    tavilyRadio.checked = true;
    tavilyRadio.dispatchEvent(new Event("change", { bubbles: true }));
    expect(recordRowIds(host)[0]).toBe("search_tavily");
    expect(host.querySelector<HTMLInputElement>("#allowPaidSearchProviders")!.checked).toBe(true);
  });
});
