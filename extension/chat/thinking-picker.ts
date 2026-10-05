// chat/thinking-picker.ts — 模型面板「思考强度」二级菜单的显示条目派生（纯函数，零 DOM）。
//
// 2026-10-05 用户裁定（.scratch/tickets/chat-thinking-submenu/）：面板底部不再把可用档位
// 全铺成一排按钮，而是固定区一行「思考强度 <当前值> ›」，点它换页到档位列表。列表里
// 显示什么、谁打勾、一级行显示什么值，全部由本模块派生；面板模块只管把结果画出来。
//
// 事实链不动：条目的档位值仍只来自 resolveThinkingAdjustment() 的同一次解析
//（availableLevels = A'），本模块**不新开第二套档位推导**，只决定分组与显示名。
//
// 三条显示口径（用户裁定）：
//   ① 开关型（switchOnly = 规则的 rule.on：非 off 域只由单个「开」写点服务）→ 收成
//      Off 一项 + On 一项；上游那 6 个非 off 档位不再各占一行（它们发的是同一个参数）。
//   ② 上游只登记了一个真实档位（如 none-high 的 {off, high}）→ 那一项显示为 On。
//   ③ off 关不掉（off ∉ A'）时显示**实发档**（2026-10-05 复审裁定，修订同日「偏好 off
//      恒显示 Off」的口径）：偏好 off 而模型只能给出 effort 档时，一级行/chip 照实发档显示
//      （{high,max} → High），不再一级行写 Off、线上发 high。偏好本身不迁移（存储值仍是
//      off，换到能关的模型照 off 解析）。只对 off 生效——档位型 clamp（high → medium）
//      的提示行已如实写出「源档 → 实发档」，chip 仍照偏好显示（05 号票口径）。
import type { ThinkingLevel } from "../ai/thinking-levels.js";

// 档位标签表（05 号票：上游词表 7 档）。口径与既有 Off/Low/High 一致——首字母大写、
// 档位词照上游写法（xhigh → XHigh）；未登记档位（脏存储值）回落原值。
// 06 号票起导出：模板占位、chip 集合工件（tests/ai/thinking-chips.test.ts）与本模块
// 同源，避免「标签」出现第三份字面量。
export const THINKING_LEVEL_LABELS: Record<string, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max"
};

// 开关型那一项的显示名（on/off 两侧不对称：off 沿用上游词 Off）。
export const THINKING_ON_LABEL = "On";

// 开关型「开」写进偏好的档位值：rule.on 型任何非 off 档都落同一个「开」写点，故取
// canonical high 作偏好值——换到有真实档位的模型时是个中档，不是凭空发明的档位。
const SWITCH_ON_LEVEL: ThinkingLevel = "high";

export interface ThinkingPickerInput {
  // 该模型的可用集（resolveThinkingAdjustment 的同一次解析；空 = 一个档位都没有）。
  availableLevels: readonly ThinkingLevel[];
  // 非 off 域是否只由单个「开」写点服务（thinking-profiles 的 rule.on）。
  switchOnly: boolean;
  // 当前全局偏好档位（chatSessionState.aiThinkingLevel 的归一化值）。
  requestedLevel: ThinkingLevel;
  // 本次解析的**实发档**（resolveThinkingAdjustment().effectiveLevel）；null = 无档可落。
  // 只在「偏好 off 且 off ∉ A'」这一格参与显示（见 offCascadeShownLevel）：关不掉时
  // 界面照实发档显示，不再显示一个线上没发的 Off。
  effectiveLevel: ThinkingLevel | null;
}

export interface ThinkingPickerEntry {
  // 点它要写进全局偏好的档位值（开关型的 On 是 SWITCH_ON_LEVEL，不是新档位）。
  level: ThinkingLevel;
  label: string;
  // 当前偏好是否落在它身上（打勾）。
  active: boolean;
}

