// extension/ui/provider-editor-modal.ts — 平台编辑 Modal 本体（provider-editor 拆分片，
// 工单 12）。
//
// 原 provider-editor.ts 三片分层后的顶片：Modal 的打开/关闭（含 dirty 保护）、
// 字段模板（经投影片的字段表拼装）、宿主挂载与全局监听、事件委托接线。依赖方向
// 单向向下：
//
//   provider-editor-state  ← 状态袋 + 会话写入/结算原语（owner 2，零运行时依赖）
//   provider-editor-projection ← 字段投影表：DOM 形态 + 目标态规则（owner 1）
//   provider-editor-catalog ← AI 模型目录（行模板 / 增删 / 空态 / 行级测试）
//   provider-editor-fetch-dialog ← 「获取可用模型」勾选弹窗
//   provider-editor-modal（本文件）→ 以上各片
//   provider-editor.ts → 本文件（对外导出壳，导入路径零变化）
//
// 动作三件（保存 / 删除 / 测试连接）随接线留在本片：它们读写状态袋并关闭
// Modal，与接线同属一条点击链；三个动作的过期回执判据一律走状态片的结算原语
//（runIfCurrent / captureSession），不再手抄代际比对。

import { escapeHtml } from "../shared/string-utils.js";
import { requestProviderOriginsViaBackground } from "../core/host-permissions.js";
import { testAsrConnection } from "../asr/provider-test.js";
import { listAsrModels } from "../asr/provider-models.js";
import { DEFAULT_SEARCH_PROVIDER_PRESET, type SearchProviderPreset } from "../core/presets.js";
import { executeWebSearch } from "../search/search-executor.js";
import { classifySearchFailure } from "../search/search-chain.js";
import { searchProviderStore } from "../search/search-provider-store.js";
// DeepSeek 凭据引用（GLOSSARY「凭据引用」）：搜索测试的 Key 与链装配同源——读 AI 族
// 列表（ai-providers-list）+ 官方端点判定，再按记录 id 取 Key（get-ai-provider-key）。
import {
  DEEPSEEK_ROW_STATUS_TEXT,
  resolveDeepseekCredential,
  type DeepseekCredentialStatus
} from "../search/deepseek-credential.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { wireModelPicker } from "./model-picker.js";
import { closeAllCustomSelects, initCustomSelect } from "./custom-select.js";
import { confirmDialog, isConfirmDialogOpen } from "./confirm-dialog.js";
import { ids } from "../reader/state.js";
import { observeSettingsPanelHidden } from "./settings-panel-hidden.js";
import type { ProviderRowElement, ProviderRowItem } from "./provider-row.js";
import { PROVIDER_FAMILY_ROWS } from "./provider-family.js";
import {
  beginEditorSession,
  captureSession,
  draftsEqual,
  editDraft,
  endEditorSession,
  getDialog,
  normalizeDraftModels,
  runIfCurrent,
  sessionObserver,
  state,
  type EditorDraft,
  type ProviderEditorKind,
  type ProviderEditorOpenOptions
} from "./provider-editor-state.js";
import {
  DRAFT_INPUTS,
  normalizeProtocolValue,
  presetBaseUrlForProtocol,
  presetProtocol,
  projectionBlocks,
  renderProjection
} from "./provider-editor-projection.js";
import {
  addModelRow,
  modelRowHtml,
  primeModelCatalogMeta,
  refreshModelCatalogMeta,
  removeModelRow,
  runModelTest
} from "./provider-editor-catalog.js";
import {
  closeFetchDialog,
  confirmFetchSelection,
  getFetchDialog,
  openFetchDialog,
  syncFetchSelectionState
} from "./provider-editor-fetch-dialog.js";

// 状态行写入口（ASR 平台级测试 / 测试模型下拉与保存共用；错误态着色走
// data-error，与平铺行 .ai-provider-status 的 CSS 契约同款）
export function showStatus(text: string, isError = false): void {
  const statusNode = getDialog()?.querySelector<HTMLElement>(".provider-editor-status");
  if (!statusNode) return;
  statusNode.hidden = false;
  statusNode.textContent = text;
  statusNode.dataset.error = isError ? "true" : "false";
}

export function statusIsError(): boolean {
  return getDialog()?.querySelector<HTMLElement>(".provider-editor-status")?.dataset.error === "true";
}

export function clearStatus(): void {
  const statusNode = getDialog()?.querySelector<HTMLElement>(".provider-editor-status");
  if (!statusNode) return;
  statusNode.hidden = true;
  statusNode.textContent = "";
  statusNode.dataset.error = "false";
}

export function setBusy(isBusy: boolean): void {
  getDialog()
    ?.querySelectorAll<HTMLButtonElement>(".provider-editor-test, .provider-editor-save")
    .forEach((button) => (button.disabled = isBusy));
}

