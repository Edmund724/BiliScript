import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { resetModuleState } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import {
  DEFAULT_AI_SYSTEM_PROMPT,
  DEFAULT_PLAYER_AI_QUICK_PROMPT,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V2,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V3,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V4,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V5,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V6,
  LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT,
  LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V2,
  LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V3,
  LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V4
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
  it("LEGACY 默认提示词映射为当前默认，非法 aiThinkingLevel 回落 default", async () => {
    const { normalizeSettings } = await loadStoreModule();
    const out = normalizeSettings({
      ...DEFAULT_SETTINGS,
      aiSystemPrompt: LEGACY_DEFAULT_AI_SYSTEM_PROMPT,
      aiThinkingLevel: "bogus"
    });
    expect(out.aiSystemPrompt).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(out.aiThinkingLevel).toBe("default");
  });

  it("返回新对象且不改入参，非受管字段原样保留", async () => {
    const { normalizeSettings } = await loadStoreModule();
    const input = { ...DEFAULT_SETTINGS, unknownKey: "passthrough", downloadFormat: "ass" };
    const out = normalizeSettings(input);
    expect(out).not.toBe(input);
    expect(input.downloadFormat).toBe("ass");
    expect(out.downloadFormat).toBe("srt");
    expect(out.unknownKey).toBe("passthrough");
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, downloadFormat: "vtt" }).downloadFormat).toBe("vtt");
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, downloadFormat: "vtt-secondary" }).downloadFormat).toBe("vtt-secondary");
  });

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

  it("aiSystemPrompt：六代历史默认都映射为当前默认，自定义文本原样保留", async () => {
    const { normalizeSettings } = await loadStoreModule();
    for (const legacy of [
      LEGACY_DEFAULT_AI_SYSTEM_PROMPT,
      LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V2,
      LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V3,
      LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V4,
      LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V5,
      LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V6
    ]) {
      expect(normalizeSettings({ ...DEFAULT_SETTINGS, aiSystemPrompt: legacy }).aiSystemPrompt).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    }
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, aiSystemPrompt: "我的自定义人设" }).aiSystemPrompt).toBe("我的自定义人设");
  });

  it("playerAiQuickPrompt：四代旧默认都映射为当前默认，自定义文本原样保留", async () => {
    const { normalizeSettings } = await loadStoreModule();
    for (const legacy of [
      LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT,
      LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V2,
      LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V3,
      LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V4
    ]) {
      expect(normalizeSettings({ ...DEFAULT_SETTINGS, playerAiQuickPrompt: legacy }).playerAiQuickPrompt).toBe(DEFAULT_PLAYER_AI_QUICK_PROMPT);
    }
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, playerAiQuickPrompt: "按章节整理内容" }).playerAiQuickPrompt).toBe("按章节整理内容");
  });

  it("新装缺键：提示词字段回落当前默认；初始问题留空保持空数组（自动生成）", async () => {
    const { normalizeSettings } = await loadStoreModule();
    const out = normalizeSettings({ ...DEFAULT_SETTINGS });
    expect(out.aiSystemPrompt).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(out.playerAiQuickPrompt).toBe(DEFAULT_PLAYER_AI_QUICK_PROMPT);
    expect(out.aiInitialQuickPrompts).toEqual([]);
  });

  it("清空保存：aiSystemPrompt/playerAiQuickPrompt 空串回落当前默认", async () => {
    const { normalizeSettings } = await loadStoreModule();
    const out = normalizeSettings({ ...DEFAULT_SETTINGS, aiSystemPrompt: "  ", playerAiQuickPrompt: "" });
    expect(out.aiSystemPrompt).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(out.playerAiQuickPrompt).toBe(DEFAULT_PLAYER_AI_QUICK_PROMPT);
  });
});

