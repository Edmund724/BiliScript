// tests/chat/thinking-picker.test.ts
// chat/thinking-picker 的纯函数契约（2026-10-05 用户裁定，票据 chat-thinking-submenu）：
// 模型面板的「思考强度」二级菜单显示什么、谁打勾、chip 与一级行显示什么值。
//
// 先列可能失败的方式（每条都有对应用例）：
//   1. 开关型（rule.on）没收成 Off/On，仍把 6 个非 off 档各列一行（用户报的「全都是按钮」）；
//   2. 只登记一个真实档位的模型（none-high）不显示 On；
//   3. off 不在可用集却凭空造出 Off 项（显示请求不发的选择）；
//   4. Off 不在首位（档位序契约：off 永远第一）；
//   5. 开关型的 On 激活判定按 data-level 相等——偏好是别的非 off 档时 On 不打勾；
//   6. 偏好落在可用集外时仍显示 On——与提示行的「low → off」自相矛盾；
//   7. 显示名出现第二套推导（chip 与列表不同源）；
//   8. 标签表键集漂移（多了 none / 少了档位）；
//   9. 关不掉（off ∉ A'）却显示 Off——一级行与线上实发的档位不符（口径 ③，2026-10-05 复审）。

import { describe, expect, it } from "vitest";
import {
  THINKING_LEVEL_LABELS,
  THINKING_ON_LABEL,
  thinkingPickerEntries,
  thinkingPickerLabel,
  type ThinkingPickerInput
} from "../../extension/chat/thinking-picker.js";
import { AI_THINKING_LEVELS, type ThinkingLevel } from "../../extension/ai/thinking-profiles.js";

// 入参工厂：effectiveLevel 缺省 null = 「没有实发档信息」（口径 ③ 只在偏好 off 且
// off ∉ A' 且实发档非 off 时才替换显示档，缺省值即那条回退路径）。
function input(
  availableLevels: readonly ThinkingLevel[],
  requestedLevel: ThinkingLevel,
  switchOnly = false,
  effectiveLevel: ThinkingLevel | null = null
): ThinkingPickerInput {
  return { availableLevels, switchOnly, requestedLevel, effectiveLevel };
}

function levelsOf(entries: ReturnType<typeof thinkingPickerEntries>): string[] {
  return entries.map((entry) => entry.level);
}

function labelsOf(entries: ReturnType<typeof thinkingPickerEntries>): string[] {
  return entries.map((entry) => entry.label);
}

