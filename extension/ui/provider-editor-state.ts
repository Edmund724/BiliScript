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

import { requestProviderOriginsViaBackground } from "../core/host-permissions.js";
import type { AiProtocol } from "../ai/protocol-vocab.js";
import type { LiveVoice } from "../live/live-provider-store.js";
import type { ProviderRowItem, ProviderRowPreset } from "./provider-row.js";
import type { SettingsPanelObserverHost } from "./settings-panel-hidden.js";

export type ProviderEditorKind = "ai" | "asr" | "search" | "live";

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
  liveGeminiNativeSearch?: boolean;
  // MOSS-LIVE 音色选择（音色列表 data[].id；空 = 平台默认音色）
  voiceId?: string;
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
    a.models.every((model, index) => model === b.models[index]) &&
    Boolean(a.liveGeminiNativeSearch) === Boolean(b.liveGeminiNativeSearch) &&
    String(a.voiceId || "") === String(b.voiceId || "")
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
// 只传 upsert。返回 error 时 Modal 内状态行显示、不关；permissionDenied 标记
// 「域名权限被拒导致未保存」，让 Modal 与落盘失败区分反馈。
export type ProviderEditorSave = (
  kind: ProviderEditorKind,
  upsert: ProviderRowItem
) => Promise<{ ok: boolean; error?: string; permissionDenied?: boolean }>;

// 删除回调（settings-panel 注入，仅编辑态提供）：回收 orphan origin + 删除
// 消息 + 列表重渲都收口在同一事务（provider-transaction.deleteProvider），本模块
// 只传目标（id + 已存列表项 baseUrl——锚定打开时的权威项，不收 DOM 里的未保存
// 输入改动）。
export type ProviderEditorDelete = (
  kind: ProviderEditorKind,
  target: { id: string; baseUrl: string }
) => Promise<{ ok: boolean; error?: string }>;

// 跨族凭据引用的编辑器内联动作（票 provider-onboarding-consistency/07、08）：
// 消费族编辑器（伴看 Gemini Live / 搜索 DeepSeek）内展示 AI 族凭据四态（无记录 /
// 缺 Key / 非官方地址 / 可用）的状态文案与对应动作。动作把编辑会话同层切换到 AI 族
// 编辑器（复用同一宿主，不加可见 Modal 层），保存或取消后由装配方凭暂存草稿恢复
// 原消费族编辑器。actionLabel / onAction 缺省 = 纯状态行（「可用」态无动作）。
export interface LinkedCredentialAction {
  statusText: string;
  actionLabel?: string;
  onAction?: () => void;
}

export interface ProviderEditorOpenOptions {
  kind: ProviderEditorKind;
  // 编辑目标（后端权威列表项，含 hasSavedKey）；缺省 = 新增空白
  item?: ProviderRowItem | null;
  presetId?: string;
  presets: readonly ProviderRowPreset[];
  mountHost?: HTMLElement;
  onSave: ProviderEditorSave;
  // 编辑态的删除入口（Modal 头部警示按钮）；缺省 = 不渲染删除按钮
  onDelete?: ProviderEditorDelete;
  // 首配模式（票 provider-onboarding-consistency/01，概览「去设置」直达流程）：
  // 保存钮文案、AI 族强制至少一个模型、保存成功后与编辑器会话结束两个回调。
  submitLabel?: string;
  firstSetup?: boolean;
  onAfterSave?: (() => void) | null;
  onSessionEnd?: (() => void) | null;
  // 跨族凭据往返流程改口「返回消费族平台」
  cancelLabel?: string;
  // 恢复草稿（票 07/08）：显式给定初始草稿与 dirty 基线（跨族凭据往返后恢复原
  // 消费族草稿）；缺省 = 由编辑目标/预设推导初稿、打开即基线
  initialDraft?: EditorDraft;
  baselineDraft?: EditorDraftView | null;
  // 跨族凭据引用的内联状态行 + 动作（伴看 Gemini Live / 搜索 DeepSeek 编辑器传入）
  linkedCredential?: LinkedCredentialAction | null;
  // 动态凭据引用解析回调（优先级高于静态 linkedCredential，新建或切预设时实时重算）
  resolveLinkedCredential?: ((draft: EditorDraftView) => LinkedCredentialAction | null) | null;
  // 首配或跨族往返时的上下文引导文案（展示在 Modal 表单顶部）
  setupContextBanner?: string | null;
  // 打开即显示的初始状态行（如跨族凭据返回提示）
  initialStatus?: { message: string; isError?: boolean } | null;
}

