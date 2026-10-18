// core/presets.ts 的预设端点查表单源叶直测：presetBaseUrlForProtocol（预设级，
// 「预览选中协议」语义）与 effectivePresetBaseUrl（记录级生效端点：记录自有
// baseUrl 优先 → 协议缺省链 record.protocol → preset.protocol → "openai" 查表）。
// 两个消费方（search/deepseek-credential 的官方端点判定、ui/provider-editor-projection
// 的 re-export）共用这一份实现——两侧不允许各写一份。

import { describe, expect, it } from "vitest";
import { effectivePresetBaseUrl, presetBaseUrlForProtocol } from "../../extension/core/presets.js";

const PRESET = {
  id: "deepseek",
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com/v1",
  requiresKey: true,
  protocol: "anthropic",
  protocolBaseUrls: { anthropic: "https://api.deepseek.com/anthropic" }
};

describe("presetBaseUrlForProtocol（预设级协议端点查表）", () => {
  it("protocolBaseUrls 登记了该协议 → 用登记值", () => {
    expect(presetBaseUrlForProtocol(PRESET, "anthropic")).toBe("https://api.deepseek.com/anthropic");
  });

  it("未登记的协议 → 回落预设 baseUrl（含 unknown protocol miss）", () => {
    expect(presetBaseUrlForProtocol(PRESET, "gemini")).toBe("https://api.deepseek.com/v1");
    expect(presetBaseUrlForProtocol(PRESET, "bogus-protocol")).toBe("https://api.deepseek.com/v1");
  });

  it("空 preset / 非字符串协议 → 空串或回落 baseUrl", () => {
    expect(presetBaseUrlForProtocol(null, "anthropic")).toBe("");
    expect(presetBaseUrlForProtocol(undefined, undefined)).toBe("");
    expect(presetBaseUrlForProtocol(PRESET, undefined)).toBe("https://api.deepseek.com/v1");
  });
});

describe("effectivePresetBaseUrl（记录级生效端点）", () => {
  it("记录自有 baseUrl（trim 后非空）优先，不看协议", () => {
    expect(
      effectivePresetBaseUrl({ baseUrl: " https://proxy.example.com/v1 ", protocol: "gemini" }, PRESET)
    ).toBe("https://proxy.example.com/v1");
  });

  it("记录 baseUrl 为空 → 按 record.protocol 查表", () => {
    expect(effectivePresetBaseUrl({ baseUrl: "", protocol: "anthropic" }, PRESET)).toBe("https://api.deepseek.com/anthropic");
  });

  it("记录 baseUrl 空白 / 缺失 → preset.protocol 回落", () => {
    expect(effectivePresetBaseUrl({ baseUrl: "   " }, PRESET)).toBe("https://api.deepseek.com/anthropic");
    expect(effectivePresetBaseUrl({}, PRESET)).toBe("https://api.deepseek.com/anthropic");
  });

  it("record.protocol 与 preset.protocol 都缺省 → openai 兜底查表（miss 落 baseUrl）", () => {
    const noProtocolPreset = { ...PRESET, protocol: undefined };
    expect(effectivePresetBaseUrl({ protocol: "" }, noProtocolPreset)).toBe("https://api.deepseek.com/v1");
  });

  it("record.protocol 为未知值 → 查表落空回落 baseUrl", () => {
    expect(effectivePresetBaseUrl({ protocol: "bogus" }, PRESET)).toBe("https://api.deepseek.com/v1");
  });

  it("空 preset → 空串", () => {
    expect(effectivePresetBaseUrl({ baseUrl: "" }, undefined)).toBe("");
    expect(effectivePresetBaseUrl({}, null)).toBe("");
  });
});
