// extension/ui/provider-editor-catalog.ts — 平台编辑 Modal 的 AI「模型目录」片
//（provider-editor 拆分片，工单 12）。
//
// 职责：目录行模板（modelRowHtml）、草稿行增删、空态提示、目录级红字错误、行级
// 连通测试（multi-model-catalog 阶段2；拍板 Q3/Q4/Q7/Q9/Q10/Q12/Q13），以及只读
// 模型元数据的渲染与重算（model-catalog/04）。
// 依赖方向：只用底层的状态袋与字段/DOM 原语（./provider-editor-state.js）与目录
// 懒加载器（./lazy-model-catalog.js）；对 ai/model-catalog 只取类型（import type，
// 构建后消失，不把 85KB 产物静态拖进本片）。不反向依赖 Modal 本体。函数体自原
// provider-editor.ts 逐字节搬移。

import { escapeHtml } from "../shared/string-utils.js";
import { testAiProviderConnection } from "../ai/provider-test.js";
import type { CatalogModelMeta } from "../ai/model-catalog.js";
import { TRASH_ICON_PATHS } from "./provider-row.js";
import { getDialog, readField, state } from "./provider-editor-state.js";
import { loadModelCatalog, loadedModelCatalog } from "./lazy-model-catalog.js";

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
  refreshModelCatalogMeta();
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
  // 协议下拉当前值随探针下发（multi-protocol-ai）：新增/改协议未保存时探针也按
  // 表单所选协议走 adapter（端点/鉴权自然切换）；未传时探针回落已存记录的协议。
  const protocol = getDialog()?.querySelector<HTMLSelectElement>(".provider-editor-protocol")?.value || "";
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
    model,
    protocol
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

// 模型目录行模板（拍板 Q3/Q9：只有模型 ID，无展示名 / 展开箭头）。
// 元数据栏（data-model-meta）由 refreshModelCatalogMeta 填充，查不到即 hidden。
export function modelRowHtml(value: string): string {
  return `
    <div class="provider-editor-model-row">
      <input class="provider-editor-model-id" type="text" placeholder="模型 ID（如 gpt-4o-mini）" value="${escapeHtml(value)}" />
      <span class="provider-editor-model-meta" data-model-meta hidden></span>
      <span class="provider-editor-model-result" data-state="idle" hidden></span>
      <button type="button" class="provider-editor-model-test" data-provider-editor-action="test-model" title="用该行模型 ID 测试连通性">测试</button>
      <button type="button" class="provider-editor-model-remove" data-provider-editor-action="remove-model" aria-label="删除该模型" title="删除该模型">
        <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">${TRASH_ICON_PATHS}</svg>
      </button>
    </div>`;
}

// ===== 只读模型元数据（model-catalog/04）=====
//
// 数据来源是构建期产物（ai/model-catalog.ts → ui/lazy-model-catalog.ts 动态
// import），只在设置 Modal 打开后加载。元数据是「搭建时看的」，只在这里渲染：
// 不进对话界面（chat 的模型 chip 宽度由 canvas 量出、硬上限 420px，塞元数据会
// 挤压截断），也不落盘、不进请求体（spec 只读纪律）。
//
// 查不到就整栏静默隐藏——不显示 "—"、不显示"暂无数据"：15 个预设里 7 个永远
// 没有目录数据，满屏占位比不显示更难看。

// 上下文窗口短格式（spec §展示）：≥10⁶ 用 M，否则取整到 K；两者都是十进制
// （1000000→"1M"、524288→"524K"）。
export function formatContextWindow(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return "";
  }
  if (tokens >= 1_000_000) {
    return `${Math.round(tokens / 100_000) / 10}M`;
  }
  return `${Math.round(tokens / 1000)}K`;
}

// 行内短格式：窗口 + 能力徽标（思考 / 图片）
function modelMetaHtml(meta: CatalogModelMeta): string {
  const parts: string[] = [];
  const window = formatContextWindow(meta.contextWindow);
  if (window) {
    parts.push(`<span class="provider-editor-model-window">${escapeHtml(window)}</span>`);
  }
  if (meta.reasoning) {
    parts.push('<span class="provider-editor-model-badge">思考</span>');
  }
  if (meta.input.includes("image")) {
    parts.push('<span class="provider-editor-model-badge">图片</span>');
  }
  return parts.join("");
}

// title 承载完整信息（spec §展示）：展示名 + 窗口 + 输出上限 + 两项能力 + 数据版本
export function modelMetaTitle(
  meta: CatalogModelMeta,
  source: { package: string; version: string } | null
): string {
  const parts = [
    meta.name,
    `上下文 ${formatContextWindow(meta.contextWindow)}`,
    `输出上限 ${formatContextWindow(meta.maxTokens)}`,
    meta.reasoning ? "支持思考" : "不支持思考",
    meta.input.includes("image") ? "支持图片" : "仅文本输入"
  ];
  if (source) {
    parts.push(`目录 ${source.package} ${source.version}`);
  }
  return parts.join(" · ");
}

function fillMetaSlot(slot: HTMLElement, meta: CatalogModelMeta | null): void {
  const html = meta ? modelMetaHtml(meta) : "";
  slot.hidden = !html;
  slot.innerHTML = html;
  if (meta && html) {
    slot.title = modelMetaTitle(meta, loadedModelCatalog()?.PI_AI_CATALOG_SOURCE ?? null);
  } else {
    slot.removeAttribute("title");
  }
}

// 重算当前 Modal 里所有元数据栏（目录行 + 已打开的「获取可用模型」弹窗勾选项）。
// 调用时机：平台身份（presetId / baseUrl）或模型 id 变化、行增删、目录模块加载
// 完成。元数据只跟着 (presetId, baseUrl) + 模型 id 走，与协议无关。
export function refreshModelCatalogMeta(): void {
  const host = state.host;
  if (!host) return;
  const catalog = loadedModelCatalog();
  const presetId = getDialog()?.querySelector<HTMLSelectElement>(".provider-editor-preset")?.value || "";
  const baseUrl = readField(".provider-editor-baseurl");
  host.querySelectorAll<HTMLElement>("[data-model-meta]").forEach((slot) => {
    const row = slot.closest<HTMLElement>(".provider-editor-model-row, .provider-editor-fetch-item");
    const modelId =
      row?.querySelector<HTMLInputElement>(".provider-editor-model-id")?.value.trim() ||
      row?.dataset.modelId ||
      "";
    fillMetaSlot(slot, catalog && modelId ? catalog.lookupCatalogMeta(presetId, baseUrl, modelId) : null);
  });
}

// 打开 AI Modal 时触发一次懒加载，加载完成后补齐已渲染的行与弹窗。
// 失败（扩展刚更新的过渡窗口里旧 chunk 404）静默降级：没有元数据不影响任何
// 既有功能，下次打开 Modal 会重试（createLazyLoader 失败清缓存）。
export async function primeModelCatalogMeta(): Promise<boolean> {
  const generation = state.generation;
  try {
    await loadModelCatalog();
  } catch {
    return false;
  }
  if (generation !== state.generation || !state.open) {
    return false; // 过期回执：Modal 已关/已重开，新的一轮自己会补
  }
  refreshModelCatalogMeta();
  return true;
}
