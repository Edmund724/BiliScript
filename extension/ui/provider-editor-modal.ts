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
//   provider-editor-fetch-dialog ← 「获取可用模型」内联子视图（票 09 起，无第二张遮罩）
//   provider-editor-modal（本文件）→ 以上各片
//   provider-editor.ts → 本文件（对外导出壳，导入路径零变化）
//
// 动作三件（保存 / 删除 / 测试连接）随接线留在本片：它们读写状态袋并关闭
// Modal，与接线同属一条点击链；三个动作的过期回执判据一律走状态片的结算原语
//（runIfCurrent / captureSession），不再手抄代际比对。

import { escapeHtml } from "../shared/string-utils.js";

import { testAsrConnection } from "../asr/provider-test.js";
import { listAsrModels } from "../asr/provider-models.js";
import { listLiveModels, listLiveVoices, testLiveConnection } from "../live/live-provider-probe.js";
import { SEARCH_TEST_QUERY, testSearchConnection } from "../search/provider-test.js";

import { wireModelPicker, type ModelPickerFetchResult } from "./model-picker.js";
import { initCustomSelect } from "./custom-select.js";
import { initToggleSwitch } from "./toggle-switch.js";
import { confirmDialog, isConfirmDialogOpen } from "./confirm-dialog.js";
import { ids } from "../reader/state.js";
import { hasReaderSettingsDropdownOpen } from "../reader/settings-mode.js";
import type { ProviderRowElement, ProviderRowItem } from "./provider-row.js";
import { PROVIDER_FAMILY_ROWS } from "./provider-family.js";
import {
  beginEditorSession,
  applyEditorVoices,
  captureSession,
  cloneDraft,
  draftsEqual,
  editDraft,
  endEditorSession,
  getDialog,
  markEditorVoicesLoaded,
  normalizeDraftModels,
  runIfCurrent,
  state,
  type EditorDraft,
  type LinkedCredentialAction,
  type ProviderEditorKind,
  type ProviderEditorOpenOptions
} from "./provider-editor-state.js";
import {
  DRAFT_INPUTS,
  isSavedKeyReconfirmRequired,
  normalizeProtocolValue,
  presetBaseUrlForProtocol,
  presetProtocol,
  projectionBlocks,
  renderProjection,
  sessionProjectionContext
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
  openFetchDialog
} from "./provider-editor-fetch-dialog.js";
import {
  createFocusScope,
  isolateHostSiblings,
  observeSettingsPanelHidden,
  type FocusScope
} from "./focus-scope.js";
import {
  beginEditorValidation,
  focusEditorField,
  isEditorValidationAttempted,
  revalidateEditorField,
  renderEditorFieldIssues,
  resetEditorValidation,
  validateEditorFields
} from "./provider-editor-validation.js";

export { SEARCH_TEST_QUERY };

// 平台级探针与模型枚举动作表（覆盖 ASR / Live / Search）：纯声明留在 provider-family.ts，
// 带网络/port 副作用的探针与模型枚举留在本懒加载片。
interface PlatformProbeIo {
  readonly preflightOrigin: boolean;
  readonly fetchModels?: (params: {
    baseUrl: string;
    apiKey?: string;
    providerId?: string;
    type?: string;
  }) => Promise<ModelPickerFetchResult | null>;
  readonly probePlatform: (params: {
    id: string;
    presetId: string;
    name: string;
    type: string;
    baseUrl: string;
    model: string;
    apiKey?: string;
    requiresKey: boolean;
  }) => Promise<{ ok?: boolean; message?: string; error?: string }>;
  readonly formatFailure: (error?: string) => string;
}

const PLATFORM_PROBE_IO: Partial<Record<ProviderEditorKind, PlatformProbeIo>> = {
  asr: {
    preflightOrigin: true,
    fetchModels: listAsrModels,
    probePlatform: ({ id, name, type, baseUrl, model, apiKey }) =>
      testAsrConnection({
        id,
        name,
        type: type || "openai-transcriptions",
        baseUrl,
        model,
        ...(apiKey ? { apiKey } : {})
      }),
    formatFailure: (error) => `失败：${error || "未知错误"}`
  },
  live: {
    preflightOrigin: true,
    fetchModels: listLiveModels,
    probePlatform: ({ id, presetId, name, type, baseUrl, model, apiKey }) =>
      testLiveConnection({
        id,
        presetId,
        name,
        type: type || "moss-live",
        baseUrl,
        model,
        ...(apiKey ? { apiKey } : {})
      }),
    formatFailure: (error) => `失败：${error || "未知错误"}`
  },
  search: {
    preflightOrigin: false,
    probePlatform: ({ id, presetId, type, baseUrl, apiKey, requiresKey }) =>
      testSearchConnection({
        id,
        presetId,
        type,
        baseUrl,
        apiKey,
        requiresKey
      }),
    formatFailure: (error) => error || "连接失败：未知错误"
  }
};