describe("normalizeReaderTheme", () => {
  it("bilibili/system/light/dark 原样放行；退役值 flyme 收敛为 bilibili", async () => {
    const { normalizeReaderTheme } = await import("../../extension/core/validators.js");
    expect(normalizeReaderTheme("flyme")).toBe("bilibili");
    expect(normalizeReaderTheme("bilibili")).toBe("bilibili");
    expect(normalizeReaderTheme("system")).toBe("system");
    expect(normalizeReaderTheme("light")).toBe("light");
    expect(normalizeReaderTheme("dark")).toBe("dark");
  });

  it("非法值回落 bilibili", async () => {
    const { normalizeReaderTheme } = await import("../../extension/core/validators.js");
    for (const dirty of ["neon", "", null, undefined, 1, {}, []]) {
      expect(normalizeReaderTheme(dirty), `脏值 ${JSON.stringify(dirty)} 应回落 bilibili`).toBe("bilibili");
    }
  });

  it("已退役纸色档 paper 归一为 bilibili", async () => {
    const { normalizeReaderTheme } = await import("../../extension/core/validators.js");
    expect(normalizeReaderTheme("paper")).toBe("bilibili");
  });
});

describe("normalizeSettings：主题明暗归一", () => {
  it("readerTheme=flyme（退役值）归一为 bilibili", async () => {
    const { normalizeSettings } = await loadStoreModule();
    expect(normalizeSettings({ readerTheme: "flyme" }).readerTheme).toBe("bilibili");
  });

  it("四模式值原样放行，非法值回落 bilibili", async () => {
    const { normalizeSettings } = await loadStoreModule();
    const cases: Array<[unknown, string]> = [
      ["bilibili", "bilibili"],
      ["system", "system"],
      ["light", "light"],
      ["dark", "dark"],
      ["neon", "bilibili"],
      [undefined, "bilibili"]
    ];
    for (const [theme, expected] of cases) {
      const out = normalizeSettings({ readerTheme: theme });
      expect(out.readerTheme, `readerTheme ${JSON.stringify(theme)}`).toBe(expected);
    }
  });
});

describe("normalizeReaderPalette", () => {
  it("flyme/editorial 原样放行", async () => {
    const { normalizeReaderPalette } = await import("../../extension/core/validators.js");
    expect(normalizeReaderPalette("flyme")).toBe("flyme");
    expect(normalizeReaderPalette("editorial")).toBe("editorial");
  });

  it("非法值与缺失值回落 flyme", async () => {
    const { normalizeReaderPalette } = await import("../../extension/core/validators.js");
    for (const dirty of ["neon", "paper", "", null, undefined, 1, {}, []]) {
      expect(normalizeReaderPalette(dirty), `脏值 ${JSON.stringify(dirty)} 应回落 flyme`).toBe("flyme");
    }
  });
});

describe("normalizeChatInputGlow", () => {
  it("布尔值原样放行，默认/缺失值回落 true，仅显式 false 返回 false", async () => {
    const { normalizeChatInputGlow } = await import("../../extension/core/validators.js");
    expect(normalizeChatInputGlow(true)).toBe(true);
    expect(normalizeChatInputGlow(false)).toBe(false);
    expect(normalizeChatInputGlow(undefined)).toBe(true);
    expect(normalizeChatInputGlow(null)).toBe(true);
    expect(normalizeChatInputGlow("")).toBe(true);
  });
});

describe("normalizeSettings：外观色板归一", () => {
  it("readerPalette=editorial 放行，非法/缺失值归一为 flyme", async () => {
    const { normalizeSettings } = await loadStoreModule();
    expect(normalizeSettings({ readerPalette: "editorial" }).readerPalette).toBe("editorial");
    for (const dirty of ["neon", "", null, undefined]) {
      const out = normalizeSettings({ readerPalette: dirty });
      expect(out.readerPalette, `readerPalette ${JSON.stringify(dirty)}`).toBe("flyme");
    }
  });

  it("写路径同口径：saveSettings 落盘的 readerPalette 经归一步骤收敛", async () => {
    const { saveSettings } = await loadStoreModule();

    await saveSettings({ readerPalette: "neon" });

    expect(syncSetMock).toHaveBeenCalledTimes(1);
    expect(syncSetMock.mock.calls[0][0].readerPalette).toBe("flyme");

    await saveSettings({ readerPalette: "editorial" });
    expect(syncSetMock.mock.calls[1][0].readerPalette).toBe("editorial");
  });
});

