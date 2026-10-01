// extension/ui/provider-row.ts
// AI 平台行与 ASR 平台行构建器的共享工厂 createProviderRow（紧凑形态，
// provider-master-detail/02）：行是纯展示 + 入口——Key 状态点 + 名称 +
// 模型名 +（ASR）选用 radio +「编辑 / 删除」两个动作（搜索族另有行尾拖拽把手，
// spec §6.10），行内零输入字段。
// 编辑（预设 / baseUrl / API Key / 模型 / 测试）全部在 ui/provider-editor.js
// 的 Modal 里（01），保存走单平台 upsert（settings-panel.saveProviderSingle）。
//
// 与 01 前的平铺形态相比退役的职责：预设下拉 / 行内编辑字段收集
//（collectAiProviders / collectAsrProviders 已删，列表真相在后端）/ 连通性
// 测试与行内状态（探针随 Modal）/ 模型下拉（model-picker 随 Modal）。
// 此前 ASR 行复用 ai-provider-remove / ai-provider-status 类名的既有耦合
// 随行内状态行退役一并收口：删除按钮统一 provider-row-remove。
//
// 两行差异通过参数注入：显示名 / 模型名的解析、删除报文；选用 radio
// （ASR / 搜索同款）由本模块的 buildActiveRadioTail 统一收口。行构建器自身
// 的状态只依赖参数与回调；唯一例外
// 是删除确认走 ui/confirm-dialog.js 的面板内弹层（该模块自持挂载与结算）。

import { escapeHtml } from "../shared/string-utils.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { confirmDialog } from "./confirm-dialog.js";
import type { SearchProviderAccess } from "../core/presets.js";
import type { BackgroundMessage, ContentScriptMessage } from "../shared/messaging-protocol.js";

// 垃圾桶图标路径：固定属性行 / 笔记段落行 / 平台行共用同一份 path 定义。
export const TRASH_ICON_PATHS: string = [
  '<path d="M4 7h16"></path>',
  '<path d="M9 3h6"></path>',
  '<path d="M10 11v6"></path>',
  '<path d="M14 11v6"></path>',
  '<path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"></path>'
].join("");

// 拖拽把手图标（竖排点阵，spec §6.10）：仅搜索族记录行渲染。
const DRAG_HANDLE_ICON_PATHS: string = [
  '<circle cx="12" cy="6" r="1.7"></circle>',
  '<circle cx="12" cy="12" r="1.7"></circle>',
  '<circle cx="12" cy="18" r="1.7"></circle>'
].join("");

// 行元素：HTMLElement 之上承载行级 dataset——providerId / hasSavedKey /
// currentPresetId / baseUrl（删除回收 host 权限时钩子要从行上拿到 baseUrl，
// 紧凑行没有输入框，渲染时写入）。索引签名仅为将来的动态键读写兜底。
export type ProviderRowElement = HTMLElement & Record<string, unknown>;

// 平台行条目的宽松形状：AI / ASR 两条真实配置与测试注入的字面量对象都按
// 此结构传入；行骨架只读列出的字段，其余字段（如 enabled/apiKey/type）不在
// 行内消费（编辑走 Modal 的权威现查）。
export interface ProviderRowItem {
  id?: string;
  presetId?: string;
  name?: string;
  baseUrl?: string;
  model?: string;
  // AI 模型目录（multi-model-catalog）：多模型时副行显示「首项 等 N 个」；
  // ASR 无此字段。缺省时回落 model（历史单模型数据/测试字面量）。
  models?: string[];
  type?: string;
  requiresKey?: boolean;
  enabled?: boolean;
  apiKey?: string;
  hasSavedKey?: boolean;
  // 平台协议（multi-protocol-ai）：编辑 Modal 预填/回写；宽松 string，合法性
  // 由编辑 Modal 经注册表词表收敛。
  protocol?: string;
}

// 平台预设的结构子集：AiProviderPreset（core/presets）与 AsrProviderPreset
// 均按结构兼容传入；搜索族额外带接入与额度形态 access（spec §7 单一真源，
// AI/ASR 预设无该字段，不受影响）。
export interface ProviderRowPreset {
  id: string;
  name: string;
  baseUrl: string;
  model?: string;
  type?: string;
  requiresKey?: boolean;
  // 接入与额度形态（仅搜索预设表提供）：keyless 无 Key 即可调用；
  // free-quota 必须自带 Key。行状态点第三态与徽章都由它派生。
  access?: SearchProviderAccess;
  // 协议默认归属（multi-protocol-ai）：选中预设时编辑 Modal 协议下拉的联动默认值。
  protocol?: string;
  // 个别协议的差异化端点（multi-protocol-ai）：切协议时 baseUrl 未改过即跟随
  // （与 AiProviderPreset.protocolBaseUrls 同字段，宽松 string 键）。
  protocolBaseUrls?: Record<string, string>;
}

