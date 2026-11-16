// extension/search/provider-test.ts
// 搜索平台连通性测试探针：使用单引擎执行路径发起一次测试搜索（不经回退链，
// 不走、不写查询缓存，也不记录健康度），不落盘任何配置。

import {
  getAiCredentialStatusText,
  queryAiCredentialKey
} from "../core/ai-credential-reference.js";
import {
  DEFAULT_SEARCH_PROVIDER_PRESET,
  SEARCH_PROVIDER_PRESETS,
  type SearchProviderType
} from "../core/presets.js";
import { classifySearchFailure } from "./search-chain.js";
import { executeWebSearch } from "./search-executor.js";
import { searchProviderStore } from "./search-provider-store.js";

export const SEARCH_TEST_QUERY = "联网搜索测试";

export interface SearchConnectionTestInput {
  id?: string;
  presetId?: string;
  type?: SearchProviderType | string;
  baseUrl: string;
  apiKey?: string;
  requiresKey?: boolean;
}

export interface SearchConnectionTestResult {
  ok: boolean;
  message?: string;
  error?: string;
}

export async function testSearchConnection(
  input: SearchConnectionTestInput
): Promise<SearchConnectionTestResult> {
  const baseUrl = String(input.baseUrl || "").trim();
  if (!baseUrl) {
    return { ok: false, error: "请填写 API 地址" };
  }

  const presetId = String(input.presetId || "").trim();
  const preset = SEARCH_PROVIDER_PRESETS.find((item) => item.id === presetId) ?? null;
  const requiresKey = input.requiresKey ?? preset?.access === "free-quota";

  let apiKey = "";
  if (presetId === "deepseek") {
    const resolved = await queryAiCredentialKey("deepseek");
    if (!resolved.key) {
      return { ok: false, error: getAiCredentialStatusText("deepseek", resolved.status) };
    }
    apiKey = resolved.key;
  } else {
    apiKey = await searchProviderStore.resolveDraftApiKey(input.apiKey, input.id);
  }

  if (!apiKey && requiresKey) {
    return { ok: false, error: "请先填写 API Key" };
  }

  const type = (String(input.type || "").trim() || preset?.type || DEFAULT_SEARCH_PROVIDER_PRESET.type) as SearchProviderType;
  try {
    const outcome = await executeWebSearch(
      {
        type,
        baseUrl,
        apiKey
      },
      SEARCH_TEST_QUERY
    );
    if (!outcome.results.length) {
      return { ok: false, error: "未返回结果" };
    }
    return { ok: true, message: `连接成功 · ${outcome.results.length} 条结果` };
  } catch (error) {
    const failure = classifySearchFailure(error);
    if (failure === "quota") {
      return { ok: false, error: "额度已用尽" };
    }
    if (failure === "auth") {
      return { ok: false, error: "Key 无效或无权限" };
    }
    return { ok: false, error: `连接失败：${(error as Error)?.message || "未知错误"}` };
  }
}
