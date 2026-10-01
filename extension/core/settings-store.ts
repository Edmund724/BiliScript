// extension/core/settings-store.ts
// 全局设置（reader/AI/ASR/下载域，键面见 DEFAULT_SETTINGS）的归一化 + 读写存储。
// 从 extension/core/ai-provider-store.ts 拆出：原先「AI provider 存储」文件
// 实际承载了全部设置域的归一化，导致 ASR 域（asr/asr-provider-store.js）
// 反向依赖「AI 域」文件，名实不符。本模块只与 chrome.storage 交互，
// 不涉及消息路由。provider 列表（asrProviders）不在受管字段内：列表+Key 归
// provider-store（asr/asr-provider-store.js），经 asr-providers-save 消息写回，
// settings 只存 ASR 标量（activeAsrProviderId / asrAutoFallback / asrLanguage）。

import { DEFAULT_SETTINGS, type Settings } from "./defaults.js";
import { normalizeAsrLanguage } from "./presets.js";
// 超时原语单源（arch-slim-2/03）：原手搓 Promise.race + setTimeout 改走
// withTimeout 的硬超时（timeoutError 拒绝），reject 仍被 .catch 回落空对象——
// 软超时语义与原实现一致。
import { withTimeout } from "../shared/error-helpers.js";
import {
  normalizeDownloadFormat,
  normalizeEnablePlayerAiQuickAction,
  normalizePlayerAiQuickPrompt,
  normalizeReaderTheme,
  normalizeReaderThemeFamily,
  normalizeAiSystemPrompt,
  normalizeAiInitialQuickPrompts,
  normalizeDefaultModel,
  normalizeAiThinkingLevel,
  normalizeWebSearchEnabled,
  normalizeWebSearchMaxToolCalls,
  normalizeSearchPresetsAutoActivated,
  normalizeSearchOptInNoticeAcknowledged
} from "./validators.js";

// ===== 设置归一化 + 存储 =====

// asrAutoFallback 标量兜底（asrProviders 列表已摘出 settings，归 provider-store）。
function normalizeAsrAutoFallback(value: unknown): boolean {
  return value !== false; // 默认 true，仅显式 false 关闭
}

type NormalizerStep = [string, (m: Record<string, unknown>) => unknown];

// 归一化步骤表：[key, normalizeField]，normalizeField 接收完整对象、返回该 key
// 的归一化值。步骤顺序即历史内联顺序，不可调整。
//
// 键面三分（见文件末白名单注释）：步骤表键 ∪ 透传键（SETTINGS_PASSTHROUGH_KEYS）
// = DEFAULT_SETTINGS 键面全集。本表不导出（步骤函数是实现细节），只导出由它
// 派生的键清单 SETTINGS_NORMALIZER_KEYS 供对账测试读面。
const SETTINGS_NORMALIZER_STEPS: NormalizerStep[] = [
  ["downloadFormat", (m) => normalizeDownloadFormat(m.downloadFormat)],
  ["enablePlayerAiQuickAction", (m) => normalizeEnablePlayerAiQuickAction(m.enablePlayerAiQuickAction)],
  ["playerAiQuickPrompt", (m) => normalizePlayerAiQuickPrompt(m.playerAiQuickPrompt)],
  ["readerTheme", (m) => normalizeReaderTheme(m.readerTheme)],
  // 主题两轴：明暗由上一步归一（退役三值制的 "flyme" 收敛为 light），族在此
  // 拆轴迁移——readerTheme 是退役值 "flyme" 时族落 flyme（存量数据没有 family
  // 键，只按新键归一会丢族）；其余情况按新键归一，缺省/脏值回落 bilibili。
  // 这里读的 readerTheme 是归一化前的原始值（见 normalizeSettings 的读视图）。
  ["readerThemeFamily", (m) =>
    m.readerTheme === "flyme" ? "flyme" : normalizeReaderThemeFamily(m.readerThemeFamily)],
  ["readerThemeUserSet", (m) => m.readerThemeUserSet === true],
  ["aiSystemPrompt", (m) => normalizeAiSystemPrompt(m.aiSystemPrompt)],
  ["aiInitialQuickPrompts", (m) => normalizeAiInitialQuickPrompts(m.aiInitialQuickPrompts)],
  ["defaultModel", (m) => normalizeDefaultModel(m.defaultModel)],
  ["aiThinkingLevel", (m) => normalizeAiThinkingLevel(m.aiThinkingLevel)],
  ["activeAsrProviderId", (m) => String(m.activeAsrProviderId || "").trim()],
  ["asrAutoFallback", (m) => normalizeAsrAutoFallback(m.asrAutoFallback)],
  ["asrLanguage", (m) => normalizeAsrLanguage(m.asrLanguage)],
  // 联网搜索标量（spec §3.2）：激活平台 id 归一为 ""，开关仅显式 true 开，
  // 上限整数夹取 1–10
  ["activeSearchProviderId", (m) => String(m.activeSearchProviderId || "").trim()],
  ["webSearchEnabled", (m) => normalizeWebSearchEnabled(m.webSearchEnabled)],
  ["webSearchMaxToolCalls", (m) => normalizeWebSearchMaxToolCalls(m.webSearchMaxToolCalls)],
  // 两个非可调一次性状态位（spec §3 落点表 20–21）：布尔归一，设置页不渲染、
  // 无校验区间；落 sync 键面（DEFAULT_SETTINGS）即自动进白名单与快照键集。
  ["searchPresetsAutoActivated", (m) => normalizeSearchPresetsAutoActivated(m.searchPresetsAutoActivated)],
  ["searchOptInNoticeAcknowledged", (m) => normalizeSearchOptInNoticeAcknowledged(m.searchOptInNoticeAcknowledged)]
];