// 会话控制字段：对外只读（写入走下面的意图级原语）。
export interface EditorState {
  readonly open: boolean;
  readonly kind: ProviderEditorKind;
  readonly editingId: string;
  readonly hasSavedKey: boolean;
  // 打开时锚定的已存列表项 baseUrl（删除回收 orphan origin 的目标地址；同时用于编辑态改 origin 防呆）
  readonly openBaseUrl: string;
  // 打开时锚定的已存列表项 presetId（编辑态换预设时防将旧平台密钥静默发往新端点）
  readonly openPresetId: string;
  // 打开参数直达（collectUpsert / runTest / 预设切换读取）
  readonly presets: readonly ProviderRowPreset[];
  readonly onSave: ProviderEditorSave;
  readonly onDelete: ProviderEditorDelete | null;
  // 首配模式（票 01）：保存钮文案（投影读 open 参数，不入袋）、AI 至少一个模型、
  // 保存成功后回调（先消费续跑意图再关 Modal）与会话结束回调（取消/删除收场清意图）
  readonly firstSetup: boolean;
  readonly onAfterSave: (() => void) | null;
  readonly onSessionEnd: (() => void) | null;
  // 跨族凭据引用内联动作（票 07）：伴看 Gemini 编辑器的四态状态行 + 同层切到
  // AI 族编辑器的动作；会话结束清空
  readonly linkedCredential: LinkedCredentialAction | null;
  readonly resolveLinkedCredential: ((draft: EditorDraftView) => LinkedCredentialAction | null) | null;
  readonly setupContextBanner: string | null;
  // 编辑草稿与打开时的基线（dirty = 逐字段对比，见 draftsEqual）
  readonly draft: EditorDraftView | null;
  readonly baselineDraft: EditorDraftView | null;
  // 代际号：测试探针/保存回执落定前比对，Modal 已关/已重开则丢弃过期回执
  readonly generation: number;
  readonly host: HTMLElement | null;
  // 平台音色列表（MOSS-LIVE 编辑器下拉的数据源）：每次打开 Modal 取一次，
  // voicesLoaded 标记「本次会话已取过」，避免预设切换时重复请求。
  readonly voices: readonly LiveVoice[];
  readonly voicesLoaded: boolean;
}

type MutableEditorState = { -readonly [K in keyof EditorState]: EditorState[K] };

const bag: MutableEditorState = {
  open: false,
  kind: "ai",
  editingId: "",
  hasSavedKey: false,
  openBaseUrl: "",
  openPresetId: "",
  presets: [],
  onSave: async () => ({ ok: false, error: "保存回调未注入" }),
  onDelete: null,
  firstSetup: false,
  onAfterSave: null,
  onSessionEnd: null,
  linkedCredential: null,
  resolveLinkedCredential: null,
  setupContextBanner: null,
  draft: null,
  baselineDraft: null,
  generation: 0,
  host: null,
  voices: [],
  voicesLoaded: false
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
  openPresetId?: string;
  hasSavedKey?: boolean;
  draft: EditorDraft;
  // 缺省 = cloneDraft(draft)（打开即基线）；显式 null = 无基线（手工挂载的测试）
  baselineDraft?: EditorDraftView | null;
  firstSetup?: boolean;
  onAfterSave?: (() => void) | null;
  onSessionEnd?: (() => void) | null;
  linkedCredential?: LinkedCredentialAction | null;
  resolveLinkedCredential?: ((draft: EditorDraftView) => LinkedCredentialAction | null) | null;
  setupContextBanner?: string | null;
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
  bag.openPresetId = init.openPresetId ?? init.draft.presetId ?? "";
  bag.hasSavedKey = Boolean(init.hasSavedKey);
  bag.firstSetup = init.firstSetup === true;
  bag.onAfterSave = init.onAfterSave ?? null;
  bag.onSessionEnd = init.onSessionEnd ?? null;
  bag.linkedCredential = init.linkedCredential ?? null;
  bag.resolveLinkedCredential = init.resolveLinkedCredential ?? null;
  bag.setupContextBanner = init.setupContextBanner?.trim() || null;
  bag.draft = init.draft;
  bag.baselineDraft = init.baselineDraft === undefined ? cloneDraft(init.draft) : init.baselineDraft;
  bag.voices = [];
  bag.voicesLoaded = false;
}

