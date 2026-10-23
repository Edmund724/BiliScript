// chat/thinking-picker.ts — 模型面板「思考强度」内联选择区的**显示视图**派生
// （纯函数，零 DOM）：一次解析（偏好 + 上下文）直接给视图值——当前显示名 · 档位条目 ·
// 提示文案；面板（reader/chat-model-panel）与组合根（reader/chat-tab）只画结果。
//
// 面板底部固定区内联展示「思考强度 <当前值> + 右上角 ↻ 重置键（Default 不干预档）」与
// 胶囊滑轨 / 单档胶囊。有哪些档位条目、哪一档是实发生效态、当前显示什么档位名、底部提示行
// 说什么，全部由本模块派生；面板模块只管把结果画出来。
//
// 架构评审候选 6（显示派生收敛，行为中立）：视图值由 thinkingViewOf(ResolveThinkingInput)
// **一次给全**——解析仍只有一处（ai/thinking-profiles 的 resolveThinkingAdjustment），
// 调用点不再手工摘字段（漏抄在类型上不可能：整份解析结果进、三个视图值出）。提示文案的
// 口径①②也随之从组合根（reader/chat-tab 的 refreshThinkingUi）移入本模块：两条口径现在
// 是纯函数，直测不必再挂整阅读壳 + 播放器链 + 换模块纪元。
//
// 事实链不动：档位值仍只来自 resolveThinkingAdjustment() 的同一次解析
//（availableLevels = A'），本模块**不新开第二套档位推导**，只决定分组、显示名与提示文案。
//
// 五条显示口径（用户裁定）：
//   ① 开关型（switchOnly = 规则的 rule.on：非 off 域只由单个「开」写点服务）→ 收成
//      Off 一项 + On 一项；上游那 6 个非 off 档位不再各占一行（它们发的是同一个参数）。
//   ② 上游只登记了一个真实档位（如 none-high 的 {off, high}）→ 那一项显示为 On。
//   ③ 偏好 ≠ 实发档时显示**实发档**（2026-10-05 复审裁定，两轮）：第一轮只改 off 关不掉
//      那一格（偏好 off 而模型只能给出 effort 档 → 一级行/chip 写 High，线上确实发 high，
//      不再写 Off）；第二轮统一到**所有**偏好 ≠ 实发的格（档位型 clamp 也从「显示偏好 +
//      提示行说明」改成显示实发档：偏好 high、A' = {low,medium} → 一级行/chip 写 Medium，
//      提示行如实说明源档）。偏好本身不迁移（存储值不动，换到支持的模型照原偏好解析）。
//   ④ **首项恒为 `Default`**（2026-10-05 用户裁定「所有模型都加一个 default 档位、都可发」）：
//      default = 不干预（不发思考字段），与 off（显式发关思考字段）不同；可表达的强度档为空时
//      列表就是只剩 Default 一项，面板**不隐藏**该行（用户裁定「破例 = 能主动选」）。
//   ⑤ **列表的勾 = 实发档**（2026-10-05 裁定 B）：勾 / 高亮 / aria-current 一律由
//      `ThinkingPickerEntry.effective` 决定——「勾 = 线上实际发的那一档」，与 chip、一级行
//      说同一件事（与面板模型页 `is-selected` 的勾同义）。**点击判据是另一个字段**
//      （`writesPreference`，从 requestedLevel 算、不读勾）：勾住的那一项在偏好 ≠ 实发时
//      点下去**也写偏好**（用户显式接受本次 clamp）；只有「它已经是偏好落在的那一项」才不写。
import {
  resolveThinkingAdjustment,
  type ResolveThinkingInput,
  type ThinkingLevelAdjustment
} from "../ai/thinking-profiles.js";
import { THINKING_DEFAULT_LEVEL, type ThinkingLevel, type ThinkingLevelValue } from "../ai/thinking-levels.js";

// 档位标签表（05 号票：上游词表 7 档）。口径 = 表内统一构词：首字母大写、其余小写
// （xhigh → Xhigh，2026-10-05 用户裁定：三家参考都不写 XHigh——Codex 的档位显示名是
// "Extra high"，Claude Code 与 dsh 一律用全小写 token xhigh）；未登记档位（脏存储值）
// 回落原值。
// 06 号票起导出：模板占位、chip 集合工件（tests/ai/thinking-chips.test.ts）与本模块
// 同源，避免「标签」出现第三份字面量。
export const THINKING_LEVEL_LABELS: Record<string, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Xhigh",
  max: "Max"
};

// 开关型那一项的显示名（on/off 两侧不对称：off 沿用上游词 Off）。
export const THINKING_ON_LABEL = "On";

// 「不干预」档的显示名（2026-10-05 用户裁定）：所有模型恒有这一项，落线 = 不发思考字段。
export const THINKING_DEFAULT_LABEL = "Default";

