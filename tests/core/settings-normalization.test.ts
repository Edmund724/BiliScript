// 设置归一化唯一收口测试：
// - normalizeSettings 是唯一的归一化路径：getMergedSettings（读）、saveSettings
//   （写）、background 的 initializeSettingsStorage（安装/更新迁移）输出一致；
// - initializeSettingsStorage 落盘的是归一化后的值：存量 LEGACY 默认提示词与
//   非法 aiThinkingLevel 在安装/更新时被一次性改写，而不是每次读取时再映射。

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { resetModuleState } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import {
  DEFAULT_AI_SYSTEM_PROMPT,
  DEFAULT_INITIAL_QUICK_PROMPTS,
  DEFAULT_PLAYER_AI_QUICK_PROMPT,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V2,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V3,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V4,
  LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT,
  LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V2
} from "../../extension/core/default-prompts.js";

let syncGetMock: Mock;
let syncSetMock: Mock;

async function loadStoreModule() {
  return import("../../extension/core/settings-store.js");
}

beforeEach(() => {
  resetModuleState();
  syncGetMock = vi.fn(async (defaults) => ({ ...defaults }));
  syncSetMock = vi.fn(async () => {});
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    runtime: {
      ...globalThis.chrome?.runtime,
      getManifest: vi.fn(() => ({ version: "2.0.0" })),
      onInstalled: { addListener: vi.fn() }
    },
    tabs: {
      ...globalThis.chrome?.tabs,
      onUpdated: { addListener: vi.fn() }
    },
    storage: {
      ...globalThis.chrome?.storage,
      sync: {
        ...globalThis.chrome?.storage?.sync,
        get: syncGetMock,
        set: syncSetMock
      }
    }
  });
});

describe("normalizeSettings 纯函数", () => {
  it("LEGACY 默认提示词映射为当前默认，非法 aiThinkingLevel 回落 off", async () => {
    const { normalizeSettings } = await loadStoreModule();
    const out = normalizeSettings({
      ...DEFAULT_SETTINGS,
      aiSystemPrompt: LEGACY_DEFAULT_AI_SYSTEM_PROMPT,
      aiThinkingLevel: "bogus"
    });
    expect(out.aiSystemPrompt).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(out.aiThinkingLevel).toBe("off");
  });

  it("返回新对象且不改入参，非受管字段原样保留", async () => {
    const { normalizeSettings } = await loadStoreModule();
    const input = { ...DEFAULT_SETTINGS, unknownKey: "passthrough", downloadFormat: "vtt" };
    const out = normalizeSettings(input);
    expect(out).not.toBe(input);
    expect(input.downloadFormat).toBe("vtt");
    expect(out.downloadFormat).toBe("srt");
    expect(out.unknownKey).toBe("passthrough");
  });

  // 笔记导出功能删除（导出的 Markdown 只剩简介/章节/字幕）：被删字段退出
  // DEFAULT_SETTINGS 键面，旧存储里残留的这些键在写路径被白名单丢弃——不需要
  // 迁移，白名单取 DEFAULT_SETTINGS 键集天然收敛。
  it("笔记导出字段已退出设置键面：DEFAULT_SETTINGS 不再声明这些键", async () => {
    for (const key of [
      "tags",
      "includeHotCommentsInNote",
      "includePlayerEmbedInNote",
      "frontmatterFields",
      "fixedFrontmatterProperties",
      "notePlaceholderSections"
    ]) {
      expect(Object.keys(DEFAULT_SETTINGS), `DEFAULT_SETTINGS 仍声明 ${key}`).not.toContain(key);
      expect(DEFAULT_SETTINGS[key]).toBeUndefined();
    }
  });

  // 四代历史默认系统提示词一次性升到当前默认；用户自定义文本不动。
  it("aiSystemPrompt：四代历史默认都映射为当前默认，自定义文本原样保留", async () => {
    const { normalizeSettings } = await loadStoreModule();
    for (const legacy of [LEGACY_DEFAULT_AI_SYSTEM_PROMPT, LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V2, LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V3, LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V4]) {
      expect(normalizeSettings({ ...DEFAULT_SETTINGS, aiSystemPrompt: legacy }).aiSystemPrompt).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    }
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, aiSystemPrompt: "我的自定义人设" }).aiSystemPrompt).toBe("我的自定义人设");
  });

  // 两代旧默认快捷提示词一次性升到当前默认；用户自定义文本不动。
  it("playerAiQuickPrompt：两代旧默认都映射为当前默认，自定义文本原样保留", async () => {
    const { normalizeSettings } = await loadStoreModule();
    for (const legacy of [LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT, LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V2]) {
      expect(normalizeSettings({ ...DEFAULT_SETTINGS, playerAiQuickPrompt: legacy }).playerAiQuickPrompt).toBe(DEFAULT_PLAYER_AI_QUICK_PROMPT);
    }
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, playerAiQuickPrompt: "按章节整理内容" }).playerAiQuickPrompt).toBe("按章节整理内容");
  });

  // defaults 拆分（first-button-ux/03）：DEFAULT_SETTINGS 的 prompt 字段是空占位，
  // 读路径归一化必须回落当前默认——新装/缺键不能得到空串/空数组。
  it("新装缺键：空占位 prompt 字段经归一化回落当前默认，不落空串/空数组", async () => {
    const { normalizeSettings } = await loadStoreModule();
    const out = normalizeSettings({ ...DEFAULT_SETTINGS });
    expect(out.aiSystemPrompt).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(out.playerAiQuickPrompt).toBe(DEFAULT_PLAYER_AI_QUICK_PROMPT);
    expect(out.aiInitialQuickPrompts).toEqual(DEFAULT_INITIAL_QUICK_PROMPTS);
  });

  // 「清空 prompt 保存 = 恢复默认」：用户把提示词清空后保存，空串（含纯空白）
  // 经归一化改写回当前默认（与 LEGACY 映射同机制，落盘即当前默认文本）。
  it("清空保存：aiSystemPrompt/playerAiQuickPrompt 空串回落当前默认", async () => {
    const { normalizeSettings } = await loadStoreModule();
    const out = normalizeSettings({ ...DEFAULT_SETTINGS, aiSystemPrompt: "  ", playerAiQuickPrompt: "" });
    expect(out.aiSystemPrompt).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(out.playerAiQuickPrompt).toBe(DEFAULT_PLAYER_AI_QUICK_PROMPT);
  });
});