// 本层焦点约束（打开时捕获触发控件，关闭/取消归还；确认框/拉取子视图打开期间让位）
let focusScope: FocusScope | null = null;
// 宿主下同级容器 inert 恢复函数（关闭 Modal 时恢复底层）
let restoreSiblings: (() => void) | null = null;
// 设置抽屉 hidden 属性观察清理函数
let stopObservingSettingsHidden: (() => void) | null = null;
// 合法提交/删除/测试在飞标记（彼此互斥，防止保存/删除/测试并发）
let saveInFlight = false;
let deleteInFlight = false;
let testInFlight = false;
// 状态行当前是否在展示字段校验汇总：输入修正时据此只更新/清掉已解决的校验错误
let validationStatusActive = false;
// 状态行当前是否在展示「换预设/换地址需重新确认 Key」提示
let reconfirmStatusActive = false;

function currentLinkedCredential(draft = state.draft): LinkedCredentialAction | null {
  if (state.resolveLinkedCredential && draft) {
    return state.resolveLinkedCredential(draft);
  }
  return state.linkedCredential;
}

function linkedCredentialInnerHtml(linkedCredential: LinkedCredentialAction | null): string {
  if (!linkedCredential) return "";
  return `<span class="provider-editor-linked-credential-text">${escapeHtml(linkedCredential.statusText || "")}</span>${
    linkedCredential.actionLabel
      ? `\n          <button type="button" class="provider-editor-linked-credential-btn" data-provider-editor-action="linked-credential">${escapeHtml(linkedCredential.actionLabel)}</button>`
      : ""
  }`;
}

function syncLinkedCredentialDom(): void {
  const container = getDialog()?.querySelector<HTMLElement>(".provider-editor-linked-credential");
  if (!container) return;
  const linked = currentLinkedCredential();
  if (!linked) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }
  container.hidden = false;
  container.innerHTML = linkedCredentialInnerHtml(linked);
}

// ===== 音色列表（MOSS-LIVE 编辑器下拉）=====
// 只在打开 Modal 时取一次（失败也记为已尝试），选项来自 /v1/audio/voices 分页
// 全量；凭证与模型列表同源（草稿 Key 优先，其次该 provider 的已存 Key）。
function isMossLivePreset(preset: { id?: string; type?: string } | null | undefined): boolean {
  return preset?.type === "moss-live" || preset?.id === "moss-live";
}

function primeEditorVoices(): void {
  if (state.kind !== "live" || state.voicesLoaded) return;
  const draft = state.draft;
  if (!draft) return;
  const preset = PROVIDER_FAMILY_ROWS.live.resolvePreset(state.presets, draft.presetId);
  if (!isMossLivePreset(preset)) return;
  const baseUrl = draft.baseUrl.trim();
  const apiKey = draft.apiKey.trim();
  const reconfirmKey = isSavedKeyReconfirmRequired(draft);
  // 新增平台尚未填 Key（或已换平台/地址待重新确认）时无从鉴权：下拉只留「默认音色」，不发起请求
  if (!baseUrl || (!apiKey && (!state.hasSavedKey || reconfirmKey))) return;
  void runIfCurrent(
    () => listLiveVoices({ baseUrl, apiKey, providerId: reconfirmKey ? "" : state.editingId }),
    {
      ok: (result) => {
        if (!result.ok) {
          markEditorVoicesLoaded();
          return;
        }
        applyEditorVoices(result.voices);
        renderProjection();
      },
      fail: () => {
        markEditorVoicesLoaded();
      }
    }
  );
}

// 状态行写入口（ASR 平台级测试 / 测试模型下拉与保存共用；错误态着色走
// data-error，与平铺行 .ai-provider-status 的 CSS 契约同款）
export function showStatus(text: string, isError = false): void {
  validationStatusActive = false;
  reconfirmStatusActive = false;
  const statusNode = getDialog()?.querySelector<HTMLElement>(".provider-editor-status");
  if (!statusNode) return;
  statusNode.hidden = false;
  statusNode.textContent = text;
  statusNode.dataset.error = isError ? "true" : "false";
}

// 字段校验汇总：与普通状态行共用节点，但标记来源以便输入修正时只更新这份汇总。
function showValidationStatus(text: string): void {
  showStatus(text, true);
  validationStatusActive = true;
}

function showReconfirmStatus(): void {
  showStatus("已切换平台或地址，请重新确认 API Key", true);
  reconfirmStatusActive = true;
}

