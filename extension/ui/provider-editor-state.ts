// extension/ui/provider-editor-state.ts — 平台编辑 Modal 的状态袋 + 字段/DOM 原语
// + 会话写入原语与结算原语（provider-editor 拆分片，工单 12；owner 2）。
//
// 为什么单独成片：Modal 的编辑态（open / kind / editingId / openBaseUrl /
// hasSavedKey / presets / onSave / onDelete / draft / baselineDraft / generation /
// host）与「按类名读字段 / 写状态行 / 置忙」原语被 Modal 本体与另两片
//（模型目录、拉取弹窗）共用。把它们放在最底层，三片之间才没有环：
//
//   provider-editor-state ← provider-editor-catalog
//                         ← provider-editor-fetch-dialog
//   provider-editor-modal（含模板与动作） → 上面三片
//   provider-editor（对外导出壳） → modal
//
// 片内只有单例状态与纯读取/写入原语，零运行时 import（类型除外）——沿用
// analysis-validate.ts「纯片」先例。
//
// 片 2 起预设回落 / Key 占位符 / 序列化等每族知识收进 provider-family.ts 声明
// 的 editor 段（行/编辑器同源合一），本片不再承载。
//
// owner 2（状态袋写纪律）：会话控制字段对片外**只读**——`state` 是 Readonly
// 视图，写入只经本片的意图级原语（beginEditorSession / endEditorSession /
// editDraft）；「代际 + open + 存活判据」的过期回执纪律收进结算原语
//（captureSession / runIfCurrent），动作只写成功与失败两支，不再逐处手抄
// `generation !== state.generation || !state.open`。挂抽屉观察器的槽位单独留
// sessionObserver（settings-panel-hidden 需要就地写入的宿主对象）。

import type { AiProtocol } from "../ai/protocol-vocab.js";
import type { ProviderRowItem, ProviderRowPreset } from "./provider-row.js";
import type { SettingsPanelObserverHost } from "./settings-panel-hidden.js";

export type ProviderEditorKind = "ai" | "asr" | "search";

// 编辑草稿（候选 4 片 3）：Modal 的唯一真源。DOM 是它的投影——输入/change
// 事件写 draft，模板与联动读 draft 后重投影；保存 / 测试连接 / 拉取弹窗 /
// dirty 对比全部只读 draft，不读 DOM。
export interface EditorDraft {
  presetId: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  protocol: AiProtocol | "";
  models: string[];
  model: string;
}

// 草稿只读视图（state.draft 对片外的类型）：顶层字段与 models 元素都不可写，
// 内容写入一律走 editDraft 的意图级入口。
export type EditorDraftView = Readonly<Omit<EditorDraft, "models">> & { readonly models: readonly string[] };

export function cloneDraft(draft: EditorDraftView): EditorDraft {
  return { ...draft, models: [...draft.models] };
}

export function draftsEqual(a: EditorDraftView, b: EditorDraftView): boolean {
  return (
    a.presetId === b.presetId &&
    a.name === b.name &&
    a.baseUrl === b.baseUrl &&
    a.apiKey === b.apiKey &&
    a.protocol === b.protocol &&
    a.model === b.model &&
    a.models.length === b.models.length &&
    a.models.every((model, index) => model === b.models[index])
  );
}

// 收集层口径（拍板 Q7）：trim / 去空行 / 静默去重（保序）。原 readModelIds
// 从 DOM 抓取，候选 4 片 3 起 draft 为真源，归一直接作用于 draft.models
export function normalizeDraftModels(models: readonly string[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const model of models) {
    const value = model.trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      ids.push(value);
    }
  }
  return ids;
}

// 保存回调（settings-panel 注入）：现查-合并-落盘-重渲与权限申请收口在
// settings-panel 的单点保存事务（provider-transaction.upsertProvider），本模块
// 只传 upsert。返回 error 时 Modal 内状态行显示、不关。
export type ProviderEditorSave = (
  kind: ProviderEditorKind,
  upsert: ProviderRowItem
) => Promise<{ ok: boolean; error?: string }>;

// 删除回调（settings-panel 注入，仅编辑态提供）：回收 orphan origin + 删除
// 消息 + 列表重渲都收口在同一事务（provider-transaction.deleteProvider），本模块
// 只传目标（id + 已存列表项 baseUrl——锚定打开时的权威项，不收 DOM 里的未保存
// 输入改动）。
export type ProviderEditorDelete = (
  kind: ProviderEditorKind,
  target: { id: string; baseUrl: string }
) => Promise<{ ok: boolean; error?: string }>;

export interface ProviderEditorOpenOptions {
  kind: ProviderEditorKind;
  // 编辑目标（后端权威列表项，含 hasSavedKey）；缺省 = 新增空白
  item?: ProviderRowItem | null;
  presets: readonly ProviderRowPreset[];
  onSave: ProviderEditorSave;
  // 编辑态的删除入口（Modal 头部警示按钮）；缺省 = 不渲染删除按钮
  onDelete?: ProviderEditorDelete;
}

