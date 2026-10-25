// extension/asr/provider-models.ts
// ASR 平台模型列表拉取（设置面板模型名下拉的数据源）。
//
// 传输经 SW 代发（core/provider-http.ts 的 providerFetchViaBackground，与 AI 探针
// ai/provider-test.ts、搜索执行器 search/search-executor.ts 同款）：本模块跑在
// content script（设置面板由 content 注入页内，manifest 无 options_page），直连
// fetch 服从**网页** CORS，带 Authorization 的 GET 必触发预检，网关不回
// Access-Control-Allow-* 时一律「Failed to fetch」；而同平台的真转写在 offscreen
// （entry/offscreen-asr.ts 装载适配器，扩展语境 fetch 只受 host 权限约束）——正是
// 「模型列表拉不到、真转写正常」的失败面。改走代发后这条链与真转写同不受网页 CORS。
//
// host 权限判定随之单源在 SW 侧代发通道（handleProviderHttpRequest，未授权回
// HOST_PERMISSION_HINT）：content 语境没有 chrome.permissions，页面侧那道预检恒
// fail-open 放行，判不了；申请侧由调用方 model-picker.ts 在用户手势上先行完成。
// 超时同理归 SW（15s 硬超时，provider-http.ts），本模块不再自持定时器。

import { normalizeBaseUrl } from "../core/presets.js";
import { providerFetchViaBackground } from "../core/provider-http.js";
import { formatProbeHttpError } from "../core/provider-store.js";
import { asrProviderStore } from "./asr-provider-store.js";

export interface ListAsrModelsInput {
  baseUrl?: string;
  apiKey?: string;
  providerId?: string;
}

export interface ListAsrModelsResult {
  ok: boolean;
  models?: string[];
  error?: string;
}

// GET `${baseUrl}/models?sub_type=speech-to-text`：sub_type 是 SiliconFlow 的
// 语音模型过滤参数，其他 OpenAI 兼容端点会忽略未知查询参数、回全量列表。
// Key 解析优先用户重输的 apiKey，否则按 providerId 读已存 Key（本地 Whisper
// 常无 Key，都没有就裸 GET）。请求本体由 SW 代发（见文件头）。
export async function listAsrModels({ baseUrl, apiKey, providerId }: ListAsrModelsInput): Promise<ListAsrModelsResult> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return { ok: false, error: "请先填写 baseUrl" };
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  const resolvedApiKey = await asrProviderStore.resolveDraftApiKey(apiKey, providerId);
  if (resolvedApiKey) {
    headers.Authorization = `Bearer ${resolvedApiKey}`;
  }

  try {
    const resp = await providerFetchViaBackground(`${normalizedBaseUrl}/models?sub_type=speech-to-text`, {
      headers,
      method: "GET"
    });
    if (!resp.ok) {
      return { ok: false, error: await formatProbeHttpError(resp) };
    }
    const data = (await resp.json()) as { data?: Array<{ id?: string }> };
    const models: string[] = [];
    if (Array.isArray(data?.data)) {
      for (const item of data.data) {
        if (item?.id) models.push(String(item.id));
      }
    }
    return { ok: true, models };
  } catch (error) {
    // 代发通道把 SW 侧的回包错误（未授权提示 / 15s 超时文案 / URL 不合法）作为
    // Error 抛出，这里原样透传，不覆盖 HTTP 层错误。
    if (error instanceof SyntaxError) {
      return { ok: false, error: "无法解析模型列表" };
    }
    return { ok: false, error: (error as Error | undefined)?.message || String(error) };
  }
}
