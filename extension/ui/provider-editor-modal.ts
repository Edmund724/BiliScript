// extension/ui/provider-editor-modal.ts — 平台编辑 Modal 本体（provider-editor 拆分片，
// 工单 12）。
//
// 原 provider-editor.ts 三片分层后的顶片：Modal 的打开/关闭（含 dirty 保护）、
// 字段模板、宿主挂载与全局监听、事件委托接线。依赖方向单向向下：
//
//   provider-editor-state  ← 状态袋 + 字段/DOM 原语（零运行时依赖）
//   provider-editor-catalog ← AI 模型目录（行模板 / 增删 / 空态 / 行级测试）
//   provider-editor-fetch-dialog ← 「获取可用模型」勾选弹窗
//   provider-editor-modal（本文件）→ 以上三片
//   provider-editor.ts → 本文件（对外导出壳，导入路径零变化）
//
// 动作三件（保存 / 删除 / 测试连接）随接线留在本片：它们读写状态袋并关闭
// Modal，与接线同属一条点击链。函数体自原 provider-editor.ts 逐字节搬移。

import { escapeHtml } from "../shared/string-utils.js";
import { validateAiProviders } from "../core/validators.js";
import { testAsrConnection } from "../asr/provider-test.js";
import { listAsrModels } from "../asr/provider-models.js";
import { buildModelPickerField, wireModelPicker } from "./model-picker.js";
import { closeAllCustomSelects, initCustomSelect } from "./custom-select.js";
import { confirmDialog, isConfirmDialogOpen } from "./confirm-dialog.js";
import { ids } from "../reader/state.js";
import { observeSettingsPanelHidden } from "./settings-panel-hidden.js";
import type { ProviderRowElement, ProviderRowItem, ProviderRowPreset } from "./provider-row.js";
import {
  apiKeyPlaceholder,
  getDialog,
  readField,
  resolvePreset,
  state,
  type ProviderEditorKind,
  type ProviderEditorOpenOptions
} from "./provider-editor-state.js";
import {
  addModelRow,
  modelRowHtml,
  readModelIds,
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

// ===== dirty 快照（拍板 Q6） =====

export function currentSnapshot(): string {
  // AI 快照含模型目录行（拍板 Q10 草稿语义：增删行即脏——行数进快照，否则
  // 加一行空白行与 0 行的拼接结果相同）；ASR 是单模型输入
  const modelInputs = state.kind === "ai"
    ? Array.from(getDialog()?.querySelectorAll<HTMLInputElement>(".provider-editor-model-id") || [])
    : [];
  const modelsPart = state.kind === "ai"
    ? `${modelInputs.length}\u0001${modelInputs.map((input) => input.value).join("\u0001")}`
    : readField(".provider-editor-model");
  return [
    getDialog()?.querySelector<HTMLSelectElement>(".provider-editor-preset")?.value || "",
    readField(".provider-editor-name"),
    readField(".provider-editor-baseurl"),
    readField(".provider-editor-apikey"),
    modelsPart
  ].join("\u0000");
}

export function isDirty(): boolean {
  return state.open && currentSnapshot() !== state.dirtySnapshot;
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
  state.generation += 1;
  state.open = false;
  state.observer?.disconnect();
  state.observer = null;
  document.removeEventListener("click", onDocumentClickCapture, true);
  document.removeEventListener("keydown", onDocumentKeyDownCapture, true);
  state.host?.remove();
  state.host = null;
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
  const presetId = getDialog()?.querySelector<HTMLSelectElement>(".provider-editor-preset")?.value || "custom";
  const preset = resolvePreset(state.presets, presetId, state.kind);
  const name = readField(".provider-editor-name") || preset?.name || "自定义";
  const baseUrl = readField(".provider-editor-baseurl").replace(/\/+$/, "");
  const apiKey = readField(".provider-editor-apikey");

  if (state.kind === "asr") {
    const model = readField(".provider-editor-model");
    return {
      upsert: {
        id: state.editingId,
        presetId: preset?.id || "custom",
        name,
        type: preset?.type || "openai-transcriptions",
        baseUrl,
        model,
        apiKey,
        hasSavedKey: state.hasSavedKey
      }
    };
  }

  // 模型目录：收集时 trim / 去空行 / 去重（拍板 Q7，与 normalize 同逻辑）；
  // 空目录合法（拍板 Q13：平台只是不出现在聊天模型选择器，目录外 ID 仍可发送）
  const upsert: ProviderRowItem = {
    id: state.editingId,
    presetId: preset?.id || "custom",
    name,
    baseUrl,
    models: readModelIds(),
    requiresKey: preset?.requiresKey !== false,
    enabled: true,
    apiKey,
    hasSavedKey: state.hasSavedKey
  };
  // 单平台校验与整表保存共用 validateAiProviders（报文语义一致：baseUrl 格式 /
  // requiresKey 缺 Key / 缺模型名）。校验失败只报状态行，不关 Modal。
  const validation = validateAiProviders([upsert]);
  return validation.ok ? { upsert } : { upsert, validationError: validation.message };
}

export async function save(): Promise<void> {
  const { upsert, validationError } = collectUpsert();
  if (validationError) {
    showStatus(validationError, true);
    return;
  }
  setBusy(true);
  showStatus("正在保存...");
  const generation = state.generation;
  try {
    const result = await state.onSave(state.kind, upsert);
    if (generation !== state.generation || !state.open) {
      return; // Modal 已关/已重开：过期回执丢弃
    }
    if (result.ok) {
      closeProviderEditor(true);
    } else {
      setBusy(false);
      showStatus(result.error || "保存失败", true);
    }
  } catch (error) {
    // void save() 会吞 rejection——任何异常都必须落到状态行，不允许无反馈
    if (generation !== state.generation || !state.open) return;
    setBusy(false);
    showStatus(`保存失败：${(error as Error).message || "未知错误"}`, true);
  }
}

// ===== 删除（编辑态，Modal 头部警示按钮；回收权限/删除消息/重渲在 onDelete） =====

export async function deleteActive(): Promise<void> {
  if (!state.editingId || !state.onDelete) return;
  // 面板内二次确认（ui/confirm-dialog.js）：原生 confirm 绘制在浏览器窗口中央，
  // 面板停靠右侧时可能看不到；确认期间编辑器的文档级监听整体让位
  if (!(await confirmDialog({ message: "确定要删除这个平台吗？删除后需要重新配置。", confirmText: "删除", danger: true }))) {
    return;
  }
  setBusy(true);
  showStatus("正在删除...");
  const generation = state.generation;
  try {
    const result = await state.onDelete(state.kind, {
      id: state.editingId,
      baseUrl: readField(".provider-editor-baseurl")
    });
    if (generation !== state.generation || !state.open) return;
    if (result.ok) {
      closeProviderEditor(true);
    } else {
      setBusy(false);
      showStatus(result.error || "删除失败", true);
    }
  } catch (error) {
    if (generation !== state.generation || !state.open) return;
    setBusy(false);
    showStatus(`删除失败：${(error as Error).message || "未知错误"}`, true);
  }
}

// ===== 测试连接（只验证连通性，成功也不落盘；保存只在点「保存」时发生） =====
//
// AI：行级测试（拍板 Q4/Q12，runModelTest），平台级按钮已退役；本函数只剩
// ASR 平台级测试。两侧同一语义：探针直调（与平铺行同源，options 页本地执行
// 免 SW 往返），成功回报连通性，不写设置。

export async function runTest(): Promise<void> {
  if (state.kind !== "asr") return;
  const baseUrl = readField(".provider-editor-baseurl");
  const model = readField(".provider-editor-model");
  if (!baseUrl) {
    showStatus("请填写 baseUrl", true);
    return;
  }
  if (!model) {
    showStatus("请填写模型名", true);
    return;
  }
  setBusy(true);
  showStatus("正在测试...");
  const generation = state.generation;
  const presetId = getDialog()?.querySelector<HTMLSelectElement>(".provider-editor-preset")?.value || "custom";
  const preset = resolvePreset(state.presets, presetId, state.kind);
  const apiKey = readField(".provider-editor-apikey");
  const name = readField(".provider-editor-name") || preset?.name || "自定义";
  // 新增时 editingId 为空，探针按空 id 代查 Key 落空，用户重输的 Key 随参数携带。
  const resp: { ok?: boolean; error?: string } = await testAsrConnection({
    id: state.editingId,
    name,
    type: preset?.type || "openai-transcriptions",
    baseUrl,
    model,
    ...(apiKey ? { apiKey } : {})
  });
  if (generation !== state.generation || !state.open) {
    return; // 过期回执：Modal 已关/已重开，不打扰
  }
  if (!resp?.ok) {
    setBusy(false);
    showStatus(`失败：${resp?.error || "未知错误"}`, true);
    return;
  }
  // 测试成功：只回报连通性，不写设置——用户显式点「保存」才落盘
  setBusy(false);
  showStatus("连接成功");
}
// ===== 模板 =====

export function editorTitle(kind: ProviderEditorKind, editing: boolean): string {
  const label = kind === "ai" ? "AI 平台" : "语音转写平台";
  return editing ? `编辑${label}` : `添加${label}`;
}
export function buildDialogHtml(options: ProviderEditorOpenOptions): string {
  const item = options.item || null;
  const presets = options.presets;
  // 新增默认「自定义」（与平铺行空白行的 presetId 默认一致，baseUrl 空）；
  // 编辑按列表项 presetId（未知值由 resolvePreset 回落，AI 回落最后一个预设）
  const presetId = String(item?.presetId || "custom");
  const preset = resolvePreset(presets, presetId, options.kind);
  const hasSavedKey = Boolean(item?.hasSavedKey);
  const baseUrl = String(item?.baseUrl ?? preset?.baseUrl ?? "");
  const isAi = options.kind === "ai";
  // AI 名称是拍板 Q7 新增的可选项：历史数据 name=预设名，值留空 + 占位符展示
  // 预设名（保存时空值回落预设名）；用户自定义过（≠预设名）才回填实值。
  // ASR 名称是实值语义（与平铺行一致：初始即预设名）。
  const presetName = preset?.name || "";
  const rawName = String(item?.name || "");
  const nameValue = isAi ? (rawName && rawName !== presetName ? rawName : "") : rawName || presetName;
  const namePlaceholder = isAi ? presetName : "平台名称";
  // AI 模型目录：编辑预填全部模型行（阶段2）；ASR 单模型回落预设
  const models = isAi && Array.isArray(item?.models) ? item.models.map(String) : [];
  const model = isAi ? "" : String(item?.model ?? preset?.model ?? "");

  return `
    <div class="provider-editor-mask" data-provider-editor-action="close"></div>
    <section class="provider-editor-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(editorTitle(options.kind, Boolean(item?.id)))}" tabindex="-1">
      <header class="provider-editor-head">
        <span class="provider-editor-title">${escapeHtml(editorTitle(options.kind, Boolean(item?.id)))}</span>
        ${item?.id && options.onDelete ? `<button type="button" class="provider-editor-delete" data-provider-editor-action="delete" title="删除该平台">删除</button>` : ""}
      </header>
      <div class="provider-editor-body">
        <div class="provider-editor-field">
          <label class="provider-editor-label">平台预设</label>
          <select class="provider-editor-preset">
            ${presets.map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === presetId ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
          </select>
        </div>
        <div class="provider-editor-field">
          <label class="provider-editor-label">名称</label>
          <input class="provider-editor-name" type="text" placeholder="${escapeHtml(namePlaceholder)}" value="${escapeHtml(nameValue)}" />
        </div>
        <div class="provider-editor-field">
          <label class="provider-editor-label">API 地址</label>
          <input class="provider-editor-baseurl" type="text" required pattern="https?://.+" placeholder="baseUrl（如 https://api.openai.com/v1）" value="${escapeHtml(baseUrl)}" />
        </div>
        <div class="provider-editor-field">
          <label class="provider-editor-label">API Key</label>
          <input class="provider-editor-apikey" type="password" placeholder="${escapeHtml(apiKeyPlaceholder(options.kind, preset, hasSavedKey))}" autocomplete="off" ${!hasSavedKey && preset?.requiresKey !== false ? "required" : ""} />
        </div>
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
          <p class="provider-editor-catalog-empty" ${models.length ? "hidden" : ""}>模型选择器中将不显示任何模型；目录外 ID 仍可直接发送。</p>
          <p class="provider-editor-catalog-error" hidden></p>
          <button type="button" class="provider-editor-model-add" data-provider-editor-action="add-model">+ 添加模型</button>
        </div>
        <p class="provider-editor-status" hidden></p>`
          : `
        <div class="provider-editor-field">
          <label class="provider-editor-label">模型</label>
          ${buildModelPickerField({
            inputClass: "provider-editor-model",
            placeholder: "模型名（点右侧箭头拉取可选模型）",
            value: model
          })}
        </div>
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

// 挂载宿主：#boc-reading-view 直下（面板内弹层的最大合理范围，不在设置抽屉
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

export function wireDialog(options: ProviderEditorOpenOptions): void {
  const dialog = getDialog();
  const host = state.host;
  if (!dialog || !host) return;

  // 委托挂 host（mask 与 dialog 的共同父级）：遮罩是 dialog 的兄弟，挂 dialog
  // 上收不到遮罩点击（explain-card 同款：委托在容器上）。
  // 无条件 stopPropagation：Modal 宿主挂 #boc-reading-view 直下，在设置抽屉
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
    else if (action === "test-model") void runModelTest(target.closest<HTMLElement>(".provider-editor-model-row"));
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
  const nameInput = dialog.querySelector<HTMLInputElement>(".provider-editor-name");
  const baseUrlInput = dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl");
  const apikeyInput = dialog.querySelector<HTMLInputElement>(".provider-editor-apikey");

  // 原生约束（reader-settings.css 的 :user-invalid/:user-valid 校验态消费）：
  // ASR 模型名输入由 model-picker 模板生成（构建器契约不含属性注入），在此补
  // required；Key 必填随预设 requiresKey 与已存 Key 态挂摘（与占位符同口径）。
  // AI 模型目录行无原生必填（空目录合法，拍板 Q13），required 不适用于目录。
  if (options.kind === "asr") {
    dialog.querySelector<HTMLInputElement>(".provider-editor-model")?.setAttribute("required", "");
  }
  const syncApiKeyRequired = (preset: ProviderRowPreset | null): void => {
    if (apikeyInput) {
      apikeyInput.required = preset?.requiresKey !== false && !state.hasSavedKey;
    }
  };
  syncApiKeyRequired(resolvePreset(options.presets, presetSelect?.value || "", options.kind));

  // 预设切换：baseUrl 未改过（空或仍是上一预设默认值）才跟随（平铺行同款规则）。
  // AI 名称留过实值（≠当前预设名）视为用户自定义，切预设不覆盖；否则跟随新
  // 预设名（仅占位符与空值）。ASR 名称/模型无条件跟随、Key 清空（平铺行同款）。
  // 不代申请权限——Modal 的 host 权限在保存时统一收口（拍板 Q5 推论）。
  presetSelect?.addEventListener("change", () => {
    const next = resolvePreset(options.presets, presetSelect.value, options.kind);
    if (!next) return;
    const previous = resolvePreset(options.presets, presetSelect.dataset.previousPresetId || "", options.kind);
    const currentBaseUrl = baseUrlInput?.value.trim() || "";
    if (baseUrlInput && (!currentBaseUrl || (previous && currentBaseUrl === previous.baseUrl))) {
      baseUrlInput.value = next.baseUrl;
    }
    if (options.kind === "asr") {
      const modelInput = dialog.querySelector<HTMLInputElement>(".provider-editor-model");
      if (modelInput) modelInput.value = next.model || "";
      if (nameInput) nameInput.value = next.name || "";
      if (apikeyInput) apikeyInput.value = "";
    } else {
      const currentName = nameInput?.value.trim() || "";
      if (nameInput && (!currentName || (previous && currentName === previous.name))) {
        nameInput.value = "";
        nameInput.placeholder = next.name || "";
      }
      if (apikeyInput) {
        apikeyInput.placeholder = apiKeyPlaceholder("ai", next, state.hasSavedKey);
      }
    }
    // Key 必填随预设挂摘（requiresKey 与已存 Key 态同占位符口径）
    syncApiKeyRequired(next);
    clearStatus();
    presetSelect.dataset.previousPresetId = next.id;
  });
  if (presetSelect) {
    presetSelect.dataset.previousPresetId = presetSelect.value;
    // AI / ASR 一律接管（ADR-0007）：原生 select 的弹层由浏览器绘制，圆角与
    // 高亮都是系统外观，与 Modal 内其余 8px 框/12px 弹层割裂。
    initCustomSelect(presetSelect, "custom-select-wrapper provider-editor-preset-wrapper");
  }

  // 输入即清错误状态行（修正输入即清错）；字段级校验态由 :user-invalid CSS
  // 随原生约束自动摘除，无需 JS 介入
  [nameInput, baseUrlInput, apikeyInput].forEach((input) => {
    input?.addEventListener("input", () => {
      if (statusIsError()) {
        clearStatus();
      }
    });
  });

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
  if (options.kind === "asr") {
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
  state.host = host;
  state.kind = options.kind;
  state.presets = options.presets;
  state.onSave = options.onSave;
  state.onDelete = options.onDelete || null;
  state.editingId = String(options.item?.id || "");
  state.hasSavedKey = Boolean(options.item?.hasSavedKey);
  state.open = true;
  host.innerHTML = buildDialogHtml(options);
  wireDialog(options);
  state.dirtySnapshot = currentSnapshot();
  document.addEventListener("click", onDocumentClickCapture, true);
  document.addEventListener("keydown", onDocumentKeyDownCapture, true);
  // 设置抽屉收起时强制关闭（含 dirty 改动）：抽屉被外点/齿轮收起时用户意图是
  // 关掉一切，confirm 无意义。自治监听 hidden 属性变化，零跨模块状态。
  observeSettingsPanelHidden(() => closeProviderEditor(true), state);
}

export function isProviderEditorOpen(): boolean {
  return state.open;
}