// 会话控制字段：对外只读（写入走下面的意图级原语）。
export interface EditorState {
  readonly open: boolean;
  readonly kind: ProviderEditorKind;
  readonly editingId: string;
  readonly hasSavedKey: boolean;
  // 打开时锚定的已存列表项 baseUrl（删除回收 orphan origin 的目标地址）
  readonly openBaseUrl: string;
  // 打开参数直达（collectUpsert / runTest / 预设切换读取）
  readonly presets: readonly ProviderRowPreset[];
  readonly onSave: ProviderEditorSave;
  readonly onDelete: ProviderEditorDelete | null;
  // 编辑草稿与打开时的基线（dirty = 逐字段对比，见 draftsEqual）
  readonly draft: EditorDraftView | null;
  readonly baselineDraft: EditorDraftView | null;
  // 代际号：测试探针/保存回执落定前比对，Modal 已关/已重开则丢弃过期回执
  readonly generation: number;
  readonly host: HTMLElement | null;
}

type MutableEditorState = { -readonly [K in keyof EditorState]: EditorState[K] };

const bag: MutableEditorState = {
  open: false,
  kind: "ai",
  editingId: "",
  hasSavedKey: false,
  openBaseUrl: "",
  presets: [],
  onSave: async () => ({ ok: false, error: "保存回调未注入" }),
  onDelete: null,
  draft: null,
  baselineDraft: null,
  generation: 0,
  host: null
};

// 片外只读视图：`state.x = ...` 编译期即失败（写入走原语）。
export const state: Readonly<EditorState> = bag;

// 抽屉收起观察器的就地写入槽（observeSettingsPanelHidden 需要宿主对象）。
export const sessionObserver: SettingsPanelObserverHost = { observer: null };

// ===== 会话写入原语（owner 2）=====

export interface EditorSessionInit {
  kind: ProviderEditorKind;
  host?: HTMLElement | null;
  presets?: readonly ProviderRowPreset[];
  onSave?: ProviderEditorSave;
  onDelete?: ProviderEditorDelete | null;
  editingId?: string;
  openBaseUrl?: string;
  hasSavedKey?: boolean;
  draft: EditorDraft;
  // 缺省 = cloneDraft(draft)（打开即基线）；显式 null = 无基线（手工挂载的测试）
  baselineDraft?: EditorDraftView | null;
}

// 打开一次编辑会话：会话控制字段的唯一写入点。
export function beginEditorSession(init: EditorSessionInit): void {
  bag.open = true;
  bag.kind = init.kind;
  bag.host = init.host ?? null;
  bag.presets = init.presets ?? [];
  bag.onSave = init.onSave ?? (async () => ({ ok: false, error: "保存回调未注入" }));
  bag.onDelete = init.onDelete ?? null;
  bag.editingId = init.editingId ?? "";
  bag.openBaseUrl = init.openBaseUrl ?? "";
  bag.hasSavedKey = Boolean(init.hasSavedKey);
  bag.draft = init.draft;
  bag.baselineDraft = init.baselineDraft === undefined ? cloneDraft(init.draft) : init.baselineDraft;
}

// 结束会话（幂等）：代际作废在飞回执、摘宿主与观察器、清草稿。文档级监听的
// 摘除仍由 Modal 持有（监听挂在 Modal 的接线一侧）。
export function endEditorSession(): void {
  bag.generation += 1;
  bag.open = false;
  sessionObserver.observer?.disconnect();
  sessionObserver.observer = null;
  bag.host?.remove();
  bag.host = null;
  bag.draft = null;
  bag.baselineDraft = null;
}

// 草稿写入的唯一入口：会话未开/无草稿时静默忽略。
export function editDraft(mutate: (draft: EditorDraft) => void): void {
  if (bag.draft) {
    mutate(bag.draft as EditorDraft);
  }
}

// ===== 结算原语（owner 2）=====
//
// 过期回执纪律的唯一持有处：捕获代际（叠加调用方的存活判据，如「行仍在文档」
// 「弹窗仍在」），work 落定后若已换代/已关闭/判据判死即静默丢弃——成功与失败
// 两支都不执行。

export interface SessionBranches<T> {
  ok: (value: T) => void;
  // 缺省 = 不吞异常：work 抛出且会话仍当前时原样上抛（保留 void 调用的
  // 未处理拒绝语义）
  fail?: (error: unknown) => void;
}

export interface EditorSessionHandle {
  isCurrent(): boolean;
  run<T>(work: () => Promise<T> | T, branches: SessionBranches<T>): Promise<void>;
}

export function captureSession(alive?: () => boolean): EditorSessionHandle {
  const generation = bag.generation;
  const isCurrent = (): boolean => generation === bag.generation && bag.open && (alive ? alive() : true);
  return {
    isCurrent,
    async run<T>(work: () => Promise<T> | T, branches: SessionBranches<T>): Promise<void> {
      let value: T;
      try {
        value = await work();
      } catch (error) {
        if (!isCurrent()) return;
        if (!branches.fail) throw error;
        branches.fail(error);
        return;
      }
      if (!isCurrent()) return;
      branches.ok(value);
    }
  };
}

export function runIfCurrent<T>(
  work: () => Promise<T> | T,
  branches: SessionBranches<T>,
  alive?: () => boolean
): Promise<void> {
  return captureSession(alive).run(work, branches);
}

// ===== DOM 读取（host 直下的 dialog 内按类名取，open 时接线） =====

export function getDialog(): HTMLElement | null {
  if (!state.host) return null;
  return state.host.querySelector<HTMLElement>(".provider-editor-dialog");
}

export function readField(selector: string): string {
  const input = getDialog()?.querySelector<HTMLInputElement>(selector);
  return String(input?.value || "").trim();
}
