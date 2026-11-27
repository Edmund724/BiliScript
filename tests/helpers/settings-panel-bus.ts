import { installSendMessageHost, type RuntimeReplies, type SendMessageHost } from "./chrome-runtime-host.js";

export type BusMessage = { type: string } & Record<string, unknown>;

export type BusResponder<M = any> = (message: M) => unknown;

export const SETTINGS_PANEL_BUS_REPLIES: RuntimeReplies = {
  "get-settings": () => ({ ok: true, settings: {} }),
  "ai-presets-list": () => ({ ok: false }),
  "asr-presets-list": () => ({ ok: false }),
  "ai-providers-list": () => ({ ok: true, providers: [] }),
  "asr-providers-list": () => ({ ok: true, providers: [] }),
  "search-providers-list": () => ({ ok: true, providers: [] }),
  "live-providers-list": () => ({ ok: true, providers: [] }),
  "agent-bridge-status": () => ({ ok: true, connected: false }),
  "agent-bridge-connect": () => ({ ok: true, connected: false }),
  "agent-bridge-test": () => ({ ok: true, connected: false }),
  "revoke-provider-origin": () => ({ origins: [], revoked: false }),
  "save-settings": () => ({ ok: true }),
  "subtitle-cache": () => ({ handled: false })
};

export type MessageBusHost<M extends BusMessage = BusMessage> = SendMessageHost<M>;

export function installSettingsPanelBus<M extends BusMessage = BusMessage>(
  overrides: Record<string, unknown | BusResponder<M>> = {}
): MessageBusHost<M> {
  return installSendMessageHost<M>({ ...SETTINGS_PANEL_BUS_REPLIES, ...overrides } as RuntimeReplies);
}
