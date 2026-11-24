import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ASR_PROVIDER_PRESETS, PRESETS, SEARCH_PROVIDER_PRESETS } from "../../extension/core/presets.js";
import type { ProviderRowElement, ProviderRowItem } from "../../extension/ui/provider-row.js";
import type { ProviderEditorSave } from "../../extension/ui/provider-editor.js";

const mocks = vi.hoisted(() => ({
  fetchProviderModels: vi.fn(async (): Promise<{ ok: boolean; models?: string[]; error?: string }> => ({
    ok: true,
    models: []
  })),
  testAiProviderConnection: vi.fn(async () => ({ ok: true })),
  testAsrConnection: vi.fn(async () => ({ ok: true })),
  executeWebSearch: vi.fn(async () => ({ results: [{ title: "ok", url: "https://example.com", snippet: "s" }], platform: "Tavily" })),
  searchGetKey: vi.fn(async () => "sk-stored-search")
}));

vi.mock("../../extension/ai/provider-models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/ai/provider-models.js")>();
  return {
    ...actual,
    fetchProviderModels: mocks.fetchProviderModels
  };
});

vi.mock("../../extension/ai/provider-test.js", () => ({
  testAiProviderConnection: mocks.testAiProviderConnection
}));

vi.mock("../../extension/asr/provider-test.js", () => ({
  testAsrConnection: mocks.testAsrConnection
}));

vi.mock("../../extension/asr/provider-models.js", () => ({
  listAsrModels: vi.fn(async () => ({ ok: true, models: ["whisper-1"] }))
}));

vi.mock("../../extension/search/search-executor.js", () => ({
  executeWebSearch: mocks.executeWebSearch
}));

vi.mock("../../extension/search/search-provider-store.js", () => ({
  searchProviderStore: {
    getKey: mocks.searchGetKey,
    resolveDraftApiKey: (apiKey?: string | null, providerId?: string | null) => {
      const direct = String(apiKey || "").trim();
      return direct ? Promise.resolve(direct) : (providerId ? mocks.searchGetKey() : Promise.resolve(""));
    }
  }
}));

import { closeConfirmDialog } from "../../extension/ui/confirm-dialog.js";
import { closeProviderEditor } from "../../extension/ui/provider-editor.js";
import { flushMicrotasks, resetProviderEditorState, waitForFast } from "../helpers/reset-provider-editor-state.js";

type SentMessage = { type: string } & Record<string, unknown>;
let sent: SentMessage[] = [];
let permissionGate: ((response?: unknown) => void) | null = null;
let deferPermission = false;

function installBus(): void {
  sent = [];
  permissionGate = null;
  deferPermission = false;
  (chrome as unknown as { runtime: { sendMessage: unknown } }).runtime.sendMessage = vi.fn(
    (message: SentMessage, callback?: (response?: unknown) => void) => {
      sent.push(message);
      if (deferPermission && message.type === "request-provider-origins") {
        permissionGate = callback ?? null;
        return undefined;
      }
      callback?.({ ok: true });
      return undefined;
    }
  );
}

function mountView(): { view: HTMLElement; settingsPanel: HTMLElement; sibling: HTMLElement } {
  document.body.innerHTML = `
    <div id="biliscript-reading-view">
      <section id="biliscript-reading-settings-panel">
        <button type="button" id="outsideTrigger">编辑平台</button>
      </section>
      <main id="biliscript-reading-main">
        <button type="button" id="mainBtn">正文按钮</button>
      </main>
    </div>`;
  return {
    view: document.getElementById("biliscript-reading-view")!,
    settingsPanel: document.getElementById("biliscript-reading-settings-panel")!,
    sibling: document.getElementById("biliscript-reading-main")!
  };
}

