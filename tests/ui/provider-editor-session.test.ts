// tests/ui/provider-editor-session.test.ts
// owner 2「结算原语」的行为契约：一次编辑会话的代际 + open + 存活判据由
// captureSession / runIfCurrent 自持，过期回执静默丢弃。
//
// 先列失败方式（每条对应下面一个用例）：
//   S1 保存中途关 Modal：回执落定时会话已关 → 不得写状态行、不得重开；
//   S2 关旧开新：旧会话的过期回执不得覆盖新一轮编辑的状态行（漏比代际即红）；
//   S3 探针在飞时关旧开新：ASR 探针回执同样不得写新会话状态行；
//   S4 行级测试在飞时删行：行已脱离文档 → 回执不得写已删行（存活判据）；
//   S5 「获取可用模型」权限在飞时关 Modal：权限回执不得触发模型请求
//      （弹窗存活判据）。
//
// 驱动方式：直接 openProviderEditor + 受控 Promise，不经设置面板。

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

// 「获取可用模型」直调 content 壳（ai/provider-models.js），整体 mock 隔离传输层。
vi.mock("../../extension/ai/provider-models.js", () => ({
  fetchProviderModels: vi.fn(async () => ({ ok: true, models: [] }))
}));

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
});