// ===== 协议/预设投影口径（provider-editor-projection）=====
// normalizeProtocolValue / presetProtocol / presetBaseUrlForProtocol / protocolNotes
// 收在投影片：它们同时是「模板与联动」的共用口径与字段投影的输入（唯一一份）。

// ===== dirty（拍板 Q6；候选 4 片 3：draft 逐字段对比，DOM 不参与） =====

export function isDirty(): boolean {
  return (
    state.open &&
    state.draft !== null &&
    state.baselineDraft !== null &&
    !draftsEqual(state.draft, state.baselineDraft)
  );
}

// ===== 关闭（幂等；force 跳过 dirty 确认弹层） =====

export function closeProviderEditor(force = false): void {
  if (!state.open && !state.host) {
    return;
  }
  if (state.open && !force && isDirty()) {
    // 非 force 直调的 dirty 拦截，与 requestClose 同路径
    void confirmDiscardChanges();
    return;
  }
  document.removeEventListener("click", onDocumentClickCapture, true);
  document.removeEventListener("keydown", onDocumentKeyDownCapture, true);
  // 会话控制字段的唯一写入点在状态片（代际作废 + 摘宿主/观察器 + 清草稿）
  endEditorSession();
}

// 取消 / Esc / 遮罩 / 面板外点击的统一关闭入口（拍板 Q6）：dirty 才拦——
// 无改动同步直关（Esc/遮罩点击的既有同步语义，测试锁定）；有改动弹面板内
// 确认弹层（ui/confirm-dialog.js，与删除二次确认同源），放弃更改才关
export function requestClose(): void {
  if (!isDirty()) {
    closeProviderEditor(true);
    return;
  }
  void confirmDiscardChanges();
}

// dirty 确认：弹层叠在本 Modal 之上（z-index 50 > 40）；确认期间编辑器的
// 文档级监听按 isConfirmDialogOpen 让位，Esc/外点由弹层承接
export async function confirmDiscardChanges(): Promise<void> {
  const ok = await confirmDialog({
    message: "未保存的更改将丢失，确定关闭？",
    confirmText: "放弃更改",
    danger: true
  });
  if (ok) {
    closeProviderEditor(true);
  }
}

// ===== 保存（拍板 Q2：单平台 upsert 委托注入的 onSave） =====

export function collectUpsert(): { upsert: ProviderRowItem; validationError?: string } {
  const family = PROVIDER_FAMILY_ROWS[state.kind];
  // draft 是真源（候选 4 片 3）：保存只读 draft，不读 DOM——裸改投影不混入保存链
  const draft = state.draft!;
  // 预设回落与序列化都走族声明（每族知识唯一来源，行/编辑器同源）
  const preset = family.resolvePreset(state.presets, draft.presetId);
  return family.editor.serializeUpsert({
    id: state.editingId,
    preset,
    name: draft.name.trim() || preset?.name || "自定义",
    baseUrl: draft.baseUrl.trim().replace(/\/+$/, ""),
    apiKey: draft.apiKey.trim(),
    hasSavedKey: state.hasSavedKey,
    models: normalizeDraftModels(draft.models),
    model: draft.model.trim(),
    // 协议显式落盘（multi-protocol-ai）：存量记录编辑保存即写入显式值
    protocol: normalizeProtocolValue(draft.protocol)
  });
}

export async function save(): Promise<void> {
  const { upsert, validationError } = collectUpsert();
  if (validationError) {
    showStatus(validationError, true);
    return;
  }
  setBusy(true);
  showStatus("正在保存...");
  // 会话结算（owner 2）：落盘回执落定时 Modal 已关/已重开即静默丢弃，否则
  // 成功关 Modal / 失败复位 busy 并写状态行——动作只写这两支。
  await runIfCurrent(
    () => state.onSave(state.kind, upsert),
    {
      ok: (result) => {
        if (result.ok) {
          closeProviderEditor(true);
          return;
        }
        setBusy(false);
        showStatus(result.error || "保存失败", true);
      },
      // void save() 会吞 rejection——任何异常都必须落到状态行，不允许无反馈
      fail: (error) => {
        setBusy(false);
        showStatus(`保存失败：${(error as Error).message || "未知错误"}`, true);
      }
    }
  );
}

// ===== 删除（编辑态，Modal 头部警示按钮；回收权限/删除消息/重渲在 onDelete） =====

