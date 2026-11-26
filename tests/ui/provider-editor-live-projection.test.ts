import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderRowItem, ProviderRowPreset } from "../../extension/ui/provider-row.js";

const mocks = vi.hoisted(() => ({
  listLiveVoices: vi.fn(async (): Promise<{ ok: boolean; voices: { id: string; name?: string }[] }> => ({
    ok: true,
    voices: [
      { id: "voice-1", name: "Alice" },
      { id: "voice-2", name: "voice-2" }
    ]
  }))
}));

vi.mock("../../extension/live/live-provider-probe.js", () => ({
  listLiveVoices: mocks.listLiveVoices,
  listLiveModels: vi.fn(async () => ({ ok: false, error: "not used" })),
  testLiveConnection: vi.fn(async () => ({ ok: true }))
}));

import { closeProviderEditor, openProviderEditor } from "../../extension/ui/provider-editor.js";
import { flushMicrotasks, resetProviderEditorState, waitForFast } from "../helpers/reset-provider-editor-state.js";

const LIVE_PRESETS: ProviderRowPreset[] = [
  {
    id: "moss-live",
    name: "MOSS Live",
    type: "moss-live",
    baseUrl: "https://api.mosi.cn",
    model: "moss-live-1.0",
    requiresKey: true
  },
  {
    id: "gemini-live",
    name: "Gemini Live",
    type: "gemini-live",
    baseUrl: "https://generativelanguage.googleapis.com",
    model: "gemini-3.8-live",
    requiresKey: false
  }
];

function mountView(): void {
  document.body.innerHTML = `
    <div id="biliscript-reading-view">
      <section id="biliscript-reading-settings-panel"></section>
    </div>`;
}

function fireClick(node: Element | null): void {
  node!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  resetProviderEditorState();
  mountView();
  mocks.listLiveVoices.mockReset().mockResolvedValue({
    ok: true,
    voices: [
      { id: "voice-1", name: "Alice" },
      { id: "voice-2", name: "voice-2" }
    ]
  });
});

afterEach(() => {
  closeProviderEditor(true);
});

describe("Gemini Live 编辑器 Key 与原生搜索字段投影", () => {
  it("选中 gemini-live 时隐藏 Key 且不要求手填，切回 moss-live 恢复显示 Key", () => {
    openProviderEditor({
      kind: "live",
      presetId: "gemini-live",
      presets: LIVE_PRESETS,
      onSave: async () => ({ ok: true })
    });

    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    const apiKeyInput = dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!;
    const apiKeyField = apiKeyInput.closest<HTMLElement>(".provider-editor-field")!;
    const voiceField = dialog.querySelector<HTMLElement>(".provider-editor-field-voice")!;
    const geminiSearchField = dialog.querySelector<HTMLElement>(".provider-editor-field-gemini-search")!;

    expect(apiKeyField.hidden).toBe(true);
    expect(apiKeyInput.required).toBe(false);
    expect(voiceField.hidden).toBe(true);
    expect(geminiSearchField.hidden).toBe(false);

    const presetSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!;
    presetSelect.value = "moss-live";
    presetSelect.dispatchEvent(new Event("change"));

    expect(apiKeyField.hidden).toBe(false);
    expect(apiKeyInput.required).toBe(true);
    expect(voiceField.hidden).toBe(false);
    expect(geminiSearchField.hidden).toBe(true);
  });
});

describe("MOSS-LIVE 音色字段投影与落盘", () => {
  it("moss-live 渲染音色下拉，选项显示 name，选中项来自已有记录", async () => {
    openProviderEditor({
      kind: "live",
      item: {
        id: "live_1",
        presetId: "moss-live",
        name: "MOSS Live",
        type: "moss-live",
        baseUrl: "https://api.mosi.cn",
        model: "moss-live-1.0",
        voiceId: "voice-2",
        hasSavedKey: true
      },
      presets: LIVE_PRESETS,
      onSave: async () => ({ ok: true })
    });

    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    const voiceField = dialog.querySelector<HTMLElement>(".provider-editor-field-voice")!;
    const voiceSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-voice")!;

    expect(voiceField.hidden).toBe(false);
    await waitForFast(() => {
      expect(Array.from(voiceSelect.options).map((option) => option.textContent)).toEqual([
        "默认音色",
        "Alice",
        "voice-2"
      ]);
    });
    expect(voiceSelect.value).toBe("voice-2");
  });

  it("音色列表未取到时仅剩默认音色与已存值", async () => {
    mocks.listLiveVoices.mockResolvedValueOnce({ ok: false, voices: [] });
    openProviderEditor({
      kind: "live",
      item: {
        id: "live_1",
        presetId: "moss-live",
        name: "MOSS Live",
        type: "moss-live",
        baseUrl: "https://api.mosi.cn",
        model: "moss-live-1.0",
        voiceId: "voice-old",
        hasSavedKey: true
      },
      presets: LIVE_PRESETS,
      onSave: async () => ({ ok: true })
    });

    await flushMicrotasks();
    const voiceSelect = document.querySelector<HTMLSelectElement>(".provider-editor-voice")!;
    expect(Array.from(voiceSelect.options).map((option) => option.value)).toEqual(["", "voice-old"]);
    expect(Array.from(voiceSelect.options).map((option) => option.textContent)).toEqual(["默认音色", "voice-old"]);
    expect(voiceSelect.value).toBe("voice-old");
  });

  it("保存时音色 ID 按 provider 落盘，Gemini 平台不写音色并落盘原生搜索开关", async () => {
    const onSave = vi.fn(async (_kind: string, _upsert: ProviderRowItem) => ({ ok: true }));
    openProviderEditor({
      kind: "live",
      item: {
        id: "live_1",
        presetId: "moss-live",
        name: "MOSS Live",
        type: "moss-live",
        baseUrl: "https://api.mosi.cn",
        model: "moss-live-1.0",
        voiceId: " voice-1 ",
        hasSavedKey: true
      },
      presets: LIVE_PRESETS,
      onSave
    });

    await flushMicrotasks();
    fireClick(document.querySelector(".provider-editor-save"));
    await waitForFast(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][1].voiceId).toBe("voice-1");
    expect(onSave.mock.calls[0][1].liveGeminiNativeSearch).toBeUndefined();

    openProviderEditor({
      kind: "live",
      item: {
        id: "live_2",
        presetId: "gemini-live",
        name: "Gemini Live",
        type: "gemini-live",
        baseUrl: "https://generativelanguage.googleapis.com",
        model: "gemini-3.8-live",
        voiceId: "voice-1",
        liveGeminiNativeSearch: false,
        hasSavedKey: true
      },
      presets: LIVE_PRESETS,
      onSave
    });

    const toggle = document.querySelector<HTMLInputElement>(".provider-editor-gemini-search")!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    fireClick(document.querySelector(".provider-editor-save"));
    await waitForFast(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1][1].voiceId).toBeUndefined();
    expect(onSave.mock.calls[1][1].liveGeminiNativeSearch).toBe(true);
  });
});
