// extension/ui/provider-editor-fetch-dialog.ts — 平台编辑 Modal 的「获取可用模型」
// 勾选弹窗片（provider-editor 拆分片，工单 12）。
//
// 职责：骨架与列表渲染、搜索 / 全选三态、已添加置灰、失败原位重试（拍板
// Q5/Q11）。弹窗与编辑器同宿主同生共死——closeProviderEditor 摘除 host 时一并消失。
// 依赖方向：只用底层状态袋（./provider-editor-state.js）与模型目录片
//（./provider-editor-catalog.js），不反向依赖 Modal 本体。
//
// 手势不变式：openFetchDialog 从函数体开头到 requestProviderOriginsViaBackground
// 之间零先行 await（tests/ui/options-save-gesture.test.ts 扫描本文件锁定——该用例
// 原扫 provider-editor.ts，随本片搬移改锚）。函数体自原 provider-editor.ts 逐字节搬移。

import { escapeHtml } from "../shared/string-utils.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { requestProviderOriginsViaBackground } from "../core/host-permissions.js";
import { getDialog, readField, resolvePreset, state } from "./provider-editor-state.js";
import { addModelRow, readModelIds, showCatalogError } from "./provider-editor-catalog.js";

// ===== 「获取可用模型」勾选弹窗（拍板 Q5/Q11）：搜索 / 全选 / 已添加置灰 =====

// 弹窗同宿主同生共死（closeProviderEditor 摘除 host 时一并消失）
export function getFetchDialog(): HTMLElement | null {
  return state.host?.querySelector<HTMLElement>(".provider-editor-fetch-dialog") || null;
}

export function closeFetchDialog(): void {
  state.host?.querySelector(".provider-editor-fetch-mask")?.remove();
  state.host?.querySelector(".provider-editor-fetch-dialog")?.remove();
}

// 拉到的全量模型 id（弹窗存活期有效）：搜索过滤与「已添加」置灰都基于它
let fetchModelsCache: string[] = [];

export function renderFetchSkeleton(): void {
  const host = state.host;
  if (!host) return;
  closeFetchDialog();
  host.insertAdjacentHTML("beforeend", `
    <div class="provider-editor-fetch-mask" data-provider-editor-action="close-fetch"></div>
    <section class="provider-editor-fetch-dialog" role="dialog" aria-modal="true" aria-label="获取可用模型">
      <header class="provider-editor-fetch-head">
        <span class="provider-editor-fetch-title">获取可用模型</span>
        <button type="button" class="provider-editor-fetch-close" data-provider-editor-action="close-fetch" aria-label="关闭">×</button>
      </header>
      <input class="provider-editor-fetch-search" type="text" placeholder="搜索模型" />
      <label class="provider-editor-fetch-all-row">
        <input type="checkbox" class="provider-editor-fetch-all" />
        <span>全选</span>
      </label>
      <ul class="provider-editor-fetch-list">
        <li class="provider-editor-fetch-message">正在拉取模型列表...</li>
      </ul>
      <p class="provider-editor-fetch-error" hidden></p>
      <footer class="provider-editor-fetch-foot">
        <button type="button" class="provider-editor-fetch-cancel" data-provider-editor-action="close-fetch">取消</button>
        <button type="button" class="provider-editor-fetch-confirm" data-provider-editor-action="confirm-fetch" disabled>添加所选</button>
      </footer>
    </section>`);
  getFetchDialog()
    ?.querySelector<HTMLInputElement>(".provider-editor-fetch-search")
    ?.addEventListener("input", (event) => {
      renderFetchItems(String((event.target as HTMLInputElement).value || ""));
    });
}

export function renderFetchList(models: string[]): void {
  const dialog = getFetchDialog();
  if (!dialog) return;
  fetchModelsCache = models.map(String);
  const error = dialog.querySelector<HTMLElement>(".provider-editor-fetch-error");
  if (error) {
    error.hidden = true;
    error.textContent = "";
  }
  renderFetchItems("");
}

export function renderFetchItems(filter: string): void {
  const dialog = getFetchDialog();
  const list = dialog?.querySelector<HTMLElement>(".provider-editor-fetch-list");
  if (!dialog || !list) return;
  // 已添加置灰（拍板 Q11）：与当前草稿目录比对，勾选添加只会追加目录外模型
  const existing = new Set(readModelIds());
  const kw = filter.trim().toLowerCase();
  const visible = fetchModelsCache.filter((m) => !kw || m.toLowerCase().includes(kw));
  list.innerHTML = visible.length
    ? visible.map((m) => {
        const added = existing.has(m);
        return `
          <li class="provider-editor-fetch-item">
            <label class="provider-editor-fetch-item-label">
              <input type="checkbox" class="provider-editor-fetch-check" value="${escapeHtml(m)}" ${added ? "disabled" : ""} />
              <span class="provider-editor-fetch-name">${escapeHtml(m)}</span>
            </label>
            ${added ? '<span class="provider-editor-fetch-added">已添加</span>' : ""}
          </li>`;
      }).join("")
    : `<li class="provider-editor-fetch-message">无匹配模型</li>`;
  syncFetchSelectionState();
}

