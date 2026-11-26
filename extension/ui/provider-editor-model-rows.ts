import { escapeHtml } from "../shared/string-utils.js";
import type { CatalogModelMeta } from "../ai/model-catalog.js";
import { testAiProviderConnection } from "../ai/provider-test.js";
import { renderUiIcon } from "./icon-registry.js";
import { loadModelCatalog, loadedModelCatalog } from "./lazy-model-catalog.js";
import { KEY_RECONFIRM_MESSAGE } from "./provider-editor-projection.js";
import type { ProviderEditorSession } from "./provider-editor-session.js";

export function modelRowHtml(value: string): string {
  return `
    <div class="provider-editor-model-row">
      <input class="provider-editor-model-id" type="text" placeholder="模型 ID（如 gpt-4o-mini）" value="${escapeHtml(value)}" />
      <span class="provider-editor-model-meta" data-model-meta hidden></span>
      <span class="provider-editor-model-result" data-state="idle" hidden></span>
      <button type="button" class="provider-editor-model-test" data-provider-editor-action="test-model" title="用该行模型 ID 测试连通性">测试</button>
      <button type="button" class="provider-editor-model-remove" data-provider-editor-action="remove-model" aria-label="删除该模型" title="删除该模型">
        ${renderUiIcon("trash")}
      </button>
    </div>`;
}

export function showCatalogError(session: ProviderEditorSession, message: string): void {
  const error = session.getDialog()?.querySelector<HTMLElement>(".provider-editor-catalog-error");
  if (!error) return;
  error.hidden = !message;
  error.textContent = message;
}

function formatContextWindow(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return "";
  }
  if (tokens >= 1_000_000) {
    return `${Math.round(tokens / 100_000) / 10}M`;
  }
  return `${Math.round(tokens / 1000)}K`;
}

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

function modelMetaTitle(
  meta: CatalogModelMeta,
  source: { source: string; contentHash: string } | null
): string {
  const parts = [
    meta.name,
    `上下文 ${formatContextWindow(meta.contextWindow)}`,
    `输出上限 ${formatContextWindow(meta.maxTokens)}`,
    meta.reasoning ? "支持思考" : "不支持思考",
    meta.input.includes("image") ? "支持图片" : "仅文本输入"
  ];
  if (source) {
    parts.push(`目录 ${source.source} ${source.contentHash}`);
  }
  return parts.join(" · ");
}

function fillMetaSlot(slot: HTMLElement, meta: CatalogModelMeta | null): void {
  const html = meta ? modelMetaHtml(meta) : "";
  slot.hidden = !html;
  slot.innerHTML = html;
  if (meta && html) {
    slot.title = modelMetaTitle(meta, loadedModelCatalog()?.UPSTREAM_CATALOG_SOURCE ?? null);
  } else {
    slot.removeAttribute("title");
  }
}

export function refreshModelCatalogMeta(session: ProviderEditorSession): void {
  const catalog = loadedModelCatalog();
  const presetId = session.draft.presetId;
  const baseUrl = session.draft.baseUrl.trim();
  const modelList = session.getDialog()?.querySelector<HTMLElement>(".provider-editor-model-list");
  const modelRows = modelList ? Array.from(modelList.children) : [];
  session.host.querySelectorAll<HTMLElement>("[data-model-meta]").forEach((slot) => {
    const row = slot.closest<HTMLElement>(".provider-editor-model-row, .provider-editor-fetch-item");
    let modelId = "";
    if (row?.classList.contains("provider-editor-model-row")) {
      const index = modelRows.indexOf(row);
      modelId = index >= 0 ? String(session.draft.models[index] ?? "").trim() : "";
    } else {
      modelId = row?.dataset.modelId || "";
    }
    fillMetaSlot(slot, catalog && modelId ? catalog.lookupCatalogMeta(presetId, baseUrl, modelId) : null);
  });
}

export function primeModelCatalogMeta(session: ProviderEditorSession): void {
  if (loadedModelCatalog()) {
    refreshModelCatalogMeta(session);
    return;
  }
  void session.runIfCurrent(
    () => loadModelCatalog(),
    {
      ok: () => {
        refreshModelCatalogMeta(session);
      },
      fail: () => {}
    }
  );
}

export async function runModelTest(session: ProviderEditorSession, row: HTMLElement | null): Promise<void> {
  if (!row || session.kind !== "ai") return;
  const dirtyDraft = session.isDirty();
  const result = row.querySelector<HTMLElement>(".provider-editor-model-result");
  const button = row.querySelector<HTMLButtonElement>(".provider-editor-model-test");
  const clearUnsavedNote = (): void => {
    if (!result) return;
    delete result.dataset.unsaved;
  };
  const list = row.closest<HTMLElement>(".provider-editor-model-list");
  const index = list ? Array.from(list.children).indexOf(row) : -1;
  const model = String(session.draft.models[index] ?? "").trim();
  const baseUrl = session.draft.baseUrl.trim();
  const fail = (message: string): void => {
    if (!result) return;
    result.hidden = false;
    result.dataset.state = "error";
    result.title = message;
    clearUnsavedNote();
  };
  if (!model) {
    fail("请先填写模型 ID");
    return;
  }
  if (!baseUrl) {
    fail("请先填写 API 地址");
    return;
  }
  const protocol = session.draft.protocol;
  const presetId = session.draft.presetId;
  const apiKey = session.draft.apiKey.trim();
  const reconfirm = session.resolveKeyReconfirm();
  if (!apiKey && reconfirm.required) {
    fail(KEY_RECONFIRM_MESSAGE);
    return;
  }
  const token = (Number(row.dataset.testToken) || 0) + 1;
  row.dataset.testToken = String(token);
  if (result) {
    result.hidden = false;
    result.dataset.state = "loading";
    result.title = "";
    clearUnsavedNote();
  }
  if (button) {
    button.disabled = true;
  }
  await session.runWithOriginPreflight(
    [baseUrl],
    () =>
      testAiProviderConnection({
        providerId: reconfirm.remoteProviderId,
        baseUrl,
        apiKey,
        model,
        protocol,
        presetId
      }),
    {
      alive: () => row.isConnected,
      workAlive: () => Number(row.dataset.testToken) === token,
      denied: (error) => {
        if (button) button.disabled = false;
        fail(error || "未取得该平台域名权限，无法测试连接");
      },
      ok: (resp) => {
        if (button) button.disabled = false;
        if (!result) return;
        if (resp?.ok) {
          result.dataset.state = "ok";
          if (dirtyDraft) {
            result.dataset.unsaved = "true";
            result.title = "连接成功（当前表单未保存）";
          } else {
            result.title = "连接成功";
          }
        } else {
          result.dataset.state = "error";
          result.title = `失败：${resp?.error || "未知错误"}`;
        }
      },
      fail: (error) => {
        if (button) button.disabled = false;
        fail(`失败：${(error as Error | undefined)?.message || "未知错误"}`);
      }
    }
  );
}
