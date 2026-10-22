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

// 主题只剩明暗一轴：readerTheme 只存明暗模式（light | dark），色板恒 flyme，
// 无主题族设置项。上一版三值制写进 readerTheme 的 flyme，归一化收敛为 light。
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

// 明暗一轴：readerTheme 只取 light | dark。存量三值制写进 readerTheme 的
// "flyme" 收敛为 light（主题族设置已删除，无拆轴迁移）。
describe("normalizeSettings：主题明暗归一", () => {
  it("readerTheme=flyme（退役三值制）归一为 light", async () => {
    const { normalizeSettings } = await loadStoreModule();
    expect(normalizeSettings({ readerTheme: "flyme" }).readerTheme).toBe("light");
  });

  it("readerTheme=dark / 非法值时明暗照常归一", async () => {
    const { normalizeSettings } = await loadStoreModule();
    for (const theme of ["dark", "light", "neon", undefined]) {
      const out = normalizeSettings({ readerTheme: theme });
      expect(out.readerTheme, `readerTheme ${JSON.stringify(theme)}`).toBe(theme === "dark" ? "dark" : "light");
    }
  });
});

// 外观色板与明暗正交：readerPalette 只取 flyme | editorial，缺失/非法存量值
// 归一回落默认 flyme。
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

// 步骤表未接线时也能成立的部分：显式键值经写路径白名单原样透传（键面随
// DEFAULT_SETTINGS 自动覆盖）。
describe("normalizeSettings：主题明暗透传", () => {
  it("明暗显式键值原样透传", async () => {
    const { normalizeSettings } = await loadStoreModule();
    const out = normalizeSettings({ readerTheme: "dark" });
    expect(out.readerTheme).toBe("dark");
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

  // 写路径与读路径共用同一张步骤表与同一个读视图：全量写回里带退役
  // readerTheme="flyme"（老客户端 / 老快照整对象写回）时，明暗同样收敛为 light。
  it("写路径同口径：全量写回带退役 readerTheme=flyme 时归一为 light", async () => {
    const { saveSettings, normalizeSettings } = await loadStoreModule();
    const payload = { ...DEFAULT_SETTINGS, readerTheme: "flyme" };

    await saveSettings(payload);

    expect(syncSetMock).toHaveBeenCalledTimes(1);
    expect(syncSetMock.mock.calls[0][0]).toEqual(normalizeSettings(payload));
    expect(syncSetMock.mock.calls[0][0].readerTheme).toBe("light");
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

// 05 号票（决策 #8）：档位值域扩到上游词表的 7 档；已存的 off/low/high 都是新值域的
// 子集 → **不需要迁移**（读回/落盘都原样）。
// 2026-10-05 用户裁定（两轮）：再加一个 `default`（不干预）——合法可存，出厂/重置默认
// 就是它；第二轮把**存储侧的缺省 / 非法值回退也改成 `default`**（此前是 `off`）：同一条
// 「没有偏好」意图全线一个说法，脏值不再被读成「显式关思考」。
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
    // 生产读路径先与 DEFAULT_SETTINGS 合并再归一（见 settings-store 的 getMergedSettings），
    // 故「缺键 = 出厂默认」在这一层表现为「合并后的值就是 default」。
    expect(normalizeSettings({ ...DEFAULT_SETTINGS }).aiThinkingLevel).toBe("default");
    // 显式给出的非法/空值与缺键同一口径（2026-10-05 第二轮裁定：回退值与出厂默认同词）。
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
    // 写路径：undefined 视为「本次不改这个键」（saveSettings 剔除），故不在此循环。
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

    // 同一 onInstalled 还跑免 Key 预设自动激活（spec §1 S2）——它会追加「记录 →
    // 链首 → flag」几次 sync.set；设置域的全量写恒是第一次调用（键面全在一次里）。
    const persisted = syncSetMock.mock.calls[0][0];
    expect(persisted.aiSystemPrompt).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(persisted.aiSystemPrompt).not.toBe(LEGACY_DEFAULT_AI_SYSTEM_PROMPT);
    expect(persisted.aiThinkingLevel).toBe("default");
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
