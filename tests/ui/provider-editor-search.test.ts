// tests/ui/provider-editor-search.test.ts
// 搜索平台编辑 Modal 的两处免 Key 契约：
// - spec §6.3 / §10 第 31 行：Key 输入三态（占位符 + required）与预设 access 同源
//   —— keyless 无 Key「API Key（可选）」+ required=false；keyless 有 Key「已保存」
//   不 required；free-quota 无 Key「API Key」+ required；切预设 sync 与初始模板同源；
// - spec §6.6 / §10 第 32 行：搜索测试动作五态 + 前置本地校验 + 三条硬约束
//   （不走也不写查询缓存、探针词是设置页常量、不落盘）。
//
// 与 provider-editor.test.ts 同款手法：真实模块 + DOM 仿真，经
// renderReaderSettingsPanel 挂载面板后从「+ 添加平台」驱动；搜索执行器整体 mock
// （五态只测 Modal 的映射与约束，不测真实网络）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

type SentMessage = { type: string } & Record<string, any>;
type MessageResponder = (message: SentMessage) => unknown;

const { executeWebSearchMock } = vi.hoisted(() => ({
  executeWebSearchMock: vi.fn<
    (config: { type: string; baseUrl: string; apiKey?: string }, query: string) => Promise<unknown>
  >()
}));

vi.mock("../../extension/ai/provider-test.js", () => ({
  testAiProviderConnection: vi.fn(async () => ({ ok: true }))
}));

vi.mock("../../extension/asr/provider-test.js", () => ({
  testAsrConnection: vi.fn(async () => ({ ok: true }))
}));

vi.mock("../../extension/asr/provider-models.js", () => ({
  listAsrModels: vi.fn(async () => ({ ok: false, error: "not used" }))
}));

vi.mock("../../extension/search/search-executor.js", () => ({
  executeWebSearch: executeWebSearchMock,
  SEARCH_RESULT_COUNT: 5
}));

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
    "search-providers-save": () => ({ ok: true, providers: [] }),
    "request-provider-origins": () => ({ ok: true }),
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
    expect(chromeStub().runtime.sendMessage.mock.calls.some(([message]) => message.type === "asr-providers-list")).toBe(true);
  });
  return { sent, host };
}

function fireClick(node: Element | null) {
  node!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function setFieldValue(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function openSearchEditor(host: HTMLElement, buttonSelectorOrElement: string | Element = "#addSearchProviderBtn") {
  fireClick(typeof buttonSelectorOrElement === "string" ? host.querySelector(buttonSelectorOrElement) : buttonSelectorOrElement);
  await vi.waitFor(() => {
    expect(document.querySelector(".provider-editor-dialog")).toBeTruthy();
  });
  return document.querySelector<HTMLElement>(".provider-editor-dialog")!;
}

function switchPreset(dialog: HTMLElement, presetId: string) {
  const select = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!;
  select.value = presetId;
  select.dispatchEvent(new Event("change"));
  return select;
}

function apiKeyInput(dialog: HTMLElement) {
  return dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!;
}

function statusNode(dialog: HTMLElement) {
  return dialog.querySelector<HTMLElement>(".provider-editor-status")!;
}

function fillBaseUrl(dialog: HTMLElement, url = "https://api.firecrawl.dev") {
  setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, url);
}

async function clickTest(dialog: HTMLElement) {
  fireClick(dialog.querySelector(".provider-editor-test"));
  await vi.waitFor(() => {
    expect(statusNode(dialog).hidden).toBe(false);
    expect(statusNode(dialog).textContent).not.toBe("正在测试...");
  });
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
  executeWebSearchMock.mockReset();
});

afterEach(async () => {
  const { closeProviderEditor } = await import("../../extension/ui/provider-editor.js");
  closeProviderEditor(true);
});

