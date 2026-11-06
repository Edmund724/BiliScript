import { beforeEach, describe, expect, it } from "vitest";
import { resetModuleState } from "../setup.js";
import type { EditorDraft } from "../../extension/ui/provider-editor-state.js";
import type { ProviderRowPreset } from "../../extension/ui/provider-row.js";
import { projectEditorFields, projectionBlocks } from "../../extension/ui/provider-editor-projection.js";

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
    expect(projectionBlocks(draft("gemini-live"), ctx).apiKey).toContain("hidden");
    expect(projectionBlocks(draft("moss-live"), ctx).apiKey).not.toContain("hidden");
  });
});