describe("normalizeSettings：主题明暗透传", () => {
  it("明暗显式键值原样透传", async () => {
    const { normalizeSettings } = await loadStoreModule();
    const out = normalizeSettings({ readerTheme: "dark" });
    expect(out.readerTheme).toBe("dark");
  });
});

describe("normalizeSettings：两个一次性状态位", () => {
  it("searchPresetsAutoActivated：缺省/脏值回落 false，显式 true 保留", async () => {
    const { normalizeSettings } = await loadStoreModule();
    expect(DEFAULT_SETTINGS.searchPresetsAutoActivated).toBe(false);
    expect(normalizeSettings({}).searchPresetsAutoActivated).toBe(false);
    expect(normalizeSettings({ searchPresetsAutoActivated: true }).searchPresetsAutoActivated).toBe(true);
    for (const dirty of ["true", 1, 0, null, undefined, {}]) {
      expect(
        normalizeSettings({ searchPresetsAutoActivated: dirty }).searchPresetsAutoActivated,
        `脏值 ${JSON.stringify(dirty)} 应回落 false`
      ).toBe(false);
    }
  });

  it("searchOptInNoticeAcknowledged：缺省/脏值回落 false，显式 true 保留", async () => {
    const { normalizeSettings } = await loadStoreModule();
    expect(DEFAULT_SETTINGS.searchOptInNoticeAcknowledged).toBe(false);
    expect(normalizeSettings({}).searchOptInNoticeAcknowledged).toBe(false);
    expect(normalizeSettings({ searchOptInNoticeAcknowledged: true }).searchOptInNoticeAcknowledged).toBe(true);
    for (const dirty of ["true", 1, 0, null, undefined, {}]) {
      expect(
        normalizeSettings({ searchOptInNoticeAcknowledged: dirty }).searchOptInNoticeAcknowledged,
        `脏值 ${JSON.stringify(dirty)} 应回落 false`
      ).toBe(false);
    }
  });

  it("写路径：两个状态位在白名单内且经归一化落盘", async () => {
    const { saveSettings } = await loadStoreModule();

    await saveSettings({ searchPresetsAutoActivated: true, searchOptInNoticeAcknowledged: "yes" });

    expect(syncSetMock).toHaveBeenCalledTimes(1);
    const persisted = syncSetMock.mock.calls[0][0];
    expect(persisted).toHaveProperty("searchPresetsAutoActivated", true);
    expect(persisted).toHaveProperty("searchOptInNoticeAcknowledged", false);
  });

  it("normalizeSearchPresetsAutoActivated / normalizeSearchOptInNoticeAcknowledged 与 normalizeWebSearchEnabled 同型", async () => {
    const {
      normalizeSearchPresetsAutoActivated,
      normalizeSearchOptInNoticeAcknowledged,
      normalizeWebSearchEnabled
    } = await import("../../extension/core/validators.js");

    for (const normalize of [
      normalizeSearchPresetsAutoActivated,
      normalizeSearchOptInNoticeAcknowledged,
      normalizeWebSearchEnabled
    ]) {
      expect(normalize(true)).toBe(true);
      expect(normalize(false)).toBe(false);
      expect(normalize(undefined)).toBe(false);
      expect(normalize("true")).toBe(false);
      expect(normalize(1)).toBe(false);
      expect(normalize(null)).toBe(false);
      expect(normalize({})).toBe(false);
    }
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

  it("写路径同口径：全量写回带退役 readerTheme=flyme 时归一为 bilibili", async () => {
    const { saveSettings, normalizeSettings } = await loadStoreModule();
    const payload = { ...DEFAULT_SETTINGS, readerTheme: "flyme" };

    await saveSettings(payload);

    expect(syncSetMock).toHaveBeenCalledTimes(1);
    expect(syncSetMock.mock.calls[0][0]).toEqual(normalizeSettings(payload));
    expect(syncSetMock.mock.calls[0][0].readerTheme).toBe("bilibili");
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

  it("写路径：清空的提示词落盘为当前默认，初始问题清空落空数组", async () => {
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
    expect(persisted.aiInitialQuickPrompts).toEqual([]);
  });

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

describe("aiThinkingLevel：7 档 + default 值域与存储兼容（05 号票 + default 档）", () => {
  const SEVEN = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  const ALL = ["default", ...SEVEN] as const;

  it("读路径：default 与 7 档全部原样读回", async () => {
    const { normalizeSettings } = await loadStoreModule();
    for (const level of ALL) {
      expect(normalizeSettings({ ...DEFAULT_SETTINGS, aiThinkingLevel: level }).aiThinkingLevel, level).toBe(level);
    }
  });

  it("写路径：default 与 7 档全部原样落盘", async () => {
    const { saveSettings } = await loadStoreModule();
    for (const level of ALL) {
      syncSetMock.mockClear();
      await saveSettings({ aiThinkingLevel: level });
      expect(syncSetMock.mock.calls[0][0], level).toEqual({ aiThinkingLevel: level });
    }
  });

  it("出厂默认 = default（合并后的设置视图读回 default）；显式垃圾/空值同口径回落 default", async () => {
    const { normalizeSettings } = await loadStoreModule();
    expect(DEFAULT_SETTINGS.aiThinkingLevel).toBe("default");
    expect(normalizeSettings({ ...DEFAULT_SETTINGS }).aiThinkingLevel).toBe("default");
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, aiThinkingLevel: undefined }).aiThinkingLevel).toBe("default");
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, aiThinkingLevel: "" }).aiThinkingLevel).toBe("default");
  });

  it("旧值 off/low/high 不迁移：读回与落盘都原样保留", async () => {
    const { normalizeSettings, saveSettings } = await loadStoreModule();
    for (const legacy of ["off", "low", "high"] as const) {
      expect(normalizeSettings({ ...DEFAULT_SETTINGS, aiThinkingLevel: legacy }).aiThinkingLevel, legacy).toBe(legacy);
      syncSetMock.mockClear();
      await saveSettings({ aiThinkingLevel: legacy });
      expect(syncSetMock.mock.calls[0][0], legacy).toEqual({ aiThinkingLevel: legacy });
    }
  });

  it("非法值（含上游 none）回落 default：显式 off 才会走关思考写点", async () => {
    const { normalizeSettings, saveSettings } = await loadStoreModule();
    for (const bogus of ["bogus", "none", "", "HIGH", null, undefined, 3]) {
      expect(normalizeSettings({ ...DEFAULT_SETTINGS, aiThinkingLevel: bogus }).aiThinkingLevel, String(bogus)).toBe("default");
    }
    for (const bogus of ["bogus", "none", "", "HIGH", null, 3]) {
      syncSetMock.mockClear();
      await saveSettings({ aiThinkingLevel: bogus });
      expect(syncSetMock.mock.calls[0][0], String(bogus)).toEqual({ aiThinkingLevel: "default" });
    }
  });
});

