// tests/chat/thinking-picker.test.ts
// chat/thinking-picker 的纯函数契约（2026-10-05 用户裁定，票据 chat-thinking-submenu；
// 架构评审候选 6 起本模块同时是**显示视图**的唯一派生处：thinkingViewOf(偏好 + 上下文)
// → 一级行 · chip 条目 · 提示文案，组合根与面板只画结果、不再手工摘字段）。
//
// 先列可能失败的方式（每条都有对应用例）：
//   1. 开关型（rule.on）没收成 Off/On，仍把 6 个非 off 档各列一行（用户报的「全都是按钮」）；
//   2. 只登记一个真实档位的模型（none-high）不显示 On；
//   3. off 不在可用集却凭空造出 Off 项（显示请求不发的选择）；
//   4. Off 不在首位（档位序契约：off 永远第一）；
//   5. 开关型 On 的打勾按 data-level 相等算——实发落在 On 那一个写点上（如 minimal）时无人打勾；
//   6. 显示档不在可用集时仍显示 On（手搓输入形状）：该防御分支随候选 6 退休——视图值只由
//      一次解析产出（effectiveLevel null 只在 unknown 哨兵，那格 A' = ∅、不是开关型）；
//   7. 显示名出现第二套推导（chip 与列表不同源）；
//   8. 标签表键集漂移（多了 none / 少了档位）；
//   9. 偏好 ≠ 实发档却显示偏好——一级行与线上实发的档位不符（口径 ③，2026-10-05 两轮复审）；
//  10. 无实发档信息（effectiveLevel null，unknown 哨兵）时不回落偏好词；
//  11. **打勾与点击判据共用一个布尔**（口径 ⑤ 裁定 B 要防的事）：勾住的那一项点下去不写偏好，
//      用户以为选了、存储里却还是旧偏好；
//  12. 开关型 On 的写入判据按 canonical high 比：偏好 max 时判成「不相等 → 写」，偏好被搬到
//      high（05 号票「偏好不迁移」要防的事）；
//  13. 视图值漏字段（候选 6：原「调用点手工摘 4 个字段」的替代面不完整）——一级行 / 条目 /
//      提示文案三值必须由 thinkingViewOf 一次给全（漏一个就是编译期红，用例钉住三值同源）；
//  14. 提示文案口径①②漂移：长/短版互换、①与②优先级倒置（off 关不掉时串成 clamp 文案）、
//      源档 / 实发档取错；
//  15. 显示口径与落线漂移：视图说发某档、请求却发别的档（视图的勾 ≠ resolveThinkingProfile 的实发档）；
//  16. 缺省 / 脏值显示不为 Default（ADR-0015 修订：请求侧与显示侧同归 default，不显示成 off）。

import { describe, expect, it } from "vitest";
import {
  THINKING_LEVEL_LABELS,
  THINKING_ON_LABEL,
  thinkingHint,
  thinkingPickerEntries,
  thinkingPickerLabel,
  thinkingViewOf,
  type ThinkingPickerEntry,
  type ThinkingPickerInput
} from "../../extension/chat/thinking-picker.js";
import {
  AI_THINKING_LEVELS,
  resolveThinkingAdjustment,
  resolveThinkingProfile,
  type ResolveThinkingInput,
  type ThinkingLevel,
  type ThinkingLevelValue
} from "../../extension/ai/thinking-profiles.js";
import { openaiVocabularyFields } from "../../extension/ai/thinking-wire-map.js";

// 入参工厂：effectiveLevel 缺省 null = 「没有解析结论」（unknown 哨兵；口径 ③ 的回退路径：
// 显示档回落偏好词、无人打勾。真实调用方总带同一次解析的实发档，零档行给的是 `default`）。
function input(
  availableLevels: readonly ThinkingLevel[],
  requestedLevel: ThinkingLevelValue,
  switchOnly = false,
  effectiveLevel: ThinkingLevelValue | null = null
): ThinkingPickerInput {
  return { availableLevels, switchOnly, requestedLevel, effectiveLevel };
}

function levelsOf(entries: readonly ThinkingPickerEntry[]): string[] {
  return entries.map((entry) => entry.level);
}

function labelsOf(entries: readonly ThinkingPickerEntry[]): string[] {
  return entries.map((entry) => entry.label);
}

// 打勾（effective = 实发档，口径 ⑤）与点击判据（writesPreference）分别取，别混成一个布尔。
function effectiveOf(entries: readonly ThinkingPickerEntry[]): string[] {
  return entries.filter((entry) => entry.effective).map((entry) => entry.level);
}

