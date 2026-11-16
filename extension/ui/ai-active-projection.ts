// extension/ui/ai-active-projection.ts
// 设置面板「AI 模型平台」分区生效投影的展示壳（票 05）：摘要文案格式化、
// 生效模型行与行内「设为默认 / 默认」按钮状态的 DOM 同步。数据真相全部来自
// ai/active-model-projection.ts（与真实请求同一解析链），本模块只做展示，
// 不含任何回落判定。
//
// AI 族行模板本身不渲染模型副行（provider-family.ts 的 displayModel 恒空），
// 生效行的模型行由本模块按需挂上，摘掉即还原；默认平台身份由行尾的
// .ai-provider-default-btn 统一承担，不再额外挂同名「默认」徽标。

import type {
  AiActiveModelProjection,
  SubtitleFollowProjection
} from "../ai/active-model-projection.js";

// 模型行的摘除标记：syncAiDefaultModelLine 每次先清带标记的节点再重挂，
// 列表重渲（整表 innerHTML 重建）后旧节点本就消失，标记只是幂等保险。
const DEFAULT_MARK_ATTR = "data-ai-default-mark";

function providerDisplayName(projection: Extract<AiActiveModelProjection, { state: "ok" }>): string {
  return String(projection.provider.name || "").trim() || "自定义";
}

/**
 * 概览 / 解释缺省选择摘要：显式默认、真实回落与不可用三态各一句话，
 * 不展示陈旧成功状态。
 */
export function formatAiDefaultSummaryLine(projection: AiActiveModelProjection): string {
  if (projection.state === "unavailable") {
    return `概览与解释暂不可用：${projection.error}`;
  }
  const target = `${providerDisplayName(projection)} · ${projection.model || "未配置模型"}`;
  return projection.isFallback
    ? `概览与解释已回落至 ${target}（默认平台不可用）`
    : `概览与解释将使用 ${target}`;
}

/**
 * 字幕翻译「跟随 AI 默认平台」的跟随目标提示：ok 时给当前跟随的平台 + 模型，
 * 专属配置失效回落时说明回落并给回落目标；不可用时如实展示原因。
 * 文案只讲控件没说的部分——控件值已经写着「跟随 AI 默认平台」。
 */
export function formatSubtitleFollowHint(projection: SubtitleFollowProjection): string {
  if (projection.state === "unavailable") {
    return `暂不可用：${projection.error}`;
  }
  const target = projection.model
    ? `${projection.providerName} · ${projection.model}`
    : projection.providerName;
  return projection.isFallback
    ? `专属模型已失效，当前 ${target}`
    : `当前 ${target}`;
}

export type SubtitleFollowHintState = "follow" | "fallback" | "unavailable";

/** 副行的视觉状态：回落 / 不可用挂琥珀圆点，正常跟随不挂。 */
export function subtitleFollowHintState(projection: SubtitleFollowProjection): SubtitleFollowHintState {
  if (projection.state === "unavailable") return "unavailable";
  return projection.isFallback ? "fallback" : "follow";
}

/**
 * 把概览 / 解释生效模型行挂到解析出的生效平台行上；providerId 为空
 * （无可用平台）或模型为空串时只摘除不新增。
 */
export function syncAiDefaultModelLine(
  listNode: HTMLElement | null | undefined,
  providerId: string,
  model: string
): void {
  if (!listNode) return;
  listNode.querySelectorAll(`[${DEFAULT_MARK_ATTR}]`).forEach((node) => node.remove());
  const target = String(providerId || "").trim();
  const effectiveModel = String(model || "").trim();
  if (!target || !effectiveModel) return;
  // 行匹配走 dataset 遍历（不经 CSS.escape：jsdom 无 CSS.escape 实现，
  // 记录 id 也不必假设为安全选择器字面量）。
  const row = Array.from(listNode.querySelectorAll<HTMLElement>(".ai-provider-row")).find(
    (candidate) => candidate.dataset.providerId === target
  );
  const line = row?.querySelector<HTMLElement>(".provider-row-line");
  if (!row || !line) return;

  const modelLine = document.createElement("div");
  modelLine.className = "provider-row-model";
  modelLine.setAttribute(DEFAULT_MARK_ATTR, "1");
  modelLine.title = "概览与解释将使用的模型";
  modelLine.textContent = effectiveModel;
  line.insertAdjacentElement("afterend", modelLine);
}

/**
 * 同步 AI 平台行内「设为默认 / 默认」切换按钮状态。
 */
export function syncAiDefaultButtonState(
  listNode: HTMLElement | null | undefined,
  defaultProviderId: string
): void {
  if (!listNode) return;
  const target = String(defaultProviderId || "").trim();
  listNode.querySelectorAll<HTMLElement>(".ai-provider-row").forEach((row) => {
    const button = row.querySelector<HTMLButtonElement>(".ai-provider-default-btn");
    if (!button) return;
    const isDefault = Boolean(target && row.dataset.providerId === target);
    button.textContent = isDefault ? "默认" : "设为默认";
    button.setAttribute("aria-pressed", String(isDefault));
    button.classList.toggle("is-default", isDefault);
    button.disabled = isDefault;
  });
}
