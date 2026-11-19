// extension/entry/onboarding.ts
// 内置交互式引导页控制器：复用现有主题令牌、AI/ASR 存储与校验、
// 协议适配器与连通性探针、host 权限申请以及联网搜索首次授权闭环。

import { DEFAULT_SETTINGS, type Settings } from "../core/defaults.js";
import {
  ASR_PROVIDER_PRESETS,
  PRESETS,
  normalizeBaseUrl,
  presetBaseUrlForProtocol,
  type AiProviderPreset,
  type AsrProviderPreset
} from "../core/presets.js";
import {
  normalizeReaderPalette,
  normalizeReaderTheme,
  validateAiProviders
} from "../core/validators.js";
import { requestProviderOriginsViaBackground } from "../core/host-permissions.js";
import { PROTOCOL_OPTIONS, resolveAdapter, type AiProtocol } from "../ai/protocol-adapter.js";
import { fetchProviderModels, resolveAiModelListTarget } from "../ai/provider-models.js";
import { testAiProviderConnection } from "../ai/provider-test.js";
import { normalizeAsrProvider, resolveActiveAsrProviderId } from "../asr/asr-provider-normalize.js";
import { testAsrConnection } from "../asr/provider-test.js";
import { resolveWebSearchOptIn } from "../search/opt-in-notice.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { isFirefoxRuntime } from "../shared/runtime-capabilities.js";
import { watchStorageKeys } from "../shared/watch-storage-keys.js";
import type { AsrProviderListEntry, ProviderListEntry } from "../shared/messaging-protocol.js";
import { normalizeProviderModels, resolveCatalogModel } from "../shared/selected-provider.js";
import {
  closeAllCustomSelects,
  initCustomSelect,
  setCustomSelectValue
} from "../ui/custom-select.js";
import { createModelCombobox, type ModelComboboxClasses } from "../ui/model-picker.js";
import { createProviderTransactions } from "../ui/provider-transaction.js";
import type { ProviderRowItem } from "../ui/provider-row.js";
import { initToggleSwitch, syncToggleSwitch } from "../ui/toggle-switch.js";

const ONBOARDING_MODEL_COMBOBOX_CLASSES: ModelComboboxClasses = {
  wrapperSelector: ".model-picker-wrapper",
  openDropdownSelector: ".model-picker-dropdown:not([hidden])",
  triggerSelector: ".model-picker-toggle",
  optionClass: "model-picker-option custom-select-option",
  searchItemClass: "model-picker-search-item",
  searchInputClass: "model-picker-search-input",
  emptyItemClass: "model-picker-message model-picker-empty",
  messageClass: "model-picker-message",
  countClass: "model-picker-count"
};

const DEFAULT_AI_PRESET_ID = "modelscope";
const DEFAULT_ASR_PRESET_ID = "siliconflow-sensevoice";

const SUGGESTED_AI_MODELS: Readonly<Record<string, readonly string[]>> = {
  modelscope: [
    "Qwen/Qwen3-235B-A22B-Instruct-2507",
    "ZhipuAI/GLM-4.6",
    "Qwen/Qwen3-30B-A3B-Instruct-2507"
  ],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  qwen: ["qwen-plus", "qwen-max", "qwen-turbo"],
  zhipu: ["glm-4-plus", "glm-4-flash"],
  moonshot: ["kimi-k2-0905-preview"],
  minimax: ["MiniMax-M2.5"],
  mimo: ["mimo-v2-flash"],
  opencodego: ["glm-5"],
  openrouter: ["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet"],
  stepfun: ["step-2-mini"],
  amd: ["DeepSeek-V4.1-Flash", "Qwen3.8-Flash-Next"],
  sensenova: ["deepseek-v4.1-flash"],
  ollama: ["qwen3:8b"],
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro"]
};

const PRESET_CREDENTIAL_LINKS: Readonly<Record<string, { href: string; label: string; placeholder: string }>> = {
  modelscope: {
    href: "https://modelscope.cn/my/myaccesstoken",
    label: "获取 ModelScope ms- Token ↗",
    placeholder: "ms- 开头的 SDK Token"
  },
  deepseek: {
    href: "https://platform.deepseek.com/api_keys",
    label: "获取 DeepSeek Key ↗",
    placeholder: "sk-..."
  },
  gemini: {
    href: "https://aistudio.google.com/apikey",
    label: "获取 Gemini Key ↗",
    placeholder: "AIza..."
  }
};

function prefersDarkScheme(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
}

function applyRootAppearance(settings: Partial<Settings>): void {
  const root = document.documentElement;
  root.setAttribute("data-biliscript-onboarding", "1");
  const theme = settings.readerThemeUserSet
    ? normalizeReaderTheme(settings.readerTheme)
    : (prefersDarkScheme() ? "dark" : "light");
  const palette = normalizeReaderPalette(settings.readerPalette);
  root.setAttribute("data-theme", theme);
  root.setAttribute("data-palette", palette);
}

function setFieldIssue(input: HTMLInputElement, errorEl: HTMLElement | null, message: string | null): void {
  if (message) {
    input.setAttribute("aria-invalid", "true");
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.hidden = false;
      input.setAttribute("aria-describedby", errorEl.id);
    }
    return;
  }
  input.setAttribute("aria-invalid", "false");
  if (errorEl) {
    errorEl.textContent = "";
    errorEl.hidden = true;
    if (input.getAttribute("aria-describedby") === errorEl.id) {
      input.removeAttribute("aria-describedby");
    }
  }
}

function setStatusLine(
  el: HTMLElement | null,
  message: string,
  tone: "neutral" | "error" | "success" = "neutral"
): void {
  if (!el) return;
  el.textContent = message;
  el.dataset.error = tone === "error" ? "true" : "false";
  el.dataset.success = tone === "success" ? "true" : "false";
}

