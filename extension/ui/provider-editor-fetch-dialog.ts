// extension/ui/provider-editor-fetch-dialog.ts — 平台编辑 Modal 的「获取可用模型」
// 内联子视图（provider-editor 拆分片，工单 12；票 09 起由第二层遮罩收进编辑器
// 内子视图）。
//
// 职责：子视图骨架与列表渲染、搜索 / 全选三态、已添加置灰、失败原位重试（拍板
// Q5/Q11）。子视图渲染在 .provider-editor-dialog 内（票 09：不再生成第二张遮罩），
// 与编辑器同宿主同生共死——closeProviderEditor 摘除 host 时一并消失。
// 依赖方向：只用底层状态袋（./provider-editor-state.js）与模型目录片
//（./provider-editor-catalog.js），不反向依赖 Modal 本体。
//
// 选择集（票 09）：会话级 Set 承载勾选，搜索过滤与列表重渲后保留；全选只作用
// 于当前可见且未添加项；确认计数包含被过滤隐藏的已选项并给出不可见数量说明。
//
// 手势不变式：openFetchDialog 从函数体开头到 requestProviderOriginsViaBackground
// 之间零先行 await——等价行为断言（点击当拍权限已出站）在
// tests/ui/provider-editor.test.ts 与 tests/ui/provider-editor-session.test.ts。
// 拉取回执的过期判据收进结算原语（captureSession / runIfCurrent，子视图存活判据）
// 并叠加子视图代次令牌：迟到回执不得覆盖新开的子视图（票 09）。

import { escapeHtml } from "../shared/string-utils.js";
import { fetchProviderModels, resolveAiModelListTarget } from "../ai/provider-models.js";
import { normalizeDraftModels, captureSession, runIfCurrent, state, getDialog } from "./provider-editor-state.js";
import { PROVIDER_FAMILY_ROWS } from "./provider-family.js";
import { addModelRow, refreshModelCatalogMeta, showCatalogError } from "./provider-editor-catalog.js";

// ===== 「获取可用模型」内联子视图（拍板 Q5/Q11 + 票 09）：搜索 / 全选 / 已添加置灰 =====

// 子视图同宿主同生共死（closeProviderEditor 摘除 host 时一并消失）
export function getFetchDialog(): HTMLElement | null {
  return state.host?.querySelector<HTMLElement>(".provider-editor-fetch-dialog") || null;
}

export function closeFetchDialog(restoreFocus = true): void {
  getFetchDialog()?.remove();
  fetchModelsCache = [];
  fetchSelected.clear();
  fetchFilter = "";
  // 子视图关闭后归还焦点到「获取可用模型」触发键（编辑器已关时宿主已摘，无处可还）
  if (restoreFocus && state.open) {
    state.host?.querySelector<HTMLElement>(".provider-editor-fetch")?.focus({ preventScroll: true });
  }
}

// 拉到的全量模型 id（子视图存活期有效）：搜索过滤与「已添加」置灰都基于它
let fetchModelsCache: string[] = [];
// 会话级选择集（票 09）：搜索过滤与列表重渲后保留；每次打开子视图时清空
const fetchSelected = new Set<string>();
// 当前搜索词（票 09）：统计「已选但不在当前筛选结果中」的不可见数量
let fetchFilter = "";
// 子视图代次（票 09）：每次 openFetchDialog 递增——在飞回执落定时代次已推进
// （子视图被关后重开、或失败原位重试）即丢弃，不得覆盖新子视图
let fetchGeneration = 0;

export function renderFetchSkeleton(): void {
  const dialog = getDialog();
  if (!dialog) return;
  // 重建子视图不先归还焦点：新骨架随后把焦点放回子视图自身
  closeFetchDialog(false);
  dialog.insertAdjacentHTML("beforeend", `
    <section class="provider-editor-fetch-dialog" role="group" aria-label="获取可用模型">
      <header class="provider-editor-fetch-head">
        <button type="button" class="provider-editor-fetch-back" data-provider-editor-action="close-fetch" aria-label="返回平台编辑器">← 返回</button>
        <span class="provider-editor-fetch-title">获取可用模型</span>
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
      <p class="provider-editor-fetch-note" hidden></p>
      <footer class="provider-editor-fetch-foot">
        <button type="button" class="provider-editor-fetch-cancel" data-provider-editor-action="close-fetch">取消</button>
        <button type="button" class="provider-editor-fetch-confirm" data-provider-editor-action="confirm-fetch" disabled>添加所选</button>
      </footer>
    </section>`);
  const subview = getFetchDialog();
  subview
    ?.querySelector<HTMLInputElement>(".provider-editor-fetch-search")
    ?.addEventListener("input", (event) => {
      renderFetchItems(String((event.target as HTMLInputElement).value || ""));
    });
  // 勾选委托（票 09：选择集随点击落 Set，重渲后由渲染回填——过滤/重渲不丢）。
  // jsdom 与浏览器都先完成 checkbox 自身切换，再进此委托。
  subview?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const all = target.closest<HTMLInputElement>(".provider-editor-fetch-all");
    if (all) {
      // 全选三态（票 09）：只作用于当前可见且未添加项
      getFetchDialog()
        ?.querySelectorAll<HTMLInputElement>(".provider-editor-fetch-check:not(:disabled)")
        .forEach((check) => {
          check.checked = all.checked;
          setFetchSelected(check.value, all.checked);
        });
    } else {
      const check = target.closest<HTMLInputElement>(".provider-editor-fetch-check");
      if (check && !check.disabled) {
        setFetchSelected(check.value, check.checked);
      }
    }
    syncFetchSelectionState();
  });
}

