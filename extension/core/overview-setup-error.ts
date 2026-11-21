export const NO_ACTIVE_PROVIDER_MESSAGE = "还没有配置 AI 平台，请先在插件设置中添加并启用。";

export const SELECTED_PROVIDER_NOT_FOUND_MESSAGE = "未找到选中的平台";

export const NO_ACTIVE_MODEL_MESSAGE = "该平台还没有配置可用模型，请先添加模型。";

export const MISSING_PROVIDER_KEY_MESSAGE = "该平台 API Key 未配置";

export type OverviewSetupErrorClass = "no-provider" | "missing-key" | "no-model";

export function classifyOverviewSetupError(errorText: unknown): OverviewSetupErrorClass | null {
  const text = String(errorText ?? "").trim();
  if (text === NO_ACTIVE_PROVIDER_MESSAGE || text === SELECTED_PROVIDER_NOT_FOUND_MESSAGE) {
    return "no-provider";
  }
  if (text === MISSING_PROVIDER_KEY_MESSAGE) {
    return "missing-key";
  }
  if (text === NO_ACTIVE_MODEL_MESSAGE) {
    return "no-model";
  }
  return null;
}