// 非 off 域是否收成一项「On」：rule.on 型（开关）或上游只登记了一个真实档位。
function isSwitchCollapsed(input: ThinkingPickerInput): boolean {
  return input.switchOnly || input.availableLevels.filter((level) => level !== "off").length === 1;
}

// 显示用的档位：默认 = 偏好；只在「偏好 off、该模型关不掉（off ∉ A'）、且真有实发档」时
// 换成实发档（口径 ③）。off 可用的模型不换（照显示 Off），无档可落（effectiveLevel
// null，如 A' = ∅ 的零档行）也不换——那时面板整行隐藏，显示名无人消费。
function offCascadeShownLevel(input: ThinkingPickerInput): ThinkingLevel | null {
  const { availableLevels, requestedLevel, effectiveLevel } = input;
  if (requestedLevel !== "off" || availableLevels.includes("off")) {
    return null;
  }
  return effectiveLevel && effectiveLevel !== "off" ? effectiveLevel : null;
}

// 档位列表的显示条目（面板换页后的那一页）。
//   空可用集 → 无条目（面板整行隐藏）；
//   可关 → 首项 Off；不可关 → 没有 Off 项（用户看到的就是「关不掉」）。
//   激活判定按条目的语义走：rule.on 型任何非 off 偏好都落在 On 上（它们发同一个参数），
//   其余按「偏好 = 该档」逐项比对——被 clamp 的偏好可能一项都不打勾，由面板底部提示行
//   说明（05 号票口径，偏好不迁移）。
//   **off 关不掉时列表也不替实发档打勾**：打勾是「点它不写偏好」的判据（面板据此把点击
//   当重复选择），而实发档不是用户存下的偏好——替它打勾会让「点 High」不再写偏好，用户
//   以为选了 High、存储里却还是 off。实发档只由一级行/chip 显示（口径 ③）。
export function thinkingPickerEntries(input: ThinkingPickerInput): ThinkingPickerEntry[] {
  const { availableLevels, switchOnly, requestedLevel } = input;
  if (availableLevels.length === 0) {
    return [];
  }
  const tiers = availableLevels.filter((level) => level !== "off");
  const entries: ThinkingPickerEntry[] = [];
  if (availableLevels.includes("off")) {
    entries.push({ level: "off", label: THINKING_LEVEL_LABELS.off, active: requestedLevel === "off" });
  }
  if (switchOnly) {
    entries.push({ level: SWITCH_ON_LEVEL, label: THINKING_ON_LABEL, active: requestedLevel !== "off" });
    return entries;
  }
  if (tiers.length === 1) {
    entries.push({ level: tiers[0], label: THINKING_ON_LABEL, active: requestedLevel === tiers[0] });
    return entries;
  }
  for (const level of tiers) {
    entries.push({ level, label: THINKING_LEVEL_LABELS[level] ?? level, active: level === requestedLevel });
  }
  return entries;
}

// 当前显示名（chip 的档位 span 与一级行右侧同用这一个）。
//   off 关不掉 → 实发档的档位词（口径 ③：线上发 high 就写 High，提示行说明关不掉）；
//   off 可用 → Off（偏好与实发档一致）；
//   开关型且显示档**在该模型可用集里** → On；
//   其余 → 上游档位词。
// 显示档落在可用集外时不给 On：档位型 clamp 下显示档仍是偏好（如 {off,high} 的偏好 low，
// 落线发 effort none），显示 On 会与提示行的「low → off」自相矛盾——此时照旧显示偏好
// 自己的档位词，让提示行说明去向。
export function thinkingPickerLabel(input: ThinkingPickerInput): string {
  const { availableLevels, switchOnly, requestedLevel } = input;
  const shown = offCascadeShownLevel(input) ?? requestedLevel;
  if (shown === "off") {
    return THINKING_LEVEL_LABELS.off;
  }
  if (isSwitchCollapsed(input) && (switchOnly || availableLevels.includes(shown))) {
    return THINKING_ON_LABEL;
  }
  return THINKING_LEVEL_LABELS[shown] ?? shown;
}