// 全选三态与「添加所选」计数同步（勾选点击经 host 委托冒泡到这里）
export function syncFetchSelectionState(): void {
  const dialog = getFetchDialog();
  if (!dialog) return;
  const checks = Array.from(dialog.querySelectorAll<HTMLInputElement>(".provider-editor-fetch-check:not(:disabled)"));
  const checkedCount = checks.filter((check) => check.checked).length;
  const all = dialog.querySelector<HTMLInputElement>(".provider-editor-fetch-all");
  if (all) {
    all.checked = checks.length > 0 && checkedCount === checks.length;
    all.indeterminate = checkedCount > 0 && checkedCount < checks.length;
  }
  const confirm = dialog.querySelector<HTMLButtonElement>(".provider-editor-fetch-confirm");
  if (confirm) {
    confirm.disabled = checkedCount === 0;
    confirm.textContent = checkedCount > 0 ? `添加所选 (${checkedCount})` : "添加所选";
  }
}

export function renderFetchError(message: string): void {
  const dialog = getFetchDialog();
  const list = dialog?.querySelector<HTMLElement>(".provider-editor-fetch-list");
  const error = dialog?.querySelector<HTMLElement>(".provider-editor-fetch-error");
  if (!dialog || !error) return;
  if (list) {
    list.innerHTML = "";
  }
  error.hidden = false;
  error.textContent = `${message} `;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "provider-editor-fetch-retry";
  retry.dataset.providerEditorAction = "retry-fetch";
  retry.textContent = "重试";
  error.appendChild(retry);
}

export async function loadFetchModels(baseUrl: string, apiKey: string): Promise<void> {
  const generation = state.generation;
  let resp: { ok?: boolean; models?: string[]; error?: string } | null = null;
  try {
    resp = await sendRuntimeMessage({ type: "ai-providers-models", baseUrl, apiKey, providerId: state.editingId });
  } catch (error) {
    resp = { ok: false, error: (error as Error | undefined)?.message || "拉取失败" };
  }
  if (generation !== state.generation || !getFetchDialog()) {
    return; // 过期回执：Modal 已关/已重开或弹窗已关
  }
  if (resp?.ok && Array.isArray(resp.models)) {
    renderFetchList(resp.models);
  } else {
    renderFetchError(String(resp?.error || "拉取失败"));
  }
}

// 「获取可用模型」入口：校验地址/Key → 弹窗骨架 → 权限代申请 → 拉列表。
// 手势同步链：本函数开头到 requestProviderOriginsViaBackground 之间零先行
// await（tests/ui/options-save-gesture.test.ts 锁定）——点击直达代申请。
export async function openFetchDialog(): Promise<void> {
  const baseUrl = readField(".provider-editor-baseurl");
  const apiKey = readField(".provider-editor-apikey");
  const presetId = getDialog()?.querySelector<HTMLSelectElement>(".provider-editor-preset")?.value || "custom";
  const preset = resolvePreset(state.presets, presetId, state.kind);
  if (!baseUrl || (!apiKey && !state.hasSavedKey && preset?.requiresKey !== false)) {
    showCatalogError("请先填写 API 地址和 Key");
    return;
  }
  showCatalogError("");
  renderFetchSkeleton();
  const generation = state.generation;
  const permission = await requestProviderOriginsViaBackground([baseUrl]);
  if (generation !== state.generation || !state.open || !getFetchDialog()) {
    return;
  }
  if (!permission.ok) {
    renderFetchError(permission.error || "未取得该平台域名权限，无法拉取模型列表");
    return;
  }
  await loadFetchModels(baseUrl, apiKey);
}

// 勾选确认：所选模型以行形式追加进目录（草稿态，拍板 Q10——不触发落盘）
export function confirmFetchSelection(): void {
  const dialog = getFetchDialog();
  if (!dialog) return;
  Array.from(dialog.querySelectorAll<HTMLInputElement>(".provider-editor-fetch-check:checked:not(:disabled)"))
    .map((check) => check.value.trim())
    .filter(Boolean)
    .forEach((model) => addModelRow(model));
  showCatalogError("");
  closeFetchDialog();
}
