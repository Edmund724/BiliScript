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
  // 读路径归一化必须回落当前默认——新装/缺键不能得到空串。
  // 例外：aiInitialQuickPrompts 空数组是合法值（留空 = 按视频自动生成），不回落。
  it("新装缺键：提示词字段回落当前默认；初始问题留空保持空数组（自动生成）", async () => {
    const { normalizeSettings } = await loadStoreModule();
    const out = normalizeSettings({ ...DEFAULT_SETTINGS });
    expect(out.aiSystemPrompt).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(out.playerAiQuickPrompt).toBe(DEFAULT_PLAYER_AI_QUICK_PROMPT);
    expect(out.aiInitialQuickPrompts).toEqual([]);
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

// 主题两轴正交：readerTheme 只存明暗模式（light | dark），readerThemeFamily
// 存主题族（bilibili | flyme）。上一版短暂存在的三值制把 flyme 写进
// readerTheme，归一化只认明暗两值（flyme 不再原样放行），拆轴迁移在
// normalizeSettings 层一次性完成（见下方迁移用例）。
describe("normalizeReaderTheme", () => {
  it("light/dark 原样放行；上一版三值制的 flyme 收敛为 light", async () => {
    const { normalizeReaderTheme } = await import("../../extension/core/validators.js");
    expect(normalizeReaderTheme("flyme")).toBe("light");
    expect(normalizeReaderTheme("light")).toBe("light");
    expect(normalizeReaderTheme("dark")).toBe("dark");
  });

  it("非法值回落 light", async () => {
    const { normalizeReaderTheme } = await import("../../extension/core/validators.js");
    for (const dirty of ["neon", "", null, undefined, 1, {}, []]) {
      expect(normalizeReaderTheme(dirty), `脏值 ${JSON.stringify(dirty)} 应回落 light`).toBe("light");
    }
  });

  // 纸色档已退役：存量 "paper" 静默归一为 light（不迁移存储、不改写其他字段）。
  it("已退役纸色档 paper 归一为 light", async () => {
    const { normalizeReaderTheme } = await import("../../extension/core/validators.js");
    expect(normalizeReaderTheme("paper")).toBe("light");
  });
});

// 主题族（整套色板归属）：与明暗模式正交的第二轴，默认族 bilibili。
describe("normalizeReaderThemeFamily", () => {
  it("DEFAULT_SETTINGS 声明主题族，默认 bilibili", () => {
    expect(DEFAULT_SETTINGS.readerThemeFamily).toBe("bilibili");
  });

  it("flyme / bilibili 原样放行", async () => {
    const { normalizeReaderThemeFamily } = await import("../../extension/core/validators.js");
    expect(normalizeReaderThemeFamily("flyme")).toBe("flyme");
    expect(normalizeReaderThemeFamily("bilibili")).toBe("bilibili");
  });

  it("非法值回落 bilibili", async () => {
    const { normalizeReaderThemeFamily } = await import("../../extension/core/validators.js");
    for (const dirty of ["neon", "light", "dark", "", null, undefined, 1, {}, []]) {
      expect(normalizeReaderThemeFamily(dirty), `脏值 ${JSON.stringify(dirty)} 应回落 bilibili`).toBe("bilibili");
    }
  });
});

// 迁移（上一版三值制 → 两轴）：输入 readerTheme === "flyme" 时输出
// readerTheme: "light" 且 readerThemeFamily: "flyme"。readerThemeFamily 是新键，
// 存量数据里不会有，无键值冲突；其余输入族落默认 bilibili。
//
// ⚠ 下面三条挂在 skip 上：normalizeSettings 不在 validators.ts，它在
// extension/core/settings-store.ts 的 SETTINGS_NORMALIZER_STEPS 步骤表里，而该
// 文件不在本次写范围内。新键的「键面」（读合并 / 写白名单 / 快照失效键集）已随
// DEFAULT_SETTINGS 自动覆盖，但「值归一化 + flyme 拆轴迁移」必须在步骤表显式登记，
// 只差这一行（import 后加在 ["readerTheme", ...] 之后）：
//   ["readerThemeFamily", (m) => normalizeReaderThemeFamily(m.readerThemeFamily)],
// 接线后删掉 .skip 即生效——注意：在它落地前，存量 readerTheme="flyme" 会随
// normalizeReaderTheme 收敛为 light 而丢掉族信息（迁移与本步是同一笔改动）。
describe.skip("normalizeSettings：主题两轴与 flyme 迁移（待 settings-store 接线）", () => {
  it("上一版三值制 readerTheme=flyme 拆到两轴：明暗回 light，族落 flyme", async () => {
    const { normalizeSettings } = await loadStoreModule();
    const out = normalizeSettings({ readerTheme: "flyme" });
    expect(out.readerTheme).toBe("light");
    expect(out.readerThemeFamily).toBe("flyme");
  });

  it("readerTheme=dark / 非法值时族落默认 bilibili，明暗照常归一", async () => {
    const { normalizeSettings } = await loadStoreModule();
    for (const theme of ["dark", "light", "neon", undefined]) {
      const out = normalizeSettings({ readerTheme: theme });
      expect(out.readerTheme, `readerTheme ${JSON.stringify(theme)}`).toBe(theme === "dark" ? "dark" : "light");
      expect(out.readerThemeFamily, `readerTheme ${JSON.stringify(theme)} 的族`).toBe("bilibili");
    }
  });

  it("readerThemeFamily 归一化：flyme 保留，非法值回落 bilibili", async () => {
    const { normalizeSettings } = await loadStoreModule();
    expect(normalizeSettings({ readerThemeFamily: "flyme" }).readerThemeFamily).toBe("flyme");
    expect(normalizeSettings({ readerThemeFamily: "bilibili" }).readerThemeFamily).toBe("bilibili");
    expect(normalizeSettings({ readerThemeFamily: "neon" }).readerThemeFamily).toBe("bilibili");
    expect(normalizeSettings({}).readerThemeFamily).toBe("bilibili");
  });
});

// 步骤表未接线时也能成立的部分：显式键值经写路径白名单原样透传（键面随
// DEFAULT_SETTINGS 自动覆盖），两轴互不干扰。
describe("normalizeSettings：主题两轴透传", () => {
  it("两轴互不干扰：flyme 族 + dark 明暗同时立住", async () => {
    const { normalizeSettings } = await loadStoreModule();
    const out = normalizeSettings({ readerTheme: "dark", readerThemeFamily: "flyme" });
    expect(out.readerTheme).toBe("dark");
    expect(out.readerThemeFamily).toBe("flyme");
  });
});

// 两个非可调一次性状态位（spec §2「flag 的家」、§3 落点表第 20–21 行、§6.7
// 「状态位」、§9.7 第 4 条）：不在设置页渲染、无校验区间，归一化与
// normalizeWebSearchEnabled 同型（布尔，仅显式 true 置位，其余回落 false）。
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

  // 写路径：两位都在 DEFAULT_SETTINGS 键面内（save-settings 白名单），且写前
  // 经同一套步骤表归一化。
  it("写路径：两个状态位在白名单内且经归一化落盘", async () => {
    const { saveSettings } = await loadStoreModule();

    await saveSettings({ searchPresetsAutoActivated: true, searchOptInNoticeAcknowledged: "yes" });

    expect(syncSetMock).toHaveBeenCalledTimes(1);
    const persisted = syncSetMock.mock.calls[0][0];
    expect(persisted).toHaveProperty("searchPresetsAutoActivated", true);
    expect(persisted).toHaveProperty("searchOptInNoticeAcknowledged", false);
  });

  // validators.ts 的两个 normalizer 与 normalizeWebSearchEnabled 同型同列。
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

  // 写路径同款：清空后的提示词空串不落盘为占位值，落盘即当前默认；
  // 初始问题清空 = 回到「按视频自动生成」，同样落空数组。
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

    // 同一 onInstalled 还跑免 Key 预设自动激活（spec §1 S2）——它会追加「记录 →
    // 链首 → flag」几次 sync.set；设置域的全量写恒是第一次调用（键面全在一次里）。
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
  // 落盘的必须是当前默认文本，不能是空串（初始问题除外：空数组即自动生成）。
  it("onInstalled 新装迁移：空占位 prompt 落盘为当前默认，不产生空串", async () => {
    await import("../../extension/entry/background.js");
    const onInstalledListener = vi.mocked(chrome.runtime.onInstalled.addListener).mock
      .calls[0][0] as unknown as () => unknown;
    syncGetMock.mockImplementation(async (defaults) => ({ ...defaults }));

    await onInstalledListener();

    // 与上方同：自动激活的记录 / 链首 / flag 写在其后，设置全量写仍是第一次调用
    const persisted = syncSetMock.mock.calls[0][0];
    expect(persisted.aiSystemPrompt).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(persisted.playerAiQuickPrompt).toBe(DEFAULT_PLAYER_AI_QUICK_PROMPT);
    expect(persisted.aiInitialQuickPrompts).toEqual([]);
  });
});
