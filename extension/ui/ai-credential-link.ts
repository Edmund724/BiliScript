// extension/ui/ai-credential-link.ts — 消费族（伴看 Gemini Live / 搜索 DeepSeek）与
// AI 族凭据的同层往返编排。
//
// 伴看 Gemini Live 与搜索 DeepSeek 都不设自有 Key 输入框，Key 单向实时引用 AI 族
// 「第一条启用、对应 presetId 且官方 HTTPS 端点」的记录（单一真源在
// core/ai-credential-reference）。本模块收口四态文案、动作生成及同层打开 AI 平台
// 编辑器的往返会话配置；编辑器草稿暂存由 provider-editor 的 stashProviderEditorDraft
// 完成，本模块零 DOM 全局访问，并始终保留单层 Modal 语义。

import {
  getAiCredentialSourceLabel,
  getAiCredentialStatusText,
  resolveAiCredentialReference,
  type AiCredentialReferenceTarget,
  type AiCredentialStatus
} from "../core/ai-credential-reference.js";
import type {
  EditorDraftView,
  LinkedCredentialAction,
  ProviderEditorDelete,
  ProviderEditorDraftStash,
  ProviderEditorSave
} from "./provider-editor.js";
import type { ProviderRowItem, ProviderRowPreset } from "./provider-row.js";

// ===== 目标档：两族共用编排的唯一差异面 =====

export type AiCredentialLinkTarget = AiCredentialReferenceTarget;

interface AiCredentialLinkProfile {
  // 消费族称呼（往返文案：「保存并返回伴看平台」/「返回搜索平台」）
  consumerLabel: string;
  // 无记录 / 非官方地址时新建独立记录预置的 AI 预设 id
  aiPresetId: string;
  // 四态动作标签；「可用」态恒无动作
  actionLabels: Readonly<Record<Exclude<AiCredentialStatus, "ok">, string>>;
  // 「可用」态是否展示实际命中的来源（DeepSeek 搜索：多条官方记录时指出生效的
  // 那一条；伴看保持既有文案不变）
  showSource: boolean;
}

const AI_CREDENTIAL_LINK_PROFILES: Readonly<
  Record<AiCredentialLinkTarget, AiCredentialLinkProfile>
> = {
  deepseek: {
    consumerLabel: "搜索平台",
    aiPresetId: "deepseek",
    actionLabels: {
      "no-record": "配置官方 DeepSeek Key",
      "no-key": "填写 AI Key",
      unofficial: "新建独立官方记录"
    },
    showSource: true
  },
  "gemini-live": {
    consumerLabel: "伴看平台",
    aiPresetId: "gemini",
    actionLabels: {
      "no-record": "配置官方 Gemini Key",
      "no-key": "填写 AI Key",
      unofficial: "新建独立官方记录"
    },
    showSource: false
  }
};

// ===== 四态解析 =====

export interface AiCredentialPlan {
  status: AiCredentialStatus;
  record: ProviderRowItem | null;
}

export function linkedCredentialTargetForDraft(
  kind: "live" | "search",
  draft: Pick<EditorDraftView, "presetId">
): AiCredentialLinkTarget | null {
  const presetId = String(draft?.presetId || "").trim();
  if (kind === "live" && presetId === "gemini-live") return "gemini-live";
  if (kind === "search" && presetId === "deepseek") return "deepseek";
  return null;
}

export function resolveAiCredentialPlan(
  target: AiCredentialLinkTarget,
  aiProviders: readonly ProviderRowItem[] | null | undefined
): AiCredentialPlan {
  return resolveAiCredentialReference(target, aiProviders);
}

// 各态对应的内联动作标签；「可用」态返回 null（纯状态行，无动作）。
function aiCredentialActionLabel(
  target: AiCredentialLinkTarget,
  status: AiCredentialStatus
): string | null {
  if (status === "ok") return null;
  return AI_CREDENTIAL_LINK_PROFILES[target].actionLabels[status];
}

// 消费族编辑器内联凭据行：状态文案（四态）+ 动作（除「可用」外）。onAction 由
// 宿主注入（进入同层 AI 编辑器往返）。
export function linkedCredentialFor(
  target: AiCredentialLinkTarget,
  plan: AiCredentialPlan,
  onAction: () => void
): LinkedCredentialAction {
  const profile = AI_CREDENTIAL_LINK_PROFILES[target];
  const statusText = getAiCredentialStatusText(target, plan.status);
  const source = profile.showSource && plan.status === "ok" && plan.record
    ? getAiCredentialSourceLabel(target, plan.record)
    : "";
  const label = aiCredentialActionLabel(target, plan.status);
  return {
    statusText: source ? `${statusText} · ${source}` : statusText,
    ...(label ? { actionLabel: label, onAction } : {})
  };
}

// ===== 同层进入 AI 族凭据编辑器 =====

export interface EnterAiCredentialDeps {
  target: AiCredentialLinkTarget;
  plan: AiCredentialPlan;
  mountHost?: HTMLElement | null;
  aiPresets: readonly ProviderRowPreset[];
  onSave: ProviderEditorSave;
  onDelete?: ProviderEditorDelete;
  // 有暂存 = 从消费族编辑器进入：保存/取消后由宿主恢复原草稿
  stash?: ProviderEditorDraftStash | null;
  // AI 会话结束（保存成功或取消/强制关闭）后的恢复出口；hint 非空 = 保存成功，
  // 提示仍需显式保存消费族记录
  reopenConsumerEditor?: (stash: ProviderEditorDraftStash, hint: string | null) => void;
}

export async function enterAiCredentialEditor(
  deps: EnterAiCredentialDeps
): Promise<typeof import("./provider-editor.js")> {
  const profile = AI_CREDENTIAL_LINK_PROFILES[deps.target];
  const editorModule = await import("./provider-editor.js");
  const { openProviderEditor } = editorModule;
  // 缺 Key / 可用：编辑实际引用的 AI 记录；无记录 / 非官方地址：新建独立官方
  // 记录（presetId 预置官方端点，不改写引用不到的中转记录）
  const editingRecord = deps.plan.status === "no-key" || deps.plan.status === "ok"
    ? deps.plan.record
    : null;
  const stash = deps.stash && deps.reopenConsumerEditor ? deps.stash : null;
  let saved = false;
  openProviderEditor({
    kind: "ai",
    item: editingRecord,
    ...(editingRecord ? {} : { presetId: profile.aiPresetId }),
    presets: deps.aiPresets,
    mountHost: deps.mountHost ?? undefined,
    onSave: deps.onSave,
    onDelete: deps.onDelete,
    initialFocusField: "apiKey",
    // 往返语义：保存钮 / 取消钮都明确「返回消费族平台」；无暂存（横幅直达）保持默认文案
    ...(stash
      ? {
          submitLabel: `保存并返回${profile.consumerLabel}`,
          cancelLabel: `返回${profile.consumerLabel}`
        }
      : {}),
    onAfterSave: stash
      ? () => {
          saved = true;
        }
      : null,
    onSessionEnd: stash
      ? () => {
          deps.reopenConsumerEditor?.(
            stash,
            saved ? `AI Key 已保存，请继续保存${profile.consumerLabel}记录` : null
          );
        }
      : null
  });
  return editorModule;
}