export async function deleteActive(): Promise<void> {
  const onDelete = state.onDelete;
  if (!state.editingId || !onDelete) return;
  // 面板内二次确认（ui/confirm-dialog.js）：原生 confirm 绘制在浏览器窗口中央，
  // 面板停靠右侧时可能看不到；确认期间编辑器的文档级监听整体让位
  if (!(await confirmDialog({ message: "确定要删除这个平台吗？删除后需要重新配置。", confirmText: "删除", danger: true }))) {
    return;
  }
  setBusy(true);
  showStatus("正在删除...");
  await runIfCurrent(
    () =>
      onDelete(state.kind, {
        id: state.editingId,
        // 回收目标锚定打开时的权威列表项：DOM 现值可能含未保存改动，拿来回收
        // 会漏收旧 origin / 误收从未授予过的 origin
        baseUrl: state.openBaseUrl
      }),
    {
      ok: (result) => {
        if (result.ok) {
          closeProviderEditor(true);
          return;
        }
        setBusy(false);
        showStatus(result.error || "删除失败", true);
      },
      fail: (error) => {
        setBusy(false);
        showStatus(`删除失败：${(error as Error).message || "未知错误"}`, true);
      }
    }
  );
}

// ===== 测试连接（只验证连通性，成功也不落盘；保存只在点「保存」时发生） =====
//
// AI：行级测试（拍板 Q4/Q12，runModelTest），平台级按钮已退役；本函数只剩
// ASR 平台级测试与搜索测试动作（spec §6.6）。ASR 的探针经 port 走 offscreen，
// 与实际转写同一条链路（dc6c4c1：探针与真跑曾分叉，才会「未授权却测出连接成功」）；
// 探针的 host 权限前置在这里补齐——点按钮这次点击就是唯一的手势，弹窗只此一次机会。

export async function runTest(): Promise<void> {
  // 平台级测试能力按族声明（ASR 探针 / 搜索测试动作）；函数体仍按族直写
  if (!PROVIDER_FAMILY_ROWS[state.kind].editor.supportsPlatformTest) return;
  if (state.kind === "search") {
    // 不同步 await：搜索域名是 manifest 静态 host 权限（settings-panel 保存链同款
    // 判据），不代申请；这里让出控制权也不影响手势（该分支直接返回，从不到申请处）
    void runSearchTest();
    return;
  }
  const draft = state.draft;
  if (!draft) return;
  const baseUrl = draft.baseUrl.trim();
  const model = draft.model.trim();
  if (!baseUrl) {
    showStatus("请填写 API 地址", true);
    return;
  }
  if (!model) {
    showStatus("请填写模型名", true);
    return;
  }
  // 手势不变式：本次点击直达权限代申请（此前零 await，等价行为断言见
  // tests/ui/provider-editor.test.ts 的点击当拍核验）。已授权时 Chrome 直接放行
  // 不弹窗；未授权时先补齐前置，探针才真发得出去，而不是回一句「该平台域名未授权」。
  const session = captureSession();
  await session.run(
    () => requestProviderOriginsViaBackground([baseUrl]),
    {
      ok: (permission) => {
        if (!permission.ok) {
          showStatus(permission.error || "未取得该平台域名权限，无法测试连接", true);
          return;
        }
        setBusy(true);
        showStatus("正在测试...");
        const preset = PROVIDER_FAMILY_ROWS[state.kind].resolvePreset(state.presets, draft.presetId);
        const apiKey = draft.apiKey.trim();
        const name = draft.name.trim() || preset?.name || "自定义";
        // 新增时 editingId 为空，探针按空 id 代查 Key 落空，用户重输的 Key 随参数携带。
        void session.run(
          () =>
            testAsrConnection({
              id: state.editingId,
              name,
              type: preset?.type || "openai-transcriptions",
              baseUrl,
              model,
              ...(apiKey ? { apiKey } : {})
            }),
          {
            ok: (resp) => {
              if (!resp?.ok) {
                setBusy(false);
                showStatus(`失败：${resp?.error || "未知错误"}`, true);
                return;
              }
              // 测试成功：只回报连通性，不写设置——用户显式点「保存」才落盘
              setBusy(false);
              showStatus("连接成功");
            }
            // fail 缺省：探针异常原样上抛（与既有 void 调用语义一致）
          }
        );
      }
    }
  );
}

// ===== 搜索测试动作（spec §6.6） =====
//
// 三条硬约束：① 测试走单引擎执行路径（executeWebSearch）——不经回退链，也不走、
// 不写查询缓存；② 探针词是设置页常量；③ 不落盘（只有「保存」写设置）。
// 前置（baseUrl 空 / Key 必填但空）是本地校验，不是测试态：不发起请求。
export const SEARCH_TEST_QUERY = "联网搜索测试";

// DeepSeek 搜索测试的 Key 解析（凭据引用，与链装配同源判定）：读 AI 族列表找
// 第一条「启用 + presetId deepseek + 官方端点」记录，再按记录 id 取 Key。
// 任一步失败返回空 Key + 对应状态（状态文案单源在 DEEPSEEK_ROW_STATUS_TEXT）。
async function resolveDeepseekKeyForSearchTest(): Promise<{ key: string; status: DeepseekCredentialStatus }> {
  try {
    const resp = await sendRuntimeMessage({ type: "ai-providers-list" });
    if (!resp?.ok || !Array.isArray(resp.providers)) {
      return { key: "", status: "no-record" };
    }
    const { status, record } = resolveDeepseekCredential(resp.providers);
    if (status !== "ok" || !record || !record.id) {
      return { key: "", status };
    }
    const keyResp = await sendRuntimeMessage({ type: "get-ai-provider-key", providerId: record.id });
    const key = keyResp?.ok ? String(keyResp.apiKey || "").trim() : "";
    return { key, status: key ? "ok" : "no-key" };
  } catch {
    return { key: "", status: "no-record" };
  }
}

