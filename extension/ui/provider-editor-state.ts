import { requestProviderOriginsViaBackground } from "../core/host-permissions.js";
import type { AiProtocol } from "../ai/protocol-vocab.js";
import type { LiveVoice } from "../live/live-provider-store.js";
import type { ProviderRowItem, ProviderRowPreset } from "./provider-row.js";
import { animateTriggerExit } from "./trigger-motion.js";

export type ProviderEditorKind = "ai" | "asr" | "search" | "live";

export interface EditorDraft {
  presetId: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  protocol: AiProtocol | "";
  models: string[];
  model: string;
  liveGeminiNativeSearch?: boolean;
  voiceId?: string;
}

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

export type ProviderEditorSave = (
  kind: ProviderEditorKind,
  upsert: ProviderRowItem
) => Promise<{ ok: boolean; error?: string; permissionDenied?: boolean }>;

export type ProviderEditorDelete = (
  kind: ProviderEditorKind,
  target: { id: string; baseUrl: string }
) => Promise<{ ok: boolean; error?: string }>;

export interface LinkedCredentialAction {
  statusText: string;
  actionLabel?: string;
  onAction?: () => void;
}

export interface ProviderEditorOpenOptions {
  kind: ProviderEditorKind;
  item?: ProviderRowItem | null;
  presetId?: string;
  presets: readonly ProviderRowPreset[];
  mountHost?: HTMLElement;
  onSave: ProviderEditorSave;
  onDelete?: ProviderEditorDelete;
  submitLabel?: string;
  firstSetup?: boolean;
  onAfterSave?: (() => void) | null;
  onSessionEnd?: (() => void) | null;
  cancelLabel?: string;
  initialDraft?: EditorDraft;
  baselineDraft?: EditorDraftView;
  linkedCredential?: LinkedCredentialAction | null;
  resolveLinkedCredential?: ((draft: EditorDraftView) => LinkedCredentialAction | null) | null;
  setupContextBanner?: string | null;
  initialStatus?: { message: string; isError?: boolean } | null;
  initialFocusField?: "apiKey" | "models";
}

export interface EditorState {
  readonly open: boolean;
  readonly kind: ProviderEditorKind;
  readonly editingId: string;
  readonly hasSavedKey: boolean;
  readonly openBaseUrl: string;
  readonly openPresetId: string;
  readonly presets: readonly ProviderRowPreset[];
  readonly onSave: ProviderEditorSave;
  readonly onDelete: ProviderEditorDelete | null;
  readonly firstSetup: boolean;
  readonly onAfterSave: (() => void) | null;
  readonly onSessionEnd: (() => void) | null;
  readonly linkedCredential: LinkedCredentialAction | null;
  readonly resolveLinkedCredential: ((draft: EditorDraftView) => LinkedCredentialAction | null) | null;
  readonly setupContextBanner: string | null;
  readonly draft: EditorDraftView | null;
  readonly baselineDraft: EditorDraftView | null;
  readonly generation: number;
  readonly host: HTMLElement | null;
  readonly trigger: Element | null;
  readonly voices: readonly LiveVoice[];
  readonly voicesLoaded: boolean;
}

type MutableEditorState = {
  -readonly [K in keyof EditorState]: K extends "draft" ? EditorDraft | null : EditorState[K];
};

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
  trigger: null,
  voices: [],
  voicesLoaded: false
};

export const state: Readonly<EditorState> = bag;

export interface EditorSessionInit {
  kind: ProviderEditorKind;
  host?: HTMLElement | null;
  trigger?: Element | null;
  presets?: readonly ProviderRowPreset[];
  onSave?: ProviderEditorSave;
  onDelete?: ProviderEditorDelete | null;
  editingId?: string;
  openBaseUrl?: string;
  openPresetId?: string;
  hasSavedKey?: boolean;
  draft: EditorDraft;
  baselineDraft?: EditorDraftView;
  firstSetup?: boolean;
  onAfterSave?: (() => void) | null;
  onSessionEnd?: (() => void) | null;
  linkedCredential?: LinkedCredentialAction | null;
  resolveLinkedCredential?: ((draft: EditorDraftView) => LinkedCredentialAction | null) | null;
  setupContextBanner?: string | null;
}

export function beginEditorSession(init: EditorSessionInit): void {
  bag.open = true;
  bag.kind = init.kind;
  bag.host = init.host ?? null;
  bag.trigger = init.trigger ?? null;
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
  bag.baselineDraft = cloneDraft(init.baselineDraft ?? init.draft);
  bag.voices = [];
  bag.voicesLoaded = false;
}

export function endEditorSession(): void {
  const onSessionEnd = bag.onSessionEnd;
  const closingHost = bag.host;
  const closingTrigger = bag.trigger;
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
  bag.host = null;
  bag.trigger = null;
  bag.draft = null;
  bag.baselineDraft = null;
  if (closingHost) {
    const dialog = closingHost.querySelector<HTMLElement>(".provider-editor-dialog");
    const mask = closingHost.querySelector<HTMLElement>(".provider-editor-mask");
    if (dialog) {
      animateTriggerExit({
        target: dialog,
        host: closingHost,
        mask,
        trigger: closingTrigger,
        fallbackOrigin: "top right",
        toScale: 0.94,
        durationMs: 140,
        onFinish: () => closingHost.remove()
      });
    } else {
      closingHost.remove();
    }
  }
  if (onSessionEnd) {
    try {
      onSessionEnd();
    } catch {
    }
  }
}

export function editDraft(mutate: (draft: EditorDraft) => void): void {
  if (bag.draft) {
    mutate(bag.draft);
  }
}

export function applyEditorVoices(voices: readonly LiveVoice[]): void {
  bag.voices = voices.map((voice) => ({ id: voice.id, name: voice.name || voice.id }));
  bag.voicesLoaded = true;
}

export function markEditorVoicesLoaded(): void {
  bag.voicesLoaded = true;
}

export interface SessionBranches<T> {
  ok: (value: T) => void;
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

export function getDialog(): HTMLElement | null {
  if (!state.host) return null;
  return state.host.querySelector<HTMLElement>(".provider-editor-dialog");
}