describe("normalizeSettings 是唯一归一化路径", () => {
  it("读路径：getMergedSettings 输出等于对原始合并结果应用 normalizeSettings", async () => {
    const { getMergedSettings, normalizeSettings } = await loadStoreModule();
    const stored = {
      aiSystemPrompt: LEGACY_DEFAULT_AI_SYSTEM_PROMPT,
      aiThinkingLevel: "bogus",
      readerTheme: "not-a-theme",
      unknownKey: "passthrough"
    };
    syncGetMock.mockImplementation(async (defaults) => ({ ...defaults, ...stored }));

    const merged = await getMergedSettings();
    const rawMerge = { ...DEFAULT_SETTINGS, ...stored };
    expect(merged).toEqual(normalizeSettings(rawMerge));
    expect(merged.aiSystemPrompt).toBe(DEFAULT_AI_SYSTEM_PROMPT);
  });

  it("写路径：全量 payload 落盘值等于 normalizeSettings 的输出", async () => {
    const { saveSettings, normalizeSettings } = await loadStoreModule();
    const payload = {
      ...DEFAULT_SETTINGS,
      aiSystemPrompt: LEGACY_DEFAULT_AI_SYSTEM_PROMPT,
      aiThinkingLevel: "bogus"
    };

    await saveSettings(payload);

    expect(syncSetMock).toHaveBeenCalledTimes(1);
    expect(syncSetMock.mock.calls[0][0]).toEqual(normalizeSettings(payload));
    expect(syncSetMock.mock.calls[0][0].aiSystemPrompt).toBe(DEFAULT_AI_SYSTEM_PROMPT);
  });

  // 写路径同款：清空后的空串/空数组不落盘为占位值，落盘即当前默认。
  it("写路径：清空的 prompt 落盘为当前默认而非空串/空数组", async () => {
    const { saveSettings } = await loadStoreModule();

    await saveSettings({
      ...DEFAULT_SETTINGS,
      aiSystemPrompt: "",
      playerAiQuickPrompt: "",
      aiInitialQuickPrompts: []
    });

    expect(syncSetMock).toHaveBeenCalledTimes(1);
    const persisted = syncSetMock.mock.calls[0][0];
    expect(persisted.aiSystemPrompt).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(persisted.playerAiQuickPrompt).toBe(DEFAULT_PLAYER_AI_QUICK_PROMPT);
    expect(persisted.aiInitialQuickPrompts).toEqual(DEFAULT_INITIAL_QUICK_PROMPTS);
  });

  // 笔记导出删除后的写路径收敛：整对象写回里的被删字段（旧存储残留 / 陈旧
  // 快照）被白名单剔除，不会复活。
  it("写路径：笔记导出字段被白名单丢弃，其余键照常落盘", async () => {
    const { saveSettings } = await loadStoreModule();

    await saveSettings({
      ...DEFAULT_SETTINGS,
      tags: "clippings,bilibili",
      includeHotCommentsInNote: true,
      includePlayerEmbedInNote: true,
      frontmatterFields: ["title"],
      fixedFrontmatterProperties: [{ key: "k", type: "text", value: "v" }],
      notePlaceholderSections: [{ title: "t", position: "before_intro", content: "c" }]
    });

    expect(syncSetMock).toHaveBeenCalledTimes(1);
    const persisted = syncSetMock.mock.calls[0][0];
    for (const key of [
      "tags",
      "includeHotCommentsInNote",
      "includePlayerEmbedInNote",
      "frontmatterFields",
      "fixedFrontmatterProperties",
      "notePlaceholderSections"
    ]) {
      expect(persisted, `${key} 不应落盘`).not.toHaveProperty(key);
    }
    expect(persisted.downloadFormat).toBe(DEFAULT_SETTINGS.downloadFormat);
    expect(persisted.includeDateInFilename).toBe(DEFAULT_SETTINGS.includeDateInFilename);
  });
});