function writesOf(entries: readonly ThinkingPickerEntry[]): string[] {
  return entries.filter((entry) => entry.writesPreference).map((entry) => entry.level);
}

// 真解析入参（视图 / 提示文案用例走真实 resolver，与生产同一条链：显示口径不许另开一条）。
// 模型选型与 tests/reader/chat-tab-thinking-hint.test.ts 同款（那些事实已由 DOM 侧钉着）。
const ZHIPU_URL = "https://open.bigmodel.cn/api/paas/v4";
const KIMI_URL = "https://api.kimi.com/coding/v1";
const DEEPSEEK_URL = "https://api.deepseek.com/v1";
const QWEN_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const OPENROUTER_URL = "https://openrouter.ai/api/v1";
const CUSTOM_URL = "https://api.example.com/v1";

function realInput(presetId: string, baseUrl: string, model: string, level: unknown): ResolveThinkingInput {
  return { presetId, baseUrl, model, level, stream: true };
}

describe("标签表（05 号票：上游 7 档，与 chip 集合工件同源）", () => {
  it("键集 = 上游 7 档（不多 none、不少档位），文案照上游写法", () => {
    expect(Object.keys(THINKING_LEVEL_LABELS)).toEqual([...AI_THINKING_LEVELS]);
    expect(THINKING_LEVEL_LABELS).toEqual({
      off: "Off",
      minimal: "Minimal",
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "Xhigh",
      max: "Max"
    });
  });
});

describe("thinkingPickerEntries", () => {
  it("首项恒为 Default（不干预，所有模型都可选）", () => {
    for (const levels of [[], ["off"], ["high"], ["off", "low", "high", "max"]] as const) {
      expect(levelsOf(thinkingPickerEntries(input([...levels], "default")))[0], JSON.stringify(levels)).toBe("default");
    }
  });

  it("空可用集（没有可表达的强度档）：只剩 Default 一项（破例 = 能主动选）", () => {
    // effectiveLevel null = 没有解析结论（unknown 哨兵）→ 谁都不打勾；真实零档行给的是 "default"。
    expect(thinkingPickerEntries(input([], "off"))).toEqual([
      { level: "default", label: "Default", effective: false, writesPreference: true }
    ]);
    expect(thinkingPickerEntries(input([], "default"))).toEqual([
      { level: "default", label: "Default", effective: false, writesPreference: false }
    ]);
    expect(thinkingPickerEntries(input([], "max", false, "default"))).toEqual([
      { level: "default", label: "Default", effective: true, writesPreference: true }
    ]);
  });

  it("可关 + 多档：Default 之后是 Off 在首位的档位列表，顺序即可用集顺序；勾落在实发档", () => {
    const entries = thinkingPickerEntries(input(["off", "low", "high", "max"], "high", false, "high"));
    expect(levelsOf(entries)).toEqual(["default", "off", "low", "high", "max"]);
    expect(labelsOf(entries)).toEqual(["Default", "Off", "Low", "High", "Max"]);
    expect(effectiveOf(entries)).toEqual(["high"]);
    expect(writesOf(entries)).toEqual(["default", "off", "low", "max"]);
  });

  it("关不掉 + 多档：没有 Off 项", () => {
    const entries = thinkingPickerEntries(input(["low", "high", "max"], "low", false, "low"));
    expect(levelsOf(entries)).toEqual(["default", "low", "high", "max"]);
    expect(effectiveOf(entries)).toEqual(["low"]);
  });

  it("开关型（switchOnly）：非 off 域收成一项 On，条目档位值取 canonical high", () => {
    const entries = thinkingPickerEntries(input([...AI_THINKING_LEVELS], "off", true, "off"));
    expect(levelsOf(entries)).toEqual(["default", "off", "high"]);
    expect(labelsOf(entries)).toEqual(["Default", "Off", THINKING_ON_LABEL]);
    expect(effectiveOf(entries)).toEqual(["off"]);
    expect(writesOf(entries)).toEqual(["default", "high"]);
  });

  it("开关型：偏好是任何非 off 强度档 → 实发就是那个档、勾落在 On 上，且点 On 不重写偏好", () => {
    for (const level of AI_THINKING_LEVELS.filter((candidate) => candidate !== "off")) {
      const entries = thinkingPickerEntries(input([...AI_THINKING_LEVELS], level, true, level));
      expect(effectiveOf(entries), level).toEqual(["high"]);
      // 偏好已经落在 On 那一个写点上（它发同一个参数）→ 点它是重复选择，不许把偏好搬成 canonical high。
      expect(writesOf(entries), level).toEqual(["default", "off"]);
    }
    const byDefault = thinkingPickerEntries(input([...AI_THINKING_LEVELS], "default", true, "default"));
    expect(effectiveOf(byDefault)).toEqual(["default"]);
    expect(writesOf(byDefault)).toEqual(["off", "high"]);
  });

  it("上游只登记一个真实档位（none-high 的 {off,high}）：那一项显示为 On，勾 = 实发档", () => {
    const on = thinkingPickerEntries(input(["off", "high"], "high", false, "high"));
    expect(labelsOf(on)).toEqual(["Default", "Off", THINKING_ON_LABEL]);
    expect(effectiveOf(on)).toEqual(["high"]);
    expect(writesOf(on)).toEqual(["default", "off"]);

    // 偏好 low 不在可用集里（clamp 落 off）：勾落在实发档 off 上，On 那一项可点（点它即改成 high）。
    const off = thinkingPickerEntries(input(["off", "high"], "low", false, "off"));
    expect(labelsOf(off)).toEqual(["Default", "Off", THINKING_ON_LABEL]);
    expect(effectiveOf(off)).toEqual(["off"]);
    expect(writesOf(off)).toEqual(["default", "off", "high"]);
  });

  it("Default 的打勾 = 实发档是 default（不是「偏好是 default」）", () => {
    expect(effectiveOf(thinkingPickerEntries(input(["off", "high"], "default", false, "default")))).toEqual(["default"]);
    // 零档行 + 偏好是强度档：实发 default → 勾在 Default，而不在偏好的档（它不存在）。
    expect(effectiveOf(thinkingPickerEntries(input([], "high", false, "default")))).toEqual(["default"]);
  });
});

