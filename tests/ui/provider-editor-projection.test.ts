import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSettingsPanelBus } from "../helpers/settings-panel-bus.js";

const mocks = vi.hoisted(() => ({
  fetchProviderModels: vi.fn(async (): Promise<{ ok: boolean; models?: string[]; error?: string }> => ({
    ok: true,
    models: []
  }))
}));

vi.mock("../../extension/ai/provider-models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/ai/provider-models.js")>();
  return {
    ...actual,
    fetchProviderModels: mocks.fetchProviderModels
  };
});

import { closeProviderEditor, openProviderEditor } from "../../extension/ui/provider-editor.js";
import type { ProviderRowPreset } from "../../extension/ui/provider-row.js";
import { renderReaderSettingsPanel } from "../../extension/ui/settings-panel.js";
import { closeConfirmDialog } from "../../extension/ui/confirm-dialog.js";
import { flushMicrotasks, resetSettingsPanelState, waitForFast } from "../helpers/reset-settings-panel-state.js";

const AI_PRESETS: ProviderRowPreset[] = [
  { id: "custom", name: "自定义", baseUrl: "", requiresKey: true },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    requiresKey: true,
    protocol: "anthropic",
    protocolBaseUrls: { anthropic: "https://api.deepseek.com/anthropic" }
  },
  { id: "ollama", name: "Ollama (本地)", baseUrl: "http://localhost:11434/v1", requiresKey: false }
];

const ASR_PRESETS: ProviderRowPreset[] = [
  { id: "custom", name: "自定义", baseUrl: "", model: "", requiresKey: true },
  { id: "local-whisper", name: "本地 Whisper 服务", baseUrl: "http://localhost:8000/v1", model: "whisper-large-v3", requiresKey: false }
];