// 行内状态 <p> 的写入口（wireModelPicker 注入用）：行内状态行已随紧凑形态
// 退役，但 ui/provider-editor.js 的 Modal 仍以此签名接入 model-picker。
export type ProviderRowShowStatus = (
  node: HTMLElement | null | undefined,
  text: string,
  isError?: boolean
) => void;

// 删除动作前先执行的钩子（调用页注入 chrome.permissions.remove 回收 origin，
// 需要在被删行摘出 DOM 之前拿到它的 baseUrl——行 dataset 提供）。
export type ProviderRowBeforeDeleteHandler = (
  providerId: string,
  baseUrl: string
) => Promise<void> | void;

// 删除完成后的回调（ASR：删的是当前选用平台时清 activeAsrProviderId）。
export type ProviderRowHandler = (providerId: string) => Promise<void> | void;

// 虚拟条目（spec §6.10 的「智能」虚拟行；仅搜索族声明）：不是平台记录，按同一
// 行类 + 同一 activeRadio 渲染——选中态读写因此复用既有单源，不新增第二条路径。
export interface ProviderRowVirtualRow {
  // 行 id（写进 dataset.providerId；搜索族 = 哨兵 SMART_SEARCH_ACTIVE_ID）
  id: string;
  label: string;
  // 副行说明（同时作为行 title 的缺省值）
  hint?: string;
  title?: string;
}

export interface CreateProviderRowConfig {
  rowClass: string;
  editClass: string;
  removeClass: string;
  idPrefix: string;
  resolvePreset: (presets: readonly ProviderRowPreset[], presetId: string) => ProviderRowPreset | null;
  // 显示名：AI=自定义名回落预设名（拍板 Q7）；ASR=名称回落预设名/自定义
  displayName: (item: ProviderRowItem, preset: ProviderRowPreset | null) => string;
  // 显示模型名：AI=item.models（多个时「首项 等 N 个」，拍板 Q15）或历史
  // item.model；ASR=item.model ?? preset.model。空串不渲染副行
  displayModel: (item: ProviderRowItem, preset: ProviderRowPreset | null) => string;
  // 额度形态徽章文案（spec §6.2，由族声明同源产出：搜索=免 Key / 已配 Key /
  // 免费额度，后两者按 access 与 hasSavedKey 判定；AI / ASR 无徽章 → 空串）。
  // 空串不渲染。
  resolveBadge?: (preset: ProviderRowPreset | null, hasSavedKey: boolean) => string;
  // 拖拽把手类名（spec §6.10 / §12.5 第 13 行）：**仅搜索族给**，给了才在
  // `.provider-row-line` 最右端（删除按钮之后）渲染把手；AI / ASR 行零变化。
  dragHandleClass?: string;
  // 置顶虚拟条目（spec §6.10）：渲染在记录行之前，零记录时也在；不渲染状态点 /
  // 徽章 / 编辑 / 删除，也不参与空态计数。
  virtualRow?: ProviderRowVirtualRow;
  // （仅 ASR）选用 radio：change 即时持久化 activeAsrProviderId（平铺形态同款语义）
  buildTailFields?: (ctx: { id: string; isActive: boolean }) => string;
  wireTailExtras?: (row: ProviderRowElement, ctx: { listNode: HTMLElement }) => void;
  onRowEdit: (row: ProviderRowElement) => void;
  buildDeleteMessage: (providerId: string) => BackgroundMessage | ContentScriptMessage;
}

export interface ProviderRowController {
  generateId: () => string;
  render: (
    listNode: HTMLElement,
    emptyNode: HTMLElement,
    items: unknown,
    addOptions?: { presets?: readonly ProviderRowPreset[]; activeId?: string }
  ) => ProviderRowItem[];
  updateEmptyState: (listNode: HTMLElement, emptyNode: HTMLElement) => void;
  setDeleteHandler: (handler: ProviderRowHandler) => void;
  setBeforeDeleteHandler: (handler: ProviderRowBeforeDeleteHandler) => void;
}

// 选用 radio 的共享实现（ASR / 搜索两行同款，差异仅类名前缀、radio 组名、
// 提示文案与即时持久化的设置键）：由本模块统一产出 buildTailFields /
// wireTailExtras 与选中态读写，行构建器只做薄调用。DOM 类名与设置键由
// 调用方给定并逐字保持（CSS 与测试锚点）。
export interface ActiveRadioTailConfig {
  // 类名前缀（"asr" / "search"）：派生 asr-provider-active-radio、
  // asr-provider-row、asrActiveProvider 三处锚点
  classPrefix: string;
  // radio 的 title 提示文案（两族语义不同）
  title: string;
  // 选中后即时落库的设置键（activeAsrProviderId / activeSearchProviderId）
  settingsKey: string;
}

