import { DEFAULT_SEARCH_PROVIDER_PRESET, type SearchProviderPreset } from "../core/presets.js";
import { SMART_SEARCH_ACTIVE_ID } from "../core/search-mode.js";
import { validateAiProviders } from "../core/validators.js";
import type { AiProtocol } from "../ai/protocol-vocab.js";
import { resolveMossLivePermissionOrigins } from "../live/moss-live-protocol.js";
import type { ProviderEditorKind } from "./provider-editor.js";
import {
  buildActiveRadioTail,
  createProviderRow,
  type ActiveRadioChangeHandler,
  type ActiveRadioTailConfig,
  type ProviderRowController,
  type ProviderRowItem,
  type ProviderRowPreset,
  type ProviderRowVirtualRow
} from "./provider-row.js";

export interface EditorUpsertFields {
  id: string;
  preset: ProviderRowPreset | null;
  name: string;
  baseUrl: string;
  apiKey: string;
  hasSavedKey: boolean;
  models: string[];
  model: string;
  protocol: AiProtocol;
  liveGeminiNativeSearch?: boolean;
  voiceId?: string;
}

export interface FamilyEditorDeclaration {
  title: string;
  defaultPresetId: (presets: readonly ProviderRowPreset[]) => string;
  apiKeyPlaceholder: (preset: ProviderRowPreset | null, hasSavedKey: boolean) => string;
  isKeyRequired: (preset: ProviderRowPreset | null) => boolean;
  accessBadge: (preset: ProviderRowPreset | null, hasSavedKey: boolean) => string;
  modelSource: "catalog" | "input" | "none";
  usesProtocol: boolean;
  supportsPlatformTest: boolean;
  resolvePermissionOrigins: (baseUrl: string, model?: string) => string[];
  serializeUpsert: (fields: EditorUpsertFields) => { upsert: ProviderRowItem; validationError?: string };
}

function presetKeyRequired(preset: ProviderRowPreset | null): boolean {
  return preset?.requiresKey !== false;
}

function defaultPermissionOrigins(baseUrl: string): string[] {
  return [baseUrl];
}

interface FamilyRowDeclaration {
  rowClass: string;
  editClass: string;
  removeClass: string;
  idPrefix: string;
  resolvePreset: (presets: readonly ProviderRowPreset[], presetId: string) => ProviderRowPreset | null;
  displayName: (item: ProviderRowItem, preset: ProviderRowPreset | null) => string;
  displayModel: (item: ProviderRowItem, preset: ProviderRowPreset | null) => string;
  activeRadio?: ActiveRadioTailConfig;
  dragHandleClass?: string;
  virtualRow?: ProviderRowVirtualRow;
  buildTailFields?: (ctx: { id: string; isActive: boolean }) => string;
  editor: FamilyEditorDeclaration;
}

const AI_FAMILY: FamilyRowDeclaration = {
  rowClass: "ai-provider-row",
  editClass: "provider-row-edit",
  removeClass: "provider-row-remove",
  idPrefix: "p_",
  resolvePreset: (presets, presetId) => presets.find((p) => p.id === presetId) || presets[presets.length - 1],
  displayName: (item, preset) => String(item.name || preset?.name || "自定义"),
  displayModel: () => "",
  editor: {
    title: "AI 平台",
    defaultPresetId: () => "custom",
    apiKeyPlaceholder: (preset, hasSavedKey) => {
      const requiresKey = presetKeyRequired(preset);
      return hasSavedKey ? "已保存" : (requiresKey ? "API Key" : "API Key（可选）");
    },
    isKeyRequired: presetKeyRequired,
    accessBadge: () => "",
    modelSource: "catalog",
    usesProtocol: true,
    supportsPlatformTest: false,
    resolvePermissionOrigins: defaultPermissionOrigins,
    serializeUpsert: ({ id, preset, name, baseUrl, apiKey, hasSavedKey, models, protocol }) => {
      const upsert: ProviderRowItem = {
        id,
        presetId: preset?.id || "custom",
        name,
        baseUrl,
        models,
        requiresKey: preset?.requiresKey !== false,
        enabled: true,
        apiKey,
        hasSavedKey,
        protocol
      };
      const validation = validateAiProviders([upsert]);
      return validation.ok ? { upsert } : { upsert, validationError: validation.message };
    }
  }
};