describe("搜索 Modal：Key 输入三态（spec §6.3 / §10 第 31 行）", () => {
  it("keyless 无 Key：占位符「API Key（可选）」+ required=false，并渲染搜索测试行", async () => {
    const { host } = await mountPanel();
    const dialog = await openSearchEditor(host);

    const key = apiKeyInput(dialog);
    expect(dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!.value).toBe("firecrawl");
    expect(key.placeholder).toBe("API Key（可选）");
    expect(key.required).toBe(false);
    // §6.6：复用 ASR 的测试行形状（按钮 + 状态行）
    const testrow = dialog.querySelector<HTMLElement>(".provider-editor-testrow")!;
    expect(testrow.querySelector(".provider-editor-test")).toBeTruthy();
    expect(testrow.querySelector(".provider-editor-status")).toBeTruthy();
    expect(testrow.querySelector<HTMLButtonElement>(".provider-editor-test")!.title).toBe(
      "会真实发起一次搜索，占用一次平台额度"
    );
  });

  it("free-quota 无 Key：「API Key」+ required；切回 keyless 摘 required（sync 与模板同源）", async () => {
    const { host } = await mountPanel();
    const dialog = await openSearchEditor(host);
    const key = apiKeyInput(dialog);

    switchPreset(dialog, "exa");
    expect(key.placeholder).toBe("API Key");
    expect(key.required).toBe(true);

    switchPreset(dialog, "doubao");
    expect(key.placeholder).toBe("API Key");
    expect(key.required).toBe(true);

    switchPreset(dialog, "tavily");
    expect(key.placeholder).toBe("API Key（可选）");
    expect(key.required).toBe(false);
  });

  it("keyless 有 Key：「已保存」且不 required；切预设后 sync 同样不 required", async () => {
    const item = {
      id: "search_fc",
      presetId: "firecrawl",
      name: "Firecrawl",
      type: "firecrawl",
      baseUrl: "https://api.firecrawl.dev",
      enabled: true,
      hasSavedKey: true
    };
    const { host } = await mountPanel({
      "search-providers-list": () => ({ ok: true, providers: [item] })
    });
    const row = host.querySelector<HTMLElement>("#searchProvidersList .search-provider-row")!;
    const dialog = await openSearchEditor(host, row.querySelector(".provider-row-edit")!);
    const key = apiKeyInput(dialog);

    expect(key.placeholder).toBe("已保存");
    expect(key.required).toBe(false);

    switchPreset(dialog, "doubao");
    expect(key.placeholder).toBe("已保存");
    expect(key.required).toBe(false);
  });
});

