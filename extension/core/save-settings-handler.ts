import { withOkResponse } from "./provider-handlers.js";
import { isSearchOptOut } from "../search/search-opt-out.js";

export interface SaveSettingsHandlerDeps {
  saveSettingsWithInvalidate: (payload: unknown) => Promise<unknown>;
  getSettingsSnapshot: () => Promise<{ webSearchEnabled?: boolean }>;
  onSearchOptOut?: () => Promise<void>;
  onSettingsSaved?: () => Promise<void>;
}

export function createSaveSettingsHandler({
  saveSettingsWithInvalidate,
  getSettingsSnapshot,
  onSearchOptOut,
  onSettingsSaved
}: SaveSettingsHandlerDeps): (
  message: unknown,
  sender: unknown,
  sendResponse: (response: { ok: boolean; error?: string }) => void
) => void {
  return function handleSaveSettings(
    message: unknown,
    _sender: unknown,
    sendResponse: (response: { ok: boolean; error?: string }) => void
  ): void {
    withOkResponse(
      (async () => {
        const payload = (message as { settings?: unknown } | null | undefined)?.settings || {};
        const searchOptOut = isSearchOptOut(
          (await getSettingsSnapshot()).webSearchEnabled === true,
          payload
        );
        await saveSettingsWithInvalidate(payload);
        if (searchOptOut && onSearchOptOut) {
          await onSearchOptOut();
        }
        await onSettingsSaved?.();
        return { ok: true as const };
      })(),
      sendResponse
    );
  };
}