// 结束会话（幂等）：代际作废在飞回执、摘宿主与观察器、清草稿。首配模式的会话
// 结束回调最后结算（取消/删除/强制关闭路径由装配方作废未消费的首配续跑意图；
// 保存成功路径此时意图已被消费，回调落到空槽）。
export function endEditorSession(): void {
  const onSessionEnd = bag.onSessionEnd;
  bag.generation += 1;
  bag.open = false;
  bag.firstSetup = false;
  bag.openBaseUrl = "";
  bag.openPresetId = "";
  bag.onAfterSave = null;
  bag.onSessionEnd = null;
  bag.linkedCredential = null;
  bag.resolveLinkedCredential = null;
  bag.setupContextBanner = null;
  sessionObserver.observer?.disconnect();
  sessionObserver.observer = null;
  bag.host?.remove();
  bag.host = null;
  bag.draft = null;
  bag.baselineDraft = null;
  if (onSessionEnd) {
    try {
      onSessionEnd();
    } catch {
      // 装配方回调异常不得阻断 Modal 收场
    }
  }
}

// 草稿写入的唯一入口：会话未开/无草稿时静默忽略。
export function editDraft(mutate: (draft: EditorDraft) => void): void {
  if (bag.draft) {
    mutate(bag.draft as EditorDraft);
  }
}

// 音色列表落位（每次 Modal 会话只取一次；成败都只经历一次，见 markEditorVoicesLoaded）。
export function applyEditorVoices(voices: readonly LiveVoice[]): void {
  bag.voices = voices.map((voice) => ({ id: voice.id, name: voice.name || voice.id }));
  bag.voicesLoaded = true;
}

// 取值失败也记为「本次会话已尝试」：音色列表只在打开设置时请求一次，
// 失败不重试，重开 Modal 再取。
export function markEditorVoicesLoaded(): void {
  bag.voicesLoaded = true;
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

export interface OriginPreflightBranches<T> extends SessionBranches<T> {
  denied?: (error: string) => void;
  beforeWork?: () => void;
  workAlive?: () => boolean;
}

export interface EditorSessionHandle {
  isCurrent(): boolean;
  run<T>(work: () => Promise<T> | T, branches: SessionBranches<T>): Promise<void>;
  runWithOriginPreflight<T>(
    urls: readonly string[],
    work: () => Promise<T> | T,
    branches: OriginPreflightBranches<T>,
    requestOrigins?: (urls: string[]) => Promise<{ ok: boolean; error?: string }>
  ): Promise<void>;
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
    },
    runWithOriginPreflight<T>(
      urls: readonly string[],
      work: () => Promise<T> | T,
      branches: OriginPreflightBranches<T>,
      requestOrigins = requestProviderOriginsViaBackground
    ): Promise<void> {
      const permissionPromise = requestOrigins([...urls]);
      return (async () => {
        let permission: { ok: boolean; error?: string };
        try {
          permission = await permissionPromise;
        } catch (error) {
          if (!isCurrent()) return;
          if (branches.fail) {
            branches.fail(error);
          } else {
            throw error;
          }
          return;
        }
        if (!isCurrent()) return;
        if (!permission.ok) {
          if (branches.workAlive && !branches.workAlive()) return;
          if (branches.denied) {
            branches.denied(permission.error || "未取得该平台域名权限，无法继续");
          } else if (branches.fail) {
            branches.fail(new Error(permission.error || "未取得该平台域名权限，无法继续"));
          }
          return;
        }
        if (branches.beforeWork) {
          branches.beforeWork();
        }
        let value: T;
        try {
          value = await work();
        } catch (error) {
          if (!isCurrent() || (branches.workAlive && !branches.workAlive())) return;
          if (!branches.fail) throw error;
          branches.fail(error);
          return;
        }
        if (!isCurrent() || (branches.workAlive && !branches.workAlive())) return;
        branches.ok(value);
      })();
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

export function runWithOriginPreflight<T>(
  urls: readonly string[],
  work: () => Promise<T> | T,
  branches: OriginPreflightBranches<T>,
  alive?: () => boolean,
  requestOrigins?: (urls: string[]) => Promise<{ ok: boolean; error?: string }>
): Promise<void> {
  return captureSession(alive).runWithOriginPreflight(urls, work, branches, requestOrigins);
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
