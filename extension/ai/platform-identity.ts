import { hostOf, presetIdForHost } from "../core/preset-host-index.js";
import { isPlatformKey, type PlatformKey } from "./platform-identity-vocab.js";

export function resolvePlatformId(presetId?: string, baseUrl?: string): PlatformKey | undefined {
  const byId = String(presetId || "").trim();
  if (isPlatformKey(byId)) {
    return byId;
  }
  const byHost = presetIdForHost(hostOf(String(baseUrl || "")));
  return isPlatformKey(byHost) ? byHost : undefined;
}
