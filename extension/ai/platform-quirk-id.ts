import { PLATFORM_QUIRKS } from "./compat-vocab.js";
import { resolvePlatformId } from "./platform-identity.js";

export function resolvePlatformQuirkId(presetId?: string, baseUrl?: string): string | undefined {
  const platformId = resolvePlatformId(presetId, baseUrl);
  return platformId && isQuirkPlatform(platformId) ? platformId : undefined;
}

function isQuirkPlatform(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(PLATFORM_QUIRKS, id);
}