// 设置归一化的唯一收口：对步骤表内的受管字段逐项归一化，返回新对象
// （不改入参）。读路径（getMergedSettings）、写路径（saveSettings）与安装/
// 更新迁移（background 的 initializeSettingsStorage）统一经由这里。
// aiSystemPrompt 在此把 LEGACY 默认提示词映射为当前默认（LEGACY 常量保留
// 一个版本周期）；落盘收口后，存储里的旧值会被一次性改写而非反复映射。
// 步骤读的是归一化前的输入视图（source），结果写进 normalized：跨字段步骤
// （readerThemeFamily 要读 readerTheme 的退役值 "flyme" 才能迁移，见步骤表）
// 必须看到原始值——若把就地改写的 normalized 递进去，"flyme" 已被前置的
// readerTheme 步骤收敛为 "light"，族会随新键缺省回落 bilibili 而丢族。
// 单键步骤读的是自己那个键的原值，与此前逐键就地归一的行为一致。
export function normalizeSettings(merged: Record<string, unknown>): Settings {
  const source: Record<string, unknown> = { ...merged };
  const normalized: Record<string, unknown> = { ...merged };
  for (const [key, normalizeField] of SETTINGS_NORMALIZER_STEPS) {
    normalized[key] = normalizeField(source);
  }
  return normalized as Settings;
}

// 步骤表键清单：从步骤表单源派生（不是第二份字面量），供键面对账测试读面
// （tests/core/settings-normalizer-keys.test.ts：步骤表键 ∪ 透传名单 = 键面全集）。
export const SETTINGS_NORMALIZER_KEYS: readonly string[] = Object.freeze(
  SETTINGS_NORMALIZER_STEPS.map(([key]) => key)
);

// 透传键名单：经 save-settings 落盘但不做值归一化的字段（值由各自的写入方
// 保证形状），此前的「透传四键」注释在此升为可校验结构——与 SETTINGS_NORMALIZER_KEYS
// 无交集、并集恰为键面全集，两条都由上述对账测试钉住（加键忘写归一步即红）。
export const SETTINGS_PASSTHROUGH_KEYS: readonly string[] = Object.freeze([
  "includeDateInFilename",
  "includeTimestampInBody",
  "enableDebugLogs",
  "aiBtnDefaultOnMigrated"
]);

export async function getMergedSettings(timeoutMs = 5000): Promise<Settings> {
  const syncSettings = await withTimeout(
    chrome.storage.sync.get(DEFAULT_SETTINGS),
    timeoutMs,
    new Error("storage timeout")
  ).catch(() => ({}));

  return normalizeSettings({ ...DEFAULT_SETTINGS, ...(syncSettings as Record<string, unknown>) });
}

// 写入白名单：settings 域的键面 = DEFAULT_SETTINGS 声明的键集，等于归一步骤表键
// （SETTINGS_NORMALIZER_KEYS）∪ 透传键（SETTINGS_PASSTHROUGH_KEYS）——includeDateInFilename
// 等透传字段也经 save-settings 落盘，因此白名单取键面全集而非步骤表键集。
// saveSettings 据此剔除键面外的键（笔记导出删除后旧存储里残留的字段也在此被自然
// 丢弃，无需迁移）。
const SETTINGS_STORAGE_KEYS = new Set<string>(Object.keys(DEFAULT_SETTINGS));

export async function saveSettings(settings: unknown): Promise<void> {
  const payload = settings && typeof settings === "object" ? settings as Record<string, unknown> : {};
  const syncPayload: Record<string, unknown> = { ...payload };
  // 值为 undefined 的 key 视为缺失，不写入存储，
  // 避免部分保存时把空值覆盖到其它设置项。
  for (const key of Object.keys(syncPayload)) {
    if (syncPayload[key] === undefined) delete syncPayload[key];
  }
  // 写路径收口：与 normalizeSettings 共用同一套步骤表，但只归一化 payload 中
  // 实际存在的 key；缺失的 key 不写入，避免部分保存（如只传 aiThinkingLevel）
  // 把其它设置覆盖成默认值。读视图同 normalizeSettings：跨字段步骤见原始值，
  // 两条路径对同一份输入给出同一结果。
  const source: Record<string, unknown> = { ...syncPayload };
  for (const [key, normalizeField] of SETTINGS_NORMALIZER_STEPS) {
    if (key in syncPayload) syncPayload[key] = normalizeField(source);
  }
  // 写入边界（白名单）：只落盘 settings 键面内的 key，payload 里的非设置键
  // （如 content.js 整对象写回里的 asrProviders）不再经 save-settings 落盘、
  // 陈旧快照无法借此复活；写回 asrProviders 请走 asr-providers-save 消息
  // （provider-store 收口，见 asr/asr-provider-store.js）。
  const whitelisted: Record<string, unknown> = {};
  for (const key of Object.keys(syncPayload)) {
    if (SETTINGS_STORAGE_KEYS.has(key)) whitelisted[key] = syncPayload[key];
  }

  await chrome.storage.sync.set(whitelisted);
}