function syncReconfirmFeedback(): void {
  const draft = state.draft;
  if (!draft) return;
  const preset = PROVIDER_FAMILY_ROWS[state.kind].resolvePreset(state.presets, draft.presetId);
  const needsReconfirm = isSavedKeyReconfirmRequired(draft) && PROVIDER_FAMILY_ROWS[state.kind].editor.isKeyRequired(preset);
  if (isEditorValidationAttempted()) {
    return;
  }
  if (needsReconfirm) {
    showReconfirmStatus();
  } else if (reconfirmStatusActive) {
    clearStatus();
  }
}

// 校验态下输入修正后重算汇总行：只剩已解决错误时清空，仍有未解决项时换成首个。
function syncValidationStatus(): void {
  if (!validationStatusActive) return;
  const issues = validateEditorFields();
  if (issues.length > 0) {
    showValidationStatus(issues[0].message);
    return;
  }
  clearStatus();
}

// 预设 / 协议切换等联动改了 required 或联动值：校验态下重算全部字段与汇总行。
function applyValidationState(): void {
  if (!isEditorValidationAttempted()) return;
  const issues = validateEditorFields();
  renderEditorFieldIssues(issues);
  if (issues.length > 0) {
    showValidationStatus(issues[0].message);
    return;
  }
  clearStatus();
}

export function clearStatus(): void {
  validationStatusActive = false;
  reconfirmStatusActive = false;
  const statusNode = getDialog()?.querySelector<HTMLElement>(".provider-editor-status");
  if (!statusNode) return;
  statusNode.hidden = true;
  statusNode.textContent = "";
  statusNode.dataset.error = "false";
}

const BUSY_CONTROL_SELECTOR = [
  ".provider-editor-test",
  ".provider-editor-save",
  ".provider-editor-delete",
  ".provider-editor-linked-credential-btn",
  ".provider-editor-fetch",
  ".provider-editor-model-add",
  ".provider-editor-model-remove",
  ".provider-editor-model-test",
  ".ai-provider-model-toggle",
  ".custom-select-trigger",
  ".provider-editor-preset",
  ".provider-editor-protocol",
  ".provider-editor-name",
  ".provider-editor-baseurl",
  ".provider-editor-apikey",
  ".provider-editor-model",
  ".provider-editor-model-id",
  ".provider-editor-voice",
  ".provider-editor-gemini-search"
].join(", ");

export function setBusy(isBusy: boolean): void {
  getDialog()
    ?.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(BUSY_CONTROL_SELECTOR)
    .forEach((control) => {
      control.disabled = isBusy;
    });
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
  stopObservingSettingsHidden?.();
  stopObservingSettingsHidden = null;
  document.removeEventListener("click", onDocumentClickCapture, true);
  document.removeEventListener("keydown", onDocumentKeyDownCapture, true);
  // 若拉取子视图仍挂在弹窗内，先清理其焦点约束与底层 inert 标记（不向触发按钮归还焦点）
  closeFetchDialog(false);
  // 先解除宿主外同级容器的 inert，再归还焦点给仍有效的触发控件
  restoreSiblings?.();
  restoreSiblings = null;
  focusScope?.dispose();
  focusScope = null;
  saveInFlight = false;
  deleteInFlight = false;
  testInFlight = false;
  validationStatusActive = false;
  reconfirmStatusActive = false;
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
    title: "放弃更改",
    message: "未保存的更改将丢失，确定关闭？",
    confirmText: "放弃更改",
    danger: true,
    mountHost: state.host?.parentElement || undefined
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
  const reconfirmKey = isSavedKeyReconfirmRequired(draft);
  return family.editor.serializeUpsert({
    id: state.editingId,
    preset,
    name: draft.name.trim() || preset?.name || "自定义",
    baseUrl: draft.baseUrl.trim().replace(/\/+$/, ""),
    apiKey: draft.apiKey.trim(),
    hasSavedKey: state.hasSavedKey && !reconfirmKey,
    models: normalizeDraftModels(draft.models),
    model: draft.model.trim(),
    liveGeminiNativeSearch: draft.liveGeminiNativeSearch === true,
    voiceId: String(draft.voiceId || "").trim(),
    // 协议显式落盘（multi-protocol-ai）：存量记录编辑保存即写入显式值
    protocol: normalizeProtocolValue(draft.protocol)
  });
}

