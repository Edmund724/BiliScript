// extension/ui/provider-editor-catalog.ts — 平台编辑 Modal 的 AI「模型目录」片
//（provider-editor 拆分片，工单 12）。
//
// 职责：目录行模板（modelRowHtml）、草稿行增删、空态提示、目录级红字错误、行级
// 连通测试（multi-model-catalog 阶段2；拍板 Q3/Q4/Q7/Q9/Q10/Q12/Q13）。
// 依赖方向：只用底层的状态袋与字段/DOM 原语（./provider-editor-state.js），
// 不反向依赖 Modal 本体。函数体自原 provider-editor.ts 逐字节搬移。

import { escapeHtml } from "../shared/string-utils.js";
import { testAiProviderConnection } from "../ai/provider-test.js";
import { TRASH_ICON_PATHS } from "./provider-row.js";
import { getDialog, readField, state } from "./provider-editor-state.js";

// ===== AI 模型目录（multi-model-catalog 阶段2：内联行 + 行级测试 + 拉取弹窗） =====

export function modelRowCount(): number {
  return getDialog()?.querySelectorAll(".provider-editor-model-row").length || 0;
}

// 收集层口径（拍板 Q7）：trim / 去空行 / 静默去重（保序），normalize 同逻辑
export function readModelIds(): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  getDialog()?.querySelectorAll<HTMLInputElement>(".provider-editor-model-id").forEach((input) => {
    const value = input.value.trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      ids.push(value);
    }
  });
  return ids;
}

export function syncCatalogEmpty(): void {
  const empty = getDialog()?.querySelector<HTMLElement>(".provider-editor-catalog-empty");
  if (empty) {
    empty.hidden = modelRowCount() > 0;
  }
}

// 目录行红字错误（「获取可用模型」前置校验等）；空串即清除
export function showCatalogError(message: string): void {
  const error = getDialog()?.querySelector<HTMLElement>(".provider-editor-catalog-error");
  if (!error) return;
  error.hidden = !message;
  error.textContent = message;
}

export function addModelRow(value = ""): void {
  const list = getDialog()?.querySelector<HTMLElement>(".provider-editor-model-list");
  if (!list) return;
  list.insertAdjacentHTML("beforeend", modelRowHtml(value));
  syncCatalogEmpty();
}

export function removeModelRow(row: HTMLElement | null): void {
  row?.remove();
  syncCatalogEmpty();
}

// 行级连通测试（拍板 Q4/Q12）：用该行输入框当前的模型 ID 发 ping，行内原地
// 反馈（spinner → ✓/✕，失败原因在 title 悬停查看）；多行可并发，同一行重复
// 点击忽略前一个（dataset.testToken 代际比对）；测试不落盘——成功也不写设置。
export async function runModelTest(row: HTMLElement | null): Promise<void> {
  if (!row || state.kind !== "ai") return;
  const input = row.querySelector<HTMLInputElement>(".provider-editor-model-id");
  const result = row.querySelector<HTMLElement>(".provider-editor-model-result");
  const button = row.querySelector<HTMLButtonElement>(".provider-editor-model-test");
  const model = String(input?.value || "").trim();
  const baseUrl = readField(".provider-editor-baseurl");
  const fail = (message: string): void => {
    if (!result) return;
    result.hidden = false;
    result.dataset.state = "error";
    result.title = message;
  };
  if (!model) {
    fail("请先填写模型 ID");
    return;
  }
  if (!baseUrl) {
    fail("请先填写 API 地址");
    return;
  }
  const apiKey = readField(".provider-editor-apikey");
  const generation = state.generation;
  const token = (Number(row.dataset.testToken) || 0) + 1;
  row.dataset.testToken = String(token);
  if (result) {
    result.hidden = false;
    result.dataset.state = "loading";
    result.title = "";
  }
  if (button) {
    button.disabled = true;
  }
  const resp: { ok?: boolean; error?: string } = await testAiProviderConnection({
    providerId: state.editingId,
    baseUrl,
    apiKey,
    model
  });
  if (generation !== state.generation || !state.open || !row.isConnected) {
    return; // 过期回执：Modal 已关/已重开或行已删，不打扰
  }
  if (Number(row.dataset.testToken) !== token) {
    return; // 同一行重复点击：前一个结果被忽略
  }
  if (button) {
    button.disabled = false;
  }
  if (!result) {
    return;
  }
  if (resp?.ok) {
    result.dataset.state = "ok";
    result.title = "连接成功";
  } else {
    result.dataset.state = "error";
    result.title = `失败：${resp?.error || "未知错误"}`;
  }
}

// 模型目录行模板（拍板 Q3/Q9：只有模型 ID，无展示名 / 展开箭头）
export function modelRowHtml(value: string): string {
  return `
    <div class="provider-editor-model-row">
      <input class="provider-editor-model-id" type="text" placeholder="模型 ID（如 gpt-4o-mini）" value="${escapeHtml(value)}" />
      <span class="provider-editor-model-result" data-state="idle" hidden></span>
      <button type="button" class="provider-editor-model-test" data-provider-editor-action="test-model" title="用该行模型 ID 测试连通性">测试</button>
      <button type="button" class="provider-editor-model-remove" data-provider-editor-action="remove-model" aria-label="删除该模型" title="删除该模型">
        <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">${TRASH_ICON_PATHS}</svg>
      </button>
    </div>`;
}
