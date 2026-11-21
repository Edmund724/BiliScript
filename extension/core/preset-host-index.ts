import { PRESETS } from "./presets.js";

const PRESET_HOST_INDEX = new Map<string, string>();

export function hostOf(baseUrl: unknown): string {
  try {
    return new URL(String(baseUrl || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

for (const preset of PRESETS) {
  const host = hostOf(preset.baseUrl);
  if (host) {
    PRESET_HOST_INDEX.set(host, preset.id);
  }
}
PRESET_HOST_INDEX.set("api.siliconflow.cn", "siliconflow");

export function presetIdForHost(host: string): string | null {
  return PRESET_HOST_INDEX.get(host) ?? null;
}
