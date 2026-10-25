// extension/ui/provider-editor-fetch-dialog.ts — 平台编辑 Modal 的「获取可用模型」
// 勾选弹窗片（provider-editor 拆分片，工单 12）。
//
// 职责：骨架与列表渲染、搜索 / 全选三态、已添加置灰、失败原位重试（拍板
// Q5/Q11）。弹窗与编辑器同宿主同生共死——closeProviderEditor 摘除 host 时一并消失。
// 依赖方向：只用底层状态袋（./provider-editor-state.js）与模型目录片
//（./provider-editor-catalog.js），不反向依赖 Modal 本体。
//
// 手势不变式：openFetchDialog 从函数体开头到 requestProviderOriginsViaBackground
// 之间零先行 await——等价行为断言（点击当拍权限已出站）在
// tests/ui/provider-editor.test.ts 与 tests/ui/provider-editor-session.test.ts。
// 拉取回执的过期判据收进结算原语（captureSession / runIfCurrent，弹窗存活判据）。

import { escapeHtml } from "../shared/string-utils.js";
import { fetchProviderModels, resolveAiModelListTarget } from "../ai/provider-models.js";
import { requestProviderOriginsViaBackground } from "../core/host-permissions.js";
import { normalizeDraftModels, captureSession, runIfCurrent, state } from "./provider-editor-state.js";
import { PROVIDER_FAMILY_ROWS } from "./provider-family.js";
import { addModelRow, refreshModelCatalogMeta, showCatalogError } from "./provider-editor-catalog.js";

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
  const existing = new Set(normalizeDraftModels(state.draft?.models ?? []));
  const kw = filter.trim().toLowerCase();
  const visible = fetchModelsCache.filter((m) => !kw || m.toLowerCase().includes(kw));
  list.innerHTML = visible.length
    ? visible.map((m) => {
        const added = existing.has(m);
        return `
          <li class="provider-editor-fetch-item" data-model-id="${escapeHtml(m)}">
            <label class="provider-editor-fetch-item-label">
              <input type="checkbox" class="provider-editor-fetch-check" value="${escapeHtml(m)}" ${added ? "disabled" : ""} />
              <span class="provider-editor-fetch-name">${escapeHtml(m)}</span>
            </label>
            <span class="provider-editor-fetch-meta" data-model-meta hidden></span>
            ${added ? '<span class="provider-editor-fetch-added">已添加</span>' : ""}
          </li>`;
      }).join("")
    : `<li class="provider-editor-fetch-message">无匹配模型</li>`;
  // 元数据栏（model-catalog/04）：查得到才渲染；目录模块尚未加载完时留空，
  // 加载完成由 primeModelCatalogMeta 补一次（不重渲列表，不丢勾选态）
  refreshModelCatalogMeta();
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

export async function loadFetchModels(baseUrl: string, apiKey: string, protocol: string): Promise<void> {
  await runIfCurrent(
    async (): Promise<{ ok?: boolean; models?: string[]; error?: string }> => {
      try {
        return await fetchProviderModels({ baseUrl, apiKey, providerId: state.editingId, protocol });
      } catch (error) {
        return { ok: false, error: (error as Error | undefined)?.message || "拉取失败" };
      }
    },
    {
      ok: (resp) => {
        if (resp?.ok && Array.isArray(resp.models)) {
          renderFetchList(resp.models);
        } else {
          renderFetchError(String(resp?.error || "拉取失败"));
        }
      }
    },
    // 存活判据：Modal 已关/已重开或弹窗已关，过期回执不打扰
    () => getFetchDialog() !== null
  );
}

// 「获取可用模型」入口：校验地址/Key → 弹窗骨架 → 权限代申请 → 拉列表。
// 手势同步链：本函数开头到 requestProviderOriginsViaBackground 之间零先行
// await——点击直达代申请（等价行为断言见 tests/ui/provider-editor.test.ts 与
// tests/ui/provider-editor-session.test.ts 的同步出站核验）。
export async function openFetchDialog(): Promise<void> {
  const draft = state.draft;
  if (!draft) return;
  const baseUrl = draft.baseUrl.trim();
  const apiKey = draft.apiKey.trim();
  const family = PROVIDER_FAMILY_ROWS[state.kind];
  const preset = family.resolvePreset(state.presets, draft.presetId);
  // Key 必填判据与 Modal / 行的占位符同源（family.editor.isKeyRequired）：
  // AI 侧公式一致才不留分叉（搜索族走不到本弹窗）
  if (!baseUrl || (!apiKey && !state.hasSavedKey && family.editor.isKeyRequired(preset))) {
    showCatalogError("请先填写 API 地址和 Key");
    return;
  }
  showCatalogError("");
  // 双协议预设的 Anthropic → OpenAI 模型端点回落与需授权源集合统一由 ai/provider-models.ts 解析。
  const target = resolveAiModelListTarget({
    baseUrl,
    protocol: draft.protocol,
    preset
  });
  renderFetchSkeleton();
  // 会话结算（owner 2）：权限回执落定时 Modal 已关/已重开或弹窗已关即丢弃，
  // 不再触发注定过期的模型请求。
  const session = captureSession(() => getFetchDialog() !== null);
  await session.run(
    () => requestProviderOriginsViaBackground(target.permissionBaseUrls),
    {
      ok: (permission) => {
        if (!permission.ok) {
          renderFetchError(permission.error || "未取得该平台域名权限，无法拉取模型列表");
          return;
        }
        void loadFetchModels(target.baseUrl, apiKey, draft.protocol);
      }
    }
  );
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