describe("thinkingPickerLabel（chip 档位 span 与一级行右侧同源）", () => {
  it("off 可用、或没有实发档信息：显示 Off（口径 ③ 只改「关不掉 + 有实发档」那一格）", () => {
    expect(thinkingPickerLabel(input(["off", "low", "high"], "off", false, "off"))).toBe("Off");
    expect(thinkingPickerLabel(input(["low", "high"], "off"))).toBe("Off");
    expect(thinkingPickerLabel(input([], "off"))).toBe("Off");
    expect(thinkingPickerLabel(input([...AI_THINKING_LEVELS], "off", true, "off"))).toBe("Off");
  });

  it("开关型且偏好非 off → On（chip 与菜单同一个词）", () => {
    expect(thinkingPickerLabel(input([...AI_THINKING_LEVELS], "low", true))).toBe("On");
    expect(thinkingPickerLabel(input(["off", "high"], "high"))).toBe("On");
  });

  it("没有解析结论（unknown 哨兵，effectiveLevel null）：回落偏好自己的档位词", () => {
    // 有规则时实发档必在可用集里（口径 ③ 显示实发档；零档行落 default），故「显示档落在
    // 可用集外」只可能是手搓入参：原先兜它的防御分支随候选 6 退休（视图值只由一次解析
    // 产出）。这里钉住唯一的 null 格——unknown 哨兵（无规则 → A' = ∅）。
    expect(thinkingPickerLabel(input([], "high"))).toBe("High");
    expect(thinkingPickerLabel(input([], "off"))).toBe("Off");
    expect(thinkingPickerLabel(input([], "default"))).toBe("Default");
  });

  it("普通多档：逐档用上游词", () => {
    const available: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    for (const level of AI_THINKING_LEVELS) {
      expect(thinkingPickerLabel(input(available, level)), level).toBe(THINKING_LEVEL_LABELS[level]);
    }
  });
});

