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

import type { Settings } from "../core/defaults.js";
import { getSettings } from "../core/runtime.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { resolveActiveAsrProviderId } from "./asr-provider-normalize.js";

// 设置动作的类目：
//   disabled        无字幕自动转写开关关闭 → 启用路径（设置面板的开关）
//   no-provider     没有任何 ASR 平台记录 → 新增编辑器
//   missing-key     激活记录已存在但未存 Key → 编辑该记录并聚焦 Key
//   provider-config 记录与 Key 都在（域名未授权 / 模型不可用 / Key 失效）→ 编辑该记录
export type AsrSetupKind = "disabled" | "no-provider" | "missing-key" | "provider-config";

export type AsrProviderSetupKind = Exclude<AsrSetupKind, "disabled">;

export interface AsrSetupPlan {
  kind: AsrSetupKind;
  /** 需要打开编辑器的 ASR 记录 id；disabled / no-provider 时为空串 */
  providerId: string;
}

export interface AsrSetupState {
  /** 优先处理的设置目标（保持「开关 → 平台列表 → 激活平台 Key」的既有判定顺序） */
  kind: AsrSetupKind;
  /** 与 kind 对应的平台记录 id；disabled / no-provider 时为空串 */
  providerId: string;
  /** 无字幕自动转写开关是否开启 */
  asrAutoFallback: boolean;
  /** 忽略开关时 ASR 平台配置本身的阻塞/就绪状态 */
  providerStatus: AsrProviderSetupKind;
  /** 当 providerStatus 为 missing-key / provider-config 时的激活 ASR 平台 id */
  targetProviderId: string;
  /** 平台本身是否仍缺配置（无 ASR 平台或激活平台缺 Key） */
  needsProviderSetup: boolean;
  /** 是否同时处于「自动转写关闭」且「缺 ASR 平台或激活平台缺 Key」的复合阻塞态 */
  blockedByBoth: boolean;
}

export interface AsrSetupInput {
  asrAutoFallback?: unknown;
  activeAsrProviderId?: unknown;
  providers?: ReadonlyArray<{ id?: string | null; hasSavedKey?: boolean }> | null;
}

function resolveAsrProviderState(input: AsrSetupInput): {
  providerStatus: AsrProviderSetupKind;
  targetProviderId: string;
} {
  const providers = (Array.isArray(input.providers) ? input.providers : [])
    .map((item) => ({
      id: String(item?.id || "").trim(),
      hasSavedKey: Boolean(item?.hasSavedKey)
    }))
    .filter((item) => item.id !== "");
  if (providers.length === 0) {
    return { providerStatus: "no-provider", targetProviderId: "" };
  }
  const activeId = resolveActiveAsrProviderId(
    providers,
    typeof input.activeAsrProviderId === "string" ? input.activeAsrProviderId : ""
  );
  const active = providers.find((item) => item.id === activeId) || providers[0];
  return {
    providerStatus: active.hasSavedKey ? "provider-config" : "missing-key",
    targetProviderId: active.id
  };
}

/**
 * 查询完整 ASR 设置状态：即使 `asrAutoFallback === false`，也一并返回底层
 * ASR 平台与 Key 是否完整及目标 `providerId`，供设置面板一次引导开开关+配置。
 */
export function resolveAsrSetupState(input: AsrSetupInput): AsrSetupState {
  const asrAutoFallback = input.asrAutoFallback === true;
  const { providerStatus, targetProviderId } = resolveAsrProviderState(input);
  const needsProviderSetup = providerStatus === "no-provider" || providerStatus === "missing-key";
  const kind: AsrSetupKind = asrAutoFallback ? providerStatus : "disabled";
  const providerId = asrAutoFallback ? targetProviderId : "";
  return {
    kind,
    providerId,
    asrAutoFallback,
    providerStatus,
    targetProviderId,
    needsProviderSetup,
    blockedByBoth: !asrAutoFallback && needsProviderSetup
  };
}

/**
 * 按实时设置 + ASR 平台列表解析设置目标。开关只认严格 true（与 fallback 的
 * `asrAutoFallback === true` 同口径）；缺 Key 只认显式 hasSavedKey 为假
 *（列表接口恒带该布尔占位，缺失按未存 Key 处理，与 AI 族缺 Key 定位同口径）。
 */
export function resolveAsrSetupPlan(input: AsrSetupInput): AsrSetupPlan {
  const { kind, providerId } = resolveAsrSetupState(input);
  return { kind, providerId };
}

export interface AsrProviderListEntry {
  id: string;
  name?: string;
  model?: string;
  type?: string;
  enabled?: boolean;
  hasSavedKey?: boolean;
}

export interface ActiveAsrRuntimeState {
  providers: AsrProviderListEntry[];
  activeId: string;
  activeProvider: AsrProviderListEntry | null;
  asrLanguage: string;
  setupState: AsrSetupState;
}

export interface ResolveActiveAsrRuntimeDeps {
  loadProviders?: () => Promise<readonly AsrProviderListEntry[]>;
  getSettings?: () => Promise<Partial<Pick<Settings, "asrAutoFallback" | "activeAsrProviderId" | "asrLanguage">>>;
}

// 页面侧 ASR provider 元数据读取唯一单点：经 background 的 asr-providers-list 返回
// 不含明文 Key 的列表，消息失败按空列表降级。
export async function loadAsrProviderList(): Promise<AsrProviderListEntry[]> {
  try {
    const resp = await sendRuntimeMessage({ type: "asr-providers-list" });
    return Array.isArray(resp?.providers) ? (resp.providers as AsrProviderListEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * 页面侧统一解析当前激活 ASR 平台、语言档位与配置状态：
 * 单趟并发读取 `asr-providers-list` 与 `getSettings()`，不直接触碰 `chrome.storage` 密钥存储。
 */
export async function resolveActiveAsrRuntimeState(
  deps: ResolveActiveAsrRuntimeDeps = {}
): Promise<ActiveAsrRuntimeState> {
  const loadProviders = deps.loadProviders ?? loadAsrProviderList;
  const readSettings = deps.getSettings ?? getSettings;
  const [rawProviders, settings] = await Promise.all([loadProviders(), readSettings()]);
  const providers = Array.isArray(rawProviders) ? [...rawProviders] : [];
  const activeAsrProviderId =
    typeof settings?.activeAsrProviderId === "string" ? settings.activeAsrProviderId : "";
  const activeId = resolveActiveAsrProviderId(providers, activeAsrProviderId);
  const activeProvider =
    providers.find((item) => String(item?.id || "").trim() === activeId) ?? null;
  const asrLanguage =
    typeof settings?.asrLanguage === "string" && settings.asrLanguage.trim()
      ? settings.asrLanguage.trim()
      : "auto";
  const setupState = resolveAsrSetupState({
    asrAutoFallback: settings?.asrAutoFallback,
    activeAsrProviderId,
    providers
  });
  return {
    providers,
    activeId,
    activeProvider,
    asrLanguage,
    setupState
  };
}