describe("initializeSettingsStorage 安装/更新迁移", () => {
  it("onInstalled 落盘归一化后的设置：LEGACY 提示词改写为当前默认，非法 aiThinkingLevel 回落", async () => {
    await import("../../extension/entry/background.js");
    const onInstalledListener = vi.mocked(chrome.runtime.onInstalled.addListener).mock
      .calls[0][0] as unknown as () => unknown;
    syncGetMock.mockImplementation(async (defaults) => ({
      ...defaults,
      aiSystemPrompt: LEGACY_DEFAULT_AI_SYSTEM_PROMPT,
      aiThinkingLevel: "bogus"
    }));

    await onInstalledListener();

    expect(syncSetMock).toHaveBeenCalledTimes(1);
    const persisted = syncSetMock.mock.calls[0][0];
    expect(persisted.aiSystemPrompt).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(persisted.aiSystemPrompt).not.toBe(LEGACY_DEFAULT_AI_SYSTEM_PROMPT);
    expect(persisted.aiThinkingLevel).toBe("off");
    // 仍然全量落盘 DEFAULT_SETTINGS 的所有 key（{ ...DEFAULT_SETTINGS, ...syncCurrent }）
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      expect(persisted).toHaveProperty(key);
    }
  });

  it("存储中已是当前值的字段原样保留，不产生多余改写", async () => {
    await import("../../extension/entry/background.js");
    const onInstalledListener = vi.mocked(chrome.runtime.onInstalled.addListener).mock
      .calls[0][0] as unknown as () => unknown;
    syncGetMock.mockImplementation(async (defaults) => ({
      ...defaults,
      downloadFormat: "srt",
      aiThinkingLevel: "high"
    }));

    await onInstalledListener();

    const persisted = syncSetMock.mock.calls[0][0];
    expect(persisted.downloadFormat).toBe("srt");
    expect(persisted.aiThinkingLevel).toBe("high");
  });

  // 新装路径：sync.get 原样返回 DEFAULT_SETTINGS（prompt 字段为空占位），迁移
  // 落盘的必须是当前默认文本，不能是空串/空数组。
  it("onInstalled 新装迁移：空占位 prompt 落盘为当前默认，不产生空串", async () => {
    await import("../../extension/entry/background.js");
    const onInstalledListener = vi.mocked(chrome.runtime.onInstalled.addListener).mock
      .calls[0][0] as unknown as () => unknown;
    syncGetMock.mockImplementation(async (defaults) => ({ ...defaults }));

    await onInstalledListener();

    expect(syncSetMock).toHaveBeenCalledTimes(1);
    const persisted = syncSetMock.mock.calls[0][0];
    expect(persisted.aiSystemPrompt).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(persisted.playerAiQuickPrompt).toBe(DEFAULT_PLAYER_AI_QUICK_PROMPT);
    expect(persisted.aiInitialQuickPrompts).toEqual(DEFAULT_INITIAL_QUICK_PROMPTS);
  });
});