const ASR_FAMILY: FamilyRowDeclaration = {
  rowClass: "asr-provider-row",
  editClass: "provider-row-edit",
  removeClass: "provider-row-remove",
  idPrefix: "asr_",
  resolvePreset: (presets, presetId) => presets.find((p) => p.id === presetId) || null,
  displayName: (item, preset) => String(item.name || preset?.name || "自定义"),
  displayModel: (item, preset) => String(item.model ?? preset?.model ?? ""),
  activeRadio: {
    classPrefix: "asr",
    title: "选用该平台自动生成字幕",
    settingsKey: "activeAsrProviderId"
  },
  editor: {
    title: "语音转写平台",
    defaultPresetId: (presets) => presets.find((p) => p.id === "siliconflow-sensevoice")?.id || "siliconflow-sensevoice",
    apiKeyPlaceholder: (_preset, hasSavedKey) => (hasSavedKey ? "已保存" : "API Key"),
    isKeyRequired: presetKeyRequired,
    accessBadge: () => "",
    modelSource: "input",
    usesProtocol: false,
    supportsPlatformTest: true,
    resolvePermissionOrigins: defaultPermissionOrigins,
    serializeUpsert: ({ id, preset, name, baseUrl, apiKey, hasSavedKey, model }) => ({
      upsert: {
        id,
        presetId: preset?.id || "custom",
        name,
        type: preset?.type || "openai-transcriptions",
        baseUrl,
        model,
        apiKey,
        hasSavedKey
      }
    })
  }
};

function searchKeyRequired(preset: ProviderRowPreset | null): boolean {
  return (preset as SearchProviderPreset | null)?.access === "free-quota";
}

function searchAccessBadge(preset: ProviderRowPreset | null, hasSavedKey: boolean): string {
  const access = (preset as SearchProviderPreset | null)?.access;
  if (access === "keyless") return hasSavedKey ? "已配 Key" : "免 Key";
  if (access === "free-quota") return "免费额度";
  if (access === "paid") return "付费";
  return "";
}

const SEARCH_FAMILY: FamilyRowDeclaration = {
  rowClass: "search-provider-row",
  editClass: "provider-row-edit",
  removeClass: "provider-row-remove",
  idPrefix: "search_",
  resolvePreset: (presets, presetId) => presets.find((p) => p.id === presetId) || null,
  displayName: (item, preset) => String(item.name || preset?.name || "自定义"),
  displayModel: (item, preset) => {
    const note = String(item.statusNote ?? (preset as SearchProviderPreset | null)?.note ?? "");
    const source = String(item.credentialSource || "");
    return [note, source].filter(Boolean).join(" · ");
  },
  activeRadio: {
    classPrefix: "search",
    title: "选用该平台联网搜索",
    settingsKey: "activeSearchProviderId"
  },
  dragHandleClass: "provider-row-drag-handle",
  virtualRow: {
    id: SMART_SEARCH_ACTIVE_ID,
    label: "智能",
    hint: "自动选择可用平台并按顺序回退，自动跳过故障平台"
  },
  editor: {
    title: "搜索平台",
    defaultPresetId: (presets) => presets.find((p) => p.id === "tavily")?.id || "tavily",
    apiKeyPlaceholder: (preset, hasSavedKey) =>
      hasSavedKey ? "已保存" : searchKeyRequired(preset) ? "API Key" : "API Key（可选）",
    isKeyRequired: searchKeyRequired,
    accessBadge: searchAccessBadge,
    modelSource: "none",
    usesProtocol: false,
    supportsPlatformTest: true,
    resolvePermissionOrigins: defaultPermissionOrigins,
    serializeUpsert: ({ id, preset, name, baseUrl, apiKey, hasSavedKey }) => ({
      upsert: {
        id,
        presetId: preset?.id || DEFAULT_SEARCH_PROVIDER_PRESET.id,
        name,
        type: preset?.type || DEFAULT_SEARCH_PROVIDER_PRESET.type,
        baseUrl,
        apiKey,
        hasSavedKey
      }
    })
  }
};