const LIVE_PRESETS: ProviderRowPreset[] = [
  { id: "moss-live", name: "MOSS Live", type: "moss-live", baseUrl: "https://api.mosi.cn", model: "moss-live-1.0", requiresKey: true },
  { id: "gemini-live", name: "Gemini Live", type: "gemini-live", baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-3.8-live", requiresKey: false }
];

type MessageResponder = (message: { type: string } & Record<string, any>) => unknown;

function installMessageBus(overrides: Record<string, MessageResponder> = {}) {
  const host = installSettingsPanelBus<{ type: string } & Record<string, any>>({
    "ai-providers-save": () => ({ ok: true, providers: [] }),
    "asr-providers-save": () => ({ ok: true, providers: [] }),
    "request-provider-origins": () => ({ ok: true }),
    ...overrides
  });
  return host.sent;
}

function mountView(): void {
  document.body.innerHTML = `
    <div id="biliscript-reading-view">
      <section id="biliscript-reading-settings-panel">
        <div id="biliscript-reading-settings-host"></div>
      </section>
    </div>`;
}

async function mountPanel(busOverrides: Record<string, MessageResponder> = {}) {
  mountView();
  const sent = installMessageBus(busOverrides);
  await renderReaderSettingsPanel();
  const host = document.getElementById("biliscript-reading-settings-host")!;
  const sendMessage = (chrome as unknown as { runtime: { sendMessage: { mock: { calls: [{ type: string }][] } } } }).runtime.sendMessage;
  expect(sendMessage.mock.calls.some(([message]) => message.type === "asr-providers-list")).toBe(true);
  return { sent, host };
}

async function openEditorFromPanel(host: HTMLElement, buttonSelector: string) {
  host.querySelector(buttonSelector)!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await waitForFast(() => {
    expect(document.querySelector(".provider-editor-dialog")).toBeTruthy();
  });
  return document.querySelector<HTMLElement>(".provider-editor-dialog")!;
}

function fireClick(node: Element | null) {
  node!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function setFieldValue(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  resetSettingsPanelState();
  mocks.fetchProviderModels.mockReset().mockResolvedValue({ ok: true, models: [] });
});

afterEach(() => {
  closeConfirmDialog();
  closeProviderEditor(true);
});

describe("字段投影：经对外接口观测初始渲染与联动重投影", () => {
  it("AI 打开预填与预设切换：preset / protocol trigger / name 占位 / baseUrl / apiKey / protocolNotes / catalogEmpty 同步更新", () => {
    mountView();
    openProviderEditor({
      kind: "ai",
      item: {
        id: "p_1",
        presetId: "deepseek",
        name: "我的端点",
        baseUrl: "https://api.deepseek.com/anthropic",
        protocol: "anthropic",
        models: ["deepseek-v4-pro"],
        hasSavedKey: false
      },
      presets: AI_PRESETS,
      onSave: async () => ({ ok: true })
    });

    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    const presetSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!;
    const protocolSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-protocol")!;
    const protocolWrapper = protocolSelect.closest<HTMLElement>(".custom-select-wrapper")!;
    const nameInput = dialog.querySelector<HTMLInputElement>(".provider-editor-name")!;
    const baseUrlInput = dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!;
    const apiKeyInput = dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!;
    const protocolNotes = dialog.querySelector<HTMLElement>(".provider-editor-protocol-notes")!;
    const catalogEmpty = dialog.querySelector<HTMLElement>(".provider-editor-catalog-empty")!;

    expect(presetSelect.value).toBe("deepseek");
    expect(protocolSelect.value).toBe("anthropic");
    expect(protocolWrapper.querySelector(".custom-select-value")!.textContent).toBe("Anthropic Messages");
    expect(nameInput.value).toBe("我的端点");
    expect(nameInput.placeholder).toBe("DeepSeek");
    expect(baseUrlInput.value).toBe("https://api.deepseek.com/anthropic");
    expect(apiKeyInput.placeholder).toBe("API Key");
    expect(apiKeyInput.required).toBe(true);
    expect(protocolNotes.hidden).toBe(true);
    expect(catalogEmpty.hidden).toBe(true);

    protocolSelect.value = "openai";
    protocolSelect.dispatchEvent(new Event("change"));
    expect(baseUrlInput.value).toBe("https://api.deepseek.com/v1");

    presetSelect.value = "ollama";
    presetSelect.dispatchEvent(new Event("change"));
    fireClick(dialog.querySelector(".provider-editor-model-remove"));

    expect(protocolSelect.value).toBe("openai");
    expect(protocolWrapper.querySelector(".custom-select-value")!.textContent).toBe("OpenAI Chat Completions");
    expect(nameInput.placeholder).toBe("Ollama (本地)");
    expect(baseUrlInput.value).toBe("http://localhost:11434/v1");
    expect(apiKeyInput.placeholder).toBe("API Key（可选）");
    expect(apiKeyInput.required).toBe(false);
    expect(catalogEmpty.hidden).toBe(false);
  });

  it("ASR 形态：单模型输入必填、暂存草稿 apiKey 回填且切免 Key 预设清空 Key", () => {
    mountView();
    openProviderEditor({
      kind: "asr",
      presets: ASR_PRESETS,
      initialDraft: {
        presetId: "custom",
        name: "本地",
        baseUrl: "http://localhost:8000/v1",
        apiKey: "sk-stashed",
        protocol: "",
        models: [],
        model: "whisper-large-v3"
      },
      onSave: async () => ({ ok: true })
    });

    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    const modelInput = dialog.querySelector<HTMLInputElement>(".provider-editor-model")!;
    const apiKeyInput = dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!;
    expect(modelInput.value).toBe("whisper-large-v3");
    expect(modelInput.required).toBe(true);
    expect(apiKeyInput.value).toBe("sk-stashed");
    expect(apiKeyInput.required).toBe(true);

    const presetSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!;
    presetSelect.value = "local-whisper";
    presetSelect.dispatchEvent(new Event("change"));
    expect(apiKeyInput.value).toBe("");
    expect(apiKeyInput.required).toBe(false);
  });

  it("批量从「获取可用模型」确认添加：一次事务写入全部新模型并清错、隐藏空态", async () => {
    mountView();
    installMessageBus();
    mocks.fetchProviderModels.mockResolvedValueOnce({
      ok: true,
      models: ["gpt-4o-mini", "gpt-4o", "o3-mini"]
    });
    openProviderEditor({
      kind: "ai",
      firstSetup: true,
      presets: AI_PRESETS,
      onSave: async () => ({ ok: true })
    });

    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    fireClick(dialog.querySelector(".provider-editor-save"));
    expect(document.getElementById("provider-editor-error-models")!.hidden).toBe(false);

    fireClick(dialog.querySelector(".provider-editor-fetch"));
    await waitForFast(() => {
      expect(document.querySelectorAll(".provider-editor-fetch-item")).toHaveLength(3);
    });
    fireClick(document.querySelector(".provider-editor-fetch-all"));
    fireClick(document.querySelector(".provider-editor-fetch-confirm"));
    await flushMicrotasks();

    expect(document.querySelector(".provider-editor-fetch-dialog")).toBeNull();
    expect(
      Array.from(dialog.querySelectorAll<HTMLInputElement>(".provider-editor-model-id")).map((input) => input.value)
    ).toEqual(["gpt-4o-mini", "gpt-4o", "o3-mini"]);
    expect(dialog.querySelector<HTMLElement>(".provider-editor-catalog-empty")!.hidden).toBe(true);
    expect(document.getElementById("provider-editor-error-models")!.hidden).toBe(true);
    expect(dialog.querySelector<HTMLElement>(".provider-editor-status")!.hidden).toBe(true);
  });
});

describe("draft 脏检测覆盖全部可编辑字段（经取消确认框观测）", () => {
  it("models 顺序调整判脏，恢复原序后不再判脏", async () => {
    mountView();
    openProviderEditor({
      kind: "ai",
      item: {
        id: "p_1",
        presetId: "custom",
        name: "端点",
        baseUrl: "https://api.example.com/v1",
        models: ["a", "b"],
        hasSavedKey: true
      },
      presets: AI_PRESETS,
      onSave: async () => ({ ok: true })
    });

    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    const inputs = dialog.querySelectorAll<HTMLInputElement>(".provider-editor-model-id");
    setFieldValue(inputs[0], "b");
    setFieldValue(inputs[1], "a");

    fireClick(dialog.querySelector(".provider-editor-cancel"));
    expect(document.querySelector(".confirm-dialog-host")).not.toBeNull();
    fireClick(document.querySelector(".confirm-dialog-cancel"));
    await waitForFast(() => expect(document.querySelector(".confirm-dialog-host")).toBeNull());

    setFieldValue(inputs[0], "a");
    setFieldValue(inputs[1], "b");
    fireClick(dialog.querySelector(".provider-editor-cancel"));
    expect(document.querySelector(".confirm-dialog-host")).toBeNull();
    expect(document.querySelector(".provider-editor-dialog")).toBeNull();
  });

  it("Live 专属字段（liveGeminiNativeSearch / voiceId）变更均触发脏保护", async () => {
    mountView();
    openProviderEditor({
      kind: "live",
      item: {
        id: "live_1",
        presetId: "gemini-live",
        name: "Gemini Live",
        type: "gemini-live",
        baseUrl: "https://generativelanguage.googleapis.com",
        model: "gemini-3.8-live",
        liveGeminiNativeSearch: false,
        hasSavedKey: false
      },
      presets: LIVE_PRESETS,
      onSave: async () => ({ ok: true })
    });

    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    const toggle = dialog.querySelector<HTMLInputElement>(".provider-editor-gemini-search")!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));

    fireClick(dialog.querySelector(".provider-editor-cancel"));
    expect(document.querySelector(".confirm-dialog-host")).not.toBeNull();
    closeConfirmDialog();
    closeProviderEditor(true);

    openProviderEditor({
      kind: "live",
      item: {
        id: "live_2",
        presetId: "moss-live",
        name: "MOSS Live",
        type: "moss-live",
        baseUrl: "https://api.mosi.cn",
        model: "moss-live-1.0",
        voiceId: "voice-1",
        hasSavedKey: true
      },
      presets: LIVE_PRESETS,
      onSave: async () => ({ ok: true })
    });

    const mossDialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    const voiceSelect = mossDialog.querySelector<HTMLSelectElement>(".provider-editor-voice")!;
    voiceSelect.value = "";
    voiceSelect.dispatchEvent(new Event("change"));

    fireClick(mossDialog.querySelector(".provider-editor-cancel"));
    expect(document.querySelector(".confirm-dialog-host")).not.toBeNull();
  });
});