// 开关型「开」写进偏好的档位值：rule.on 型任何非 off 档都落同一个「开」写点，故取
// canonical high 作偏好值——换到有真实档位的模型时是个中档，不是凭空发明的档位。
const SWITCH_ON_LEVEL: ThinkingLevel = "high";

// 条目派生吃的字段面 = 解析结果里与显示有关的那一面。**由 ThinkingLevelAdjustment 派生**
// （候选 6 前是手写 interface + 调用点手工摘 4 个字段，漏抄无人拦）：形状与解析结果在
// 编译期对账，字段增删不会悄悄漂移；生产调用点是 thinkingViewOf（整份解析结果进）。
export type ThinkingPickerInput = Pick<
  ThinkingLevelAdjustment,
  "availableLevels" | "switchOnly" | "requestedLevel" | "effectiveLevel"
>;

export interface ThinkingPickerEntry {
  // 点它要写进全局偏好的值（开关型的 On 是 SWITCH_ON_LEVEL；`default` 是「不干预」）。
  level: ThinkingLevelValue;
  label: string;
  // 这一项就是本次解析的**实发档**（口径 ⑤，2026-10-05 裁定 B）：列表据此打勾 / 高亮 /
  // aria-current。偏好 ≠ 实发时线上发的是它，所以「打不打勾」答的是「线上实际发什么」。
  effective: boolean;
  // 点它是否写全局偏好（**点击判据，与打勾分开**）。只有「它已经是偏好落在的那一项」才不写；
  // 开关型的 On 代表全部非 off 档，必须按语义判（按 canonical high 比会把偏好悄悄搬走），
  // 其余按值比（口径 ⑤：勾住的那一项在偏好 ≠ 实发时点下去也写偏好）。
  writesPreference: boolean;
}

// 视图值（候选 6：同一次解析的三个显示产出）。画侧只读这些字段：
//   label   → chip 的档位 span 与一级行右侧（reader/chat-model-panel 写入）
//   entries → 档位页条目
//   hint    → 面板底部提示行；null = 不显示
export interface ThinkingView {
  label: string;
  entries: readonly ThinkingPickerEntry[];
  hint: string | null;
}

// 视图值的唯一派生入口（候选 6）：偏好 + 上下文 → 一级行 · chip 条目 · 提示文案。
// 解析只在这里发生一次（resolveThinkingAdjustment）：显示口径与请求落线读同一张规则、
// 同一个 clamp，不可能出现「提示说 medium、请求发 xhigh」。
export function thinkingViewOf(input: ResolveThinkingInput): ThinkingView {
  const adjustment = resolveThinkingAdjustment(input);
  return {
    label: thinkingPickerLabel(adjustment),
    entries: thinkingPickerEntries(adjustment),
    hint: thinkingHint(adjustment)
  };
}

// 非 off 域是否收成一项「On」：rule.on 型（开关）或上游只登记了一个真实档位。
function isSwitchCollapsed(input: ThinkingPickerInput): boolean {
  return input.switchOnly || input.availableLevels.filter((level) => level !== "off").length === 1;
}

// 显示用的档位：默认 = **实发档**（口径 ③）。只有没有解析结论（effectiveLevel null）才回落偏好。
function shownLevel(input: ThinkingPickerInput): ThinkingLevelValue {
  return input.effectiveLevel ?? input.requestedLevel;
}

// 档位值的显示名（`default` 是「不干预」，不在上游档位词表里）。
export function thinkingLevelValueLabel(value: ThinkingLevelValue): string {
  return value === "default" ? THINKING_DEFAULT_LABEL : THINKING_LEVEL_LABELS[value] ?? value;
}