function fireClick(node: Element | null): void {
  node!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function setFieldValue(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function switchPreset(dialog: HTMLElement, presetId: string): void {
  const select = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!;
  select.value = presetId;
  select.dispatchEvent(new Event("change"));
}

beforeEach(() => {
  resetProviderEditorState();
  installBus();
  mountView();
  mocks.fetchProviderModels.mockReset().mockResolvedValue({ ok: true, models: [] });
  mocks.testAiProviderConnection.mockReset().mockResolvedValue({ ok: true });
  mocks.testAsrConnection.mockReset().mockResolvedValue({ ok: true });
  mocks.executeWebSearch.mockReset().mockResolvedValue({
    results: [{ title: "ok", url: "https://example.com", snippet: "s" }],
    platform: "Tavily"
  });
  mocks.searchGetKey.mockReset().mockResolvedValue("sk-stored-search");
});

afterEach(() => {
  closeConfirmDialog();
  closeProviderEditor(true);
});

describe("1. inert 隔离与嵌套焦点圈禁", () => {
  it("嵌套叠层：editorHost -> confirmDialog 逐层 inert 并逐层恢复；fetch-dialog 隔离底层头/表", async () => {
    const { openProviderEditor, closeProviderEditor } = await import("../../extension/ui/provider-editor.js");
    const settingsPanel = document.getElementById("biliscript-reading-settings-panel")!;
    const main = document.getElementById("biliscript-reading-main")!;
    const trigger = document.getElementById("outsideTrigger")!;
    trigger.focus();

    openProviderEditor({
      kind: "ai",
      presets: PRESETS,
      onSave: async () => ({ ok: true })
    });

    const editorHost = document.querySelector<HTMLElement>(".provider-editor-host")!;
    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    expect(settingsPanel.inert).toBe(true);
    expect(main.inert).toBe(true);
    expect(Boolean(editorHost.inert)).toBe(false);

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    mocks.fetchProviderModels.mockResolvedValueOnce({ ok: true, models: ["gpt-4o-mini"] });
    fireClick(dialog.querySelector(".provider-editor-fetch"));
    await waitForFast(() => {
      expect(document.querySelectorAll(".provider-editor-fetch-item")).toHaveLength(1);
    });

    const head = dialog.querySelector<HTMLElement>(".provider-editor-head")!;
    const form = dialog.querySelector<HTMLElement>(".provider-editor-form")!;
    const subview = dialog.querySelector<HTMLElement>(".provider-editor-fetch-dialog")!;
    expect(head.inert).toBe(true);
    expect(head.getAttribute("aria-hidden")).toBe("true");
    expect(form.inert).toBe(true);
    expect(form.getAttribute("aria-hidden")).toBe("true");

    const confirmBtn = subview.querySelector<HTMLButtonElement>(".provider-editor-fetch-confirm")!;
    confirmBtn.disabled = false;
    confirmBtn.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(subview.contains(document.activeElement)).toBe(true);
    expect(form.contains(document.activeElement)).toBe(false);

    fireClick(subview.querySelector(".provider-editor-fetch-back"));
    expect(document.querySelector(".provider-editor-fetch-dialog")).toBeNull();
    expect(head.inert).toBe(false);
    expect(head.hasAttribute("aria-hidden")).toBe(false);
    expect(form.inert).toBe(false);
    expect(form.hasAttribute("aria-hidden")).toBe(false);
    expect(document.activeElement).toBe(dialog.querySelector(".provider-editor-fetch"));

    fireClick(dialog.querySelector(".provider-editor-cancel"));
    expect(document.querySelector(".confirm-dialog-host")).toBeTruthy();
    expect(editorHost.inert).toBe(true);
    expect(settingsPanel.inert).toBe(true);

    fireClick(document.querySelector(".confirm-dialog-cancel"));
    await waitForFast(() => expect(document.querySelector(".confirm-dialog-host")).toBeNull());
    expect(editorHost.inert).toBe(false);
    expect(settingsPanel.inert).toBe(true);
    expect(main.inert).toBe(true);

    closeProviderEditor(true);
    expect(settingsPanel.inert).toBe(false);
    expect(main.inert).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });
});

describe("2. 异步防重入锁与 setBusy 禁用覆盖", () => {
  it("deleteInFlight：确认删除期间 setBusy 禁用全部表单与动作控件，并拦截并发 save / delete / test", async () => {
    const { openProviderEditor, closeProviderEditor } = await import("../../extension/ui/provider-editor.js");
    let resolveDelete: ((res: { ok: boolean }) => void) | undefined;
    const onDelete = vi.fn(() => new Promise<{ ok: boolean }>((r) => { resolveDelete = r; }));
    const onSave = vi.fn(async () => ({ ok: true }));

    openProviderEditor({
      kind: "ai",
      presets: PRESETS,
      item: {
        id: "p1",
        presetId: "custom",
        name: "自定义",
        baseUrl: "https://api.example.com/v1",
        models: ["gpt-4o-mini"],
        hasSavedKey: true
      },
      onSave,
      onDelete
    });

    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    fireClick(dialog.querySelector(".provider-editor-delete"));
    fireClick(document.querySelector(".confirm-dialog-confirm"));
    await flushMicrotasks();

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(dialog.querySelector<HTMLButtonElement>(".provider-editor-delete")!.disabled).toBe(true);
    expect(dialog.querySelector<HTMLButtonElement>(".provider-editor-fetch")!.disabled).toBe(true);
    expect(dialog.querySelector<HTMLButtonElement>(".provider-editor-model-add")!.disabled).toBe(true);
    expect(dialog.querySelector<HTMLButtonElement>(".provider-editor-model-remove")!.disabled).toBe(true);
    expect(dialog.querySelector<HTMLButtonElement>(".provider-editor-model-test")!.disabled).toBe(true);
    expect(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!.disabled).toBe(true);
    expect(dialog.querySelector<HTMLButtonElement>(".provider-editor-save")!.disabled).toBe(true);
    expect(dialog.querySelector<HTMLButtonElement>(".provider-editor-cancel")!.disabled).toBe(false);

    dialog.querySelector<HTMLFormElement>(".provider-editor-form")!.dispatchEvent(
      new Event("submit", { cancelable: true, bubbles: true })
    );
    fireClick(dialog.querySelector(".provider-editor-delete"));
    await flushMicrotasks();
    expect(onSave).not.toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalledTimes(1);

    resolveDelete!({ ok: false });
    await flushMicrotasks();
    expect(dialog.querySelector<HTMLButtonElement>(".provider-editor-delete")!.disabled).toBe(false);

    closeProviderEditor(true);
    let resolveSearchDelete: ((res: { ok: boolean }) => void) | undefined;
    openProviderEditor({
      kind: "search",
      presets: SEARCH_PROVIDER_PRESETS,
      item: {
        id: "s1",
        presetId: "deepseek",
        name: "DeepSeek Search",
        type: "deepseek",
        baseUrl: "https://api.deepseek.com",
        hasSavedKey: false
      },
      linkedCredential: { statusText: "状态", actionLabel: "去配置", onAction: vi.fn() },
      onSave,
      onDelete: vi.fn(() => new Promise<{ ok: boolean }>((r) => { resolveSearchDelete = r; }))
    });
    const searchDialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    fireClick(searchDialog.querySelector(".provider-editor-delete"));
    fireClick(document.querySelector(".confirm-dialog-confirm"));
    await flushMicrotasks();
    expect(searchDialog.querySelector<HTMLButtonElement>(".provider-editor-linked-credential-btn")!.disabled).toBe(true);
    resolveSearchDelete!({ ok: true });
    await flushMicrotasks();
  });

  it("runTest 与 runSearchTest：在 await 前同步上锁并 setBusy，双击只发一次请求", async () => {
    const { openProviderEditor, closeProviderEditor } = await import("../../extension/ui/provider-editor.js");

    deferPermission = true;
    openProviderEditor({ kind: "asr", presets: ASR_PROVIDER_PRESETS, onSave: async () => ({ ok: true }) });
    let dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://asr.example.com/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-asr");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-model")!, "whisper-1");

    const asrTestBtn = dialog.querySelector<HTMLButtonElement>(".provider-editor-test")!;
    fireClick(asrTestBtn);
    expect(asrTestBtn.disabled).toBe(true);
    expect(dialog.querySelector<HTMLButtonElement>(".provider-editor-save")!.disabled).toBe(true);
    fireClick(asrTestBtn);
    expect(sent.filter((m) => m.type === "request-provider-origins")).toHaveLength(1);
    permissionGate!({ ok: true });
    await flushMicrotasks();
    expect(asrTestBtn.disabled).toBe(false);

    closeProviderEditor(true);
    let resolveKey: ((key: string) => void) | undefined;
    mocks.searchGetKey.mockImplementationOnce(() => new Promise((r) => { resolveKey = r; }));
    openProviderEditor({
      kind: "search",
      presets: SEARCH_PROVIDER_PRESETS,
      item: {
        id: "s1",
        presetId: "exa",
        name: "Exa",
        type: "exa",
        baseUrl: "https://api.exa.ai",
        hasSavedKey: true
      },
      onSave: async () => ({ ok: true })
    });
    dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    const searchTestBtn = dialog.querySelector<HTMLButtonElement>(".provider-editor-test")!;
    fireClick(searchTestBtn);
    expect(searchTestBtn.disabled).toBe(true);
    fireClick(searchTestBtn);
    expect(mocks.searchGetKey).toHaveBeenCalledTimes(1);
    resolveKey!("sk-stored");
    await flushMicrotasks();
    expect(mocks.executeWebSearch).toHaveBeenCalledTimes(1);
    expect(searchTestBtn.disabled).toBe(false);
  });

  it("openFetchDialog 双击防重入 & model-picker 并发/断连守卫与 aria-expanded 同步", async () => {
    const { openProviderEditor, closeProviderEditor } = await import("../../extension/ui/provider-editor.js");
    const { buildModelPickerField, wireModelPicker } = await import("../../extension/ui/model-picker.js");

    let resolveFetch: ((res: { ok: boolean; models?: string[]; error?: string }) => void) | undefined;
    mocks.fetchProviderModels.mockImplementationOnce(() => new Promise((r) => { resolveFetch = r; }));
    openProviderEditor({ kind: "ai", presets: PRESETS, onSave: async () => ({ ok: true }) });
    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    fireClick(dialog.querySelector(".provider-editor-fetch"));
    await flushMicrotasks();
    fireClick(dialog.querySelector(".provider-editor-fetch"));
    expect(mocks.fetchProviderModels).toHaveBeenCalledTimes(1);
    resolveFetch!({ ok: true, models: ["gpt-4o"] });
    await flushMicrotasks();
    closeProviderEditor(true);

    const row = document.createElement("div") as unknown as ProviderRowElement;
    row.dataset.providerId = "asr_1";
    row.innerHTML = `
      <input class="mp-url" value="https://asr.example.com/v1" />
      <input class="mp-key" value="sk-1" />
      <div class="mp-status" hidden></div>
      ${buildModelPickerField({ inputClass: "mp-model", placeholder: "m", value: "" })}
    `;
    document.body.appendChild(row);
    let resolvePicker: ((res: { ok: boolean; models: string[] }) => void) | undefined;
    const fetchModels = vi.fn(() => new Promise<{ ok: boolean; models: string[] }>((r) => { resolvePicker = r; }));
    wireModelPicker(row, {
      inputClass: "mp-model",
      baseUrlClass: "mp-url",
      apiKeyClass: "mp-key",
      statusClass: "mp-status",
      showStatus: vi.fn(),
      fetchModels
    });
    const toggle = row.querySelector<HTMLButtonElement>(".ai-provider-model-toggle")!;
    const dropdown = row.querySelector<HTMLElement>(".ai-provider-model-dropdown")!;
    toggle.click();
    await flushMicrotasks();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    document.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(dropdown.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    resolvePicker!({ ok: true, models: ["stale-model"] });
    await flushMicrotasks();
    expect(dropdown.hidden).toBe(true);
    expect(dropdown.querySelector("[data-model]")).toBeNull();
    expect(dropdown.textContent).not.toContain("stale-model");
    expect(fetchModels).toHaveBeenCalledTimes(1);
  });
});

describe("4. 动态 resolveLinkedCredential、setupContextBanner 与 initialStatus", () => {
  it("切预设与改 baseUrl 实时重算 resolveLinkedCredential，且展示上下文引导与初始状态", async () => {
    const { openProviderEditor } = await import("../../extension/ui/provider-editor.js");
    const onAction = vi.fn();

    openProviderEditor({
      kind: "search",
      presets: SEARCH_PROVIDER_PRESETS,
      setupContextBanner: "来自首次联网搜索配置，保存后将返回继续提问",
      initialStatus: { message: "已回到原搜索草稿，请点击「保存」落盘" },
      resolveLinkedCredential: (draft) => {
        if (draft.presetId !== "deepseek") return null;
        if (draft.baseUrl.includes("custom-proxy")) {
          return { statusText: "当前为自定义中转地址", actionLabel: "新建独立官方记录", onAction };
        }
        return { statusText: "缺少官方 DeepSeek Key", actionLabel: "配置官方 DeepSeek Key", onAction };
      },
      onSave: async () => ({ ok: true })
    });

    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    const banner = dialog.querySelector<HTMLElement>(".provider-editor-context-banner")!;
    const status = dialog.querySelector<HTMLElement>(".provider-editor-status")!;
    const linked = dialog.querySelector<HTMLElement>(".provider-editor-linked-credential")!;

    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain("首次联网搜索配置");
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain("请点击「保存」落盘");
    expect(linked.hidden).toBe(true);

    switchPreset(dialog, "deepseek");
    expect(linked.hidden).toBe(false);
    expect(linked.textContent).toContain("缺少官方 DeepSeek Key");
    const btn = linked.querySelector<HTMLButtonElement>(".provider-editor-linked-credential-btn")!;
    expect(btn.textContent).toBe("配置官方 DeepSeek Key");
    fireClick(btn);
    expect(onAction).toHaveBeenCalledTimes(1);

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://custom-proxy.example.com");
    expect(linked.textContent).toContain("当前为自定义中转地址");
    expect(linked.querySelector(".provider-editor-linked-credential-btn")!.textContent).toBe("新建独立官方记录");

    switchPreset(dialog, "tavily");
    expect(linked.hidden).toBe(true);
  });
});

describe("5. 非 AI 预设切换保护 & 编辑态换预设/改 origin 禁发旧 Key", () => {
  it("ASR 切预设保护用户手改名称与手填 Key（仅免 Key 预设清 Key，空/旧预设名才替换）", async () => {
    const { openProviderEditor } = await import("../../extension/ui/provider-editor.js");
    openProviderEditor({
      kind: "asr",
      presets: ASR_PROVIDER_PRESETS,
      onSave: async () => ({ ok: true })
    });

    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    const nameInput = dialog.querySelector<HTMLInputElement>(".provider-editor-name")!;
    const keyInput = dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!;

    setFieldValue(nameInput, "我的高速转写");
    setFieldValue(keyInput, "sk-user-draft");

    const keyPreset = ASR_PROVIDER_PRESETS.find((p) => p.requiresKey !== false && p.id !== ASR_PROVIDER_PRESETS[0].id);
    if (keyPreset) {
      switchPreset(dialog, keyPreset.id);
      expect(nameInput.value).toBe("我的高速转写");
      expect(keyInput.value).toBe("sk-user-draft");
    }

    switchPreset(dialog, "local-whisper");
    expect(nameInput.value).toBe("我的高速转写");
    expect(keyInput.value).toBe("");
  });

  it("AI 编辑态改地址到不同 origin 后，阻断行级测试与保存复用旧已存 Key", async () => {
    const { openProviderEditor } = await import("../../extension/ui/provider-editor.js");
    const onSave = vi.fn<ProviderEditorSave>(async () => ({ ok: true }));
    const item: ProviderRowItem = {
      id: "ai_1",
      presetId: "custom",
      name: "原平台",
      baseUrl: "https://api.trusted.example.com/v1",
      models: ["gpt-4o-mini"],
      hasSavedKey: true
    };
    openProviderEditor({ kind: "ai", presets: PRESETS, item, onSave });

    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    const keyInput = dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!;
    expect(keyInput.placeholder).toBe("已保存");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://evil.example.com/v1");
    expect(keyInput.required).toBe(true);
    expect(keyInput.placeholder).toContain("重新确认");

    fireClick(dialog.querySelector(".provider-editor-model-test"));
    expect(mocks.testAiProviderConnection).not.toHaveBeenCalled();
    expect(dialog.querySelector<HTMLElement>(".provider-editor-model-result")!.dataset.state).toBe("error");

    fireClick(dialog.querySelector(".provider-editor-save"));
    expect(onSave).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(keyInput);

    setFieldValue(keyInput, "sk-new-confirmed");
    fireClick(dialog.querySelector(".provider-editor-save"));
    await flushMicrotasks();
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0]?.[1];
    expect(saved?.apiKey).toBe("sk-new-confirmed");

    openProviderEditor({ kind: "ai", presets: PRESETS, item, onSave });
    const dialog2 = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    switchPreset(dialog2, "ollama");
    fireClick(dialog2.querySelector(".provider-editor-save"));
    await flushMicrotasks();
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1]?.[1]?.hasSavedKey).toBe(false);
  });
});

