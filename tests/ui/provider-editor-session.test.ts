import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import type { ProviderRowPreset } from "../../extension/ui/provider-row.js";

vi.mock("../../extension/ai/provider-test.js", () => ({
  testAiProviderConnection: vi.fn(async () => ({ ok: true }))
}));

vi.mock("../../extension/asr/provider-test.js", () => ({
  testAsrConnection: vi.fn(async () => ({ ok: true }))
}));

vi.mock("../../extension/asr/provider-models.js", () => ({
  listAsrModels: vi.fn(async () => ({ ok: false, error: "not used" }))
}));

vi.mock("../../extension/ai/provider-models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/ai/provider-models.js")>();
  return {
    ...actual,
    fetchProviderModels: vi.fn(async () => ({ ok: true, models: [] }))
  };
});

const PRESETS: ProviderRowPreset[] = [
  { id: "custom", name: "自定义", baseUrl: "", requiresKey: true }
];

type SentMessage = { type: string } & Record<string, any>;

let sent: SentMessage[] = [];
let pendingPermission: ((response?: unknown) => void) | null = null;
let deferPermission = false;

function installBus(responders: Record<string, (message: SentMessage) => unknown> = {}) {
  sent = [];
  pendingPermission = null;
  deferPermission = false;
  const sendMessage = vi.fn((message: SentMessage, callback?: (response?: unknown) => void) => {
    sent.push(message);
    if (deferPermission && message.type === "request-provider-origins") {
      pendingPermission = callback ?? null;
      return undefined;
    }
    const respond = responders[message.type];
    callback?.(respond ? respond(message) : { ok: true });
    return undefined;
  });
  (chrome as unknown as { runtime: { sendMessage: unknown } }).runtime.sendMessage = sendMessage;
}

function mountView(): void {
  document.body.innerHTML = `
    <div id="biliscript-reading-view">
      <section id="biliscript-reading-settings-panel"></section>
    </div>`;
}