function bindPasswordToggle(
  input: HTMLInputElement,
  button: HTMLButtonElement | null,
  signal?: AbortSignal
): void {
  if (!button) return;
  button.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    button.setAttribute("aria-pressed", show ? "true" : "false");
    button.textContent = show ? "隐藏" : "显示";
    button.setAttribute("aria-label", show ? "隐藏 API Key" : "显示 API Key");
  }, { signal });
}

function resolveAiPreset(presetId: string): AiProviderPreset {
  return PRESETS.find((p) => p.id === presetId) ?? PRESETS.find((p) => p.id === DEFAULT_AI_PRESET_ID) ?? PRESETS[0];
}

function resolveAsrPreset(presetId: string): AsrProviderPreset {
  return (
    ASR_PROVIDER_PRESETS.find((p) => p.id === presetId) ??
    ASR_PROVIDER_PRESETS.find((p) => p.id === DEFAULT_ASR_PRESET_ID) ??
    ASR_PROVIDER_PRESETS[0]
  );
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export interface OnboardingController {
  refresh(): Promise<void>;
  dispose(): void;
}

const activeMountDisposers = new WeakMap<Document, () => void>();

export async function mountOnboardingPage(doc: Document = document): Promise<OnboardingController> {
  // 清理同文档上一次挂载（例如模块自动挂载后测试再次显式挂载），避免重复绑定事件监听
  activeMountDisposers.get(doc)?.();
  const mountAbort = new AbortController();
  const { signal } = mountAbort;
  let disposed = false;
  let unwatch: (() => void) | null = null;
  let colorSchemeMedia: MediaQueryList | null = null;
  let onColorSchemeChange: (() => void) | null = null;

  const byId = <T extends HTMLElement>(id: string): T | null => doc.getElementById(id) as T | null;

  const versionEl = byId<HTMLElement>("onboardingVersion");
  const themeBtn = byId<HTMLButtonElement>("onboardingThemeBtn");

  // AI 表单节点
  const aiForm = byId<HTMLFormElement>("onboardingAiForm");
  const aiReadyBadge = byId<HTMLElement>("aiReadyBadge");
  const aiPresetSelect = byId<HTMLSelectElement>("aiPresetSelect");
  const aiProtocolSelect = byId<HTMLSelectElement>("aiProtocolSelect");
  const aiBaseUrlInput = byId<HTMLInputElement>("aiBaseUrlInput");
  const aiBaseUrlError = byId<HTMLElement>("aiBaseUrlError");
  const aiApiKeyInput = byId<HTMLInputElement>("aiApiKeyInput");
  const aiApiKeyError = byId<HTMLElement>("aiApiKeyError");
  const aiApiKeyToggle = byId<HTMLButtonElement>("aiApiKeyToggle");
  const aiCredentialLink = byId<HTMLAnchorElement>("aiCredentialLink");
  const aiModelInput = byId<HTMLInputElement>("aiModelInput");
  const aiModelError = byId<HTMLElement>("aiModelError");
  const aiModelDropdownToggle = byId<HTMLButtonElement>("aiModelDropdownToggle");
  const aiModelDropdown = byId<HTMLElement>("aiModelDropdown");
  const aiFetchModelsBtn = byId<HTMLButtonElement>("aiFetchModelsBtn");
  const aiTestBtn = byId<HTMLButtonElement>("aiTestBtn");
  const aiSaveBtn = byId<HTMLButtonElement>("aiSaveBtn");
  const aiStatus = byId<HTMLElement>("aiStatus");

  // ASR 表单节点
  const asrForm = byId<HTMLFormElement>("onboardingAsrForm");
  const asrReadyBadge = byId<HTMLElement>("asrReadyBadge");
  const asrPresetSelect = byId<HTMLSelectElement>("asrPresetSelect");
  const asrModelInput = byId<HTMLInputElement>("asrModelInput");
  const asrModelError = byId<HTMLElement>("asrModelError");
  const asrBaseUrlInput = byId<HTMLInputElement>("asrBaseUrlInput");
  const asrBaseUrlError = byId<HTMLElement>("asrBaseUrlError");
  const asrApiKeyInput = byId<HTMLInputElement>("asrApiKeyInput");
  const asrApiKeyError = byId<HTMLElement>("asrApiKeyError");
  const asrApiKeyToggle = byId<HTMLButtonElement>("asrApiKeyToggle");
  const asrCredentialLink = byId<HTMLAnchorElement>("asrCredentialLink");
  const asrAutoFallbackToggle = byId<HTMLInputElement>("asrAutoFallbackToggle");
  const asrTestBtn = byId<HTMLButtonElement>("asrTestBtn");
  const asrSaveBtn = byId<HTMLButtonElement>("asrSaveBtn");
  const asrStatus = byId<HTMLElement>("asrStatus");

  // 联网搜索节点
  const searchReadyBadge = byId<HTMLElement>("searchReadyBadge");
  const webSearchToggle = byId<HTMLInputElement>("webSearchToggle");
  const searchStatus = byId<HTMLElement>("searchStatus");

  if (versionEl) {
    const version = globalThis.chrome?.runtime?.getManifest?.()?.version || "";
    versionEl.textContent = version ? `v${version}` : "";
  }

  // 步骤 1 固定图标图示按当前浏览器切换：Firefox 扩展菜单无图钉，走齿轮菜单「固定到工具栏」
  const isFirefox = isFirefoxRuntime();
  const extMenuTitle = doc.getElementById("onboardingExtMenuTitle");
  const pinCaption = doc.getElementById("onboardingPinCaption");
  const chromiumPinIcon = doc.getElementById("onboardingPinIconChromium");
  const firefoxPinIcon = doc.getElementById("onboardingPinIconFirefox");
  if (extMenuTitle) {
    extMenuTitle.textContent = isFirefox ? "扩展" : "扩展程序";
  }
  if (pinCaption) {
    pinCaption.textContent = isFirefox ? "点齿轮选择固定到工具栏" : "点击图钉固定到工具栏";
  }
  if (chromiumPinIcon) {
    if (isFirefox) {
      chromiumPinIcon.setAttribute("display", "none");
      chromiumPinIcon.setAttribute("hidden", "");
    } else {
      chromiumPinIcon.removeAttribute("display");
      chromiumPinIcon.removeAttribute("hidden");
    }
  }
  if (firefoxPinIcon) {
    if (isFirefox) {
      firefoxPinIcon.removeAttribute("display");
      firefoxPinIcon.removeAttribute("hidden");
    } else {
      firefoxPinIcon.setAttribute("display", "none");
      firefoxPinIcon.setAttribute("hidden", "");
    }
  }

  let currentSettings: Settings = { ...DEFAULT_SETTINGS };
  let aiProviders: ProviderListEntry[] = [];
  let asrProviders: AsrProviderListEntry[] = [];
  let editingAiId = "";
  let editingAiHasSavedKey = false;
  let editingAsrId = "";
  let editingAsrHasSavedKey = false;
  let aiBaseUrlEdited = false;
  let aiModelEdited = false;
  let searchBusy = false;

  const aiModelCombobox =
    aiModelInput && aiModelDropdownToggle && aiModelDropdown
      ? createModelCombobox({
          input: aiModelInput,
          toggle: aiModelDropdownToggle,
          dropdown: aiModelDropdown,
          classes: ONBOARDING_MODEL_COMBOBOX_CLASSES,
          searchAriaLabel: "搜索可用模型",
          emptyMessage: "暂无推荐模型，请直接输入或点击「拉取模型」",
          focusInputOnSelect: true,
          onSelect: () => {
            aiModelEdited = true;
            setFieldIssue(aiModelInput, aiModelError, null);
          },
          onInput: () => {
            aiModelEdited = true;
            setFieldIssue(aiModelInput, aiModelError, null);
          },
          signal
        })
      : null;

  const providerTransactions = createProviderTransactions({
    families: {
      ai: {
        list: () => sendRuntimeMessage({ type: "ai-providers-list" }),
        save: (providers) => sendRuntimeMessage({ type: "ai-providers-save", providers }),
        generateId: () => `p_${Date.now()}`,
        optionalHostPermission: true
      },
      asr: {
        list: () => sendRuntimeMessage({ type: "asr-providers-list" }),
        save: (providers) => sendRuntimeMessage({ type: "asr-providers-save", providers }),
        generateId: () => `asr_${Date.now()}`,
        optionalHostPermission: true
      }
    },
    requestOrigins: requestProviderOriginsViaBackground
  });

  const cleanup = (): void => {
    if (disposed) return;
    disposed = true;
    mountAbort.abort();
    if (activeMountDisposers.get(doc) === cleanup) {
      activeMountDisposers.delete(doc);
    }
    aiModelCombobox?.dispose();
    closeAllCustomSelects();
    unwatch?.();
    if (onColorSchemeChange) {
      colorSchemeMedia?.removeEventListener?.("change", onColorSchemeChange);
    }
  };
  activeMountDisposers.set(doc, cleanup);

  if (aiPresetSelect) {
    aiPresetSelect.innerHTML = PRESETS.map((preset) => {
      const label = preset.id === DEFAULT_AI_PRESET_ID ? `${preset.name}（推荐免费额度）` : preset.name;
      return `<option value="${preset.id}">${label}</option>`;
    }).join("");
    setCustomSelectValue(aiPresetSelect, DEFAULT_AI_PRESET_ID);
    initCustomSelect(aiPresetSelect, "custom-select-wrapper");
  }

  if (aiProtocolSelect) {
    aiProtocolSelect.innerHTML = PROTOCOL_OPTIONS.map(
      (opt) => `<option value="${opt.value}">${opt.label}</option>`
    ).join("");
    setCustomSelectValue(aiProtocolSelect, "openai");
    initCustomSelect(aiProtocolSelect, "custom-select-wrapper");
  }

  if (asrPresetSelect) {
    asrPresetSelect.innerHTML = ASR_PROVIDER_PRESETS.map((preset) => {
      const label = preset.id === DEFAULT_ASR_PRESET_ID ? `${preset.name}（推荐）` : preset.name;
      return `<option value="${preset.id}">${label}</option>`;
    }).join("");
    setCustomSelectValue(asrPresetSelect, DEFAULT_ASR_PRESET_ID);
    initCustomSelect(asrPresetSelect, "custom-select-wrapper");
  }

  if (asrAutoFallbackToggle) initToggleSwitch(asrAutoFallbackToggle);
  if (webSearchToggle) initToggleSwitch(webSearchToggle);

  function populateAiModelSuggestions(presetId: string, extraModels: readonly string[] = []): void {
    const models = [...new Set([...extraModels, ...(SUGGESTED_AI_MODELS[presetId] ?? [])].filter(Boolean))];
    aiModelCombobox?.setOptions(models);
  }

  function syncAiPresetMetadata(presetId: string, options: { updateBaseUrl?: boolean; updateProtocol?: boolean; updateModel?: boolean } = {}): void {
    const preset = resolveAiPreset(presetId);
    const protocol: AiProtocol = options.updateProtocol
      ? resolveAdapter(preset.protocol).protocol
      : resolveAdapter(aiProtocolSelect?.value).protocol;
    if (options.updateProtocol && aiProtocolSelect) {
      setCustomSelectValue(aiProtocolSelect, protocol);
    }
    if (options.updateBaseUrl && aiBaseUrlInput) {
      aiBaseUrlInput.value = presetBaseUrlForProtocol(preset, protocol);
      aiBaseUrlEdited = false;
    }
    const meta = PRESET_CREDENTIAL_LINKS[preset.id];
    if (aiCredentialLink) {
      if (meta) {
        aiCredentialLink.href = meta.href;
        aiCredentialLink.textContent = meta.label;
        aiCredentialLink.hidden = false;
      } else {
        aiCredentialLink.hidden = true;
      }
    }
    if (aiApiKeyInput) {
      if (editingAiHasSavedKey && aiPresetSelect?.value === preset.id) {
        aiApiKeyInput.placeholder = "已保存（留空沿用）";
      } else if (preset.requiresKey === false) {
        aiApiKeyInput.placeholder = "API Key（本地服务可留空）";
      } else {
        aiApiKeyInput.placeholder = meta?.placeholder || "填写 API Key";
      }
    }
    populateAiModelSuggestions(preset.id);
    if (options.updateModel && aiModelInput && !aiModelEdited) {
      aiModelInput.value = SUGGESTED_AI_MODELS[preset.id]?.[0] ?? "";
    }
  }

  function syncAsrPresetMetadata(presetId: string, options: { updateFields?: boolean } = {}): void {
    const preset = resolveAsrPreset(presetId);
    if (options.updateFields) {
      if (asrBaseUrlInput) asrBaseUrlInput.value = preset.baseUrl;
      if (asrModelInput) asrModelInput.value = preset.model;
    }
    if (asrCredentialLink) {
      asrCredentialLink.hidden = preset.id !== DEFAULT_ASR_PRESET_ID;
    }
    if (asrApiKeyInput) {
      if (editingAsrHasSavedKey) {
        asrApiKeyInput.placeholder = "已保存（留空沿用）";
      } else if (preset.requiresKey === false) {
        asrApiKeyInput.placeholder = "API Key（本地服务可留空）";
      } else {
        asrApiKeyInput.placeholder = "填写 SiliconFlow API Key";
      }
    }
  }

  function renderReadiness(settings: Settings, aiList: ProviderListEntry[], asrList: AsrProviderListEntry[]): void {
    // AI 就绪态
    const enabledAi = aiList.filter((p) => p && p.enabled !== false);
    const activeAi =
      enabledAi.find((p) => p.id === settings.defaultModel) ??
      enabledAi[0] ??
      null;
    const activeAiModel = activeAi ? resolveCatalogModel(activeAi, settings.defaultAiModel) : "";
    const aiReady = Boolean(activeAi && (activeAi.requiresKey === false || activeAi.hasSavedKey));
    if (aiReadyBadge) {
      aiReadyBadge.dataset.ready = aiReady ? "true" : "false";
      aiReadyBadge.textContent = aiReady && activeAi
        ? `已就绪 · ${activeAi.name}${activeAiModel ? ` (${activeAiModel})` : ""}`
        : activeAi
          ? "待补充 Key"
          : "未配置";
    }

    // ASR 就绪态
    const activeAsrId = resolveActiveAsrProviderId(asrList, settings.activeAsrProviderId);
    const activeAsr = asrList.find((p) => p.id === activeAsrId) ?? asrList[0] ?? null;
    const asrPreset = activeAsr ? resolveAsrPreset(activeAsr.presetId) : null;
    const asrReady = Boolean(activeAsr && (asrPreset?.requiresKey === false || activeAsr.hasSavedKey));
    if (asrReadyBadge) {
      asrReadyBadge.dataset.ready = asrReady ? "true" : "false";
      asrReadyBadge.textContent = asrReady && activeAsr
        ? `已就绪 · ${activeAsr.name}`
        : activeAsr
          ? "待补充 Key"
          : "可选";
    }

    // 搜索就绪态
    const searchEnabled = settings.webSearchEnabled === true;
    const searchAck = settings.searchOptInNoticeAcknowledged === true;
    if (searchReadyBadge) {
      searchReadyBadge.dataset.ready = searchEnabled && searchAck ? "true" : "false";
      searchReadyBadge.textContent = !searchEnabled
        ? "已关闭"
        : searchAck
          ? "已开启（已授权）"
          : "已开启（待首次确认）";
    }
  }

  function hydrateForms(): void {
    // AI 表单水合：优先当前 defaultModel 对应平台，其次首个 AI 平台，否则默认 ModelScope
    const preferredAi =
      aiProviders.find((p) => p.id === currentSettings.defaultModel) ??
      aiProviders[0] ??
      null;
    if (preferredAi) {
      editingAiId = String(preferredAi.id || "");
      editingAiHasSavedKey = Boolean(preferredAi.hasSavedKey);
      const presetId = String(preferredAi.presetId || DEFAULT_AI_PRESET_ID);
      if (aiPresetSelect) {
        setCustomSelectValue(aiPresetSelect, PRESETS.some((p) => p.id === presetId) ? presetId : "custom");
      }
      if (aiProtocolSelect) {
        setCustomSelectValue(aiProtocolSelect, resolveAdapter(preferredAi.protocol).protocol);
      }
      if (aiBaseUrlInput) aiBaseUrlInput.value = String(preferredAi.baseUrl || "");
      const models = normalizeProviderModels(preferredAi);
      const activeModel = resolveCatalogModel(preferredAi, currentSettings.defaultAiModel) || models[0] || "";
      if (aiModelInput) aiModelInput.value = activeModel;
      aiBaseUrlEdited = false;
      aiModelEdited = Boolean(activeModel);
      const selectedPreset = aiPresetSelect?.value || presetId;
      syncAiPresetMetadata(selectedPreset, { updateBaseUrl: false, updateProtocol: false, updateModel: false });
      populateAiModelSuggestions(selectedPreset, models);
    } else {
      editingAiId = "";
      editingAiHasSavedKey = false;
      if (aiPresetSelect) setCustomSelectValue(aiPresetSelect, DEFAULT_AI_PRESET_ID);
      syncAiPresetMetadata(DEFAULT_AI_PRESET_ID, { updateBaseUrl: true, updateProtocol: true, updateModel: true });
    }

    // ASR 表单水合
    const activeAsrId = resolveActiveAsrProviderId(asrProviders, currentSettings.activeAsrProviderId);
    const preferredAsr =
      asrProviders.find((p) => p.id === activeAsrId) ??
      asrProviders[0] ??
      null;
    if (preferredAsr) {
      editingAsrId = String(preferredAsr.id || "");
      editingAsrHasSavedKey = Boolean(preferredAsr.hasSavedKey);
      const presetId = String(preferredAsr.presetId || DEFAULT_ASR_PRESET_ID);
      if (asrPresetSelect) {
        setCustomSelectValue(asrPresetSelect, ASR_PROVIDER_PRESETS.some((p) => p.id === presetId) ? presetId : "custom");
      }
      if (asrBaseUrlInput) asrBaseUrlInput.value = String(preferredAsr.baseUrl || "");
      if (asrModelInput) asrModelInput.value = String(preferredAsr.model || resolveAsrPreset(presetId).model);
      syncAsrPresetMetadata(asrPresetSelect?.value || presetId, { updateFields: false });
    } else {
      editingAsrId = "";
      editingAsrHasSavedKey = false;
      if (asrPresetSelect) setCustomSelectValue(asrPresetSelect, DEFAULT_ASR_PRESET_ID);
      syncAsrPresetMetadata(DEFAULT_ASR_PRESET_ID, { updateFields: true });
    }

    if (asrAutoFallbackToggle) {
      asrAutoFallbackToggle.checked = currentSettings.asrAutoFallback !== false;
      syncToggleSwitch(asrAutoFallbackToggle);
    }

    if (webSearchToggle) {
      webSearchToggle.checked = currentSettings.webSearchEnabled === true;
      syncToggleSwitch(webSearchToggle);
    }
  }

  async function refresh(): Promise<void> {
    const [settingsResp, aiResp, asrResp] = await Promise.all([
      sendRuntimeMessage({ type: "get-settings" }).catch(() => null),
      sendRuntimeMessage({ type: "ai-providers-list" }).catch(() => null),
      sendRuntimeMessage({ type: "asr-providers-list" }).catch(() => null)
    ]);
    if (disposed) return;
    currentSettings = { ...DEFAULT_SETTINGS, ...(settingsResp?.ok ? settingsResp.settings : {}) };
    aiProviders = aiResp?.ok && Array.isArray(aiResp.providers) ? aiResp.providers : [];
    asrProviders = asrResp?.ok && Array.isArray(asrResp.providers) ? asrResp.providers : [];
    applyRootAppearance(currentSettings);
    hydrateForms();
    renderReadiness(currentSettings, aiProviders, asrProviders);
  }

  await refresh();
  if (disposed) {
    return {
      refresh,
      dispose: cleanup
    };
  }

  if (aiApiKeyInput) bindPasswordToggle(aiApiKeyInput, aiApiKeyToggle, signal);
  if (asrApiKeyInput) bindPasswordToggle(asrApiKeyInput, asrApiKeyToggle, signal);

  function runGestureFormAction(options: {
    button: HTMLButtonElement | null;
    statusEl: HTMLElement | null;
    pendingMessage: string;
    fallbackError: string;
    permissionUrls?: readonly string[];
    run: () => Promise<void>;
  }): void {
    const urls = options.permissionUrls?.filter(Boolean) ?? [];
    // 同步手势链：permissionUrls 非空时在首个 await 前同步发起域名权限申请；
    // 走 providerTransactions 时省略 permissionUrls，由 run() 同步段直接经事务发起申请。
    const permissionPromise: Promise<{ ok: boolean; error?: string }> | null =
      urls.length > 0 ? requestProviderOriginsViaBackground(urls) : null;
    if (options.button) options.button.disabled = true;
    setStatusLine(options.statusEl, options.pendingMessage);
    const task = permissionPromise
      ? permissionPromise.then((perm) => {
          if (!perm.ok) {
            setStatusLine(options.statusEl, perm.error || "域名权限未授予", "error");
            return;
          }
          return options.run();
        })
      : options.run();
    void task
      .catch((error) => {
        setStatusLine(options.statusEl, (error as Error).message || options.fallbackError, "error");
      })
      .finally(() => {
        if (options.button) options.button.disabled = false;
      });
  }

  // ===== 主题切换 =====
  themeBtn?.addEventListener("click", () => {
    const current = doc.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    const next = current === "dark" ? "light" : "dark";
    currentSettings = { ...currentSettings, readerTheme: next, readerThemeUserSet: true };
    applyRootAppearance(currentSettings);
    void sendRuntimeMessage({
      type: "save-settings",
      settings: { readerTheme: next, readerThemeUserSet: true }
    }).catch(() => {});
  }, { signal });

  colorSchemeMedia = typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
  onColorSchemeChange = () => {
    if (!currentSettings.readerThemeUserSet) {
      applyRootAppearance(currentSettings);
    }
  };
  colorSchemeMedia?.addEventListener?.("change", onColorSchemeChange);

  // ===== AI 平台表单逻辑 =====
  aiPresetSelect?.addEventListener("change", () => {
    aiModelCombobox?.close(false);
    const presetId = aiPresetSelect.value;
    const matched = aiProviders.find((p) => p.presetId === presetId);
    editingAiId = matched?.id ?? "";
    editingAiHasSavedKey = Boolean(matched?.hasSavedKey);
    aiBaseUrlEdited = false;
    aiModelEdited = false;
    syncAiPresetMetadata(presetId, { updateBaseUrl: true, updateProtocol: true, updateModel: true });
    if (aiApiKeyInput) {
      aiApiKeyInput.value = "";
      setFieldIssue(aiApiKeyInput, aiApiKeyError, null);
    }
    if (aiBaseUrlInput) setFieldIssue(aiBaseUrlInput, aiBaseUrlError, null);
    if (aiModelInput) setFieldIssue(aiModelInput, aiModelError, null);
    setStatusLine(aiStatus, "");
  }, { signal });

  aiProtocolSelect?.addEventListener("change", () => {
    const preset = resolveAiPreset(aiPresetSelect?.value || DEFAULT_AI_PRESET_ID);
    if (!aiBaseUrlEdited && aiBaseUrlInput) {
      aiBaseUrlInput.value = presetBaseUrlForProtocol(preset, aiProtocolSelect.value);
    }
  }, { signal });

  aiBaseUrlInput?.addEventListener("input", () => {
    aiBaseUrlEdited = true;
    setFieldIssue(aiBaseUrlInput, aiBaseUrlError, null);
  }, { signal });
  aiApiKeyInput?.addEventListener("input", () => {
    setFieldIssue(aiApiKeyInput, aiApiKeyError, null);
  }, { signal });

  function validateAiDraft(requireModel: boolean): {
    ok: boolean;
    preset: AiProviderPreset;
    protocol: AiProtocol;
    baseUrl: string;
    apiKey: string;
    model: string;
  } {
    const preset = resolveAiPreset(aiPresetSelect?.value || DEFAULT_AI_PRESET_ID);
    const protocol = resolveAdapter(aiProtocolSelect?.value).protocol;
    const baseUrl = normalizeBaseUrl(aiBaseUrlInput?.value);
    const apiKey = String(aiApiKeyInput?.value || "").trim();
    const model = String(aiModelInput?.value || "").trim();
    let firstInvalid: HTMLInputElement | null = null;

    if (aiBaseUrlInput) {
      if (!baseUrl) {
        setFieldIssue(aiBaseUrlInput, aiBaseUrlError, "请填写 API 地址");
        firstInvalid ??= aiBaseUrlInput;
      } else if (!isValidHttpUrl(baseUrl)) {
        setFieldIssue(aiBaseUrlInput, aiBaseUrlError, "API 地址需以 http:// 或 https:// 开头");
        firstInvalid ??= aiBaseUrlInput;
      } else {
        setFieldIssue(aiBaseUrlInput, aiBaseUrlError, null);
      }
    }

    const canReuseSavedKey = Boolean(editingAiId && editingAiHasSavedKey && aiBaseUrlInput?.value.trim() === aiProviders.find((p) => p.id === editingAiId)?.baseUrl);
    if (aiApiKeyInput) {
      if (preset.requiresKey !== false && !apiKey && !canReuseSavedKey) {
        setFieldIssue(aiApiKeyInput, aiApiKeyError, `平台「${preset.name}」需要填写 API Key`);
        firstInvalid ??= aiApiKeyInput;
      } else {
        setFieldIssue(aiApiKeyInput, aiApiKeyError, null);
      }
    }

    if (aiModelInput) {
      if (requireModel && !model) {
        setFieldIssue(aiModelInput, aiModelError, "请填写或拉取至少一个模型");
        firstInvalid ??= aiModelInput;
      } else {
        setFieldIssue(aiModelInput, aiModelError, null);
      }
    }

    if (firstInvalid) {
      firstInvalid.focus();
      return { ok: false, preset, protocol, baseUrl, apiKey, model };
    }
    return { ok: true, preset, protocol, baseUrl, apiKey, model };
  }

  aiFetchModelsBtn?.addEventListener("click", () => {
    const draft = validateAiDraft(false);
    if (!draft.ok) return;
    const preset = draft.preset;
    const target = resolveAiModelListTarget({
      baseUrl: draft.baseUrl,
      protocol: draft.protocol,
      preset
    });
    runGestureFormAction({
      button: aiFetchModelsBtn,
      statusEl: aiStatus,
      pendingMessage: "正在拉取可用模型…",
      fallbackError: "拉取模型失败",
      permissionUrls: target.permissionBaseUrls,
      run: async () => {
        const res = await fetchProviderModels({
          baseUrl: draft.baseUrl,
          apiKey: draft.apiKey,
          providerId: editingAiId || undefined,
          protocol: draft.protocol,
          preset
        });
        if (!res.ok) {
          setStatusLine(aiStatus, res.error || "拉取模型失败", "error");
          return;
        }
        const models = res.models ?? [];
        populateAiModelSuggestions(preset.id, models);
        if (aiModelInput && !aiModelInput.value.trim() && models[0]) {
          aiModelInput.value = models[0];
          setFieldIssue(aiModelInput, aiModelError, null);
        }
        setStatusLine(aiStatus, `已获取 ${models.length} 个可用模型`, "success");
      }
    });
  }, { signal });

  aiTestBtn?.addEventListener("click", () => {
    const draft = validateAiDraft(true);
    if (!draft.ok) return;
    runGestureFormAction({
      button: aiTestBtn,
      statusEl: aiStatus,
      pendingMessage: "正在测试连接…",
      fallbackError: "连接失败",
      permissionUrls: draft.baseUrl ? [draft.baseUrl] : [],
      run: async () => {
        const result = await testAiProviderConnection({
          providerId: editingAiId || undefined,
          baseUrl: draft.baseUrl,
          apiKey: draft.apiKey,
          model: draft.model,
          protocol: draft.protocol,
          presetId: draft.preset.id
        });
        if (result.ok) {
          setStatusLine(aiStatus, "连接成功", "success");
        } else {
          setStatusLine(aiStatus, result.error || "连接失败", "error");
        }
      }
    });
  }, { signal });

  aiForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const draft = validateAiDraft(true);
    if (!draft.ok) return;
    let savedName = draft.preset.name;
    runGestureFormAction({
      button: aiSaveBtn,
      statusEl: aiStatus,
      pendingMessage: "正在保存 AI 平台配置…",
      fallbackError: "保存失败",
      run: async () => {
        const saveRes = await providerTransactions.upsertProvider(
          "ai",
          { id: editingAiId, baseUrl: draft.baseUrl },
          {
            matchExisting: (list) =>
              list.find((p) => p.presetId === draft.preset.id && normalizeBaseUrl(p.baseUrl) === draft.baseUrl),
            buildUpsert: (existing, providerId) => {
              const existingModels = existing ? normalizeProviderModels(existing) : [];
              const models = [...new Set([draft.model, ...existingModels].filter(Boolean))];
              savedName = String(existing?.name || draft.preset.name);
              const upsert: ProviderRowItem = {
                id: providerId,
                presetId: draft.preset.id,
                name: savedName,
                baseUrl: draft.baseUrl,
                models,
                requiresKey: draft.preset.requiresKey !== false,
                enabled: true,
                protocol: draft.protocol,
                apiKey: draft.apiKey,
                hasSavedKey: Boolean(existing?.hasSavedKey)
              };
              const validation = validateAiProviders([upsert]);
              if (!validation.ok) {
                return { ok: false, error: validation.message || "AI 平台配置不合法" };
              }
              return { ok: true, upsert };
            }
          }
        );
        if (!saveRes.ok || !saveRes.providerId) {
          setStatusLine(
            aiStatus,
            saveRes.error || (saveRes.permissionDenied ? "域名权限未授予" : "保存 AI 平台失败"),
            "error"
          );
          return;
        }
        const providerId = saveRes.providerId;
        await sendRuntimeMessage({
          type: "save-settings",
          settings: { defaultModel: providerId, defaultAiModel: draft.model }
        });
        aiProviders = (saveRes.providers ?? []) as ProviderListEntry[];
        currentSettings = { ...currentSettings, defaultModel: providerId, defaultAiModel: draft.model };
        editingAiId = providerId;
        editingAiHasSavedKey = Boolean(aiProviders.find((p) => p.id === providerId)?.hasSavedKey);
        if (aiApiKeyInput) {
          aiApiKeyInput.value = "";
          aiApiKeyInput.placeholder = editingAiHasSavedKey ? "已保存（留空沿用）" : "填写 API Key";
        }
        renderReadiness(currentSettings, aiProviders, asrProviders);
        setStatusLine(aiStatus, `已保存 ${savedName}（${draft.model}），文摘面板可直接使用`, "success");
      }
    });
  }, { signal });

  // ===== ASR 转写表单逻辑 =====
  asrPresetSelect?.addEventListener("change", () => {
    const presetId = asrPresetSelect.value;
    const matched = asrProviders.find((p) => p.presetId === presetId);
    editingAsrId = matched?.id ?? "";
    editingAsrHasSavedKey = Boolean(matched?.hasSavedKey);
    syncAsrPresetMetadata(presetId, { updateFields: true });
    if (matched) {
      if (asrBaseUrlInput) asrBaseUrlInput.value = matched.baseUrl;
      if (asrModelInput) asrModelInput.value = matched.model || resolveAsrPreset(presetId).model;
    }
    if (asrApiKeyInput) {
      asrApiKeyInput.value = "";
      setFieldIssue(asrApiKeyInput, asrApiKeyError, null);
    }
    if (asrBaseUrlInput) setFieldIssue(asrBaseUrlInput, asrBaseUrlError, null);
    if (asrModelInput) setFieldIssue(asrModelInput, asrModelError, null);
    setStatusLine(asrStatus, "");
  }, { signal });

  asrBaseUrlInput?.addEventListener("input", () => setFieldIssue(asrBaseUrlInput, asrBaseUrlError, null), { signal });
  asrModelInput?.addEventListener("input", () => setFieldIssue(asrModelInput, asrModelError, null), { signal });
  asrApiKeyInput?.addEventListener("input", () => setFieldIssue(asrApiKeyInput, asrApiKeyError, null), { signal });

  function validateAsrDraft(): {
    ok: boolean;
    preset: AsrProviderPreset;
    baseUrl: string;
    model: string;
    apiKey: string;
  } {
    const preset = resolveAsrPreset(asrPresetSelect?.value || DEFAULT_ASR_PRESET_ID);
    const baseUrl = normalizeBaseUrl(asrBaseUrlInput?.value);
    const model = String(asrModelInput?.value || "").trim();
    const apiKey = String(asrApiKeyInput?.value || "").trim();
    let firstInvalid: HTMLInputElement | null = null;

    if (asrBaseUrlInput) {
      if (!baseUrl || !isValidHttpUrl(baseUrl)) {
        setFieldIssue(asrBaseUrlInput, asrBaseUrlError, "请填写合法的 http(s):// 转写 API 地址");
        firstInvalid ??= asrBaseUrlInput;
      } else {
        setFieldIssue(asrBaseUrlInput, asrBaseUrlError, null);
      }
    }
    if (asrModelInput) {
      if (!model) {
        setFieldIssue(asrModelInput, asrModelError, "请填写转写模型名");
        firstInvalid ??= asrModelInput;
      } else {
        setFieldIssue(asrModelInput, asrModelError, null);
      }
    }
    if (asrApiKeyInput) {
      if (preset.requiresKey !== false && !apiKey && !editingAsrHasSavedKey) {
        setFieldIssue(asrApiKeyInput, asrApiKeyError, `平台「${preset.name}」需要填写 API Key`);
        firstInvalid ??= asrApiKeyInput;
      } else {
        setFieldIssue(asrApiKeyInput, asrApiKeyError, null);
      }
    }
    if (firstInvalid) {
      firstInvalid.focus();
      return { ok: false, preset, baseUrl, model, apiKey };
    }
    return { ok: true, preset, baseUrl, model, apiKey };
  }

  asrTestBtn?.addEventListener("click", () => {
    const draft = validateAsrDraft();
    if (!draft.ok) return;
    runGestureFormAction({
      button: asrTestBtn,
      statusEl: asrStatus,
      pendingMessage: "正在测试转写服务…",
      fallbackError: "转写连接失败",
      permissionUrls: draft.baseUrl ? [draft.baseUrl] : [],
      run: async () => {
        const res = await testAsrConnection({
          id: editingAsrId || undefined,
          type: draft.preset.type,
          baseUrl: draft.baseUrl,
          model: draft.model,
          apiKey: draft.apiKey
        });
        if (res.ok) {
          setStatusLine(asrStatus, "转写服务连接成功", "success");
        } else {
          setStatusLine(asrStatus, res.error || "转写连接失败", "error");
        }
      }
    });
  }, { signal });

  asrForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const draft = validateAsrDraft();
    if (!draft.ok) return;
    let savedName = draft.preset.name;
    let savedModel = draft.model;
    runGestureFormAction({
      button: asrSaveBtn,
      statusEl: asrStatus,
      pendingMessage: "正在保存转写配置…",
      fallbackError: "保存失败",
      run: async () => {
        const saveRes = await providerTransactions.upsertProvider(
          "asr",
          { id: editingAsrId, baseUrl: draft.baseUrl, model: draft.model },
          {
            matchExisting: (list) =>
              list.find((p) => p.presetId === draft.preset.id && normalizeBaseUrl(p.baseUrl) === draft.baseUrl),
            buildUpsert: (existing, providerId) => {
              const normalized = normalizeAsrProvider({
                id: providerId,
                presetId: draft.preset.id,
                name: String(existing?.name || draft.preset.name),
                type: draft.preset.type,
                baseUrl: draft.baseUrl,
                model: draft.model,
                supportsTimestamps: draft.preset.supportsTimestamps
              });
              if (!normalized) {
                return { ok: false, error: "转写配置格式不合法" };
              }
              savedName = normalized.name;
              savedModel = normalized.model;
              return {
                ok: true,
                upsert: {
                  ...normalized,
                  apiKey: draft.apiKey,
                  hasSavedKey: Boolean(existing?.hasSavedKey)
                }
              };
            }
          }
        );
        if (!saveRes.ok || !saveRes.providerId) {
          setStatusLine(
            asrStatus,
            saveRes.error || (saveRes.permissionDenied ? "域名权限未授予" : "保存转写平台失败"),
            "error"
          );
          return;
        }
        const providerId = saveRes.providerId;
        const asrAutoFallback = asrAutoFallbackToggle ? asrAutoFallbackToggle.checked : true;
        await sendRuntimeMessage({
          type: "save-settings",
          settings: { activeAsrProviderId: providerId, asrAutoFallback }
        });
        asrProviders = (saveRes.providers ?? []) as AsrProviderListEntry[];
        currentSettings = { ...currentSettings, activeAsrProviderId: providerId, asrAutoFallback };
        editingAsrId = providerId;
        editingAsrHasSavedKey = Boolean(asrProviders.find((p) => p.id === providerId)?.hasSavedKey);
        if (asrApiKeyInput) {
          asrApiKeyInput.value = "";
          asrApiKeyInput.placeholder = editingAsrHasSavedKey ? "已保存（留空沿用）" : "填写 API Key";
        }
        renderReadiness(currentSettings, aiProviders, asrProviders);
        setStatusLine(asrStatus, `已保存 ${savedName}（${savedModel}）`, "success");
      }
    });
  }, { signal });

  asrAutoFallbackToggle?.addEventListener("change", () => {
    const checked = asrAutoFallbackToggle.checked;
    currentSettings = { ...currentSettings, asrAutoFallback: checked };
    void sendRuntimeMessage({ type: "save-settings", settings: { asrAutoFallback: checked } });
  }, { signal });

  // ===== 免 Key 联网搜索开关（严守现有 opt-in 授权确认流程） =====
  webSearchToggle?.addEventListener("change", () => {
    if (searchBusy) return;
    const targetEnabled = webSearchToggle.checked;
    searchBusy = true;
    void (async () => {
      try {
        if (!targetEnabled) {
          await sendRuntimeMessage({ type: "save-settings", settings: { webSearchEnabled: false } });
          currentSettings = { ...currentSettings, webSearchEnabled: false };
          renderReadiness(currentSettings, aiProviders, asrProviders);
          setStatusLine(searchStatus, "已关闭联网搜索");
          return;
        }

        // 先落盘偏好开关，再走标准 resolveWebSearchOptIn 授权弹窗（绝不绕过确认状态位）
        await sendRuntimeMessage({ type: "save-settings", settings: { webSearchEnabled: true } });
        const optInResult = await resolveWebSearchOptIn(true, { mountHost: doc.body });
        if (optInResult === "granted") {
          currentSettings = {
            ...currentSettings,
            webSearchEnabled: true,
            searchOptInNoticeAcknowledged: true
          };
          webSearchToggle.checked = true;
          syncToggleSwitch(webSearchToggle);
          renderReadiness(currentSettings, aiProviders, asrProviders);
          setStatusLine(searchStatus, "联网搜索已授权开启", "success");
          return;
        }

        // 取消 / 拒绝：由 opt-in 逻辑写回 webSearchEnabled: false，此处同步界面状态
        currentSettings = { ...currentSettings, webSearchEnabled: false };
        webSearchToggle.checked = false;
        syncToggleSwitch(webSearchToggle);
        renderReadiness(currentSettings, aiProviders, asrProviders);
        setStatusLine(searchStatus, "已取消授权，联网搜索保持关闭");
      } catch (error) {
        setStatusLine(searchStatus, (error as Error).message || "更新联网搜索状态失败", "error");
      } finally {
        searchBusy = false;
      }
    })();
  }, { signal });

  unwatch = watchStorageKeys(
    () => {
      void refresh();
    },
    {
      sync: [
        "aiProviders",
        "asrProviders",
        "defaultModel",
        "defaultAiModel",
        "activeAsrProviderId",
        "asrAutoFallback",
        "webSearchEnabled",
        "searchOptInNoticeAcknowledged",
        "readerTheme",
        "readerThemeUserSet",
        "readerPalette"
      ],
      local: ["aiProviderKeys", "asrProviderKeys"]
    }
  );

  return {
    refresh,
    dispose: cleanup
  };
}

if (typeof document !== "undefined" && document.getElementById("onboardingAiForm")) {
  void mountOnboardingPage(document);
}