describe("搜索 Modal：测试动作五态与前置校验（spec §6.6 / §10 第 32 行）", () => {
  const results = [
    { title: "a", url: "https://a.example.com", snippet: "sa" },
    { title: "b", url: "https://b.example.com", snippet: "sb" },
    { title: "c", url: "https://c.example.com", snippet: "sc" }
  ];

  function sentTypes(sent: SentMessage[]): string[] {
    return sent.map((message) => message.type);
  }

  it("HTTP 200 + ≥1 条 →「连接成功 · N 条结果」（非失败态）", async () => {
    const { host } = await mountPanel();
    const dialog = await openSearchEditor(host);
    await fillBaseUrl(dialog);
    executeWebSearchMock.mockResolvedValueOnce({ results, platform: "Firecrawl" });

    await clickTest(dialog);

    expect(statusNode(dialog).textContent).toBe("连接成功 · 3 条结果");
    expect(statusNode(dialog).dataset.error).toBe("false");
  });

  it("HTTP 200 + 0 条 →「未返回结果」（失败态，不落盘）", async () => {
    const { sent, host } = await mountPanel();
    const dialog = await openSearchEditor(host);
    await fillBaseUrl(dialog);
    executeWebSearchMock.mockResolvedValueOnce({ results: [], platform: "Firecrawl" });

    await clickTest(dialog);

    expect(statusNode(dialog).textContent).toBe("未返回结果");
    expect(statusNode(dialog).dataset.error).toBe("true");
    expect(sentTypes(sent)).not.toContain("save-settings");
  });

  it("额度类（429）→「额度已用尽」；鉴权类（401）→「Key 无效或无权限」", async () => {
    const { host } = await mountPanel();
    const dialog = await openSearchEditor(host);
    await fillBaseUrl(dialog);

    executeWebSearchMock.mockRejectedValueOnce(Object.assign(new Error("HTTP 429"), { status: 429 }));
    await clickTest(dialog);
    expect(statusNode(dialog).textContent).toBe("额度已用尽");
    expect(statusNode(dialog).dataset.error).toBe("true");

    setFieldValue(apiKeyInput(dialog), "");
    executeWebSearchMock.mockRejectedValueOnce(Object.assign(new Error("HTTP 401"), { status: 401 }));
    await clickTest(dialog);
    expect(statusNode(dialog).textContent).toBe("Key 无效或无权限");
    expect(statusNode(dialog).dataset.error).toBe("true");
  });

  it("其余类 →「连接失败：<原因>」", async () => {
    const { host } = await mountPanel();
    const dialog = await openSearchEditor(host);
    await fillBaseUrl(dialog);
    executeWebSearchMock.mockRejectedValueOnce(new Error("请求超时，请检查 baseUrl 或稍后重试"));

    await clickTest(dialog);

    expect(statusNode(dialog).textContent).toBe("连接失败：请求超时，请检查 baseUrl 或稍后重试");
    expect(statusNode(dialog).dataset.error).toBe("true");
  });

  it("编辑已存 Key 的平台：空输入沿用已存 Key（只读存储，不落盘）", async () => {
    const item = {
      id: "search_exa",
      presetId: "exa",
      name: "Exa",
      type: "exa",
      baseUrl: "https://api.exa.ai",
      enabled: true,
      hasSavedKey: true
    };
    const { sent, host } = await mountPanel({
      "search-providers-list": () => ({ ok: true, providers: [item] })
    });
    const row = host.querySelector<HTMLElement>("#searchProvidersList .search-provider-row")!;
    const dialog = await openSearchEditor(host, row.querySelector(".provider-row-edit")!);
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      searchProviderKeys: { search_exa: "sk-stored" }
    });
    executeWebSearchMock.mockResolvedValueOnce({ results: [results[0]], platform: "Exa" });

    await clickTest(dialog);

    expect(executeWebSearchMock).toHaveBeenCalledTimes(1);
    expect(executeWebSearchMock.mock.calls[0][0]).toMatchObject({
      type: "exa",
      baseUrl: "https://api.exa.ai",
      apiKey: "sk-stored"
    });
    expect(statusNode(dialog).textContent).toBe("连接成功 · 1 条结果");
    expect(sentTypes(sent)).not.toContain("save-settings");
  });

  it("前置本地校验：baseUrl 空 →「请填写 baseUrl」；free-quota 未配 Key →「请先填写 API Key」，都不发起请求", async () => {
    const { host } = await mountPanel();
    const dialog = await openSearchEditor(host);

    // 搜索预设自带 baseUrl（新增即预填），用户清空后才触发地址校验
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "");
    await clickTest(dialog);
    expect(statusNode(dialog).textContent).toBe("请填写 baseUrl");
    expect(statusNode(dialog).dataset.error).toBe("true");

    await fillBaseUrl(dialog, "https://api.exa.ai");
    switchPreset(dialog, "exa");
    await clickTest(dialog);
    expect(statusNode(dialog).textContent).toBe("请先填写 API Key");
    expect(statusNode(dialog).dataset.error).toBe("true");
    expect(executeWebSearchMock).not.toHaveBeenCalled();
  });

  it("硬约束：探针词是设置页常量「联网搜索测试」、不走也不写查询缓存、不落盘", async () => {
    const { sent, host } = await mountPanel();
    const dialog = await openSearchEditor(host);
    await fillBaseUrl(dialog);
    executeWebSearchMock.mockResolvedValueOnce({ results, platform: "Firecrawl" });

    const localSetBefore = (chrome.storage.local.set as ReturnType<typeof vi.fn>).mock.calls.length;
    const syncSetBefore = (chrome.storage.sync.set as ReturnType<typeof vi.fn>).mock.calls.length;

    await clickTest(dialog);

    // ② 探针词是设置页常量（不是用户问题）
    expect(executeWebSearchMock).toHaveBeenCalledTimes(1);
    expect(executeWebSearchMock.mock.calls[0][1]).toBe("联网搜索测试");
    // ① 测试不走也不写查询缓存（缓存族消息零出站）
    expect(sentTypes(sent).filter((type) => type.includes("search-cache"))).toEqual([]);
    // ①' 测试动作不走回退链 → 零健康度记账（探针不得扰动运行时状态，spec §12.4 第 2 条）
    expect(sentTypes(sent).filter((type) => type === "search-health")).toEqual([]);
    // ③ 不落盘：只有「保存」写设置——测试动作无 save-settings / 平台保存消息
    expect(sentTypes(sent)).not.toContain("save-settings");
    expect(sentTypes(sent).filter((type) => type.endsWith("-providers-save"))).toEqual([]);
    expect((chrome.storage.local.set as ReturnType<typeof vi.fn>).mock.calls.length).toBe(localSetBefore);
    expect((chrome.storage.sync.set as ReturnType<typeof vi.fn>).mock.calls.length).toBe(syncSetBefore);
  });
});