// 档位列表的显示条目（面板换页后的那一页）。
//   **首项恒为 `Default`**（2026-10-05 用户裁定：所有模型都可选「不干预」，落线 = 不发思考字段）；
//   之后是可关 → `Off`、开关型 → 一项 `On`、其余 → 逐档上游词。
//   可表达的强度档为空也**不是**空列表：只剩 `Default` 一项（用户裁定「破例 = 能主动选」）。
//   两个字段按三条分支各自算（**不能**写 `entry.level === effectiveLevel`）：
//     `effective`（口径 ⑤，打勾）= 这一项是不是本次解析的实发档。开关型的 On 是**唯一写点**，
//       实发是任何强度档都落在它身上（`effectiveLevel` 是 minimal/low/… 时也如此）；单档型
//       按档位值比；Off / Default 按值比。没有解析结论（effectiveLevel null）时谁都不打勾。
//     `writesPreference`（点击判据）= 它还不是偏好落在的那一项。开关型的 On 只要偏好是非 off
//       非 default 的强度档就不写（它们发同一个「开」写点——偏好不迁移）；其余按值比。
//   于是：偏好 ∈ A' → 勾在偏好那一项（口径 ③ 的常规格）；偏好 ∉ A'（off 关不掉 / 档位型 clamp）
//   → 勾落在实发那一项，点它即把该档写成偏好（用户裁定 B），提示行说明被调整的来源档。
export function thinkingPickerEntries(input: ThinkingPickerInput): ThinkingPickerEntry[] {
  const { availableLevels, switchOnly, requestedLevel } = input;
  const effective = input.effectiveLevel;
  const entries: ThinkingPickerEntry[] = [
    {
      level: THINKING_DEFAULT_LEVEL,
      label: THINKING_DEFAULT_LABEL,
      effective: effective === THINKING_DEFAULT_LEVEL,
      writesPreference: requestedLevel !== THINKING_DEFAULT_LEVEL
    }
  ];
  if (availableLevels.length === 0) {
    return entries;
  }
  const tiers = availableLevels.filter((level) => level !== "off");
  if (availableLevels.includes("off")) {
    entries.push({
      level: "off",
      label: THINKING_LEVEL_LABELS.off,
      effective: effective === "off",
      writesPreference: requestedLevel !== "off"
    });
  }
  if (switchOnly) {
    entries.push({
      level: SWITCH_ON_LEVEL,
      label: THINKING_ON_LABEL,
      // 非 off 域只由这一个「开」写点服务：实发只要是个强度档就是它发的（口径 ①/⑤）。
      effective: effective !== null && effective !== "off" && effective !== THINKING_DEFAULT_LEVEL,
      // 偏好已经是任何非 off 强度档 → 已落在它身上（canonical high ≠ 偏好值时也不许重写）。
      writesPreference: requestedLevel === "off" || requestedLevel === THINKING_DEFAULT_LEVEL
    });
    return entries;
  }
  if (tiers.length === 1) {
    entries.push({
      level: tiers[0],
      label: THINKING_ON_LABEL,
      effective: effective === tiers[0],
      writesPreference: requestedLevel !== tiers[0]
    });
    return entries;
  }
  for (const level of tiers) {
    entries.push({
      level,
      label: THINKING_LEVEL_LABELS[level] ?? level,
      effective: effective === level,
      writesPreference: level !== requestedLevel
    });
  }
  return entries;
}

// 当前显示名（chip 的档位 span 与一级行右侧同用这一个）。
//   `default`（不干预）→ Default；
//   有实发档 → 实发档的档位词（口径 ③：线上发 high 就写 High、被裁到 medium 就写 Medium，
//   源档与原因由提示行说明）；
//   开关型（口径 ①②，含上游只登记一个真实档位）→ On；
//   其余 → 上游档位词。
// 候选 6 起本函数只吃解析结果（ThinkingPickerInput 由 ThinkingLevelAdjustment 派生）：
//「实发档 ∈ A' ∪ {default}」是解析层的不变式（effectiveLevel null ⟺ 无规则 ⟺ A' = ∅ 且
// 非开关型），故原先「显示档落在可用集外就不给 On」的防御分支（只兜手搓入参）退休。
export function thinkingPickerLabel(input: ThinkingPickerInput): string {
  const shown = shownLevel(input);
  if (shown === THINKING_DEFAULT_LEVEL || shown === "off") {
    return thinkingLevelValueLabel(shown);
  }
  return isSwitchCollapsed(input) ? THINKING_ON_LABEL : THINKING_LEVEL_LABELS[shown] ?? shown;
}

// ===== 提示文案（口径①②；候选 6 起从组合根移入本模块）=====
// 文案逐字给定（工单 03，勿改写）：长版 = 级联落了最小思考档；短版 = 连最小档都没有。
const THINKING_OFF_FALLBACK_LOW_HINT = "当前模型不支持关闭思考，已使用最低档位";
const THINKING_OFF_UNAVAILABLE_HINT = "当前模型不支持关闭思考";

// 提示行文案（null = 不显示提示行）。两类提示互斥，**① 优先**：
//   ① 工单 03「关不掉思考」：偏好 off 且解析判 off 不可用（级联落了最小档 / 无档可落），
//      长/短文案由 offFallback 区分；
//   ② 05 号票「档位被 clamp」：偏好档位不在模型可用集里时如实给出源档 → 实发档
//      （2026-10-05 复审裁定：句式与①对齐，不再附原因）。
// 偏好词取解析归一化后的 requestedLevel（缺省 / 脏值 = default，与请求侧同口径）：
// 那种输入下两处判定都不成立（default 不参与级联），故与改造前按原始存储值判定逐字同结果。
export function thinkingHint(adjustment: ThinkingLevelAdjustment): string | null {
  const { requestedLevel, effectiveLevel, resolution, reason } = adjustment;
  if (requestedLevel === "off") {
    if (!resolution.offUnavailable) {
      return null;
    }
    return resolution.offFallback === "low" ? THINKING_OFF_FALLBACK_LOW_HINT : THINKING_OFF_UNAVAILABLE_HINT;
  }
  // ② 被 clamp：只有真的落了别的档位才提示（无档可落 = 维持「不发参」现状，不报文案）。
  if (reason && effectiveLevel !== null) {
    return `当前模型不支持思考强度 ${requestedLevel}，已使用 ${effectiveLevel}`;
  }
  return null;
}
