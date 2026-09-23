// extension/core/preset-host-index.ts — AI preset 的 host 索引（从 core/presets.ts
// 的 baseUrl 派生，baseUrl 数据不在此复制）。
//
// 谁用：ai/thinking-profiles.ts 的 provider 识别兜底（presetId 未命中时按用户
// 直填的 baseUrl 推断平台），与 ai/model-catalog.ts 的 piProvider 识别兜底
// （custom/未知预设）。两处共用本模块，避免各建一份 host→preset 事实。
// 不读 protocolBaseUrls：那里登记的是「同厂不同协议的端点」，不是平台身份
// 的主 baseUrl（例：api.xiaomimimo.com 的 mimo 主 baseUrl 已在此索引）。
//
// 语义：host 取 URL.hostname 小写；无 scheme 的 baseUrl 进不了 fetch，同样
// 进不了本索引（返回 ""）。同一 host 在 PRESETS 里出现多次时后写者胜——现状
// 无重复，保留既有行为不做额外裁决。

import { PRESETS } from "./presets.js";

const PRESET_HOST_INDEX = new Map<string, string>();

export function hostOf(baseUrl: unknown): string {
  try {
    return new URL(String(baseUrl || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

for (const preset of PRESETS) {
  const host = hostOf(preset.baseUrl);
  if (host) {
    PRESET_HOST_INDEX.set(host, preset.id);
  }
}
// 手工别名：SiliconFlow 只存在于 ASR preset（core/presets 的音频表），AI preset
// 表没有它，但它是思考适配收录的平台（enable_thinking 系）——用户手填其 baseUrl
// 作 custom 平台时靠这条命中。表数据仍不复制 baseUrl。对模型目录无影响：
// siliconflow 没有 piProvider，查到也返回 null。
PRESET_HOST_INDEX.set("api.siliconflow.cn", "siliconflow");

export function presetIdForHost(host: string): string | null {
  return PRESET_HOST_INDEX.get(host) ?? null;
}