// 五态：HTTP 200 有结果 →「连接成功 · N 条结果」；200 且 0 条 →「未返回结果」
// （失败态）；额度类 →「额度已用尽」；鉴权类 →「Key 无效或无权限」；其余类 →
//「连接失败：<原因>」。分类复用 search-chain 的 classifySearchFailure（单一映射表）。
export async function runSearchTest(): Promise<void> {
  const family = PROVIDER_FAMILY_ROWS[state.kind];
  const draft = state.draft;
  if (!draft) return;
  const preset = family.resolvePreset(state.presets, draft.presetId) as SearchProviderPreset | null;
  const baseUrl = draft.baseUrl.trim();
  if (!baseUrl) {
    showStatus("请填写 API 地址", true);
    return;
  }
  let apiKey = draft.apiKey.trim();
  // 编辑已存 Key 的平台时空输入沿用已存 Key（与保存链同语义）：只读存储，不写
  if (!apiKey && state.hasSavedKey && state.editingId) {
    try {
      apiKey = (await searchProviderStore.getKey(state.editingId)) || "";
    } catch {
      apiKey = "";
    }
  }
  // DeepSeek 搜索测试：搜索侧没有自有 Key，Key 经凭据引用实时读 AI 族（与链装配
  // 同源判定）；取不到按状态给三态文案之一，不发起请求。
  if (preset?.id === "deepseek") {
    const resolved = await resolveDeepseekKeyForSearchTest();
    if (!resolved.key) {
      showStatus(DEEPSEEK_ROW_STATUS_TEXT[resolved.status], true);
      return;
    }
    apiKey = resolved.key;
  }
  // Key 必填判据与占位符 / required 同源（族声明的 isKeyRequired）
  if (!apiKey && family.editor.isKeyRequired(preset)) {
    showStatus("请先填写 API Key", true);
    return;
  }
  setBusy(true);
  showStatus("正在测试...");
  // 会话结算（owner 2）：五态映射只写在成功与失败两支，过期回执静默丢弃
  await runIfCurrent(
    () =>
      executeWebSearch(
        {
          type: preset?.type || DEFAULT_SEARCH_PROVIDER_PRESET.type,
          baseUrl,
          apiKey
        },
        SEARCH_TEST_QUERY
      ),
    {
      ok: (outcome) => {
        setBusy(false);
        // 200 但 0 条是失败态（空结果不能假装连通成功）
        if (!outcome.results.length) {
          showStatus("未返回结果", true);
          return;
        }
        showStatus(`连接成功 · ${outcome.results.length} 条结果`);
      },
      fail: (error) => {
        setBusy(false);
        const failure = classifySearchFailure(error);
        if (failure === "quota") {
          showStatus("额度已用尽", true);
          return;
        }
        if (failure === "auth") {
          showStatus("Key 无效或无权限", true);
          return;
        }
        showStatus(`连接失败：${(error as Error)?.message || "未知错误"}`, true);
      }
    }
  );
}

// ===== 模板 =====

export function editorTitle(kind: ProviderEditorKind, editing: boolean): string {
  const label = PROVIDER_FAMILY_ROWS[kind].editor.title;
  return editing ? `编辑${label}` : `添加${label}`;
}
// 初稿（候选 4 片 3）：打开时把编辑对象/预设默认推导成 draft——模板与联动只
// 认 draft，DOM 是它的投影。协议口径：编辑按记录值（存量缺字段/未知值显示
// 「OpenAI」，不得跟随预设默认漂移）；新增才回落预设默认归属（拍板
// 05-ui-protocol-selector）。名称沿用拍板 Q7：AI 值留空 + 占位（≠预设名才回填），
// ASR/搜索是实值语义
function buildInitialDraft(options: ProviderEditorOpenOptions): EditorDraft {
  const item = options.item || null;
  const family = PROVIDER_FAMILY_ROWS[options.kind];
  // 新增默认按族取 defaultPresetId（AI custom / ASR 硅基流动 / 搜索 tavily）；
  // 编辑按列表项 presetId（未知值由 resolvePreset 回落，AI 回落最后一个预设）
  const presetId = String(item?.presetId || family.editor.defaultPresetId(options.presets));
  const preset = family.resolvePreset(options.presets, presetId);
  const isAi = options.kind === "ai";
  const protocol = normalizeProtocolValue(item ? item.protocol : presetProtocol(preset));
  const presetName = preset?.name || "";
  const rawName = String(item?.name || "");
  return {
    presetId,
    name: isAi ? (rawName && rawName !== presetName ? rawName : "") : rawName || presetName,
    // 无存量 baseUrl 时按协议取预设端点（DeepSeek 预设默认 Anthropic，新建即填
    // /anthropic；其余预设未登记 protocolBaseUrls，回落 preset.baseUrl）
    baseUrl: String(item?.baseUrl ?? (isAi ? presetBaseUrlForProtocol(preset, protocol) : preset?.baseUrl) ?? ""),
    apiKey: "",
    protocol: isAi ? protocol : "",
    // AI 模型目录：编辑预填全部模型行（阶段2）；ASR 单模型回落预设
    models: isAi && Array.isArray(item?.models) ? item.models.map(String) : [],
    model: isAi ? "" : String(item?.model ?? preset?.model ?? "")
  };
}

