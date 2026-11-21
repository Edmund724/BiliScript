import { errorText } from "./provider-http-shared.js";
import { resolveActiveAsrProviderId } from "../asr/asr-provider-normalize.js";
import { resolveCatalogModel } from "../shared/selected-provider.js";
import type {
  AsrProviderListEntry,
  GetAsrRuntimeConfigResponse,
  MessageReplyDecision,
  ProviderListEntry,
  ResolveAiProviderResponse,
  ResolveSubtitleTranslateProviderResponse
} from "../shared/messaging-protocol.js";
import { resolveSubtitleTranslateProviderConfig } from "../ai/subtitle-translate-config.js";

export interface ProviderHandlersMessage {
  providerId?: string | number;
  providers?: unknown[];
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  provider?: unknown;
}

export type MessageErrorEnvelope = { ok: false; error: string };

export function withOkResponse<R>(
  task: Promise<R>,
  sendResponse: (response: R | MessageErrorEnvelope) => void,
  toError: (error: unknown) => string = errorText
): void {
  void (async () => {
    try {
      const payload = await task;
      sendResponse(payload);
    } catch (error) {
      sendResponse({ ok: false, error: toError(error) });
    }
  })();
}

export type ProviderProvidersResponse<E> = {
  ok: boolean;
  providers?: E[];
  error?: string;
};
export type ProviderKeyResponse = { ok: boolean; apiKey?: string; error?: string };

export interface ProviderMessageHandlersDeps<E> {
  loadProviders: () => Promise<E[]>;
  saveProviders: (items: unknown[]) => Promise<E[]>;
  deleteProvider: (providerId: string) => Promise<E[]>;
  loadKeys: () => Promise<Record<string, string>>;
}

export interface ProviderMessageHandlers<E> {
  list: (message: unknown, sender: unknown, sendResponse: (response: ProviderProvidersResponse<E>) => void) => void;
  get: (message: unknown, sender: unknown, sendResponse: (response: ProviderKeyResponse) => void) => MessageReplyDecision;
  save: (message: unknown, sender: unknown, sendResponse: (response: ProviderProvidersResponse<E>) => void) => void;
  remove: (message: unknown, sender: unknown, sendResponse: (response: ProviderProvidersResponse<E>) => void) => void;
}

export function createProviderMessageHandlers<E>({
  loadProviders,
  saveProviders,
  deleteProvider,
  loadKeys
}: ProviderMessageHandlersDeps<E>): ProviderMessageHandlers<E> {
  function list(_message: unknown, _sender: unknown, sendResponse: (response: ProviderProvidersResponse<E>) => void): void {
    withOkResponse(
      (async () => ({ ok: true, providers: await loadProviders() }))(),
      sendResponse
    );
  }

  function get(message: unknown, _sender: unknown, sendResponse: (response: ProviderKeyResponse) => void): MessageReplyDecision {
    const msg = message as ProviderHandlersMessage;
    const providerId = String(msg.providerId || "").trim();
    if (!providerId) {
      sendResponse({ ok: false, error: "缺少 providerId" });
      return "answered";
    }
    withOkResponse(
      (async () => {
        const keys = await loadKeys();
        const apiKey = String(keys[providerId] || "").trim();
        return { ok: true, apiKey };
      })(),
      sendResponse
    );
    return "hold";
  }

  function save(message: unknown, _sender: unknown, sendResponse: (response: ProviderProvidersResponse<E>) => void): void {
    const msg = message as ProviderHandlersMessage;
    withOkResponse(
      (async () => ({ ok: true, providers: await saveProviders(msg.providers || []) }))(),
      sendResponse
    );
  }

  function remove(message: unknown, _sender: unknown, sendResponse: (response: ProviderProvidersResponse<E>) => void): void {
    const msg = message as ProviderHandlersMessage;
    withOkResponse(
      (async () => ({
        ok: true,
        providers: await deleteProvider(String(msg.providerId || ""))
      }))(),
      sendResponse
    );
  }

  return { list, get, save, remove };
}

export interface AsrRuntimeConfigSettings {
  activeAsrProviderId?: string;
  asrLanguage?: string;
  asrAutoFallback?: boolean;
}

export interface AsrRuntimeConfigHandlerDeps {
  getMergedSettings: () => Promise<AsrRuntimeConfigSettings>;
  loadProviders: () => Promise<AsrProviderListEntry[]>;
  getAsrProviderKey: (providerId: string) => Promise<string>;
}

