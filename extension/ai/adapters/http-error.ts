// extension/ai/adapters/http-error.ts
// 模型列表拉取的 HTTP 错误摘要格式化：提取 JSON 错误说明、过滤 HTML/裸 JSON 噪声，
// 并为 401/403/404/429/5xx 提供可读中文提示。

function extractJsonMessage(trimmed: string): string {
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return "";
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { message?: unknown } | string;
      message?: unknown;
      detail?: unknown;
    };
    const candidate =
      typeof parsed?.error === "string"
        ? parsed.error
        : typeof parsed?.error?.message === "string"
          ? parsed.error.message
          : typeof parsed?.message === "string"
            ? parsed.message
            : typeof parsed?.detail === "string"
              ? parsed.detail
              : "";
    return candidate.trim().slice(0, 160);
  } catch {
    return "";
  }
}

function isHtmlOrJsonNoise(trimmed: string): boolean {
  if (!trimmed) return true;
  if (/^<(?:!doctype|html|head|body|title|h1)\b/i.test(trimmed)) return true;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return true;
  return false;
}

function statusSummary(status: number): string {
  if (status === 401) return "API Key 无效或未授权";
  if (status === 403) return "无权限访问该接口";
  if (status === 404) return "模型列表接口不存在，可返回手动添加";
  if (status === 429) return "请求过于频繁或额度不足";
  if (status >= 500) return "服务端暂时不可用";
  return "";
}

export function formatModelListHttpError(status: number, bodyText: string): string {
  const trimmed = String(bodyText || "").trim();
  const jsonDetail = extractJsonMessage(trimmed);
  const summary = statusSummary(status);

  if (summary) {
    if (jsonDetail) {
      return `HTTP ${status}：${summary}（${jsonDetail}）`;
    }
    if (!isHtmlOrJsonNoise(trimmed)) {
      return `HTTP ${status}: ${trimmed.slice(0, 200)}`;
    }
    return `HTTP ${status}：${summary}`;
  }

  if (jsonDetail) {
    return `HTTP ${status}: ${jsonDetail}`;
  }
  if (!isHtmlOrJsonNoise(trimmed)) {
    return `HTTP ${status}: ${trimmed.slice(0, 200)}`;
  }
  return `HTTP ${status}：请求失败`;
}
