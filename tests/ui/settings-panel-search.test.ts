// tests/ui/settings-panel-search.test.ts
// 设置抽屉搜索节的免 Key 文案、悬空链首提示与智能模式 / 拖拽排序 UI：
// - spec §6.9 / §10：说明行承载 opt-in 常驻版（同一套词）、空态改六预设；
// - spec §6.8 / §12.1：activeSearchProviderId 指向不存在记录时出现条件提示行
//   「原选用平台已不可用，当前按默认链搜索」，用户改选即消失、不新增存储位；
//   **哨兵 / 空串不算悬空**（§10 第 82 行）；
// - spec §6.10 / §12.5 第 12/15/16 行（验收第 77–80 行）：「智能」虚拟条目
//   （固定置顶、无把手、选中写哨兵）、搜索平台列表按 searchProviderOrder 归一序
//   渲染（未入组记录按内置默认序排其后）、拖拽落库 = DOM 记录行 id 顺序、
//   「恢复默认顺序」= 删 storage 键（不写 []）。
//
// 文案断言可直接构建模板；列表 / 提示行需要真实挂载（loadSettings 的搜索节渲染）。

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { resetModuleState } from "../setup.js";
import { buildSettingsHtml } from "../../extension/ui/settings-panel-html.js";
import { SEARCH_OPT_IN_NOTICE_MESSAGE } from "../../extension/search/opt-in-notice.js";

type SentMessage = { type: string } & Record<string, any>;
type MessageResponder = (message: SentMessage) => unknown;

type SyncStorageMock = { get: Mock; set: Mock; remove: Mock };

function syncStorage(): SyncStorageMock {
  return (chrome as unknown as { storage: { sync: SyncStorageMock } }).storage.sync;
}

const SMART_ID = "__smart__";

// 六预设成员各一条记录（输入序刻意 = 预设表序 ≠ 内置默认链序，证明列表按链序渲染）
const SEARCH_ITEMS = [
  { id: "search_firecrawl", presetId: "firecrawl", name: "Firecrawl", type: "firecrawl", baseUrl: "https://api.firecrawl.dev", enabled: true, hasSavedKey: false },
  { id: "search_tavily", presetId: "tavily", name: "Tavily", type: "tavily", baseUrl: "https://api.tavily.com", enabled: true, hasSavedKey: false },
  { id: "search_doubao", presetId: "doubao", name: "豆包", type: "doubao", baseUrl: "https://open.feedcoopapi.com", enabled: true, hasSavedKey: false },
  { id: "search_anysearch", presetId: "anysearch", name: "AnySearch", type: "anysearch", baseUrl: "https://api.anysearch.com", enabled: true, hasSavedKey: false },
  { id: "search_parallel", presetId: "parallel", name: "Parallel", type: "parallel", baseUrl: "https://search.parallel.ai", enabled: true, hasSavedKey: false },
  { id: "search_exa", presetId: "exa", name: "Exa", type: "exa", baseUrl: "https://api.exa.ai", enabled: true, hasSavedKey: false }
];

// 内置默认链序（spec §12.2 / DEFAULT_SEARCH_PROVIDER_ORDER）
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

// 记录行 = 自带拖拽把手的行（虚拟「智能」行无把手，spec §6.10）
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

// jsdom 无布局：按当前 DOM 序给每行 40px 的矩形带（中线 = index * 40 + 20）
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
  await vi.waitFor(() => {
    expect(recordRows(host)).toHaveLength(count);
  });
}

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
  // searchProviderOrder 直读 sync（§12.3 读 / 写同侧）：默认键缺席 = 无自定义顺序
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

  it("说明行 = function calling 说明 + opt-in 常驻版（两处撤回入口：关开关 + 删记录）", () => {
    expect(html).toContain("function calling");
    expect(html).toContain(
      "联网搜索会把查询词发往内置的免 Key 服务（Tavily / Firecrawl / AnySearch / Parallel）以及你配置过 Key 的搜索平台；关闭搜索开关可随时撤回，删除对应平台记录可停止该家接收查询。"
    );
    // 次入口单独成句（用户裁定③）：删记录停止该家接收查询
    expect(html).toContain("删除对应平台记录可停止该家接收查询");
    expect(html).not.toContain("当前选用平台提供搜索结果");
  });

  it("常驻行与一次性说明文案逐字一致（该行自己持文，不 import 单源）", () => {
    expect(html).toContain(SEARCH_OPT_IN_NOTICE_MESSAGE);
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

    // 不可拖：无把手；也不是记录行（不进 searchProviderOrder 的前提）
    expect(first.querySelector(".provider-row-drag-handle")).toBeNull();
    // 虚拟条目不是平台：无编辑 / 删除入口、无状态点与徽章
    expect(first.querySelector(".provider-row-edit")).toBeNull();
    expect(first.querySelector(".provider-row-remove")).toBeNull();
    expect(first.querySelector(".provider-row-dot")).toBeNull();
    expect(first.querySelector(".provider-row-badge")).toBeNull();
    // 同组同 class 的 radio（复用既有 activeRadio 单源）
    expect(first.querySelector(".search-provider-active-radio")).toBeTruthy();
  });

  it("零记录时智能行仍在（模式不是平台），空态文案照常显示", async () => {
    const { host } = await mountPanel({
      "search-providers-list": () => ({ ok: true, providers: [] })
    });
    await vi.waitFor(() => {
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

    await vi.waitFor(() => {
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

describe("设置页搜索节：拖拽落库（spec §6.10 / §10 第 78–79 行）", () => {
  it("跨行落定写 searchProviderOrder = DOM 记录行 id 顺序，逐项相等且不含哨兵", async () => {
    const { host } = await mountPanel({
      "search-providers-list": () => ({ ok: true, providers: SEARCH_ITEMS })
    });
    await waitForSearchRows(host, 6);
    installRowRects(searchList(host));

    const handle = handleOf(host, "search_exa");
    handle.dispatchEvent(dragPointer("pointerdown", 60));
    handle.dispatchEvent(dragPointer("pointermove", 130)); // 越过 tavily 中线 → 插到它之前
    handle.dispatchEvent(dragPointer("pointerup", 130));

    const expected = [
      "search_doubao",
      "search_exa",
      "search_tavily",
      "search_firecrawl",
      "search_anysearch",
      "search_parallel"
    ];
    await vi.waitFor(() => {
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

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(syncStorage().set).not.toHaveBeenCalled();
    expect(recordRowIds(host)).toEqual(DEFAULT_ORDER_IDS);
  });

  it("写库失败（sync.set reject）不崩溃，列表保持拖动后顺序", async () => {
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

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recordRowIds(host)).toEqual([
      "search_doubao",
      "search_exa",
      "search_tavily",
      "search_firecrawl",
      "search_anysearch",
      "search_parallel"
    ]);
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

    await vi.waitFor(() => {
      expect(syncStorage().remove).toHaveBeenCalledWith("searchProviderOrder");
    });
    expect(syncStorage().set).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(recordRowIds(host)).toEqual(DEFAULT_ORDER_IDS);
    });
    expect(button.disabled).toBe(true);
  });
});