describe("6. 模型拉取子视图四态 UX + 快捷键 + 前置定位", () => {
  it("缺 baseUrl / 缺 Key 时精准定位并聚焦对应输入", async () => {
    const { openProviderEditor } = await import("../../extension/ui/provider-editor.js");
    openProviderEditor({ kind: "ai", presets: PRESETS, onSave: async () => ({ ok: true }) });
    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    const baseUrl = dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!;
    const apiKey = dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!;

    fireClick(dialog.querySelector(".provider-editor-fetch"));
    expect(document.activeElement).toBe(baseUrl);
    expect(baseUrl.getAttribute("aria-invalid")).toBe("true");

    setFieldValue(baseUrl, "https://api.example.com/v1");
    fireClick(dialog.querySelector(".provider-editor-fetch"));
    expect(document.activeElement).toBe(apiKey);
    expect(apiKey.getAttribute("aria-invalid")).toBe("true");
  });

  it("严格区分 loading / error / empty-server / ready 四态，且支持 Enter 与 ArrowDown 快捷操作", async () => {
    const { openProviderEditor } = await import("../../extension/ui/provider-editor.js");
    let resolveFirst: ((r: { ok: boolean; models?: string[]; error?: string }) => void) | undefined;
    mocks.fetchProviderModels.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));

    openProviderEditor({ kind: "ai", presets: PRESETS, onSave: async () => ({ ok: true }) });
    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    fireClick(dialog.querySelector(".provider-editor-fetch"));
    await flushMicrotasks();

    const subview = document.querySelector<HTMLElement>(".provider-editor-fetch-dialog")!;
    const loading = subview.querySelector<HTMLElement>(".provider-editor-fetch-loading")!;
    const search = subview.querySelector<HTMLInputElement>(".provider-editor-fetch-search")!;
    const allRow = subview.querySelector<HTMLElement>(".provider-editor-fetch-all-row")!;
    const list = subview.querySelector<HTMLElement>(".provider-editor-fetch-list")!;
    const emptyServer = subview.querySelector<HTMLElement>(".provider-editor-fetch-empty-server")!;
    const error = subview.querySelector<HTMLElement>(".provider-editor-fetch-error")!;

    expect(subview.dataset.fetchState).toBe("loading");
    expect(loading.hidden).toBe(false);
    expect(search.hidden).toBe(true);
    expect(allRow.hidden).toBe(true);
    expect(list.hidden).toBe(true);
    expect(emptyServer.hidden).toBe(true);
    expect(error.hidden).toBe(true);

    resolveFirst!({ ok: false, error: "HTTP 401：API Key 无效或未授权" });
    await flushMicrotasks();
    expect(subview.dataset.fetchState).toBe("error");
    expect(loading.hidden).toBe(true);
    expect(search.hidden).toBe(true);
    expect(allRow.hidden).toBe(true);
    expect(list.hidden).toBe(true);
    expect(emptyServer.hidden).toBe(true);
    expect(error.hidden).toBe(false);
    expect(error.querySelector(".provider-editor-fetch-retry")).toBeTruthy();

    mocks.fetchProviderModels.mockResolvedValueOnce({ ok: true, models: [] });
    fireClick(error.querySelector(".provider-editor-fetch-retry"));
    await flushMicrotasks();
    const retriedSubview = document.querySelector<HTMLElement>(".provider-editor-fetch-dialog")!;
    expect(retriedSubview.dataset.fetchState).toBe("empty-server");
    expect(retriedSubview.querySelector<HTMLElement>(".provider-editor-fetch-loading")!.hidden).toBe(true);
    expect(retriedSubview.querySelector<HTMLElement>(".provider-editor-fetch-search")!.hidden).toBe(true);
    expect(retriedSubview.querySelector<HTMLElement>(".provider-editor-fetch-all-row")!.hidden).toBe(true);
    expect(retriedSubview.querySelector<HTMLElement>(".provider-editor-fetch-list")!.hidden).toBe(true);
    expect(retriedSubview.querySelector<HTMLElement>(".provider-editor-fetch-error")!.hidden).toBe(true);
    const retriedEmpty = retriedSubview.querySelector<HTMLElement>(".provider-editor-fetch-empty-server")!;
    expect(retriedEmpty.hidden).toBe(false);
    expect(retriedEmpty.textContent).toContain("该平台未返回可用模型");

    fireClick(retriedSubview.querySelector(".provider-editor-fetch-back"));
    mocks.fetchProviderModels.mockResolvedValueOnce({ ok: true, models: ["gpt-4o", "o3-mini"] });
    fireClick(dialog.querySelector(".provider-editor-fetch"));
    await waitForFast(() => {
      expect(document.querySelectorAll(".provider-editor-fetch-item")).toHaveLength(2);
    });
    const subview2 = document.querySelector<HTMLElement>(".provider-editor-fetch-dialog")!;
    const search2 = subview2.querySelector<HTMLInputElement>(".provider-editor-fetch-search")!;
    expect(subview2.dataset.fetchState).toBe("ready");
    expect(search2.hidden).toBe(false);
    expect(subview2.querySelector<HTMLElement>(".provider-editor-fetch-all-row")!.hidden).toBe(false);
    expect(subview2.querySelector<HTMLElement>(".provider-editor-fetch-list")!.hidden).toBe(false);

    search2.value = "o3";
    search2.dispatchEvent(new Event("input"));
    search2.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(subview2.querySelector<HTMLButtonElement>(".provider-editor-fetch-confirm")!.textContent).toBe("添加所选 (1)");

    search2.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(subview2.querySelector(".provider-editor-fetch-check"));
  });

  it("跨族凭据 onAction 同步抛错时通过 logWarn 留痕并在状态栏显示错误", async () => {
    const { registerDebugGate } = await import("../../extension/shared/logging.js");
    registerDebugGate(() => true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { openProviderEditor } = await import("../../extension/ui/provider-editor.js");
      const actionError = new Error("linked credential jump failed");
      openProviderEditor({
        kind: "search",
        presets: SEARCH_PROVIDER_PRESETS,
        onSave: async () => ({ ok: true }),
        linkedCredential: {
          statusText: "未配置 DeepSeek Key",
          actionLabel: "配置官方 DeepSeek Key",
          onAction: () => {
            throw actionError;
          }
        }
      });

      const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
      fireClick(dialog.querySelector(".provider-editor-linked-credential-btn"));

      const status = dialog.querySelector<HTMLElement>(".provider-editor-status")!;
      expect(status.hidden).toBe(false);
      expect(status.dataset.error).toBe("true");
      expect(status.textContent).toBe("linked credential jump failed");
      expect(warnSpy).toHaveBeenCalledWith("[BILISCRIPT] linked credential action failed", actionError);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
