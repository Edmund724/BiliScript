// chat/thinking-picker.ts — 模型面板「思考强度」二级菜单的显示条目派生（纯函数，零 DOM）。
//
// 2026-10-05 用户裁定（.scratch/tickets/chat-thinking-submenu/）：面板底部不再把可用档位
// 全铺成一排按钮，而是固定区一行「思考强度 <当前值> ›」，点它换页到档位列表。列表里
// 显示什么、谁打勾、一级行显示什么值，全部由本模块派生；面板模块只管把结果画出来。
//
// 事实链不动：条目的档位值仍只来自 resolveThinkingAdjustment() 的同一次解析
//（availableLevels = A'），本模块**不新开第二套档位推导**，只决定分组与显示名。
//
// 四条显示口径（用户裁定）：
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
import { THINKING_DEFAULT_LEVEL, type ThinkingLevel, type ThinkingLevelValue } from "../ai/thinking-levels.js";

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

// 「不干预」档的显示名（2026-10-05 用户裁定）：所有模型恒有这一项，落线 = 不发思考字段。
export const THINKING_DEFAULT_LABEL = "Default";

// 开关型「开」写进偏好的档位值：rule.on 型任何非 off 档都落同一个「开」写点，故取
// canonical high 作偏好值——换到有真实档位的模型时是个中档，不是凭空发明的档位。
const SWITCH_ON_LEVEL: ThinkingLevel = "high";

export interface ThinkingPickerInput {
  // 该模型的**强度**档可用集（resolveThinkingAdjustment 的同一次解析；空 = 一个强度档都没有）。
  // 恒在的 `default`（不干预）不在此集里——它不是模型声明的档位（2026-10-05 用户裁定）。
  availableLevels: readonly ThinkingLevel[];
  // 非 off 域是否只由单个「开」写点服务（thinking-profiles 的 rule.on）。
  switchOnly: boolean;
  // 当前全局偏好（chatSessionState.aiThinkingLevel 的归一化值；可为 `default`）。
  requestedLevel: ThinkingLevelValue;
  // 本次解析的**实发档**（resolveThinkingAdjustment().effectiveLevel）；null = 没有解析结论。
  // 显示档默认取它（口径 ③：偏好 ≠ 实发时一级行/chip 照实发档显示，不再显示线上没发的东西）；
  // null（unknown 哨兵）时回落偏好词。
  effectiveLevel: ThinkingLevelValue | null;
}

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
//   开关型且显示档**在该模型可用集里** → On；
//   其余 → 上游档位词。
// 显示档落在可用集外时不给 On：真实调用方的显示档必来自同一次解析（∈ A' 或 off），这一
// 分支只兜住手搓入参（如 effectiveLevel 缺省 null 而偏好又不在可用集里）——那种输入下显示
// On 会与提示行的「low → off」自相矛盾，故照旧显示偏好自己的档位词。
export function thinkingPickerLabel(input: ThinkingPickerInput): string {
  const { availableLevels, switchOnly } = input;
  const shown = shownLevel(input);
  if (shown === THINKING_DEFAULT_LEVEL || shown === "off") {
    return thinkingLevelValueLabel(shown);
  }
  if (isSwitchCollapsed(input) && (switchOnly || availableLevels.includes(shown))) {
    return THINKING_ON_LABEL;
  }
  return THINKING_LEVEL_LABELS[shown] ?? shown;
}