describe("输入回写与联动（真实设置面板路径）", () => {
  it.each([
    ["name", "#addAiProviderBtn", ".provider-editor-name", "我的端点"],
    ["baseUrl", "#addAiProviderBtn", ".provider-editor-baseurl", "https://api.example.com/v1"],
    ["apiKey", "#addAiProviderBtn", ".provider-editor-apikey", "sk-test"],
    ["model", "#addAsrProviderBtn", ".provider-editor-model", "whisper-1"]
  ])("%s 经 input 事件写入即判脏（回写漏字段即红）", async (_key, button, selector, value) => {
    const { host } = await mountPanel();
    const dialog = await openEditorFromPanel(host, button);

    dialog.querySelector(".provider-editor-cancel")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(document.querySelector(".confirm-dialog-host"), "未改动前取消不应弹放弃确认").toBeNull();
    expect(document.querySelector(".provider-editor-dialog")).toBeNull();

    const reopened = await openEditorFromPanel(host, button);
    setFieldValue(reopened.querySelector<HTMLInputElement>(selector)!, value);
    reopened.querySelector(".provider-editor-cancel")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(document.querySelector(".confirm-dialog-host"), "输入后取消必须触发未保存放弃确认").not.toBeNull();
  });

  it("预设切换走自定义下拉：联动结果写入 draft 并随保存落盘（只改 DOM 会落旧值）", async () => {
    const { sent, host } = await mountPanel();
    const dialog = await openEditorFromPanel(host, "#addAiProviderBtn");

    const presetSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!;
    const wrapper = presetSelect.closest<HTMLElement>(".custom-select-wrapper")!;
    wrapper
      .querySelector<HTMLElement>('.custom-select-option[data-value="deepseek"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(presetSelect.value).toBe("deepseek");
    expect(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!.value).toBe(
      "https://api.deepseek.com/anthropic"
    );

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    dialog.querySelector(".provider-editor-save")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitForFast(() => {
      expect(sent.some((message) => message.type === "ai-providers-save")).toBe(true);
    });
    const saveMessage = sent.find((message) => message.type === "ai-providers-save")!;
    expect(saveMessage.providers[0]).toMatchObject({
      presetId: "deepseek",
      baseUrl: "https://api.deepseek.com/anthropic",
      protocol: "anthropic"
    });
  });
});