function fireClick(node: Element | null) {
  node!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function setFieldValue(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flushMicrotasks() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
}

function dialogNode(): HTMLElement {
  return document.querySelector<HTMLElement>(".provider-editor-dialog")!;
}

function statusNode(dialog: HTMLElement): HTMLElement {
  return dialog.querySelector<HTMLElement>(".provider-editor-status")!;
}

beforeEach(() => {
  resetModuleState();
  installBus();
  mountView();
});

afterEach(async () => {
  const { closeProviderEditor } = await import("../../extension/ui/provider-editor.js");
  closeProviderEditor(true);
});

describe("过期回执纪律（owner 2：captureSession / runIfCurrent）", () => {
  it("S1 保存中途关 Modal：回执落定时不写状态行、不重开", async () => {
    const editor = await import("../../extension/ui/provider-editor.js");
    let resolveSave: ((result: { ok: boolean; error?: string }) => void) | undefined;
    const onSave = vi.fn(
      () => new Promise<{ ok: boolean; error?: string }>((resolve) => { resolveSave = resolve; })
    );
    editor.openProviderEditor({ kind: "ai", presets: PRESETS, onSave });

    const dialog = dialogNode();
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    fireClick(dialog.querySelector(".provider-editor-save"));
    await flushMicrotasks();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(statusNode(dialog).textContent).toBe("正在保存...");

    editor.closeProviderEditor(true);
    expect(document.querySelector(".provider-editor-dialog")).toBeNull();

    resolveSave!({ ok: false, error: "boom" });
    await flushMicrotasks();
    expect(document.querySelector(".provider-editor-dialog")).toBeNull();
    expect(document.querySelector(".confirm-dialog-host")).toBeNull();
  });

  it("S2 关旧开新：旧会话的过期保存回执不覆盖新会话状态行", async () => {
    const editor = await import("../../extension/ui/provider-editor.js");
    let resolveSave: ((result: { ok: boolean; error?: string }) => void) | undefined;
    const onSaveA = vi.fn(
      () => new Promise<{ ok: boolean; error?: string }>((resolve) => { resolveSave = resolve; })
    );
    editor.openProviderEditor({ kind: "ai", presets: PRESETS, onSave: onSaveA });
    const dialogA = dialogNode();
    setFieldValue(dialogA.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    setFieldValue(dialogA.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    fireClick(dialogA.querySelector(".provider-editor-save"));
    await flushMicrotasks();
    expect(onSaveA).toHaveBeenCalledTimes(1);

    editor.closeProviderEditor(true);
    editor.openProviderEditor({ kind: "ai", presets: PRESETS, onSave: async () => ({ ok: true }) });
    const dialogB = dialogNode();
    expect(dialogB).not.toBe(dialogA);

    resolveSave!({ ok: false, error: "旧会话错误" });
    await flushMicrotasks();

    expect(document.querySelector(".provider-editor-dialog")).toBe(dialogB);
    expect(statusNode(dialogB).hidden, "新会话状态行被过期回执写脏").toBe(true);
    expect(statusNode(dialogB).textContent).toBe("");
  });

  it("S3 探针在飞时关旧开新：ASR 探针回执不写新会话状态行", async () => {
    const editor = await import("../../extension/ui/provider-editor.js");
    const { testAsrConnection } = await import("../../extension/asr/provider-test.js");
    let resolveProbe: ((result: { ok: boolean; error?: string }) => void) | undefined;
    vi.mocked(testAsrConnection).mockImplementationOnce(
      () => new Promise((resolve) => { resolveProbe = resolve; })
    );

    editor.openProviderEditor({ kind: "asr", presets: PRESETS, onSave: async () => ({ ok: true }) });
    const dialogA = dialogNode();
    setFieldValue(dialogA.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://asr.example.com/v1");
    setFieldValue(dialogA.querySelector<HTMLInputElement>(".provider-editor-model")!, "whisper-1");
    fireClick(dialogA.querySelector(".provider-editor-test"));
    await flushMicrotasks();
    expect(testAsrConnection).toHaveBeenCalledTimes(1);

    editor.closeProviderEditor(true);
    editor.openProviderEditor({ kind: "asr", presets: PRESETS, onSave: async () => ({ ok: true }) });
    const dialogB = dialogNode();

    resolveProbe!({ ok: true });
    await flushMicrotasks();

    expect(statusNode(dialogB).hidden, "新会话状态行被过期探针回执写脏").toBe(true);
    expect(statusNode(dialogB).textContent).toBe("");
  });

  it("S4 行级测试在飞时删行：过期回执不写已删行（存活判据）", async () => {
    const editor = await import("../../extension/ui/provider-editor.js");
    const { testAiProviderConnection } = await import("../../extension/ai/provider-test.js");
    let resolveProbe: ((result: { ok: boolean; error?: string }) => void) | undefined;
    vi.mocked(testAiProviderConnection).mockImplementationOnce(
      () => new Promise((resolve) => { resolveProbe = resolve; })
    );

    editor.openProviderEditor({ kind: "ai", presets: PRESETS, onSave: async () => ({ ok: true }) });
    const dialog = dialogNode();
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    fireClick(dialog.querySelector(".provider-editor-model-add"));
    const row = dialog.querySelector<HTMLElement>(".provider-editor-model-row")!;
    setFieldValue(row.querySelector<HTMLInputElement>(".provider-editor-model-id")!, "gpt-4o-mini");

    fireClick(row.querySelector(".provider-editor-model-test"));
    expect(row.querySelector<HTMLElement>(".provider-editor-model-result")!.dataset.state).toBe("loading");
    await flushMicrotasks();
    expect(testAiProviderConnection, "探针应已在飞").toHaveBeenCalledTimes(1);

    fireClick(row.querySelector(".provider-editor-model-remove"));
    expect(dialog.querySelectorAll(".provider-editor-model-row")).toHaveLength(0);

    resolveProbe!({ ok: true });
    await flushMicrotasks();

    expect(row.isConnected).toBe(false);
    expect(
      row.querySelector<HTMLButtonElement>(".provider-editor-model-test")!.disabled,
      "过期回执写了已删行（存活判据失效）"
    ).toBe(true);
    expect(row.querySelector<HTMLElement>(".provider-editor-model-result")!.dataset.state).toBe("loading");
  });

  it("S5 「获取可用模型」权限在飞时关 Modal：回执不触发注定过期的模型请求", async () => {
    const editor = await import("../../extension/ui/provider-editor.js");
    deferPermission = true;
    editor.openProviderEditor({ kind: "ai", presets: PRESETS, onSave: async () => ({ ok: true }) });

    const dialog = dialogNode();
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    fireClick(dialog.querySelector(".provider-editor-fetch"));

    expect(document.querySelector(".provider-editor-fetch-dialog")).toBeTruthy();
    expect(pendingPermission, "权限代申请应已在点击同步链上发出").toBeTruthy();

    editor.closeProviderEditor(true);
    pendingPermission!({ ok: true });
    await flushMicrotasks();

    expect(sent.filter((message) => message.type === "ai-providers-models")).toEqual([]);
    const { fetchProviderModels } = await import("../../extension/ai/provider-models.js");
    expect(vi.mocked(fetchProviderModels)).not.toHaveBeenCalled();
    expect(document.querySelector(".provider-editor-fetch-dialog")).toBeNull();
  });

  it("S6 runWithOriginPreflight 同步触发权限申请，并在会话关闭时丢弃权限成功回执与后续工作", async () => {
    const editor = await import("../../extension/ui/provider-editor.js");
    const { captureSession } = await import("../../extension/ui/provider-editor-state.js");
    let resolvePermission: ((res: { ok: boolean }) => void) | undefined;
    const requestOriginsMock = vi.fn(
      () => new Promise<{ ok: boolean }>((resolve) => { resolvePermission = resolve; })
    );
    const work = vi.fn(async () => "done");
    const ok = vi.fn();
    const denied = vi.fn();

    editor.openProviderEditor({ kind: "ai", presets: PRESETS, onSave: async () => ({ ok: true }) });
    const session = captureSession();

    const p = session.runWithOriginPreflight(
      ["https://test.example.com"],
      work,
      { ok, denied },
      requestOriginsMock
    );

    expect(requestOriginsMock, "权限代申请必须同步触发").toHaveBeenCalledWith(["https://test.example.com"]);
    expect(work).not.toHaveBeenCalled();

    editor.closeProviderEditor(true);
    resolvePermission!({ ok: true });
    await p;

    expect(work, "会话关闭后不得触发 work").not.toHaveBeenCalled();
    expect(ok).not.toHaveBeenCalled();
    expect(denied).not.toHaveBeenCalled();
  });

  it("S7 runWithOriginPreflight 权限被拒且会话当前时触发 denied 分支", async () => {
    const editor = await import("../../extension/ui/provider-editor.js");
    const { captureSession } = await import("../../extension/ui/provider-editor-state.js");
    const requestOriginsMock = vi.fn(async () => ({ ok: false, error: "用户取消授权" }));
    const work = vi.fn(async () => "done");
    const ok = vi.fn();
    const denied = vi.fn();

    editor.openProviderEditor({ kind: "ai", presets: PRESETS, onSave: async () => ({ ok: true }) });
    const session = captureSession();

    await session.runWithOriginPreflight(
      ["https://test.example.com"],
      work,
      { ok, denied },
      requestOriginsMock
    );

    expect(denied).toHaveBeenCalledWith("用户取消授权");
    expect(work).not.toHaveBeenCalled();
    expect(ok).not.toHaveBeenCalled();
  });

  it("S8 「获取可用模型」拉取在飞时关子视图重开：旧回执不覆盖新子视图（票 09 代次令牌）", async () => {
    const editor = await import("../../extension/ui/provider-editor.js");
    const { fetchProviderModels } = await import("../../extension/ai/provider-models.js");
    let resolveA: ((result: { ok: boolean; models?: string[] }) => void) | undefined;
    let resolveB: ((result: { ok: boolean; models?: string[] }) => void) | undefined;
    vi.mocked(fetchProviderModels)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));

    editor.openProviderEditor({ kind: "ai", presets: PRESETS, onSave: async () => ({ ok: true }) });
    const dialog = dialogNode();
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");

    fireClick(dialog.querySelector(".provider-editor-fetch"));
    await flushMicrotasks();
    expect(document.querySelector(".provider-editor-fetch-dialog")).toBeTruthy();
    fireClick(document.querySelector(".provider-editor-fetch-cancel"));
    expect(document.querySelector(".provider-editor-fetch-dialog")).toBeNull();

    fireClick(dialog.querySelector(".provider-editor-fetch"));
    await flushMicrotasks();
    expect(document.querySelector(".provider-editor-fetch-dialog")).toBeTruthy();
    expect(vi.mocked(fetchProviderModels), "重开的子视图应发起新拉取").toHaveBeenCalledTimes(2);

    resolveA!({ ok: true, models: ["stale-model"] });
    await flushMicrotasks();
    expect(document.querySelector('.provider-editor-fetch-check[value="stale-model"]')).toBeNull();

    resolveB!({ ok: true, models: ["fresh-model"] });
    await flushMicrotasks();
    expect(document.querySelector('.provider-editor-fetch-check[value="fresh-model"]')).toBeTruthy();
  });
});

describe("provider-editor 对外窄接口（initialFocusField / stashProviderEditorDraft）", () => {
  it("initialFocusField 支持打开后直聚焦 apiKey 或 models 控件", async () => {
    const editor = await import("../../extension/ui/provider-editor.js");

    editor.openProviderEditor({
      kind: "ai",
      presets: PRESETS,
      onSave: async () => ({ ok: true }),
      initialFocusField: "apiKey"
    });
    expect(document.activeElement).toBe(document.querySelector(".provider-editor-apikey"));

    editor.openProviderEditor({
      kind: "ai",
      presets: PRESETS,
      onSave: async () => ({ ok: true }),
      initialFocusField: "models"
    });
    expect(document.activeElement).toBe(document.querySelector('[data-provider-editor-action="add-model"]'));

    editor.openProviderEditor({
      kind: "asr",
      presets: PRESETS,
      onSave: async () => ({ ok: true }),
      initialFocusField: "models"
    });
    expect(document.activeElement).toBe(document.querySelector(".provider-editor-model"));
  });

  it("stashProviderEditorDraft 仅在对应消费族会话打开时返回深拷贝草稿与基线", async () => {
    const editor = await import("../../extension/ui/provider-editor.js");

    expect(editor.stashProviderEditorDraft("live")).toBeNull();

    editor.openProviderEditor({
      kind: "search",
      item: { id: "s_1", presetId: "tavily", name: "Tavily", type: "tavily", baseUrl: "https://api.tavily.com", hasSavedKey: false },
      presets: [{ id: "tavily", name: "Tavily", type: "tavily", baseUrl: "https://api.tavily.com", requiresKey: false }],
      onSave: async () => ({ ok: true })
    });

    expect(editor.stashProviderEditorDraft("live")).toBeNull();
    setFieldValue(dialogNode().querySelector<HTMLInputElement>(".provider-editor-name")!, "自定义搜索");

    const stash = editor.stashProviderEditorDraft("search")!;
    expect(stash).toMatchObject({
      editingId: "s_1",
      draft: { name: "自定义搜索" },
      baseline: { name: "Tavily" }
    });

    stash.draft.name = "外部篡改";
    expect(editor.stashProviderEditorDraft("search")?.draft.name).toBe("自定义搜索");

    editor.closeProviderEditor(true);
    expect(editor.stashProviderEditorDraft("search")).toBeNull();
  });
});