export function buildDialogHtml(options: ProviderEditorOpenOptions): string {
  const item = options.item || null;
  // 模板是 draft 的投影：字段片段一律来自投影片（字段的 DOM 形态与目标态规则
  // 各一份），本函数只做布局拼装（哪个 kind 出哪些块）
  const draft = state.draft;
  if (!draft) return "";
  const blocks = projectionBlocks(draft, {
    kind: options.kind,
    presets: options.presets,
    hasSavedKey: Boolean(item?.hasSavedKey)
  });
  const isAi = options.kind === "ai";
  const isSearch = options.kind === "search";
  const models = draft.models;
  const title = editorTitle(options.kind, Boolean(item?.id));

  return `
    <div class="provider-editor-mask" data-provider-editor-action="close"></div>
    <section class="provider-editor-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}" tabindex="-1">
      <header class="provider-editor-head">
        <span class="provider-editor-title">${escapeHtml(title)}</span>
        ${item?.id && options.onDelete ? `<button type="button" class="provider-editor-delete" data-provider-editor-action="delete" title="删除该平台">删除</button>` : ""}
      </header>
      <div class="provider-editor-body">
        ${blocks.preset}
        ${isAi ? `\n        ${blocks.protocol}` : ""}
        ${blocks.name}
        ${blocks.baseUrl}
        ${blocks.apiKey}
        ${isAi
          ? `
        <div class="provider-editor-field provider-editor-catalog">
          <div class="provider-editor-catalog-head">
            <label class="provider-editor-label">模型</label>
            <button type="button" class="provider-editor-fetch" data-provider-editor-action="fetch-models">获取可用模型</button>
          </div>
          <div class="provider-editor-model-list">
            ${models.map((m) => modelRowHtml(m)).join("")}
          </div>
          ${blocks.catalogEmpty}
          <p class="provider-editor-catalog-error" hidden></p>
          <button type="button" class="provider-editor-model-add" data-provider-editor-action="add-model">+ 添加模型</button>
        </div>
        <p class="provider-editor-status" hidden></p>
        ${blocks.protocolNotes}`
          : isSearch
            ? `
        <div class="provider-editor-testrow">
          <button type="button" class="provider-editor-test" data-provider-editor-action="test" title="会真实发起一次搜索，占用一次平台额度">测试</button>
          <p class="provider-editor-status" hidden></p>
        </div>`
            : `
        ${blocks.model}
        <div class="provider-editor-testrow">
          <button type="button" class="provider-editor-test" data-provider-editor-action="test">测试</button>
          <p class="provider-editor-status" hidden></p>
        </div>`}
      </div>
      <footer class="provider-editor-foot">
        <button type="button" class="provider-editor-cancel" data-provider-editor-action="close">取消</button>
        <button type="button" class="provider-editor-save" data-provider-editor-action="save">保存</button>
      </footer>
    </section>
  `;
}

// ===== 挂载与全局监听 =====

// 挂载宿主：#biliscript-reading-view 直下（面板内弹层的最大合理范围，不在设置抽屉
// 滚动容器内——mask 不随内容滚动）。阅读视图重建时宿主随根节点一起消失，
// open 入口的幂等重置兜底状态残留。
export function ensureHost(): HTMLElement | null {
  const view = document.getElementById(ids.readingView);
  if (!view) {
    return null;
  }
  const host = document.createElement("div");
  host.className = "provider-editor-host";
  view.appendChild(host);
  return host;
}

// 面板外点击（capture 阶段拦截）：只关 Modal 不关抽屉——ui-renderer 的抽屉
// 外点关闭是 document bubble 委托，capture 阶段 stopPropagation 后不再触发
//（一次点击只关一层）。面板内点击（含遮罩）正常冒泡：settings-panel 的
// 文档级委托照常收起 Modal 内的模型下拉。
export function onDocumentClickCapture(event: MouseEvent): void {
  if (!state.open) return;
  // 确认弹层（删除二次确认）叠在本 Modal 之上时整体让位：同一批事件由
  // confirm-dialog 的 capture 监听承接，避免一次外点/Esc 把两层一起关掉
  if (isConfirmDialogOpen()) return;
  const view = document.getElementById(ids.readingView);
  if (view && event.target instanceof Node && view.contains(event.target)) {
    return;
  }
  event.stopPropagation();
  requestClose();
}