export async function save(): Promise<void> {
  // 合法提交/删除/测试在飞或确认框打开时忽略重复提交：一次提交只落盘一次
  if (saveInFlight || deleteInFlight || testInFlight || isConfirmDialogOpen()) return;
  // 提交时才进入校验态（保留交互后校验）：首配缺模型、URL、Key 与单模型字段
  // 全部定位到具体控件并聚焦首个无效字段
  beginEditorValidation();
  const issues = validateEditorFields();
  renderEditorFieldIssues(issues);
  if (issues.length > 0) {
    showValidationStatus(issues[0].message);
    focusEditorField(issues[0].field);
    return;
  }
  const { upsert, validationError } = collectUpsert();
  if (validationError) {
    showStatus(validationError, true);
    return;
  }
  saveInFlight = true;
  setBusy(true);
  showStatus("正在保存...");
  // 会话结算（owner 2）：落盘回执落定时 Modal 已关/已重开即静默丢弃，否则
  // 成功关 Modal / 失败复位 busy 并写状态行——动作只写这两支。
  await runIfCurrent(
    () => state.onSave(state.kind, upsert),
    {
      ok: (result) => {
        if (result.ok) {
          // 首配续跑：先通知装配方（消费意图/退出设置），再关 Modal——
          // 装配方回调里关设置会强制关闭本 Modal，随后的 close 幂等收空。
          const afterSave = state.onAfterSave;
          if (afterSave) {
            try {
              afterSave();
            } catch {
              // 装配方回调异常不得阻断保存收场
            }
          }
          closeProviderEditor(true);
          return;
        }
        saveInFlight = false;
        setBusy(false);
        showStatus(
          result.permissionDenied
            ? `未保存：${result.error || "未取得该平台域名权限，保存已中止"}。请重新授权后重试`
            : result.error || "保存失败",
          true
        );
      },
      // void save() 会吞 rejection——任何异常都必须落到状态行，不允许无反馈
      fail: (error) => {
        saveInFlight = false;
        setBusy(false);
        showStatus(`保存失败：${(error as Error).message || "未知错误"}`, true);
      }
    }
  );
}

// ===== 删除（编辑态，Modal 头部警示按钮；回收权限/删除消息/重渲在 onDelete） =====

export async function deleteActive(): Promise<void> {
  if (saveInFlight || deleteInFlight || testInFlight || isConfirmDialogOpen()) return;
  const onDelete = state.onDelete;
  if (!state.editingId || !onDelete) return;
  const session = captureSession();
  // 面板内二次确认（ui/confirm-dialog.js）：原生 confirm 绘制在浏览器窗口中央，
  // 面板停靠右侧时可能看不到；确认期间编辑器的文档级监听与宿主整体让位
  const confirmed = await confirmDialog({
    title: "删除平台",
    message: "确定要删除这个平台吗？删除后需要重新配置。",
    confirmText: "删除",
    danger: true,
    mountHost: state.host?.parentElement || undefined
  });
  if (!confirmed || !session.isCurrent() || saveInFlight || deleteInFlight || testInFlight) {
    return;
  }
  deleteInFlight = true;
  setBusy(true);
  showStatus("正在删除...");
  await session.run(
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
        deleteInFlight = false;
        setBusy(false);
        showStatus(result.error || "删除失败", true);
      },
      fail: (error) => {
        deleteInFlight = false;
        setBusy(false);
        showStatus(`删除失败：${(error as Error).message || "未知错误"}`, true);
      }
    }
  );
}

// ===== 测试连接（只验证连通性，成功也不落盘；保存只在点「保存」时发生） =====
//
// AI 走目录行级测试；本函数处理保留平台级探针的族（ASR / Live / Search）。
// 需动态权限的族（ASR / Live）从函数入口到 runWithOriginPreflight 之间保持零 await，
// 以确保权限弹窗在点击手势同步链上发起；静态权限族（Search）直接走 session.run。

