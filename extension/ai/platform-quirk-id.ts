// ai/platform-quirk-id.ts — 「这个平台是词表里的哪一行」的唯一识别口径。
//
// 词表查表的单点：所有要从 PLATFORM_QUIRKS 取平台怪癖声明的消费方
// （preset-headers 的会话头、adapters/anthropic 的 effort 词汇）都经这里拿
// 平台 id，不各写一份识别规则、也不各拿别的 id 当口径。
//
// 为什么不复用 resolveThinkingProviderId（ai/thinking-profiles.ts）：两者的
// **键空间不同**——那是 thinking 的 PROVIDERS 表的键空间，PROVIDERS ⊋
// PLATFORM_QUIRKS。反例 siliconflow：它是思考适配收录的平台（enable_thinking
// 系，PROVIDERS 有它），但没声明任何怪癖（PLATFORM_QUIRKS 无此键）；拿
// resolveThinkingProviderId 当词表识别口径，会把非词表平台也认成词表成员，
// anthropic 的 effort 词汇查表就会按错误的键空间判。故本模块自持一口，不
// import thinking-profiles（否则还有反向依赖）。
//
// 识别语义（与 thinking-profiles 的 provider 识别同形：presetId 主路径 +
// baseUrl host 兜底）：
//   presetId trim 后是 PLATFORM_QUIRKS 的键        → 它
//   否则 presetIdForHost(hostOf(baseUrl)) 是词表键 → 它
//   否则                                          → undefined（未登记的平台不开任何怪癖）
// host 兜底服务 custom/用户直填 baseUrl 的平台——platform 身份只看 presetId
// 会静默漏声明（如会话头缺失导致请求不被接受）。host 索引单源在
// core/preset-host-index.ts（与 thinking-profiles 的兜底共用，baseUrl 数据不
// 在此复制）。
//
// 词表叶 ai/compat-vocab.ts 保持零运行时 import 契约（识别器在叶外，只读它的
// 导出）：本模块是 import 词表的一方，不是词表的一部分。

import { PLATFORM_QUIRKS } from "./compat-vocab.js";
import { hostOf, presetIdForHost } from "../core/preset-host-index.js";

export function resolvePlatformQuirkId(presetId?: string, baseUrl?: string): string | undefined {
  const byId = String(presetId || "").trim();
  if (isQuirkPlatform(byId)) {
    return byId;
  }
  const byHost = presetIdForHost(hostOf(String(baseUrl || "")));
  return byHost && isQuirkPlatform(byHost) ? byHost : undefined;
}

// 「是词表成员」= PLATFORM_QUIRKS 的自有键（原型链上的键不算）。
function isQuirkPlatform(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(PLATFORM_QUIRKS, id);
}