export function onDocumentKeyDownCapture(event: KeyboardEvent): void {
  if (!state.open || event.key !== "Escape") return;
  // 确认弹层打开期间让位（同 onDocumentClickCapture）：Esc 逐层退出，先关确认
  if (isConfirmDialogOpen()) return;
  event.stopPropagation();
  // 弹窗开着先关弹窗（拍板 Q5：Esc 逐层退出），否则关编辑器
  if (getFetchDialog()) {
    closeFetchDialog();
    return;
  }
  requestClose();
}

// ===== 接线 =====

// 接线只认状态袋（会话控制字段的唯一写入点在状态片）：字段 DOM 形态来自投影片，
// 联动处理器只改 draft 再 renderProjection。模板已渲染、会话已就位时才有效。
export function wireDialog(): void {
  const dialog = getDialog();
  const host = state.host;
  if (!dialog || !host) return;
  const family = PROVIDER_FAMILY_ROWS[state.kind];

  // 委托挂 host（mask 与 dialog 的共同父级）：遮罩是 dialog 的兄弟，挂 dialog
  // 上收不到遮罩点击（explain-card 同款：委托在容器上）。
  // 无条件 stopPropagation：Modal 宿主挂 #biliscript-reading-view 直下，在设置抽屉
  // （settingsPanel）之外——点击外传会被 ui-renderer 的抽屉外点关闭委托（判定
  // 域 settingsPanel+齿轮，document bubble）当成外点把抽屉一起收掉，随即触发
  // hidden 联动的强制关闭，保存/关闭动作被吞（一次点击只关一层）。下拉的外点
  // 收起语义（常态由 settings-panel 的文档级委托负责）在此自持。
  host.addEventListener("click", (event) => {
    event.stopPropagation();
    const target = event.target as HTMLElement;
    // 点在下拉组件（模型 picker / ASR 自定义预设）之外才收起——组件的
    // toggle/trigger/option 自带开关逻辑，点在组件内不干扰
    if (!target.closest(".ai-provider-model-wrapper") && !target.closest(".custom-select-wrapper")) {
      host.querySelectorAll<HTMLElement>(".ai-provider-model-dropdown").forEach((d) => (d.hidden = true));
      closeAllCustomSelects();
    }
    // 全部动作走这一条委托（按钮直连绑定曾在真实页面失效，close 是
    // 用户验证过的同源路径）；异常兜底在各 handler 内部落状态行
    const action = target.closest<HTMLElement>("[data-provider-editor-action]")?.dataset.providerEditorAction;
    if (action === "close") requestClose();
    else if (action === "save") void save();
    else if (action === "test") void runTest();
    else if (action === "delete") void deleteActive();
    else if (action === "add-model") addModelRow();
    else if (action === "remove-model") removeModelRow(target.closest<HTMLElement>(".provider-editor-model-row"));
    else if (action === "test-model") void runModelTest(target.closest<HTMLElement>(".provider-editor-model-row"), isDirty());
    else if (action === "fetch-models") void openFetchDialog();
    else if (action === "close-fetch") closeFetchDialog();
    else if (action === "confirm-fetch") confirmFetchSelection();
    else if (action === "retry-fetch") void openFetchDialog();
    // 「获取可用模型」弹窗内勾选：全选点击把目录外可选项整体勾/去勾（jsdom
    // 与浏览器都先完成 checkbox 自身切换，再进此委托），随后同步三态与计数
    if (target.closest(".provider-editor-fetch-dialog")) {
      const all = target.closest<HTMLInputElement>(".provider-editor-fetch-all");
      if (all) {
        getFetchDialog()
          ?.querySelectorAll<HTMLInputElement>(".provider-editor-fetch-check:not(:disabled)")
          .forEach((check) => {
            check.checked = all.checked;
          });
      }
      syncFetchSelectionState();
    }
  });

  const presetSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset");

  // 原生约束（reader-settings-providers.css 的 :user-invalid/:user-valid 校验态消费）
  // 由字段投影负责：Key 的 required 随 isKeyRequired / 已存 Key 态、ASR 模型名的
  // required 都在投影片的字段表内挂摘（与占位符同源，模板与联动同一份规则）。

  // 预设切换（候选 4 片 3：改 draft 后重投影）：baseUrl 未改过（空或仍是上一
  // 预设默认值）才跟随（平铺行同款规则）。AI 名称留过实值（≠当前预设名）视为
  // 用户自定义，切预设不覆盖；否则跟随新预设名（仅占位符与空值）。ASR 名称/
  // 模型无条件跟随、Key 清空（平铺行同款）。不代申请权限——Modal 的 host 权限
  // 在保存时统一收口（拍板 Q5 推论）。DOM 写入一律经 renderProjection。
  presetSelect?.addEventListener("change", () => {
    const next = family.resolvePreset(state.presets, presetSelect.value);
    const draft = state.draft;
    if (!next || !draft) return;
    const previous = family.resolvePreset(state.presets, draft.presetId);
    const currentBaseUrl = draft.baseUrl.trim();
    editDraft((current) => {
      current.presetId = next.id;
      if (state.kind === "ai") {
        // 协议先联动（拍板 05-ui-protocol-selector）：当前值仍是上一预设默认值
        //（或空）才跟随新预设；用户改过的选择不覆盖。随后 baseUrl 按「上一预设 +
        // 当时协议」的端点判是否未改过——两处联动共用一条判据，否则 DeepSeek 这类
        // 默认 Anthropic 的预设会把 /v1 当成用户手改值
        if (!current.protocol || current.protocol === presetProtocol(previous)) {
          current.protocol = presetProtocol(next);
        }
        const previousBaseUrl = previous ? presetBaseUrlForProtocol(previous, current.protocol) : "";
        if (!currentBaseUrl || currentBaseUrl === previousBaseUrl) {
          current.baseUrl = presetBaseUrlForProtocol(next, current.protocol);
        }
        const currentName = current.name.trim();
        if (!currentName || (previous && currentName === previous.name)) {
          current.name = "";
        }
      } else {
        if (!currentBaseUrl || (previous && currentBaseUrl === String(previous.baseUrl || ""))) {
          current.baseUrl = next.baseUrl || "";
        }
        // ASR 名称/模型无条件跟随、Key 清空（平铺行同款）；搜索平台同款语义，
        // 只是无模型字段可跟
        if (state.kind === "asr") {
          current.model = next.model || "";
        }
        current.name = next.name || "";
        current.apiKey = "";
      }
    });
    // 一次重投影覆盖全部字段：协议 trigger 显示 / Key 占位与 required / 名称
    // 占位 / baseUrl / 模型，不再逐字段手写
    renderProjection();
    clearStatus();
    // 元数据跟着平台身份走（presetId 变了、baseUrl 可能被联动改掉）
    refreshModelCatalogMeta();
  });
  if (presetSelect) {
    // AI / ASR 一律接管（ADR-0007）：原生 select 的弹层由浏览器绘制，圆角与
    // 高亮都是系统外观，与 Modal 内其余 8px 框/12px 弹层割裂。
    initCustomSelect(presetSelect, "custom-select-wrapper provider-editor-preset-wrapper");
  }

  // 协议下拉（multi-protocol-ai，仅 AI）：切协议即重投影（限制点小字 + trigger
  // 显示 + baseUrl 联动）。baseUrl 联动（拍板同预设切换惯例）：当前值仍是上一
  // 协议在该预设下的默认端点（或空）才跟随新协议的默认端点；用户手改过不覆盖
  //（同 baseUrl 切协议的代理平台用例不受影响——前后端点相同，跟随是 no-op）
  const protocolSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-protocol");
  if (protocolSelect) {
    initCustomSelect(protocolSelect, "custom-select-wrapper provider-editor-protocol-wrapper");
    protocolSelect.addEventListener("change", () => {
      const draft = state.draft;
      if (!draft) return;
      if (state.kind === "ai") {
        const previous = normalizeProtocolValue(draft.protocol);
        const next = normalizeProtocolValue(protocolSelect.value);
        editDraft((current) => {
          current.protocol = next;
          const preset = family.resolvePreset(state.presets, current.presetId);
          const currentBaseUrl = current.baseUrl.trim();
          if (preset && (!currentBaseUrl || currentBaseUrl === presetBaseUrlForProtocol(preset, previous))) {
            current.baseUrl = presetBaseUrlForProtocol(preset, next);
          }
        });
      }
      renderProjection();
      // 切协议可能联动改 baseUrl（protocolBaseUrls 端点），元数据跟着重算
      refreshModelCatalogMeta();
    });
  }

  // 输入即写 draft（候选 4 片 3：draft 是真源，input 事件是文本字段的唯一写
  // 通道）并清错误状态行（修正输入即清错）；字段级校验态由 :user-invalid CSS
  // 随原生约束自动摘除，无需 JS 介入。选择器、draft 键与「是否清错」都由投影片
  // 的字段表声明（DRAFT_INPUTS），这里只做一次统一接线。
  // ASR 单模型输入只回写 draft（状态行由 model-picker 自持）；其下拉选值已在
  // model-picker 内补派 input 事件。
  for (const field of DRAFT_INPUTS) {
    const input = dialog.querySelector<HTMLInputElement>(field.selector);
    input?.addEventListener("input", () => {
      editDraft((draft) => {
        draft[field.key] = input.value;
      });
      if (field.clearStatus && statusIsError()) {
        clearStatus();
      }
    });
  }
  // AI 目录行：行动态增删，输入事件按当前行序整列回写 draft.models（行 DOM
  // 就是 draft.models 的投影，一一对应）
  dialog.querySelector<HTMLElement>(".provider-editor-model-list")?.addEventListener("input", (event) => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains("provider-editor-model-id")) return;
    const list = target.closest<HTMLElement>(".provider-editor-model-list");
    if (!list) return;
    editDraft((draft) => {
      draft.models = Array.from(list.querySelectorAll<HTMLInputElement>(".provider-editor-model-id")).map(
        (input) => input.value
      );
    });
  });

  // 只读模型元数据（model-catalog/04）：改 API 地址（custom/未知预设的身份来源）
  // 或改模型 ID 都要重算；目录行是动态增删的，用委托收 input
  dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")?.addEventListener("input", () => refreshModelCatalogMeta());
  dialog
    .querySelector<HTMLElement>(".provider-editor-model-list")
    ?.addEventListener("input", () => refreshModelCatalogMeta());

  // 可达性桥（accessible-error-announcement）：:user-invalid（视觉态）与
  // aria-invalid（程序态）同拍——浏览器判定进入/退出 :user-invalid 的时刻
  //（blur 提交值 / input 修正值）同步属性，AT 与视觉在同一时刻拿到「无效」。
  // blur 不冒泡走 capture；jsdom 无 :user-invalid 判定（matches 恒 false），
  // 正向路径无法在测试网仿真，浏览器（Chrome 119+，Baseline 2023-11）按标准工作。
  const syncAriaInvalid = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.matches("input, textarea, select")) {
      return;
    }
    try {
      if (target.matches(":user-invalid")) {
        target.setAttribute("aria-invalid", "true");
      } else {
        target.removeAttribute("aria-invalid");
      }
    } catch {
      // 老内核不识别 :user-invalid（matches 抛 SyntaxError）：属性面保持不动
    }
  };
  dialog.addEventListener("blur", syncAriaInvalid, true);
  dialog.addEventListener("input", syncAriaInvalid);

  // ASR 侧模型下拉接线（AI 目录无下拉，「获取可用模型」弹窗另行委托）；
  // 直调 provider-models（与平铺行一致）
  if (state.kind === "asr") {
    wireModelPicker(dialog as unknown as ProviderRowElement, {
      inputClass: "provider-editor-model",
      baseUrlClass: "provider-editor-baseurl",
      apiKeyClass: "provider-editor-apikey",
      statusClass: "provider-editor-status",
      showStatus: (_node, text, isError) => showStatus(text, isError),
      fetchModels: ({ baseUrl, apiKey, providerId }) => listAsrModels({ baseUrl, apiKey, providerId })
    });
  }

  dialog.focus({ preventScroll: true });
}