const LIVE_FAMILY: FamilyRowDeclaration = {
  rowClass: "live-provider-row",
  editClass: "provider-row-edit",
  removeClass: "provider-row-remove",
  idPrefix: "live_",
  resolvePreset: (presets, presetId) => presets.find((p) => p.id === presetId) || presets[0] || null,
  displayName: (item, preset) => String(item.name || preset?.name || "MOSS Live"),
  displayModel: (item, preset) => {
    const model = String(item.model ?? preset?.model ?? "moss-live-1.0");
    return preset?.id === "gemini-live" && item.statusNote ? `${model} · ${item.statusNote}` : model;
  },
  activeRadio: {
    classPrefix: "live",
    title: "选用该平台进行实时伴看",
    settingsKey: "activeLiveProviderId"
  },
  editor: {
    title: "实时伴看平台",
    defaultPresetId: (presets) => presets.find((p) => p.id === "moss-live")?.id || "moss-live",
    apiKeyPlaceholder: (_preset, hasSavedKey) => (hasSavedKey ? "已保存" : "API Key"),
    isKeyRequired: presetKeyRequired,
    accessBadge: () => "",
    modelSource: "input",
    usesProtocol: false,
    supportsPlatformTest: true,
    resolvePermissionOrigins: resolveMossLivePermissionOrigins,
    serializeUpsert: ({ id, preset, name, baseUrl, apiKey, hasSavedKey, model, liveGeminiNativeSearch, voiceId }) => {
      const gemini = preset?.type === "gemini-live" || preset?.id === "gemini-live";
      const trimmedVoiceId = String(voiceId || "").trim();
      return {
        upsert: {
          id,
          presetId: preset?.id || "moss-live",
          name: name || preset?.name || "MOSS Live",
          type: preset?.type || "moss-live",
          baseUrl: baseUrl || preset?.baseUrl || "https://api.mosi.cn",
          model: model || preset?.model || "moss-live-1.0",
          apiKey,
          hasSavedKey,
          ...(gemini ? { liveGeminiNativeSearch: liveGeminiNativeSearch === true } : {}),
          ...(!gemini && trimmedVoiceId ? { voiceId: trimmedVoiceId } : {})
        }
      };
    }
  }
};

export const PROVIDER_FAMILY_ROWS: Record<ProviderEditorKind, FamilyRowDeclaration> = {
  ai: AI_FAMILY,
  asr: ASR_FAMILY,
  search: SEARCH_FAMILY,
  live: LIVE_FAMILY
};

export interface FamilyRowsBinding {
  controller: ProviderRowController;
  render: (
    listNode: HTMLElement,
    emptyNode: HTMLElement,
    items: ProviderRowItem[] | null | undefined,
    options?: { presets?: readonly ProviderRowPreset[]; activeId?: string }
  ) => ProviderRowItem[];
  getActiveId: ((listNode: HTMLElement) => string) | null;
  setActiveChangeHandler: ((handler: ActiveRadioChangeHandler) => void) | null;
  syncActiveRendered: ((listNode: HTMLElement) => void) | null;
}

export interface CreateFamilyRowsDeps {
  onRowEdit: (kind: ProviderEditorKind, providerId: string) => void;
  onRowDelete: (
    kind: ProviderEditorKind,
    target: { id: string; baseUrl: string }
  ) => Promise<{ ok: boolean; error?: string }>;
  getConfirmMountHost?: () => HTMLElement | null;
}

export type ProviderFamilyRows = Record<ProviderEditorKind, FamilyRowsBinding>;

export function createProviderFamilyRows(deps: CreateFamilyRowsDeps): ProviderFamilyRows {
  const entries = (Object.entries(PROVIDER_FAMILY_ROWS) as [ProviderEditorKind, FamilyRowDeclaration][]).map(
    ([kind, decl]) => {
      const activeRadio = decl.activeRadio ? buildActiveRadioTail(decl.activeRadio) : null;
      const rawController = createProviderRow({
        rowClass: decl.rowClass,
        editClass: decl.editClass,
        removeClass: decl.removeClass,
        idPrefix: decl.idPrefix,
        resolvePreset: decl.resolvePreset,
        displayName: decl.displayName,
        displayModel: decl.displayModel,
        resolveBadge: decl.editor.accessBadge,
        dragHandleClass: decl.dragHandleClass,
        virtualRow: decl.virtualRow,
        buildTailFields: decl.buildTailFields ?? activeRadio?.buildTailFields,
        wireTailExtras: activeRadio?.wireTailExtras,
        onRowEdit: (row) => deps.onRowEdit(kind, row.dataset.providerId || ""),
        onRowDelete: (target) => deps.onRowDelete(kind, target),
        getConfirmMountHost: deps.getConfirmMountHost
      });
      const controller: ProviderRowController = {
        ...rawController,
        setErrorHandler(handler) {
          rawController.setErrorHandler(handler);
          activeRadio?.setErrorHandler(handler);
        }
      };
      const render: FamilyRowsBinding["render"] = (listNode, emptyNode, items, options) => {
        const rendered = controller.render(listNode, emptyNode, items, options);
        activeRadio?.syncRendered(listNode);
        return rendered;
      };
      return [
        kind,
        {
          controller,
          render,
          getActiveId: activeRadio?.getActiveId ?? null,
          setActiveChangeHandler: activeRadio
            ? (handler: ActiveRadioChangeHandler) => activeRadio.setActiveChangeHandler(handler)
            : null,
          syncActiveRendered: activeRadio
            ? (listNode: HTMLElement) => activeRadio.syncRendered(listNode)
            : null
        }
      ] as const;
    }
  );
  return Object.fromEntries(entries) as ProviderFamilyRows;
}