export async function runTest(): Promise<void> {
  if (saveInFlight || deleteInFlight || testInFlight || isConfirmDialogOpen()) return;
  const family = PROVIDER_FAMILY_ROWS[state.kind];
  const probeIo = PLATFORM_PROBE_IO[state.kind];
  const draft = state.draft;
  if (!family.editor.supportsPlatformTest || !probeIo || !draft) return;
  const baseUrl = draft.baseUrl.trim();
  const model = draft.model.trim();
  if (!baseUrl) {
    showStatus("请填写 API 地址", true);
    return;
  }
  if (family.editor.modelSource === "input" && !model) {
    showStatus("请填写模型名", true);
    return;
  }
  const preset = family.resolvePreset(state.presets, draft.presetId);
  const apiKey = draft.apiKey.trim();
  const reconfirmKey = isSavedKeyReconfirmRequired(draft);
  const requiresKey = family.editor.isKeyRequired(preset);
  if (!apiKey && reconfirmKey && requiresKey) {
    showReconfirmStatus();
    return;
  }
  testInFlight = true;
  setBusy(true);
  showStatus("正在测试...");
  const session = captureSession();
  const probeParams = {
    id: reconfirmKey ? "" : state.editingId,
    presetId: draft.presetId,
    name: draft.name.trim() || preset?.name || "自定义",
    type: preset?.type || "",
    baseUrl,
    model,
    ...(apiKey ? { apiKey } : {}),
    requiresKey
  };
  const onOk = (resp: { ok?: boolean; message?: string; error?: string }): void => {
    testInFlight = false;
    setBusy(false);
    if (!resp?.ok) {
      showStatus(probeIo.formatFailure(resp?.error), true);
      return;
    }
    showStatus(resp.message || "连接成功");
  };
  const onFail = (error: unknown): void => {
    testInFlight = false;
    setBusy(false);
    showStatus(probeIo.formatFailure((error as Error)?.message), true);
  };
  if (probeIo.preflightOrigin) {
    await session.runWithOriginPreflight(
      family.editor.resolvePermissionOrigins(baseUrl, model),
      () => probeIo.probePlatform(probeParams),
      {
        denied: (error) => {
          testInFlight = false;
          setBusy(false);
          showStatus(
            `未测试：${error || "未取得该平台域名权限，无法测试连接"}。请重新授权后重试`,
            true
          );
        },
        ok: onOk,
        fail: onFail
      }
    );
    return;
  }
  await session.run(() => probeIo.probePlatform(probeParams), {
    ok: onOk,
    fail: onFail
  });
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
  const presetId = String(item?.presetId || options.presetId || family.editor.defaultPresetId(options.presets));
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
    model: isAi ? "" : String(item?.model ?? preset?.model ?? ""),
    liveGeminiNativeSearch: options.kind === "live" ? item?.liveGeminiNativeSearch === true : false,
    voiceId: options.kind === "live" ? String(item?.voiceId || "") : ""
  };
}

// 跨族凭据引用内联行（票 07/08）：消费族编辑器（伴看 Gemini Live / 搜索
// DeepSeek）内展示四态状态文案与同层进入 AI 族编辑器的动作。始终保留占位节点，
// 以便新建或切预设时由 syncLinkedCredentialDom() 实时显隐。
function linkedCredentialHtml(linkedCredential: LinkedCredentialAction | null): string {
  return `
        <div class="provider-editor-linked-credential"${linkedCredential ? "" : " hidden"}>
          ${linkedCredentialInnerHtml(linkedCredential)}
        </div>`;
}

