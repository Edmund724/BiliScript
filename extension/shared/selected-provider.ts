// shared/selected-provider.ts — 「对话 tab 选中的平台 + 模型」的存储键与复合值编解码（单源）。
//
// 选中项落 chrome.storage.local，值是复合值「平台 id\u0001模型 id」（multi-model-catalog
// 拍板 Q8：一模型一选项，选模型即隐式选定平台）。两侧消费必须同一套编解码，禁止
// 各自手拆分隔符：
//   - 对话侧：模型选择器渲染与选中回落（chat/providers.ts）、change 监听
//     （reader/chat-tab-lifecycle.ts）、思考档位提示（chat-tab-core.ts）；
//   - AI 链侧：概览 / 选区解释没有模型选择器，跟随对话 tab 的选中模型发请求
//     （ai/active-provider.ts）——不同步就会出现「对话正常、概览与解释失败」。
//
// 为什么收口成 shared 叶子（零 import）：ai 域若直接 import chat/providers.ts，会把
// 整个对话 tab chunk 拖进按需装载的 AI 管线；键与编解码本就不属于任何一个域。

export const SELECTED_PROVIDER_KEY = "biliscript_ai_selected_provider";

// 模型选项复合值分隔符：该控制字符不出现在平台 id / 模型名中。
export const MODEL_OPTION_SEPARATOR = String.fromCharCode(1);

export function buildModelOptionValue(providerId: string, model: string): string {
  return `${String(providerId || "").trim()}${MODEL_OPTION_SEPARATOR}${String(model || "").trim()}`;
}

export function parseModelOptionValue(value: unknown): { providerId: string; model: string } {
  const raw = String(value || "");
  const idx = raw.indexOf(MODEL_OPTION_SEPARATOR);
  if (idx === -1) {
    // 旧裸平台 id（multi-model-catalog 之前写入）：只有平台，没有模型段。
    return { providerId: raw.trim(), model: "" };
  }
  return {
    providerId: raw.slice(0, idx).trim(),
    model: raw.slice(idx + MODEL_OPTION_SEPARATOR.length).trim()
  };
}
