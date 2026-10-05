// tests/chat/thinking-picker.test.ts
// chat/thinking-picker 的纯函数契约（2026-10-05 用户裁定，票据 chat-thinking-submenu）：
// 模型面板的「思考强度」二级菜单显示什么、谁打勾、chip 与一级行显示什么值。
//
// 先列可能失败的方式（每条都有对应用例）：
//   1. 开关型（rule.on）没收成 Off/On，仍把 6 个非 off 档各列一行（用户报的「全都是按钮」）；
//   2. 只登记一个真实档位的模型（none-high）不显示 On；
//   3. off 不在可用集却凭空造出 Off 项（显示请求不发的选择）；
//   4. Off 不在首位（档位序契约：off 永远第一）；
//   5. 开关型 On 的打勾按 data-level 相等算——实发落在 On 那一个写点上（如 minimal）时无人打勾；
//   6. 偏好落在可用集外时仍显示 On——与提示行的「low → off」自相矛盾；
//   7. 显示名出现第二套推导（chip 与列表不同源）；
//   8. 标签表键集漂移（多了 none / 少了档位）；
//   9. 偏好 ≠ 实发档却显示偏好——一级行与线上实发的档位不符（口径 ③，2026-10-05 两轮复审）；
//  10. 无实发档信息（effectiveLevel null，unknown 哨兵）时不回落偏好词；
//  11. **打勾与点击判据共用一个布尔**（口径 ⑤ 裁定 B 要防的事）：勾住的那一项点下去不写偏好，
//      用户以为选了、存储里却还是旧偏好；
//  12. 开关型 On 的写入判据按 canonical high 比：偏好 max 时判成「不相等 → 写」，偏好被搬到
//      high（05 号票「偏好不迁移」要防的事）。

import { describe, expect, it } from "vitest";
import {
  THINKING_LEVEL_LABELS,
  THINKING_ON_LABEL,
  thinkingPickerEntries,
  thinkingPickerLabel,
  type ThinkingPickerInput
} from "../../extension/chat/thinking-picker.js";
import { AI_THINKING_LEVELS, type ThinkingLevel, type ThinkingLevelValue } from "../../extension/ai/thinking-profiles.js";

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

function levelsOf(entries: ReturnType<typeof thinkingPickerEntries>): string[] {
  return entries.map((entry) => entry.level);
}

function labelsOf(entries: ReturnType<typeof thinkingPickerEntries>): string[] {
  return entries.map((entry) => entry.label);
}

// 打勾（effective = 实发档，口径 ⑤）与点击判据（writesPreference）分别取，别混成一个布尔。
function effectiveOf(entries: ReturnType<typeof thinkingPickerEntries>): string[] {
  return entries.filter((entry) => entry.effective).map((entry) => entry.level);
}

function writesOf(entries: ReturnType<typeof thinkingPickerEntries>): string[] {
  return entries.filter((entry) => entry.writesPreference).map((entry) => entry.level);
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
      xhigh: "XHigh",
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

  it("没有实发档信息（effectiveLevel null）：回落偏好自己的档位词", () => {
    // 真实调用方只有「无规则」（unknown 哨兵，面板整行隐藏）才会传 null；此处同时钉住
    // 「显示档落在可用集外不给 On」的兜底分支：偏好不在可用集里、又不知实发档 → 不显示 On。
    expect(thinkingPickerLabel(input(["off", "high"], "low"))).toBe("Low");
    expect(thinkingPickerLabel(input(["high", "max"], "medium"))).toBe("Medium");
    expect(thinkingPickerLabel(input(["low", "high"], "off"))).toBe("Off");
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
