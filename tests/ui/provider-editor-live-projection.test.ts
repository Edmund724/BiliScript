import { beforeEach, describe, expect, it } from "vitest";
import { resetModuleState } from "../setup.js";
import type { EditorDraft } from "../../extension/ui/provider-editor-state.js";
import type { ProviderRowPreset } from "../../extension/ui/provider-row.js";
import { projectEditorFields, projectionBlocks } from "../../extension/ui/provider-editor-projection.js";
import { PROVIDER_FAMILY_ROWS } from "../../extension/ui/provider-family.js";

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

function draft(presetId: string): EditorDraft {
  const preset = LIVE_PRESETS.find((item) => item.id === presetId)!;
  return {
    presetId,
    name: preset.name,
    baseUrl: preset.baseUrl,
    apiKey: "",
    protocol: "",
    models: [],
    model: preset.model || ""
  };
}

beforeEach(() => {
  resetModuleState();
});

describe("Gemini Live 编辑器 Key 字段投影", () => {
  it("选中 gemini-live 时隐藏 Key 且不要求手填", () => {
    const ctx = { kind: "live" as const, presets: LIVE_PRESETS, hasSavedKey: false };
    const fields = projectEditorFields(draft("gemini-live"), ctx);
    expect(fields.apiKey.hidden).toBe(true);
    expect(fields.apiKey.required).not.toBe(true);
    const fieldOf = (html: string): HTMLElement => {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = html;
      return wrapper.firstElementChild as HTMLElement;
    };
    expect(fieldOf(projectionBlocks(draft("gemini-live"), ctx).apiKey).hidden).toBe(true);
    expect(fieldOf(projectionBlocks(draft("moss-live"), ctx).apiKey).hidden).toBe(false);
  });
});

describe("MOSS-LIVE 音色字段投影与落盘", () => {
  const voices = [
    { id: "voice-1", name: "Alice" },
    { id: "voice-2", name: "voice-2" }
  ];

  it("moss-live 渲染音色下拉，选项显示 name，选中项来自草稿", () => {
    const ctx = { kind: "live" as const, presets: LIVE_PRESETS, hasSavedKey: true, voices };
    const mossDraft = { ...draft("moss-live"), voiceId: "voice-2" };

    expect(projectEditorFields(mossDraft, ctx).voice).toMatchObject({
      hidden: false,
      value: "voice-2"
    });
    const html = projectionBlocks(mossDraft, ctx).voice;
    expect(html).toContain("provider-editor-voice");
    expect(html).toContain("Alice");
    expect(html).toContain("默认音色");
    expect(html).toContain('value="voice-2" selected');
  });

  it("gemini-live 不渲染音色字段；列表未取到时仅剩默认音色与已存值", () => {
    const geminiCtx = { kind: "live" as const, presets: LIVE_PRESETS, hasSavedKey: true, voices };
    expect(projectEditorFields(draft("gemini-live"), geminiCtx).voice.hidden).toBe(true);

    const emptyCtx = { kind: "live" as const, presets: LIVE_PRESETS, hasSavedKey: true };
    const html = projectionBlocks({ ...draft("moss-live"), voiceId: "voice-old" }, emptyCtx).voice;
    expect(html).toContain("默认音色");
    expect(html).toContain("voice-old");
  });

  it("保存时音色 ID 按 provider 落盘，Gemini 平台不写音色", () => {
    const baseFields = {
      id: "live_1",
      name: "MOSS Live",
      baseUrl: "https://api.mosi.cn",
      apiKey: "",
      hasSavedKey: true,
      models: [] as string[],
      model: "moss-live-1.0",
      protocol: "openai" as const
    };
    const moss = PROVIDER_FAMILY_ROWS.live.editor.serializeUpsert({
      ...baseFields,
      preset: LIVE_PRESETS[0],
      voiceId: " voice-1 "
    });
    expect(moss.upsert.voiceId).toBe("voice-1");

    const gemini = PROVIDER_FAMILY_ROWS.live.editor.serializeUpsert({
      ...baseFields,
      preset: LIVE_PRESETS[1],
      voiceId: "voice-1"
    });
    expect(gemini.upsert.voiceId).toBeUndefined();
  });
});
