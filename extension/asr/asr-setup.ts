import type { Settings } from "../core/defaults.js";
import { getSettings } from "../core/runtime.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { resolveActiveAsrProviderId } from "./asr-provider-normalize.js";

export type AsrSetupKind = "disabled" | "no-provider" | "missing-key" | "provider-config";

export type AsrProviderSetupKind = Exclude<AsrSetupKind, "disabled">;

export interface AsrSetupPlan {
  kind: AsrSetupKind;
  providerId: string;
}

export interface AsrSetupState {
  kind: AsrSetupKind;
  providerId: string;
  asrAutoFallback: boolean;
  providerStatus: AsrProviderSetupKind;
  targetProviderId: string;
  needsProviderSetup: boolean;
  blockedByBoth: boolean;
}

export interface AsrSetupInput {
  asrAutoFallback?: unknown;
  activeAsrProviderId?: unknown;
  providers?: ReadonlyArray<{ id?: string | null; hasSavedKey?: boolean }> | null;
}

function resolveAsrProviderState(input: AsrSetupInput): {
  providerStatus: AsrProviderSetupKind;
  targetProviderId: string;
} {
  const providers = (Array.isArray(input.providers) ? input.providers : [])
    .map((item) => ({
      id: String(item?.id || "").trim(),
      hasSavedKey: Boolean(item?.hasSavedKey)
    }))
    .filter((item) => item.id !== "");
  if (providers.length === 0) {
    return { providerStatus: "no-provider", targetProviderId: "" };
  }
  const activeId = resolveActiveAsrProviderId(
    providers,
    typeof input.activeAsrProviderId === "string" ? input.activeAsrProviderId : ""
  );
  const active = providers.find((item) => item.id === activeId) || providers[0];
  return {
    providerStatus: active.hasSavedKey ? "provider-config" : "missing-key",
    targetProviderId: active.id
  };
}

export function resolveAsrSetupState(input: AsrSetupInput): AsrSetupState {
  const asrAutoFallback = input.asrAutoFallback === true;
  const { providerStatus, targetProviderId } = resolveAsrProviderState(input);
  const needsProviderSetup = providerStatus === "no-provider" || providerStatus === "missing-key";
  const kind: AsrSetupKind = asrAutoFallback ? providerStatus : "disabled";
  const providerId = asrAutoFallback ? targetProviderId : "";
  return {
    kind,
    providerId,
    asrAutoFallback,
    providerStatus,
    targetProviderId,
    needsProviderSetup,
    blockedByBoth: !asrAutoFallback && needsProviderSetup
  };
}

export function resolveAsrSetupPlan(input: AsrSetupInput): AsrSetupPlan {
  const { kind, providerId } = resolveAsrSetupState(input);
  return { kind, providerId };
}

export interface AsrProviderListEntry {
  id: string;
  name?: string;
  model?: string;
  type?: string;
  enabled?: boolean;
  hasSavedKey?: boolean;
}

export interface ActiveAsrRuntimeState {
  providers: AsrProviderListEntry[];
  activeId: string;
  activeProvider: AsrProviderListEntry | null;
  asrLanguage: string;
  setupState: AsrSetupState;
}

export interface ResolveActiveAsrRuntimeDeps {
  loadProviders?: () => Promise<readonly AsrProviderListEntry[]>;
  getSettings?: () => Promise<Partial<Pick<Settings, "asrAutoFallback" | "activeAsrProviderId" | "asrLanguage">>>;
}

export async function loadAsrProviderList(): Promise<AsrProviderListEntry[]> {
  try {
    const resp = await sendRuntimeMessage({ type: "asr-providers-list" });
    return Array.isArray(resp?.providers) ? (resp.providers as AsrProviderListEntry[]) : [];
  } catch {
    return [];
  }
}

export async function resolveActiveAsrRuntimeState(
  deps: ResolveActiveAsrRuntimeDeps = {}
): Promise<ActiveAsrRuntimeState> {
  const loadProviders = deps.loadProviders ?? loadAsrProviderList;
  const readSettings = deps.getSettings ?? getSettings;
  const [rawProviders, settings] = await Promise.all([loadProviders(), readSettings()]);
  const providers = Array.isArray(rawProviders) ? [...rawProviders] : [];
  const activeAsrProviderId =
    typeof settings?.activeAsrProviderId === "string" ? settings.activeAsrProviderId : "";
  const activeId = resolveActiveAsrProviderId(providers, activeAsrProviderId);
  const activeProvider =
    providers.find((item) => String(item?.id || "").trim() === activeId) ?? null;
  const asrLanguage =
    typeof settings?.asrLanguage === "string" && settings.asrLanguage.trim()
      ? settings.asrLanguage.trim()
      : "auto";
  const setupState = resolveAsrSetupState({
    asrAutoFallback: settings?.asrAutoFallback,
    activeAsrProviderId,
    providers
  });
  return {
    providers,
    activeId,
    activeProvider,
    asrLanguage,
    setupState
  };
}