function activeOf(entries: ReturnType<typeof thinkingPickerEntries>): string[] {
  return entries.filter((entry) => entry.active).map((entry) => entry.level);
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
  it("空可用集：一个条目都没有（面板整行隐藏，fail-closed）", () => {
    expect(thinkingPickerEntries(input([], "off"))).toEqual([]);
    expect(thinkingPickerEntries(input([], "max"))).toEqual([]);
  });

  it("可关 + 多档：Off 在首位的档位列表，顺序即可用集顺序", () => {
    const entries = thinkingPickerEntries(input(["off", "low", "high", "max"], "high"));
    expect(levelsOf(entries)).toEqual(["off", "low", "high", "max"]);
    expect(labelsOf(entries)).toEqual(["Off", "Low", "High", "Max"]);
    expect(activeOf(entries)).toEqual(["high"]);
  });

  it("关不掉 + 多档：没有 Off 项", () => {
    const entries = thinkingPickerEntries(input(["low", "high", "max"], "low"));
    expect(levelsOf(entries)).toEqual(["low", "high", "max"]);
    expect(activeOf(entries)).toEqual(["low"]);
  });

  it("开关型（switchOnly）：非 off 域收成一项 On，条目档位值取 canonical high", () => {
    const entries = thinkingPickerEntries(input([...AI_THINKING_LEVELS], "off", true));
    expect(levelsOf(entries)).toEqual(["off", "high"]);
    expect(labelsOf(entries)).toEqual(["Off", THINKING_ON_LABEL]);
    expect(activeOf(entries)).toEqual(["off"]);
  });

  it("开关型：偏好是任何非 off 档都落在 On 上（6 个非 off 档发的是同一个「开」写点）", () => {
    for (const level of AI_THINKING_LEVELS.filter((candidate) => candidate !== "off")) {
      const entries = thinkingPickerEntries(input([...AI_THINKING_LEVELS], level, true));
      expect(activeOf(entries), level).toEqual(["high"]);
    }
  });

  it("上游只登记一个真实档位（none-high 的 {off,high}）：那一项显示为 On，按档位值打勾", () => {
    const on = thinkingPickerEntries(input(["off", "high"], "high"));
    expect(labelsOf(on)).toEqual(["Off", THINKING_ON_LABEL]);
    expect(activeOf(on)).toEqual(["high"]);

    // 偏好 low 不在可用集里（clamp 落 off）：没有条目命中，不做成「已选中 On」。
    const off = thinkingPickerEntries(input(["off", "high"], "low"));
    expect(labelsOf(off)).toEqual(["Off", THINKING_ON_LABEL]);
    expect(activeOf(off)).toEqual([]);
  });

  it("单选条目：可用集只有一项时条目数 = 1（面板据此隐藏整行）", () => {
    expect(thinkingPickerEntries(input(["high"], "high"))).toHaveLength(1);
    expect(thinkingPickerEntries(input(["off"], "off"))).toHaveLength(1);
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

  it("偏好落在可用集外：显示偏好自己的档位词，不显示 On（避免与「low → off」提示矛盾）", () => {
    expect(thinkingPickerLabel(input(["off", "high"], "low"))).toBe("Low");
    expect(thinkingPickerLabel(input(["high", "max"], "medium"))).toBe("Medium");
  });

  it("普通多档：逐档用上游词", () => {
    const available: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    for (const level of AI_THINKING_LEVELS) {
      expect(thinkingPickerLabel(input(available, level)), level).toBe(THINKING_LEVEL_LABELS[level]);
    }
  });
});

// 口径 ③（2026-10-05 复审裁定）：偏好 off 而该模型关不掉时，一级行与 chip 显示
// **实发档**——线上发 high 就写 High，不再一边写 Off 一边发 high。列表不替实发档打勾：
// 打勾是「点它不写偏好」的判据，替实发档打勾会让用户点了 High 却什么都没落盘。
describe("口径 ③：off 关不掉 → 一级行显示实发档（列表仍按偏好打勾）", () => {
  it("多档模型：{high,max} + 偏好 off + 实发 high → 一级行 High；列表条目不变、无人打勾", () => {
    const view = input(["high", "max"], "off", false, "high");
    expect(thinkingPickerLabel(view)).toBe("High");
    expect(levelsOf(thinkingPickerEntries(view))).toEqual(["high", "max"]);
    expect(activeOf(thinkingPickerEntries(view))).toEqual([]);
  });

  it("单档模型（上游只登记一个真实档位）：实发 high → 一级行照这里的 On 口径显示", () => {
    const view = input(["high"], "off", false, "high");
    expect(thinkingPickerLabel(view)).toBe("On");
    expect(activeOf(thinkingPickerEntries(view))).toEqual([]);
  });

  it("off 可用：不替换显示档（仍 Off、仍勾 off）", () => {
    const view = input(["off", "high", "max"], "off", false, "off");
    expect(thinkingPickerLabel(view)).toBe("Off");
    expect(activeOf(thinkingPickerEntries(view))).toEqual(["off"]);
  });

  it("无档可落（effectiveLevel null，A' = ∅）：维持 Off（面板整行隐藏，显示名无人消费）", () => {
    const view = input([], "off", false, null);
    expect(thinkingPickerLabel(view)).toBe("Off");
    expect(thinkingPickerEntries(view)).toEqual([]);
  });

  it("偏好非 off 时不受影响：档位型 clamp 仍显示偏好自己的档位词、不替它打勾（05 号票口径）", () => {
    const view = input(["high", "max"], "medium", false, "high");
    expect(thinkingPickerLabel(view)).toBe("Medium");
    expect(activeOf(thinkingPickerEntries(view))).toEqual([]);
  });
});
