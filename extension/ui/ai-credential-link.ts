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

export type AiCredentialLinkTarget = AiCredentialReferenceTarget;

interface AiCredentialLinkProfile {
  consumerLabel: string;
  aiPresetId: string;
  actionLabels: Readonly<Record<Exclude<AiCredentialStatus, "ok">, string>>;
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

function aiCredentialActionLabel(
  target: AiCredentialLinkTarget,
  status: AiCredentialStatus
): string | null {
  if (status === "ok") return null;
  return AI_CREDENTIAL_LINK_PROFILES[target].actionLabels[status];
}

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

export interface EnterAiCredentialDeps {
  target: AiCredentialLinkTarget;
  plan: AiCredentialPlan;
  mountHost?: HTMLElement | null;
  aiPresets: readonly ProviderRowPreset[];
  onSave: ProviderEditorSave;
  onDelete?: ProviderEditorDelete;
  stash?: ProviderEditorDraftStash | null;
  reopenConsumerEditor?: (stash: ProviderEditorDraftStash, hint: string | null) => void;
}

export async function enterAiCredentialEditor(
  deps: EnterAiCredentialDeps
): Promise<typeof import("./provider-editor.js")> {
  const profile = AI_CREDENTIAL_LINK_PROFILES[deps.target];
  const editorModule = await import("./provider-editor.js");
  const { openProviderEditor } = editorModule;
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