function setFetchSelected(model: string, selected: boolean): void {
  const value = model.trim();
  if (!value) return;
  if (selected) {
    fetchSelected.add(value);
  } else {
    fetchSelected.delete(value);
  }
}

export function renderFetchList(models: string[]): void {
  const dialog = getFetchDialog();
  if (!dialog) return;
  fetchModelsCache = models.map(String);
  // 重拉取（含原位重试）后清单是唯一事实：不再返回的模型从选择集剔除
  for (const model of Array.from(fetchSelected)) {
    if (!fetchModelsCache.includes(model)) {
      fetchSelected.delete(model);
    }
  }
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
  fetchFilter = filter;
  // 已添加置灰（拍板 Q11）：与当前草稿目录比对，勾选添加只会追加目录外模型
  const existing = new Set(normalizeDraftModels(state.draft?.models ?? []));
  const kw = filter.trim().toLowerCase();
  const visible = fetchModelsCache.filter((m) => !kw || m.toLowerCase().includes(kw));
  list.innerHTML = visible.length
    ? visible.map((m) => {
        const added = existing.has(m);
        // 渲染时回填勾选（票 09：选择集跨过滤/重渲保留）；已添加项不可选，
        // 同步剔出选择集——确认只追加目录外模型
        if (added) {
          fetchSelected.delete(m);
        }
        return `
          <li class="provider-editor-fetch-item" data-model-id="${escapeHtml(m)}">
            <label class="provider-editor-fetch-item-label">
              <input type="checkbox" class="provider-editor-fetch-check" value="${escapeHtml(m)}" ${added ? "disabled" : ""} ${!added && fetchSelected.has(m) ? "checked" : ""} />
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

// 全选三态与「添加所选」计数同步（勾选点击经子视图委托落到本函数）
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
  // 计数（票 09）：确认加入全量已选——含被搜索过滤隐藏的已选项
  const total = fetchSelected.size;
  const confirm = dialog.querySelector<HTMLButtonElement>(".provider-editor-fetch-confirm");
  if (confirm) {
    confirm.disabled = total === 0;
    confirm.textContent = total > 0 ? `添加所选 (${total})` : "添加所选";
  }
  // 不可见已选说明（票 09）：当前筛选结果之外的已选数量
  const kw = fetchFilter.trim().toLowerCase();
  const hidden = kw ? Array.from(fetchSelected).filter((m) => !m.toLowerCase().includes(kw)).length : 0;
  const note = dialog.querySelector<HTMLElement>(".provider-editor-fetch-note");
  if (note) {
    note.hidden = hidden === 0;
    note.textContent = hidden > 0 ? `另有 ${hidden} 项已选不在当前筛选结果中` : "";
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

export async function loadFetchModels(
  baseUrl: string,
  apiKey: string,
  protocol: string,
  generation?: number
): Promise<void> {
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
    // 存活判据：Modal 已关/已重开或子视图已关/已重开（代次令牌不匹配），过期回执不打扰
    () => getFetchDialog() !== null && (generation === undefined || generation === fetchGeneration)
  );
}

// 「获取可用模型」入口：校验地址/Key → 子视图骨架 → 权限代申请 → 拉列表。
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
  // AI 侧公式一致才不留分叉（搜索族走不到本子视图）
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
  // 子视图代次（票 09）：重开/重试即在飞回执判死——迟到回执不得覆盖新子视图
  const generation = ++fetchGeneration;
  renderFetchSkeleton();
  // 焦点进子视图（层内 Tab 约束由编辑器的 focus-scope 覆盖整个 Dialog）
  getFetchDialog()?.querySelector<HTMLElement>(".provider-editor-fetch-back")?.focus({ preventScroll: true });
  // 会话结算（owner 2）：权限回执落定时 Modal 已关/已重开或子视图已关/已重开
  // （代次不匹配）即丢弃，不再触发注定过期的模型请求。
  const session = captureSession(
    () => getFetchDialog() !== null && generation === fetchGeneration
  );
  await session.runWithOriginPreflight(
    target.permissionBaseUrls,
    () => loadFetchModels(target.baseUrl, apiKey, draft.protocol, generation),
    {
      ok: () => {},
      denied: (error) => {
        renderFetchError(
          `未拉取：${error || "未取得该平台域名权限，无法拉取模型列表"}。请重新授权后重试`
        );
      }
    }
  );
}

// 勾选确认：全量已选模型以行形式追加进目录（草稿态，拍板 Q10——不触发落盘）。
// 目录外判据收口在此：与当前草稿目录比对去重，重复确认不会制造重复目录项。
export function confirmFetchSelection(): void {
  if (!getFetchDialog()) return;
  const existing = new Set(normalizeDraftModels(state.draft?.models ?? []));
  Array.from(fetchSelected)
    .map((model) => model.trim())
    .filter((model) => model && !existing.has(model))
    .forEach((model) => addModelRow(model));
  showCatalogError("");
  closeFetchDialog();
}