export interface ActiveRadioTail {
  buildTailFields: (ctx: { id: string; isActive: boolean }) => string;
  wireTailExtras: (row: ProviderRowElement, ctx: { listNode: HTMLElement }) => void;
  // 把列表里 radio 选中态同步到指定平台 id（传空串则全部取消）
  setActive: (listNode: HTMLElement, activeId: string) => void;
  // 当前列表选中的平台 id（无则空串）
  getActiveId: (listNode: HTMLElement) => string;
}

export function buildActiveRadioTail({ classPrefix, title, settingsKey }: ActiveRadioTailConfig): ActiveRadioTail {
  const radioClass = `${classPrefix}-provider-active-radio`;
  const rowClass = `${classPrefix}-provider-row`;

  function buildTailFields({ isActive }: { id: string; isActive: boolean }): string {
    return `
    <label class="${classPrefix}-provider-active" title="${title}">
      <input class="${radioClass}" type="radio" name="${classPrefix}ActiveProvider" ${isActive ? "checked" : ""} />
      选用
    </label>`;
  }

  function wireTailExtras(row: ProviderRowElement, { listNode }: { listNode: HTMLElement }): void {
    row.querySelector(`.${radioClass}`)?.addEventListener("change", async () => {
      if (!(row.querySelector(`.${radioClass}`) as HTMLInputElement).checked) return;
      const providerId = row.dataset.providerId || "";
      try {
        await sendRuntimeMessage({ type: "save-settings", settings: { [settingsKey]: providerId } });
      } catch {}
      setActive(listNode, providerId);
    });
  }

  function setActive(listNode: HTMLElement, activeId: string): void {
    const target = String(activeId || "");
    listNode.querySelectorAll<HTMLInputElement>(`.${radioClass}`).forEach((radio) => {
      const row = radio.closest(`.${rowClass}`) as HTMLElement | null;
      radio.checked = Boolean(row && row.dataset.providerId === target);
    });
  }

  function getActiveId(listNode: HTMLElement): string {
    const checked = listNode.querySelector<HTMLInputElement>(`.${radioClass}:checked`);
    const row = checked?.closest(`.${rowClass}`) as HTMLElement | null;
    return row?.dataset.providerId || "";
  }

  return { buildTailFields, wireTailExtras, setActive, getActiveId };
}