// 口径 ③ + ⑤（2026-10-05 两轮复审 + 裁定 B）：偏好 ≠ 实发档时，一级行/chip **一律显示实发档**，
// 列表的勾也落在实发档（勾 = 线上实际发的那一档），点它即把该档写成偏好（writesPreference）——
// 显示与点击判据是两个字段，不再是同一个布尔。偏好本身不迁移（切模型只重解析、不写存储），
// 偏差由面板底部提示行说明。
describe("口径 ③/⑤：偏好 ≠ 实发档 → 一级行/chip 与列表的勾都落在实发档，点它写偏好", () => {
  it("off 关不掉·多档模型：{high,max} + 偏好 off + 实发 high → 一级行 High、勾在 high（点谁写谁）", () => {
    const view = input(["high", "max"], "off", false, "high");
    expect(thinkingPickerLabel(view)).toBe("High");
    expect(levelsOf(thinkingPickerEntries(view))).toEqual(["default", "high", "max"]);
    expect(effectiveOf(thinkingPickerEntries(view))).toEqual(["high"]);
    // 偏好 off 在列表里没有对应项 → 每一项都可点（点 high 即把偏好改成 high）。
    expect(writesOf(thinkingPickerEntries(view))).toEqual(["default", "high", "max"]);
  });

  it("off 关不掉·单档模型（上游只登记一个真实档位）：实发 high → 一级行照 On 口径显示、On 打勾", () => {
    const view = input(["high"], "off", false, "high");
    expect(thinkingPickerLabel(view)).toBe("On");
    expect(effectiveOf(thinkingPickerEntries(view))).toEqual(["high"]);
    expect(writesOf(thinkingPickerEntries(view))).toEqual(["default", "high"]);
  });

  it("off 关不掉·开关型（rule.off 缺失，A' 只有非 off 档）：实发 minimal 落在 On 的写点上 → 勾在 On", () => {
    // 关键：实发档（minimal）与条目档位值（canonical high）不相等——打勾必须按分支算。
    const view = input(["minimal", "low", "medium", "high", "xhigh", "max"], "off", true, "minimal");
    expect(levelsOf(thinkingPickerEntries(view))).toEqual(["default", "high"]);
    expect(effectiveOf(thinkingPickerEntries(view))).toEqual(["high"]);
    expect(writesOf(thinkingPickerEntries(view))).toEqual(["default", "high"]);
    expect(thinkingPickerLabel(view)).toBe("On");
  });

  it("off 可用：不替换显示档（仍 Off、仍勾 off、点 off 不写偏好）", () => {
    const view = input(["off", "high", "max"], "off", false, "off");
    expect(thinkingPickerLabel(view)).toBe("Off");
    expect(effectiveOf(thinkingPickerEntries(view))).toEqual(["off"]);
    expect(writesOf(thinkingPickerEntries(view))).toEqual(["default", "high", "max"]);
  });

  it("零档行（A' = ∅ → 实发 default）：一级行 Default、只剩 Default 且打勾；没有解析结论（null）才回落偏好词、无人打勾", () => {
    const noTiers = input([], "high", false, "default");
    expect(thinkingPickerLabel(noTiers)).toBe("Default");
    expect(levelsOf(thinkingPickerEntries(noTiers))).toEqual(["default"]);
    expect(effectiveOf(thinkingPickerEntries(noTiers))).toEqual(["default"]);

    // unknown 哨兵（没有规则 → 没有解析结论）：显示名回落偏好词，实发档无人打勾。
    const noRule = input([], "high", false, null);
    expect(thinkingPickerLabel(noRule)).toBe("High");
    expect(levelsOf(thinkingPickerEntries(noRule))).toEqual(["default"]);
    expect(effectiveOf(thinkingPickerEntries(noRule))).toEqual([]);

    expect(thinkingPickerLabel(input([], "off", false, "default"))).toBe("Default");
  });

  it("档位型 clamp（偏好 high、A' = {low,medium}）→ 一级行 Medium、勾在 medium", () => {
    const view = input(["low", "medium"], "high", false, "medium");
    expect(thinkingPickerLabel(view)).toBe("Medium");
    expect(levelsOf(thinkingPickerEntries(view))).toEqual(["default", "low", "medium"]);
    expect(effectiveOf(thinkingPickerEntries(view))).toEqual(["medium"]);
    expect(writesOf(thinkingPickerEntries(view))).toEqual(["default", "low", "medium"]);
  });

  it("档位型 clamp·偏好落在可用集下方（{off,high} + 偏好 low → 实发 off）：一级行 Off、勾在 off", () => {
    const view = input(["off", "high"], "low", false, "off");
    expect(thinkingPickerLabel(view)).toBe("Off");
    expect(effectiveOf(thinkingPickerEntries(view))).toEqual(["off"]);
    expect(writesOf(thinkingPickerEntries(view))).toEqual(["default", "off", "high"]);
  });

  it("档位型 clamp·单档模型（{high,max} + 偏好 medium → 实发 high）：一级行 On，不是 Medium", () => {
    const view = input(["high", "max"], "medium", false, "high");
    expect(thinkingPickerLabel(view)).toBe("High");
    expect(effectiveOf(thinkingPickerEntries(view))).toEqual(["high"]);
    const single = input(["high"], "medium", false, "high");
    expect(thinkingPickerLabel(single)).toBe("On");
  });
});