export function openProviderEditor(options: ProviderEditorOpenOptions): void {
  // 幂等重置：重复打开（编辑 A 中改开 B）先作废旧 Modal 的在飞回执与监听
  closeProviderEditor(true);
  const host = ensureHost();
  if (!host) {
    return;
  }
  // 会话控制字段的唯一写入点（状态片原语）：draft 真源与 dirty 基线先就位，
  // 模板渲染（buildDialogHtml）只是它的投影
  beginEditorSession({
    kind: options.kind,
    host,
    presets: options.presets,
    onSave: options.onSave,
    onDelete: options.onDelete || null,
    editingId: String(options.item?.id || ""),
    openBaseUrl: String(options.item?.baseUrl || ""),
    hasSavedKey: Boolean(options.item?.hasSavedKey),
    draft: buildInitialDraft(options)
  });
  host.innerHTML = buildDialogHtml(options);
  // 投影水合：模板已按同一份字段表渲染，这里再走一遍 apply，把「投影规则」
  //（含 required 挂摘、Key 占位符等）统一落到 DOM，随后联动只调 renderProjection
  renderProjection();
  wireDialog();
  document.addEventListener("click", onDocumentClickCapture, true);
  document.addEventListener("keydown", onDocumentKeyDownCapture, true);
  // 设置抽屉收起时强制关闭（含 dirty 改动）：抽屉被外点/齿轮收起时用户意图是
  // 关掉一切，confirm 无意义。自治监听 hidden 属性变化，零跨模块状态。
  observeSettingsPanelHidden(() => closeProviderEditor(true), sessionObserver);
  // 只读模型元数据（model-catalog/04）：只有目录族的 Modal 用得上，打开后才动态
  // import 目录 chunk（85KB），首屏不为它买单；加载完补齐已渲染的目录行与拉取弹窗
  if (PROVIDER_FAMILY_ROWS[options.kind].editor.modelSource === "catalog") {
    void primeModelCatalogMeta();
  }
}

export function isProviderEditorOpen(): boolean {
  return state.open;
}