export function createProviderRow({
  rowClass,
  editClass,
  removeClass,
  idPrefix,
  resolvePreset,
  displayName,
  displayModel,
  resolveBadge,
  dragHandleClass,
  virtualRow,
  buildTailFields,
  wireTailExtras,
  onRowEdit,
  buildDeleteMessage
}: CreateProviderRowConfig): ProviderRowController {
  let onDelete: ProviderRowHandler = async () => {};
  // 删除动作前先执行的钩子（调用页注入回收 origin，需要被删行的 baseUrl）
  let onBeforeDelete: ProviderRowBeforeDeleteHandler = async () => {};

  function generateId(): string {
    return `${idPrefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  // 空态计数只认**记录行**：置顶虚拟条目在场不代表配置了平台（spec §6.10）
  function updateEmptyState(listNode: HTMLElement, emptyNode: HTMLElement): void {
    const virtualId = virtualRow?.id;
    const hasRows = Array.from(listNode.children).some(
      (child) => (child as HTMLElement).dataset?.["providerId"] !== virtualId
    );
    emptyNode.hidden = hasRows;
  }

  // 虚拟条目（spec §6.10）：置顶、复用同一 activeRadio 的 buildTailFields /
  // wireTailExtras（选中即写哨兵走既有单源）；不渲染把手，故拖拽天然跳过它。
  function renderVirtualRow(listNode: HTMLElement, activeId: string): void {
    if (!virtualRow) return;
    const hint = String(virtualRow.hint || "");
    const row = document.createElement("div") as unknown as ProviderRowElement;
    row.className = rowClass;
    row.dataset.providerId = virtualRow.id;
    row.title = String(virtualRow.title || hint || "");
    const isActive = activeId === virtualRow.id;
    row.innerHTML = `
      <div class="provider-row-line">
        <span class="provider-row-name">${escapeHtml(virtualRow.label)}</span>
        ${buildTailFields ? buildTailFields({ id: virtualRow.id, isActive }) : ""}
      </div>
      ${hint ? `<div class="provider-row-model" title="${escapeHtml(hint)}">${escapeHtml(hint)}</div>` : ""}
    `;
    wireTailExtras?.(row, { listNode });
    listNode.appendChild(row);
  }

  function render(
    listNode: HTMLElement,
    emptyNode: HTMLElement,
    items: unknown,
    addOptions: { presets?: readonly ProviderRowPreset[]; activeId?: string } = {}
  ): ProviderRowItem[] {
    listNode.innerHTML = "";
    const activeId = String(addOptions.activeId || "");
    renderVirtualRow(listNode, activeId);
    const list: ProviderRowItem[] = Array.isArray(items) ? (items as ProviderRowItem[]) : [];
    list.forEach((item) => {
      const id = String(item.id || generateId());
      const presetId = String(item.presetId || "custom");
      const preset = resolvePreset(addOptions.presets || [], presetId);
      const baseUrl = String(item.baseUrl ?? preset?.baseUrl ?? "");
      const hasSavedKey = Boolean(item.hasSavedKey);
      const isActive = activeId === id;

      const row = document.createElement("div") as unknown as ProviderRowElement;
      row.className = rowClass;
      row.dataset.providerId = id;
      row.dataset.hasSavedKey = hasSavedKey ? "1" : "0";
      row.dataset.currentPresetId = presetId;
      row.dataset.baseUrl = baseUrl;

      const model = displayModel(item, preset);
      // Key 状态点第三态（spec §6.1 判据 f(access, hasSavedKey)）：keyless 预设
      // 无 Key 也标「可用」（第三色由 CSS 复用 success 变量，不新增颜色）；
      // free-quota 无 Key 恒 missing（与「无 Key 不进链」自洽）。
      const keyState = hasSavedKey ? "saved" : preset?.access === "keyless" ? "keyless" : "missing";
      const keyStateTitle =
        keyState === "saved" ? "已保存 API Key" : keyState === "keyless" ? "免 Key 可用" : "未保存 API Key";
      // 额度形态徽章（spec §6.2）：讲额度形态而非是否存在 Key——free-quota 有
      // Key 也不消失；keyless 是否已配自己的 Key 会改口径（免 Key ↔ 已配 Key，
      // 免得配了 Key 还自称免 Key）。文案由族声明同源产出，空串不渲染。
      const badge = String(resolveBadge?.(preset, hasSavedKey) || "");
      // 拖拽把手（spec §6.10）：行内最右端（删除按钮之后）的独立元素，仅搜索族
      // 记录行渲染；只认它的 pointerdown（wireProviderRowDrag）。
      const dragHandle = dragHandleClass
        ? `<span class="${dragHandleClass}" title="拖拽调整搜索顺序"><svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">${DRAG_HANDLE_ICON_PATHS}</svg></span>`
        : "";
      row.innerHTML = `
        <div class="provider-row-line">
          <span class="provider-row-dot" data-state="${keyState}" title="${keyStateTitle}"></span>
          <span class="provider-row-name">${escapeHtml(displayName(item, preset))}</span>
          ${badge ? `<span class="provider-row-badge">${escapeHtml(badge)}</span>` : ""}
          ${buildTailFields ? buildTailFields({ id, isActive }) : ""}
          <button type="button" class="${editClass}">编辑</button>
          <button type="button" class="${removeClass}" aria-label="删除" title="删除">
            <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">${TRASH_ICON_PATHS}</svg>
          </button>
          ${dragHandle}
        </div>
        ${model ? `<div class="provider-row-model" title="${escapeHtml(model)}">${escapeHtml(model)}</div>` : ""}
      `;

      // 编辑：打开 provider-editor Modal（回调由配置注入）
      row.querySelector(`.${editClass}`)?.addEventListener("click", () => {
        onRowEdit?.(row);
      });

      // 删除：面板内二次确认（ui/confirm-dialog.js，原生 confirm 弹窗绘制在浏
      // 览器窗口中央，面板停靠右侧时可能看不到）后调后台删除；若删的是当前
      // 选用平台，清空选用态（onDelete 注入处理）。onBeforeDelete 在被删行摘出
      // DOM 之前执行，注入方据此拿到该行的 baseUrl 回收 host 权限
      //（chrome.permissions.remove 不需要用户手势）；钩子报错不阻断删除。
      row.querySelector(`.${removeClass}`)?.addEventListener("click", async () => {
        if (!(await confirmDialog({ message: "确定要删除这个平台吗？", confirmText: "删除", danger: true }))) {
          return;
        }
        const providerId = row.dataset.providerId || "";
        try {
          await onBeforeDelete(providerId, row.dataset.baseUrl || "");
        } catch {}
        if (providerId) {
          try {
            await sendRuntimeMessage(buildDeleteMessage(providerId));
          } catch {}
        }
        row.remove();
        updateEmptyState(listNode, emptyNode);
        if (typeof onDelete === "function") {
          onDelete(providerId);
        }
      });

      wireTailExtras?.(row, { listNode });

      listNode.appendChild(row);
    });
    updateEmptyState(listNode, emptyNode);
    return list;
  }

  return {
    generateId,
    render,
    updateEmptyState,
    setDeleteHandler(handler) {
      onDelete = handler;
    },
    setBeforeDeleteHandler(handler) {
      onBeforeDelete = handler;
    }
  };
}
