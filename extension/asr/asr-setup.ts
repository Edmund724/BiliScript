// ASR 配置类阻塞 → 实际设置动作的目标解析（票 provider-onboarding-consistency/04）。
//
// 为什么单列零 DOM 叶子：字幕空态、概览空态与对话拦截三个面都要把「去哪里配」
// 落到具体动作上——无 ASR 记录则新增、已有记录缺 Key 则编辑该记录并聚焦 Key、
// 无字幕自动转写关闭则去开开关；三个面在点击时刻都重新读一次实时设置与平台
// 列表（跨端设置变化后立即按新配置解析），规则只写在这里。
//
// 解析顺序对齐运行时的失败顺序（entry/offscreen-asr 的 resolveAsrProvider）：
// 先判开关（关闭时无论平台是否可用都不会转写），再判列表（空列表即 no-asr-config），
// 再判激活记录是否缺 Key。列表与激活 id 的选取复用 asr/asr-provider-normalize 的
// resolveActiveAsrProviderId（与设置面板单选激活、运行时配置解析同一份回退规则），
// 不在此另写一份「谁是激活平台」。

import { resolveActiveAsrProviderId } from "./asr-provider-normalize.js";

// 设置动作的类目：
//   disabled        无字幕自动转写开关关闭 → 启用路径（设置面板的开关）
//   no-provider     没有任何 ASR 平台记录 → 新增编辑器
//   missing-key     激活记录已存在但未存 Key → 编辑该记录并聚焦 Key
//   provider-config 记录与 Key 都在（域名未授权 / 模型不可用 / Key 失效）→ 编辑该记录
export type AsrSetupKind = "disabled" | "no-provider" | "missing-key" | "provider-config";

export interface AsrSetupPlan {
  kind: AsrSetupKind;
  /** 需要打开编辑器的 ASR 记录 id；disabled / no-provider 时为空串 */
  providerId: string;
}

export interface AsrSetupInput {
  asrAutoFallback?: unknown;
  activeAsrProviderId?: unknown;
  providers?: ReadonlyArray<{ id?: string | null; hasSavedKey?: boolean }> | null;
}

/**
 * 按实时设置 + ASR 平台列表解析设置目标。开关只认严格 true（与 fallback 的
 * `asrAutoFallback === true` 同口径）；缺 Key 只认显式 hasSavedKey 为假
 *（列表接口恒带该布尔占位，缺失按未存 Key 处理，与 AI 族缺 Key 定位同口径）。
 */
export function resolveAsrSetupPlan(input: AsrSetupInput): AsrSetupPlan {
  if (input.asrAutoFallback !== true) {
    return { kind: "disabled", providerId: "" };
  }
  const providers = (Array.isArray(input.providers) ? input.providers : [])
    .map((item) => ({
      id: String(item?.id || "").trim(),
      hasSavedKey: Boolean(item?.hasSavedKey)
    }))
    .filter((item) => item.id !== "");
  if (providers.length === 0) {
    return { kind: "no-provider", providerId: "" };
  }
  const activeId = resolveActiveAsrProviderId(
    providers,
    typeof input.activeAsrProviderId === "string" ? input.activeAsrProviderId : ""
  );
  const active = providers.find((item) => item.id === activeId) || providers[0];
  return {
    kind: active.hasSavedKey ? "provider-config" : "missing-key",
    providerId: active.id
  };
}