export function createAsrRuntimeConfigHandler({
  getMergedSettings,
  loadProviders,
  getAsrProviderKey
}: AsrRuntimeConfigHandlerDeps) {
  return function handleGetAsrRuntimeConfig(
    _message: unknown,
    _sender: unknown,
    sendResponse: (response: GetAsrRuntimeConfigResponse) => void
  ): void {
    withOkResponse(
      (async () => {
        const settings = await getMergedSettings();
        const providers = await loadProviders();
        const activeId = resolveActiveAsrProviderId(providers, settings.activeAsrProviderId);
        const activeKey = activeId ? await getAsrProviderKey(activeId) : "";
        return {
          ok: true,
          providers,
          activeAsrProviderId: activeId,
          activeKey,
          asrLanguage: settings.asrLanguage,
          asrAutoFallback: settings.asrAutoFallback === true
        };
      })(),
      sendResponse,
      (error) => (error as Error)?.message || String(error)
    );
  };
}

export {
  MISSING_PROVIDER_KEY_MESSAGE,
  NO_ACTIVE_PROVIDER_MESSAGE,
  SELECTED_PROVIDER_NOT_FOUND_MESSAGE
} from "./overview-setup-error.js";
import {
  MISSING_PROVIDER_KEY_MESSAGE,
  NO_ACTIVE_PROVIDER_MESSAGE,
  SELECTED_PROVIDER_NOT_FOUND_MESSAGE
} from "./overview-setup-error.js";

export interface AiResolvedProviderHandlerDeps {
  getMergedSettings: () => Promise<{ defaultModel?: unknown; defaultAiModel?: unknown }>;
  loadProviders: () => Promise<ProviderListEntry[]>;
  loadKeys: () => Promise<Record<string, string>>;
}

export function createAiResolvedProviderHandler({
  getMergedSettings,
  loadProviders,
  loadKeys
}: AiResolvedProviderHandlerDeps) {
  return function handleResolveAiProvider(
    message: unknown,
    _sender: unknown,
    sendResponse: (response: ResolveAiProviderResponse) => void
  ): void {
    withOkResponse(
      (async () => {
        const requestedId = String((message as { providerId?: unknown })?.providerId || "").trim();
        const providers = (await loadProviders()) || [];
        const enabled = providers.filter(
          (item) =>
            Boolean(item)
            && typeof item === "object"
            && item.enabled !== false
            && String(item.id || "").trim() !== ""
        );
        let provider: ProviderListEntry | null = null;
        let isFallback = false;
        let model = "";
        if (requestedId) {
          provider = enabled.find((item) => String(item.id) === requestedId) || null;
          if (!provider) {
            throw new Error(SELECTED_PROVIDER_NOT_FOUND_MESSAGE);
          }
        } else {
          const settings = await getMergedSettings();
          const preferredId = String(settings?.defaultModel || "").trim();
          provider = enabled.find((item) => String(item.id) === preferredId) || enabled[0] || null;
          if (!provider) {
            throw new Error(NO_ACTIVE_PROVIDER_MESSAGE);
          }
          isFallback = preferredId !== "" && String(provider.id) !== preferredId;
          model = resolveCatalogModel(provider, isFallback ? "" : settings?.defaultAiModel);
        }
        const providerId = String(provider.id);
        const keys = (await loadKeys()) || {};
        const apiKey = String(keys[providerId] || "").trim();
        if (provider.requiresKey !== false && !apiKey) {
          throw new Error(MISSING_PROVIDER_KEY_MESSAGE);
        }
        return {
          ok: true,
          provider,
          apiKey,
          ...(!requestedId && model ? { model } : {}),
          ...(isFallback ? { isFallback: true } : {})
        };
      })(),
      sendResponse,
      (error) => (error as Error)?.message || String(error)
    );
  };
}

export interface SubtitleTranslateProviderHandlerDeps {
  getMergedSettings: () => Promise<{
    subtitleTranslateProviderId?: unknown;
    subtitleTranslateModel?: unknown;
  }>;
  loadProviders: () => Promise<ProviderListEntry[]>;
  loadKeys: () => Promise<Record<string, string>>;
}

export function createSubtitleTranslateProviderHandler({
  getMergedSettings,
  loadProviders,
  loadKeys
}: SubtitleTranslateProviderHandlerDeps) {
  return function handleResolveSubtitleTranslateProvider(
    _message: unknown,
    _sender: unknown,
    sendResponse: (response: ResolveSubtitleTranslateProviderResponse) => void
  ): void {
    withOkResponse(
      (async () => {
        const [settings, providers, keys] = await Promise.all([
          getMergedSettings(),
          loadProviders(),
          loadKeys()
        ]);
        const resolved = resolveSubtitleTranslateProviderConfig(providers, keys, settings);
        const preferredProviderId = String(settings?.subtitleTranslateProviderId || "").trim();
        const isFallback = preferredProviderId !== "" && resolved.isFallback;
        return {
          ok: true,
          provider: resolved.provider,
          apiKey: resolved.apiKey,
          model: resolved.model,
          ...(isFallback ? { isFallback: true } : {})
        };
      })(),
      sendResponse,
      (error) => (error as Error)?.message || String(error)
    );
  };
}
