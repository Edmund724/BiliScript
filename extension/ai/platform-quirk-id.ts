import { PLATFORM_QUIRKS } from "./compat-vocab.js";
import { hostOf, presetIdForHost } from "../core/preset-host-index.js";

export function resolvePlatformQuirkId(presetId?: string, baseUrl?: string): string | undefined {
  const byId = String(presetId || "").trim();
  if (isQuirkPlatform(byId)) {
    return byId;
  }
  const byHost = presetIdForHost(hostOf(String(baseUrl || "")));
  return byHost && isQuirkPlatform(byHost) ? byHost : undefined;
}

function isQuirkPlatform(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(PLATFORM_QUIRKS, id);
}