// ============================================================
// 架构评审候选 6：**一次解析直接给视图值**（偏好 + 上下文 → 一级行 · chip 条目 · 提示文案）。
// 组合根（reader/chat-tab）与面板（reader/chat-model-panel）只画结果——提示文案的两条口径
// 从此不挂整阅读壳（播放器链 + 换模块纪元）也能直测。
// 先列可能失败的方式：① 视图漏字段（替代面不完整）；② 提示文案口径①②漂移 / 优先级倒置；
// ③ 显示口径与落线漂移（视图说发某档、请求发别的档）；④ 缺省 / 脏值显示不为 Default；
// ⑤ 零档行被隐藏（ADR-0015：一级行照旧显示且能主动选）。
// ============================================================
describe("thinkingViewOf：一次解析直接给视图值（一级行 · chip 条目 · 提示文案）", () => {
  it("开关型（zhipu/glm-4.6 + 偏好 low）：三值同源——一级行 On、条目 Default/Off/On、无提示", () => {
    const view = thinkingViewOf(realInput("zhipu", ZHIPU_URL, "glm-4.6", "low"));
    expect(view.label).toBe(THINKING_ON_LABEL);
    expect(levelsOf(view.entries)).toEqual(["default", "off", "high"]);
    expect(labelsOf(view.entries)).toEqual(["Default", "Off", THINKING_ON_LABEL]);
    expect(effectiveOf(view.entries)).toEqual(["high"]);
    expect(view.hint).toBe(null);
  });

  it("档位型 clamp（qwen/qwen3.8-max + 偏好 high → medium）：一级行 Medium、勾在 medium、提示到场且与落线同档", () => {
    const view = thinkingViewOf(realInput("qwen", QWEN_URL, "qwen3.8-max", "high"));
    expect(view.label).toBe("Medium");
    expect(levelsOf(view.entries)).toEqual(["default", "off", "low", "medium", "xhigh"]);
    expect(effectiveOf(view.entries)).toEqual(["medium"]);
    expect(view.hint).toBe("当前模型不支持思考强度 high，已使用 medium");
    // 显示口径与落线同源：视图说发 medium，请求就发 reasoning_effort: medium。
    expect(
      openaiVocabularyFields(resolveThinkingProfile(realInput("qwen", QWEN_URL, "qwen3.8-max", "high")).vocabulary)
    ).toEqual({ reasoning_effort: "medium" });
  });

  it("零档行（openrouter/anthropic/claude-haiku-4.5，A' = ∅）：一级行 Default、条目只剩 Default 且打勾", () => {
    const zero = realInput("openrouter", OPENROUTER_URL, "anthropic/claude-haiku-4.5", "default");
    const view = thinkingViewOf(zero);
    expect(view.label).toBe("Default");
    expect(levelsOf(view.entries)).toEqual(["default"]);
    expect(effectiveOf(view.entries)).toEqual(["default"]);
    expect(view.hint).toBe(null);
    // 零档行 + 强度档偏好：实发 default，提示如实写「已使用 default」（ADR-0015 决定 5）。
    expect(thinkingViewOf({ ...zero, level: "high" }).hint).toBe("当前模型不支持思考强度 high，已使用 default");
  });

  it("unknown 哨兵（没有解析结论）：一级行回落偏好词、无人打勾、无提示", () => {
    const view = thinkingViewOf(realInput("custom", CUSTOM_URL, "vendor-future-1", "high"));
    expect(view.label).toBe("High");
    expect(levelsOf(view.entries)).toEqual(["default"]);
    expect(effectiveOf(view.entries)).toEqual([]);
    expect(view.hint).toBe(null);
  });

  it("缺省 / 脏值一律按 Default 显示（不显示成 off，也不报「已调整」）", () => {
    for (const level of [undefined, "", "bogus"]) {
      const view = thinkingViewOf(realInput("deepseek", DEEPSEEK_URL, "deepseek-v4-pro", level));
      expect(view.label, String(level)).toBe("Default");
      expect(levelsOf(view.entries), String(level)).toEqual(["default", "off", "low", "high", "max"]);
      expect(effectiveOf(view.entries), String(level)).toEqual(["default"]);
      expect(view.hint, String(level)).toBe(null);
    }
  });

  // 防御分支退休的依据（原来的分支只兜「显示档不在可用集」的手搓入参）：规则命中时实发档
  // 必在 A' 里（零档行落 default），null 只可能是 unknown 哨兵（无规则 → A' = ∅、非开关型）。
  it("不变式：实发档恒 ∈ A' ∪ {default}；null 只在无规则（unknown 哨兵）", () => {
    const samples: ReadonlyArray<[string, string, string]> = [
      ["deepseek", DEEPSEEK_URL, "deepseek-v4-pro"],
      ["zhipu", ZHIPU_URL, "glm-4.6"],
      ["zhipu", ZHIPU_URL, "glm-5.3"],
      ["qwen", QWEN_URL, "qwen3.8-max"],
      ["openrouter", OPENROUTER_URL, "anthropic/claude-haiku-4.5"],
      ["ollama", "http://localhost:11434/v1", "llama3.2"],
      ["custom", CUSTOM_URL, "vendor-future-1"]
    ];
    for (const [presetId, baseUrl, model] of samples) {
      const adjustment = resolveThinkingAdjustment(realInput(presetId, baseUrl, model, "low"));
      const at = `${presetId}/${model}`;
      if (adjustment.effectiveLevel === null) {
        expect(adjustment.availableLevels, at).toEqual([]);
        expect(adjustment.switchOnly, at).toBe(false);
      } else if (adjustment.effectiveLevel !== "default") {
        expect(adjustment.availableLevels, at).toContain(adjustment.effectiveLevel);
      }
    }
  });
});

