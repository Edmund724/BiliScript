// extension/ui/gemini-credential-link.ts — 伴看 Gemini Live ↔ AI 族凭据的同层往返编排
//（票 provider-onboarding-consistency/07）。
//
// 伴看侧 Gemini Live 没有自有 Key 输入框，Key 单向实时引用 AI 族「第一条启用、
// gemini 预设且官方 HTTPS 端点」的记录（单一真源在 core/ai-credential-reference）。
// 本模块把「在伴看编辑器里进入官方 Gemini Key 配置、再返回原伴看草稿」的编排收
// 成一份，视频页设置面板（settings-panel）与直播间伴看设置（live-provider-settings）
// 两个宿主共用：
//
//   1. resolveGeminiCredentialPlan：四态解析（ok / no-record / no-key / unofficial），
//      判定口径与列表行 annotate 同源（同函数，不换第二份判据）；
//   2. geminiLinkedCredential：伴看编辑器内联凭据行的文案与动作标签（四态各配
//      动作；「可用」态只读无按钮）；
//   3. stashLiveEditorDraft：动作点击时暂存当前打开的伴看编辑会话（草稿 + dirty
//      基线 + 编辑目标 id），供往返后恢复；
//   4. enterGeminiCredentialEditor：同层打开 AI 族编辑器——缺 Key / 可用编辑实际
//      引用记录并聚焦 Key；无记录 / 非官方地址新建独立官方 Gemini 记录（不静默
//      改写仍可能服务其他任务的中转地址）；有暂存时提交钮「保存并返回伴看平台」、
//      取消钮「返回伴看平台」，保存成功或取消都会话结束（onSessionEnd）后由宿主
//      reopenLiveEditor 恢复原伴看草稿。
//
// 宿主的差异（行装载/事务/宿主元素/重渲）经 deps 注入；本模块零 DOM 全局访问，
// 编辑器会话切换复用 provider-editor 的既有单例（openProviderEditor 开头幂等
// 作废旧会话），不增加可见 Modal 层。

import {
  getAiCredentialStatusText,
  resolveAiCredentialReference,
  type AiCredentialStatus
} from "../core/ai-credential-reference.js";
import {
  cloneDraft,
  state as editorState,
  type EditorDraft,
  type EditorDraftView,
  type LinkedCredentialAction,
  type ProviderEditorDelete,
  type ProviderEditorSave
} from "./provider-editor-state.js";
import type { ProviderRowItem, ProviderRowPreset } from "./provider-row.js";

// ===== 四态解析 =====

export interface GeminiCredentialPlan {
  status: AiCredentialStatus;
  record: ProviderRowItem | null;
}

export function resolveGeminiCredentialPlan(
  aiProviders: readonly ProviderRowItem[] | null | undefined
): GeminiCredentialPlan {
  return resolveAiCredentialReference("gemini-live", aiProviders);
}

// 各态对应的内联动作标签；「可用」态返回 null（纯状态行，无动作）。
export function geminiCredentialActionLabel(status: AiCredentialStatus): string | null {
  switch (status) {
    case "no-record":
      return "配置官方 Gemini Key";
    case "no-key":
      return "填写 AI Key";
    case "unofficial":
      return "新建独立官方记录";
    default:
      return null;
  }
}

// 伴看编辑器内联凭据行：状态文案（四态）+ 动作（除「可用」外）。onAction 由宿主
// 注入（进入同层 AI 编辑器往返）。
export function geminiLinkedCredential(
  plan: GeminiCredentialPlan,
  onAction: () => void
): LinkedCredentialAction {
  const label = geminiCredentialActionLabel(plan.status);
  return {
    statusText: getAiCredentialStatusText("gemini-live", plan.status),
    ...(label ? { actionLabel: label, onAction } : {})
  };
}

// ===== 伴看草稿暂存 =====

export interface LiveEditorStash {
  editingId: string;
  draft: EditorDraft;
  baseline: EditorDraftView | null;
}

// 动作点击时暂存当前打开的伴看编辑会话。草稿与 dirty 基线都深拷贝——往返后恢复
// 的编辑器要保留原 dirty 判定（Esc/外点的逐层退出与确认框按既有规则结算）。
// 会话未开 / 非伴看 / 无草稿时返回 null（无草稿可恢复，AI 编辑器不带返回语义）。
export function stashLiveEditorDraft(kind: "live"): LiveEditorStash | null {
  if (!editorState.open || editorState.kind !== kind || !editorState.draft || !editorState.host) {
    return null;
  }
  return {
    editingId: editorState.editingId,
    draft: cloneDraft(editorState.draft),
    baseline: editorState.baselineDraft ? cloneDraft(editorState.baselineDraft) : null
  };
}

// ===== 同层进入 AI 族凭据编辑器 =====

export interface EnterGeminiCredentialDeps {
  plan: GeminiCredentialPlan;
  mountHost?: HTMLElement | null;
  aiPresets: readonly ProviderRowPreset[];
  onSave: ProviderEditorSave;
  onDelete?: ProviderEditorDelete;
  // 有暂存 = 从伴看编辑器进入：保存/取消后由宿主恢复伴看草稿
  stash?: LiveEditorStash | null;
  // AI 会话结束（保存成功或取消/强制关闭）后的恢复出口；hint 非空 = 保存成功，
  // 提示仍需显式保存伴看记录
  reopenLiveEditor?: (stash: LiveEditorStash, hint: string | null) => void;
}

export const GEMINI_AI_PRESET_ID = "gemini";

export async function enterGeminiCredentialEditor(
  deps: EnterGeminiCredentialDeps
): Promise<typeof import("./provider-editor.js")> {
  const editorModule = await import("./provider-editor.js");
  const { openProviderEditor } = editorModule;
  // 缺 Key / 可用：编辑实际引用的 AI 记录；无记录 / 非官方地址：新建独立官方
  // Gemini 记录（presetId 预置官方端点，不改写引用不到的中转记录）
  const editingRecord = deps.plan.status === "no-key" || deps.plan.status === "ok"
    ? deps.plan.record
    : null;
  const stash = deps.stash && deps.reopenLiveEditor ? deps.stash : null;
  let saved = false;
  openProviderEditor({
    kind: "ai",
    item: editingRecord,
    ...(editingRecord ? {} : { presetId: GEMINI_AI_PRESET_ID }),
    presets: deps.aiPresets,
    mountHost: deps.mountHost ?? undefined,
    onSave: deps.onSave,
    onDelete: deps.onDelete,
    // 往返语义：保存钮 / 取消钮都明确「返回伴看平台」；无暂存（横幅直达）保持默认文案
    ...(stash ? { submitLabel: "保存并返回伴看平台", cancelLabel: "返回伴看平台" } : {}),
    onAfterSave: stash
      ? () => {
          saved = true;
        }
      : null,
    onSessionEnd: stash
      ? () => {
          deps.reopenLiveEditor?.(stash, saved ? "AI Key 已保存，请继续保存伴看平台记录" : null);
        }
      : null
  });
  // 缺 Key / 无记录 / 非官方都落在 Key 输入框（新增态聚焦待填项，与既有直达
  // 入口行为一致）
  (deps.mountHost ?? document)
    .querySelector<HTMLInputElement>(".provider-editor-apikey")
    ?.focus({ preventScroll: true });
  return editorModule;
}