describe("initializeSettingsStorage 安装/更新迁移", () => {
  it("onInstalled 落盘归一化后的设置：LEGACY 提示词改写为当前默认，非法 aiThinkingLevel 回落 default", async () => {
    await import("../../extension/entry/background.js");
    const onInstalledListener = vi.mocked(chrome.runtime.onInstalled.addListener).mock
      .calls[0][0] as unknown as () => unknown;
    syncGetMock.mockImplementation(async (defaults) => ({
      ...defaults,
      aiSystemPrompt: LEGACY_DEFAULT_AI_SYSTEM_PROMPT,
      aiThinkingLevel: "bogus"
    }));

    await onInstalledListener();

    const persisted = syncSetMock.mock.calls[0][0];
    expect(persisted.aiSystemPrompt).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(persisted.aiSystemPrompt).not.toBe(LEGACY_DEFAULT_AI_SYSTEM_PROMPT);
    expect(persisted.aiThinkingLevel).toBe("default");
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

  it("onInstalled 新装迁移：空占位 prompt 落盘为当前默认，不产生空串", async () => {
    await import("../../extension/entry/background.js");
    const onInstalledListener = vi.mocked(chrome.runtime.onInstalled.addListener).mock
      .calls[0][0] as unknown as () => unknown;
    syncGetMock.mockImplementation(async (defaults) => ({ ...defaults }));

    await onInstalledListener();

    const persisted = syncSetMock.mock.calls[0][0];
    expect(persisted.aiSystemPrompt).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(persisted.playerAiQuickPrompt).toBe(DEFAULT_PLAYER_AI_QUICK_PROMPT);
    expect(persisted.aiInitialQuickPrompts).toEqual([]);
    expect(persisted.subtitleTranslateProviderId).toBe("bilibili-index-translate");
    expect(persisted.subtitleTranslateModel).toBe("Index-Translate-35B-A3B");
  });

  it("onInstalled 存量空翻译配置迁入免 Key Index-Translate 且不覆盖通用 AI 默认平台", async () => {
    await import("../../extension/entry/background.js");
    const onInstalledListener = vi.mocked(chrome.runtime.onInstalled.addListener).mock
      .calls[0][0] as unknown as () => unknown;
    syncGetMock.mockImplementation(async (defaults) => ({
      ...defaults,
      defaultModel: "deepseek-p1",
      defaultAiModel: "deepseek-chat",
      subtitleTranslateProviderId: "",
      subtitleTranslateModel: ""
    }));

    await onInstalledListener();

    const persisted = syncSetMock.mock.calls[0][0];
    expect(persisted.subtitleTranslateProviderId).toBe("bilibili-index-translate");
    expect(persisted.subtitleTranslateModel).toBe("Index-Translate-35B-A3B");
    expect(persisted.defaultModel).toBe("deepseek-p1");
    expect(persisted.defaultAiModel).toBe("deepseek-chat");
  });
});

describe("normalizeSettings：文摘面板排版设置归一", () => {
  it("readerFontSizeScale 限制在 70～130，缺失/非法回落 100", async () => {
    const { normalizeSettings } = await loadStoreModule();
    expect(normalizeSettings({ readerFontSizeScale: 100 }).readerFontSizeScale).toBe(100);
    expect(normalizeSettings({ readerFontSizeScale: 60 }).readerFontSizeScale).toBe(70);
    expect(normalizeSettings({ readerFontSizeScale: 150 }).readerFontSizeScale).toBe(130);
    expect(normalizeSettings({ readerFontSizeScale: "invalid" }).readerFontSizeScale).toBe(100);
    expect(normalizeSettings({ readerFontSizeScale: null }).readerFontSizeScale).toBe(100);
  });

  it("chatLineHeight 限制在 120～200，缺失/非法回落 160", async () => {
    const { normalizeSettings } = await loadStoreModule();
    expect(normalizeSettings({ chatLineHeight: 160 }).chatLineHeight).toBe(160);
    expect(normalizeSettings({ chatLineHeight: 100 }).chatLineHeight).toBe(120);
    expect(normalizeSettings({ chatLineHeight: 250 }).chatLineHeight).toBe(200);
    expect(normalizeSettings({ chatLineHeight: "bad" }).chatLineHeight).toBe(160);
    expect(normalizeSettings({ chatLineHeight: undefined }).chatLineHeight).toBe(160);
  });

  it("chatParagraphSpacing 限制在 4～20，缺失/非法回落 12", async () => {
    const { normalizeSettings } = await loadStoreModule();
    expect(normalizeSettings({ chatParagraphSpacing: 12 }).chatParagraphSpacing).toBe(12);
    expect(normalizeSettings({ chatParagraphSpacing: 2 }).chatParagraphSpacing).toBe(4);
    expect(normalizeSettings({ chatParagraphSpacing: 30 }).chatParagraphSpacing).toBe(20);
    expect(normalizeSettings({ chatParagraphSpacing: "" }).chatParagraphSpacing).toBe(12);
  });
});

describe("getMergedSettings：宽度自定义标记存量补齐", () => {
  it("只设宽度未设开关键 → 读路径按已自定义对待", async () => {
    const { getMergedSettings } = await loadStoreModule();
    syncGetMock.mockImplementation(async (defaults) => ({ ...defaults, customPanelWidth: 460 }));

    const merged = await getMergedSettings();

    expect(merged.customPanelWidth).toBe(460);
    expect(merged.customPanelWidthEnabled).toBe(true);
  });

  it("宽度为默认值（540）时不置位：未自定义保持默认几何", async () => {
    const { getMergedSettings } = await loadStoreModule();
    syncGetMock.mockImplementation(async (defaults) => ({ ...defaults, customPanelWidth: 540 }));

    const merged = await getMergedSettings();

    expect(merged.customPanelWidthEnabled).toBe(false);
  });

  it("显式恢复默认（宽度 540 + 标记 false）读回不再置位", async () => {
    const { getMergedSettings } = await loadStoreModule();
    syncGetMock.mockImplementation(async (defaults) => ({
      ...defaults,
      customPanelWidth: 540,
      customPanelWidthEnabled: false
    }));

    const merged = await getMergedSettings();

    expect(merged.customPanelWidthEnabled).toBe(false);
  });

  it("显式 true 原样保留（含宽度恰为默认值的显式自定义）", async () => {
    const { getMergedSettings } = await loadStoreModule();
    syncGetMock.mockImplementation(async (defaults) => ({
      ...defaults,
      customPanelWidth: 540,
      customPanelWidthEnabled: true
    }));

    const merged = await getMergedSettings();

    expect(merged.customPanelWidthEnabled).toBe(true);
  });
});

describe("normalizeDetachedWindowMode 与 detachedWindowMode 持久化", () => {
  it("normalizeDetachedWindowMode 放行 pip/popup，脏值回落 pip", async () => {
    const { normalizeDetachedWindowMode } = await import("../../extension/core/validators.js");
    expect(normalizeDetachedWindowMode("pip")).toBe("pip");
    expect(normalizeDetachedWindowMode("popup")).toBe("popup");
    for (const dirty of ["window", "PIP", "", null, undefined, 1, {}, []]) {
      expect(normalizeDetachedWindowMode(dirty)).toBe("pip");
    }
  });

  it("normalizeSettings / getMergedSettings / saveSettings 正确规范化并落盘 detachedWindowMode", async () => {
    const { normalizeSettings, getMergedSettings, saveSettings } = await loadStoreModule();
    expect(DEFAULT_SETTINGS.detachedWindowMode).toBe("pip");
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, detachedWindowMode: "popup" }).detachedWindowMode).toBe("popup");
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, detachedWindowMode: "invalid" }).detachedWindowMode).toBe("pip");

    syncGetMock.mockImplementationOnce(async (defaults) => ({ ...defaults, detachedWindowMode: "popup" }));
    const merged = await getMergedSettings();
    expect(merged.detachedWindowMode).toBe("popup");

    await saveSettings({ detachedWindowMode: "popup" });
    expect(syncSetMock).toHaveBeenCalledWith({ detachedWindowMode: "popup" });

    await saveSettings({ detachedWindowMode: "bogus" });
    expect(syncSetMock).toHaveBeenCalledWith({ detachedWindowMode: "pip" });
  });
});
