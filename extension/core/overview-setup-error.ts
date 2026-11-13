// 概览首配错误分类的单一真源（票 provider-onboarding-consistency/01）。
//
// 为什么单列一个零依赖叶子：这两个文案由 SW 侧 resolve-ai-provider 处理器在解析期
// 产生（core/provider-handlers.ts 的抛出点），但「哪些错误算配置类、概览该给设置
// 动作」是 content 侧呈现层的判定——两边都要买得起，故常量与分类器住本叶子，
// provider-handlers 从这里取文案（产生点与契约同源），概览 UI 从这里取分类
// （只认精确文案，非配置类错误不伪装成配置问题）。
//
// 零运行时 import（纯叶）：SW 静态图与 content 懒加载区都能安全引用。

// 无可用平台（defaultModel 未命中且无任何启用平台）的解析期文案。
export const NO_ACTIVE_PROVIDER_MESSAGE = "还没有配置 AI 平台，请先在插件设置中添加并启用。";

// 平台已解析但 Key 缺失（requiresKey !== false 且密钥为空）的解析期文案。
export const MISSING_PROVIDER_KEY_MESSAGE = "该平台 API Key 未配置";

// 配置类错误的两个类目：概览「去设置」动作据此直达正确的平台编辑界面。
export type OverviewSetupErrorClass = "no-provider" | "missing-key";

/**
 * 判定概览错误文案是否为配置类错误。只认解析期产生的两个精确文案：
 * 其余错误（网络、鉴权 401、额度、参数等）一律返回 null——非配置类错误
 * 不伪装成配置问题，概览 error 条只给「重试」。
 */
export function classifyOverviewSetupError(errorText: unknown): OverviewSetupErrorClass | null {
  const text = String(errorText ?? "").trim();
  if (text === NO_ACTIVE_PROVIDER_MESSAGE) {
    return "no-provider";
  }
  if (text === MISSING_PROVIDER_KEY_MESSAGE) {
    return "missing-key";
  }
  return null;
}