export function buildDialogHtml(options: ProviderEditorOpenOptions): string {
  const item = options.item || null;
  // 模板是 draft 的投影：字段片段一律来自投影片（字段的 DOM 形态与目标态规则
  // 各一份），本函数只做布局拼装（哪个 kind 出哪些块）
  const draft = state.draft;
  if (!draft) return "";
  const blocks = projectionBlocks(draft, sessionProjectionContext());
  const isAi = options.kind === "ai";
  const isSearch = options.kind === "search";
  const models = draft.models;
  const title = editorTitle(options.kind, Boolean(item?.id));
  // 跨族凭据引用内联行（票 07/08，伴看 Gemini Live / 搜索 DeepSeek 编辑器）：
  // 优先动态回调，切预设或新建切到对应平台时即刻刷新
  const linkedCredential = currentLinkedCredential(draft);

  return `
    <div class="provider-editor-mask" data-provider-editor-action="close"></div>
    <section class="provider-editor-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}" tabindex="-1">
      <header class="provider-editor-head">
        <span class="provider-editor-title">${escapeHtml(title)}</span>
        ${item?.id && options.onDelete ? `<button type="button" class="provider-editor-delete" data-provider-editor-action="delete" title="删除该平台">删除</button>` : ""}
      </header>
      <form class="provider-editor-form" novalidate>
        <div class="provider-editor-body">
          <p class="provider-editor-context-banner"${state.setupContextBanner ? "" : " hidden"}>${escapeHtml(state.setupContextBanner || "")}</p>
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
          <p class="provider-editor-field-error" id="provider-editor-error-models" hidden></p>
        </div>
        ${blocks.protocolNotes}`
            : isSearch
              ? `
        ${linkedCredentialHtml(linkedCredential)}
        <div class="provider-editor-testrow">
          <button type="button" class="provider-editor-test" data-provider-editor-action="test" title="会真实发起一次搜索，占用一次平台额度" aria-describedby="provider-editor-test-hint">测试</button>
          <p class="provider-editor-test-hint" id="provider-editor-test-hint">会真实发起一次搜索，占用一次平台额度</p>
        </div>`
              : `
        ${blocks.model}
        ${blocks.voice}
        ${blocks.liveGeminiNativeSearch}
        ${linkedCredentialHtml(linkedCredential)}
        <div class="provider-editor-testrow">
          <button type="button" class="provider-editor-test" data-provider-editor-action="test">测试</button>
        </div>`}
        </div>
        <p class="provider-editor-status" role="status" aria-live="polite" hidden></p>
        <footer class="provider-editor-foot">
          <button type="button" class="provider-editor-cancel" data-provider-editor-action="close">${escapeHtml(options.cancelLabel?.trim() || "取消")}</button>
          <button type="submit" class="provider-editor-save" data-provider-editor-action="save">${escapeHtml(options.submitLabel?.trim() || "保存")}</button>
        </footer>
      </form>
    </section>
  `;
}

// ===== 挂载与全局监听 =====

// 默认挂在视频页阅读视图；直播间传入自己的 dialog 内宿主。
export function ensureHost(mountHost?: HTMLElement): HTMLElement | null {
  const view = mountHost || document.getElementById(ids.readingView);
  if (!view) {
    return null;
  }
  const host = document.createElement("div");
  host.className = "provider-editor-host";
  view.appendChild(host);
  return host;
}

// 编辑器只结算当前最上层：确认框或下拉展开时让位；自身处理外点时在 capture
// 阶段截断，设置与宿主的后续委托不会把同一次点击再结算一遍。
export function onDocumentClickCapture(event: MouseEvent): void {
  if (!state.open) return;
  if (isConfirmDialogOpen() || hasReaderSettingsDropdownOpen()) return;
  const view = state.host?.parentElement || document.getElementById(ids.readingView);
  if (view && event.target instanceof Node && view.contains(event.target)) {
    return;
  }
  event.stopPropagation();
  requestClose();
}

export function onDocumentKeyDownCapture(event: KeyboardEvent): void {
  if (!state.open || event.key !== "Escape") return;
  if (isConfirmDialogOpen() || hasReaderSettingsDropdownOpen()) return;
  event.preventDefault();
  event.stopPropagation();
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
  // hidden 联动的强制关闭，保存/关闭动作被吞（一次点击只关一层）。Modal 内下拉的
  // 外点收起由下拉组件在 capture 阶段自持，不依赖此处的 bubble 传播。
  host.addEventListener("click", (event) => {
    event.stopPropagation();
    const target = event.target as HTMLElement;
    // 全部动作走这一条委托（按钮直连绑定曾在真实页面失效，close 是
    // 用户验证过的同源路径）；异常兜底在各 handler 内部落状态行
    const action = target.closest<HTMLElement>("[data-provider-editor-action]")?.dataset.providerEditorAction;
    if (action === "close") requestClose();
    else if (action === "save") {
      // 保存键是表单的 submit 控件：点击路径在这里统一走一次提交，并取消浏览器的
      // 原生提交默认动作（否则 click 与 submit 会各结算一次）
      event.preventDefault();
      void save();
    }
    else if (action === "test") void runTest();
    else if (action === "delete") void deleteActive();
    else if (action === "linked-credential") {
      // 跨族凭据动作（票 07）：装配方负责同层切换编辑器；异常不得阻断收场
      try {
        currentLinkedCredential()?.onAction?.();
      } catch {}
    }
    else if (action === "add-model") {
      addModelRow();
      revalidateEditorField("models");
    }
    else if (action === "remove-model") {
      removeModelRow(target.closest<HTMLElement>(".provider-editor-model-row"));
      revalidateEditorField("models");
    }
    else if (action === "test-model") void runModelTest(target.closest<HTMLElement>(".provider-editor-model-row"), isDirty());
    else if (action === "fetch-models") void openFetchDialog();
    else if (action === "close-fetch") closeFetchDialog();
    else if (action === "confirm-fetch") {
      confirmFetchSelection();
      revalidateEditorField("models");
    }
    else if (action === "retry-fetch") void openFetchDialog();
    // 「获取可用模型」子视图内的勾选（全选三态 / 选择集）由子视图自持委托
    // （provider-editor-fetch-dialog 片），此处只结算动作按钮
  });

  // 语义化表单提交（保存键 submit / 输入框内 Enter 隐式提交）：校验、聚焦首个
  // 无效字段与重复提交拦截都走 save() 的同一条路径。
  dialog.querySelector<HTMLFormElement>(".provider-editor-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void save();
  });

  const presetSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset");

  // 原生约束（reader-settings-providers.css 的 :user-invalid/:user-valid 校验态消费）
  // 由字段投影负责：Key 的 required 随 isKeyRequired / 已存 Key 态、ASR 模型名的
  // required 都在投影片的字段表内挂摘（与占位符同源，模板与联动同一份规则）。

  // 预设切换（候选 4 片 3：改 draft 后重投影）：baseUrl 未改过（空或仍是上一
  // 预设默认值）才跟随（平铺行同款规则）。名称仅在为空或等于上一预设默认名时跟随
  // 新预设名（保护用户手动修改过的名称）；Key 仅在新预设免 Key（requiresKey === false）
  // 时清空，保留用户新填的 Key 草稿。编辑态切换预设/origin 时明确提示重新确认 Key。
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
        if (family.editor.modelSource === "input") {
          current.model = next.model || "";
        }
        const currentName = current.name.trim();
        if (!currentName || (previous && currentName === previous.name)) {
          current.name = next.name || "";
        }
        if (next.requiresKey === false) {
          current.apiKey = "";
        }
      }
    });
    // 一次重投影覆盖全部字段：协议 trigger 显示 / Key 占位与 required / 名称
    // 占位 / baseUrl / 模型，不再逐字段手写
    renderProjection();
    syncLinkedCredentialDom();
    // 预设切换改变 required（如免 Key 预设 / 换平台重新确认 Key）与联动值：
    // 校验态下重算字段错误；未进入校验态时按是否需重确认 Key 更新/清空状态行
    if (isEditorValidationAttempted()) {
      applyValidationState();
    } else {
      clearStatus();
      syncReconfirmFeedback();
    }
    // 元数据跟着平台身份走（presetId 变了、baseUrl 可能被联动改掉）
    refreshModelCatalogMeta();
    // 切到 MOSS-LIVE 时按本次会话首次取音色列表（已取过则 no-op）
    primeEditorVoices();
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
      syncLinkedCredentialDom();
      // 切协议可能联动改 baseUrl（protocolBaseUrls 端点）：校验态下重算字段错误
      applyValidationState();
      syncReconfirmFeedback();
      // 切协议可能联动改 baseUrl（protocolBaseUrls 端点），元数据跟着重算
      refreshModelCatalogMeta();
    });
  }

  // 输入即写 draft（候选 4 片 3：draft 是真源，input 事件是文本字段的唯一写
  // 通道）。字段级校验在提交过校验之后才随修正重算：只清掉被修正且已解决的
  // 字段错误，未解决项与普通状态行（保存失败、权限被拒）保持原样。
  // 选择器与 draft 键由投影片的字段表声明（DRAFT_INPUTS），这里只做一次统一接线。
  // ASR 单模型输入只回写 draft（状态行由 model-picker 自持）；其下拉选值已在
  // model-picker 内补派 input 事件。
  const geminiSearchInput = dialog.querySelector<HTMLInputElement>(".provider-editor-gemini-search");
  if (geminiSearchInput) {
    initToggleSwitch(geminiSearchInput);
    geminiSearchInput.addEventListener("change", () => {
      editDraft((draft) => {
        draft.liveGeminiNativeSearch = geminiSearchInput.checked;
      });
    });
  }

  // 音色下拉（仅 MOSS-LIVE 渲染）：选值写 draft，保存时按 provider 落盘
  const voiceSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-voice");
  if (voiceSelect) {
    initCustomSelect(voiceSelect, "custom-select-wrapper provider-editor-voice-wrapper");
    voiceSelect.addEventListener("change", () => {
      editDraft((draft) => {
        draft.voiceId = voiceSelect.value;
      });
      clearStatus();
    });
  }

  for (const field of DRAFT_INPUTS) {
    const input = dialog.querySelector<HTMLInputElement>(field.selector);
    input?.addEventListener("input", () => {
      editDraft((draft) => {
        draft[field.key] = input.value;
      });
      if (field.key === "baseUrl") {
        renderProjection();
        syncLinkedCredentialDom();
        refreshModelCatalogMeta();
      } else if (field.key === "apiKey") {
        renderProjection();
      }
      if (field.key !== "name") {
        revalidateEditorField(field.key);
      }
      if (field.key === "baseUrl" || field.key === "apiKey") {
        syncReconfirmFeedback();
      }
      syncValidationStatus();
    });
  }
  // AI 目录行：行动态增删，输入事件按当前行序整列回写 draft.models（行 DOM
  // 就是 draft.models 的投影，一一对应），并实时重算元数据与 models 字段校验
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
    refreshModelCatalogMeta();
    revalidateEditorField("models");
    syncValidationStatus();
  });

  // 单模型输入族（ASR / Live）侧模型下拉接线（AI 目录无下拉，「获取可用模型」弹窗另行委托）
  const probeIo = PLATFORM_PROBE_IO[state.kind];
  const fetchModels = probeIo?.fetchModels;
  if (family.editor.modelSource === "input" && fetchModels) {
    wireModelPicker(dialog as unknown as ProviderRowElement, {
      inputClass: "provider-editor-model",
      baseUrlClass: "provider-editor-baseurl",
      apiKeyClass: "provider-editor-apikey",
      statusClass: "provider-editor-status",
      showStatus: (_node, text, isError) => showStatus(text, isError),
      fetchModels: ({ baseUrl, apiKey, providerId }) => {
        const preset = family.resolvePreset(state.presets, state.draft?.presetId || "");
        const reconfirmKey = isSavedKeyReconfirmRequired();
        return fetchModels({
          baseUrl,
          apiKey,
          providerId: reconfirmKey ? "" : (providerId || state.editingId),
          type: preset?.type
        });
      },
      isKeyRequired: () => {
        const draft = state.draft;
        const preset = family.resolvePreset(state.presets, draft?.presetId || "");
        if (preset?.requiresKey === false) return false;
        try {
          const url = new URL(draft?.baseUrl || "");
          if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return false;
        } catch {
          // 非合法绝对 URL，沿用预设规则
        }
        return family.editor.isKeyRequired(preset);
      },
      hasSavedKey: () => Boolean(state.hasSavedKey && !isSavedKeyReconfirmRequired())
    });
  }
}

export function openProviderEditor(options: ProviderEditorOpenOptions): void {
  // 幂等重置：重复打开（编辑 A 中改开 B）先作废旧 Modal 的在飞回执与监听
  closeProviderEditor(true);
  const host = ensureHost(options.mountHost);
  if (!host) {
    return;
  }
  const initialDraft = options.initialDraft ? cloneDraft(options.initialDraft) : buildInitialDraft(options);
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
    openPresetId: String(options.item?.presetId || initialDraft.presetId || ""),
    hasSavedKey: Boolean(options.item?.hasSavedKey),
    firstSetup: options.firstSetup === true,
    onAfterSave: options.onAfterSave ?? null,
    onSessionEnd: options.onSessionEnd ?? null,
    linkedCredential: options.linkedCredential ?? null,
    resolveLinkedCredential: options.resolveLinkedCredential ?? null,
    setupContextBanner: options.setupContextBanner ?? null,
    // 恢复草稿（票 07）：跨族凭据往返后显式带回原草稿与 dirty 基线；缺省由
    // 编辑目标/预设推导初稿、打开即基线
    draft: initialDraft,
    ...(options.baselineDraft !== undefined ? { baselineDraft: options.baselineDraft } : {})
  });
  host.innerHTML = buildDialogHtml(options);
  // 隔离宿主同级容器，防止 Tab 穿透到底层页面或设置面板
  restoreSiblings = isolateHostSiblings(host);
  // 投影水合：模板已按同一份字段表渲染，这里再走一遍 apply，把「投影规则」
  //（含 required 挂摘、Key 占位符等）统一落到 DOM，随后联动只调 renderProjection
  renderProjection();
  wireDialog();
  // 新会话的首次提交前不展示字段错误
  resetEditorValidation();
  if (options.initialStatus?.message) {
    showStatus(options.initialStatus.message, options.initialStatus.isError === true);
  }
  // 焦点约束：打开即入 Dialog（Tab 在层内环绕），关闭/取消后归还仍有效的触发
  // 控件；确认框与模型拉取子视图打开期间本层让位（一次输入只结算最上层）
  const dialog = getDialog();
  if (dialog) {
    focusScope = createFocusScope(dialog, {
      initialFocus: dialog,
      isActive: () => !isConfirmDialogOpen() && !getFetchDialog()
    });
  }
  primeEditorVoices();
  document.addEventListener("click", onDocumentClickCapture, true);
  document.addEventListener("keydown", onDocumentKeyDownCapture, true);
  stopObservingSettingsHidden = observeSettingsPanelHidden(() => closeProviderEditor(true));
  if (PROVIDER_FAMILY_ROWS[options.kind].editor.modelSource === "catalog") {
    void primeModelCatalogMeta();
  }
  if (dialog && options.initialFocusField === "apiKey") {
    dialog.querySelector<HTMLElement>(".provider-editor-apikey")?.focus({ preventScroll: true });
  } else if (dialog && options.initialFocusField === "models") {
    dialog
      .querySelector<HTMLElement>(
        '[data-provider-editor-action="add-model"], .provider-editor-model-input, .provider-editor-model'
      )
      ?.focus({ preventScroll: true });
  }
}

export interface ProviderEditorDraftStash {
  editingId: string;
  draft: EditorDraft;
  baseline: EditorDraft | null;
}

export function stashProviderEditorDraft(kind: "live" | "search"): ProviderEditorDraftStash | null {
  if (!state.open || state.kind !== kind || !state.draft || !state.host) {
    return null;
  }
  return {
    editingId: state.editingId,
    draft: cloneDraft(state.draft),
    baseline: state.baselineDraft ? cloneDraft(state.baselineDraft) : null
  };
}

export function isProviderEditorOpen(): boolean {
  return state.open;
}