describe("thinkingHint：提示文案口径①②（纯函数直测，不挂阅读壳）", () => {
  // 文案逐字给定（工单 03 + 05 号票复审，勿改写）：长版 = 级联落了最小思考档；短版 = 连
  // 最小档都没有。
  it("① off 关不掉：级联落最小思考档 → 长版；无档可落 → 短版；优先级压过②（不串成 clamp 文案）", () => {
    // zhipu/glm-5.3：上游词表 low-high-max（无 off 写点）→ 级联落 low；reason 同时非空，
    // 口径①必须优先（否则会写成「不支持 off，已使用 low」）。
    const long = resolveThinkingAdjustment(realInput("zhipu", ZHIPU_URL, "glm-5.3", "off"));
    expect(long.reason).not.toBe(null);
    expect(thinkingHint(long)).toBe("当前模型不支持在本次请求中关闭思考，已使用最小思考档位");
    // moonshot/kimi-k2.7-code：手写兜底 kimi-always、无档位写点 → 无档可落。
    const short = resolveThinkingAdjustment(realInput("", "", "kimi-k2.7-code", "off"));
    expect(short.resolution.offUnavailable).toBe(true);
    expect(short.resolution.offFallback).toBe(null);
    expect(thinkingHint(short)).toBe("当前模型没办法关掉思考");
  });

  it("① off 正常可用 / never 静默：都无提示", () => {
    expect(thinkingHint(resolveThinkingAdjustment(realInput("zhipu", ZHIPU_URL, "glm-4.6", "off")))).toBe(null);
    expect(thinkingHint(resolveThinkingAdjustment(realInput("", KIMI_URL, "kimi-k2-instruct", "off")))).toBe(null);
    expect(thinkingHint(resolveThinkingAdjustment(realInput("deepseek", DEEPSEEK_URL, "deepseek-chat", "off")))).toBe(null);
  });

  it("② 偏好档位被 clamp：源档 → 实发档（逐字）；档位可用 / default 偏好都不报", () => {
    expect(thinkingHint(resolveThinkingAdjustment(realInput("qwen", QWEN_URL, "qwen3.8-max", "high")))).toBe(
      "当前模型不支持思考强度 high，已使用 medium"
    );
    expect(
      thinkingHint(resolveThinkingAdjustment(realInput("deepseek", DEEPSEEK_URL, "deepseek-v4-pro-2026", "xhigh")))
    ).toBe("当前模型不支持思考强度 xhigh，已使用 high");
    expect(thinkingHint(resolveThinkingAdjustment(realInput("qwen", QWEN_URL, "qwen3.8-max", "low")))).toBe(null);
    expect(thinkingHint(resolveThinkingAdjustment(realInput("qwen", QWEN_URL, "qwen3.8-max", "default")))).toBe(null);
  });
});
