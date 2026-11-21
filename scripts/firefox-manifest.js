const path = require("path");

const DEFAULT_PRESETS_PATH = path.join(__dirname, "..", "extension", "core", "presets.ts");
const LIVE_MATCH_PATTERN = "https://live.bilibili.com/*";
const FIREFOX_REMOVED_PERMISSIONS = new Set(["offscreen", "tts"]);
const FIREFOX_EXTENSION_PAGES_CSP = "script-src 'self'";

const FIREFOX_GECKO_SETTINGS = Object.freeze({
  id: "biliscript@edmund724.github.io",
  strict_min_version: "153.0",
  data_collection_permissions: Object.freeze({
    required: Object.freeze(["websiteContent", "searchTerms", "authenticationInfo"]),
  }),
});

function toOfficialHttpsHostPattern(rawUrl) {
  const trimmed = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) return null;
  if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") return null;
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

function extractOfficialHttpsHostPermissions(presets, asrPresets) {
  const collected = new Set();

  for (const preset of presets ?? []) {
    if (!preset || preset.id === "custom") continue;
    const candidates = [preset.baseUrl, ...Object.values(preset.protocolBaseUrls ?? {})];
    for (const url of candidates) {
      const pattern = toOfficialHttpsHostPattern(url);
      if (pattern) collected.add(pattern);
    }
  }

  for (const preset of asrPresets ?? []) {
    if (!preset || preset.id === "custom") continue;
    const pattern = toOfficialHttpsHostPattern(preset.baseUrl);
    if (pattern) collected.add(pattern);
  }

  return [...collected];
}

function loadExtensionPresets(presetsPath = DEFAULT_PRESETS_PATH) {
  const esbuild = require("esbuild");
  const result = esbuild.buildSync({
    entryPoints: [presetsPath],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    logLevel: "silent",
  });
  const code = result.outputFiles[0]?.text;
  if (!code) {
    throw new Error(`firefox-manifest: failed to bundle ${presetsPath}`);
  }
  const mod = { exports: {} };
  const evaluator = new Function("exports", "module", code);
  evaluator(mod.exports, mod);
  const { PRESETS, ASR_PROVIDER_PRESETS } = mod.exports;
  if (!Array.isArray(PRESETS) || !Array.isArray(ASR_PROVIDER_PRESETS)) {
    throw new Error(
      `firefox-manifest: ${presetsPath} must export PRESETS and ASR_PROVIDER_PRESETS arrays`
    );
  }
  return { presets: PRESETS, asrPresets: ASR_PROVIDER_PRESETS };
}

function deriveFirefoxManifest(chromiumManifest, { presets, asrPresets } = {}) {
  const derived = JSON.parse(JSON.stringify(chromiumManifest));

  delete derived.minimum_chrome_version;

  derived.permissions = (derived.permissions ?? []).filter(
    (perm) => !FIREFOX_REMOVED_PERMISSIONS.has(perm)
  );

  const officialHosts = extractOfficialHttpsHostPermissions(presets, asrPresets);
  derived.host_permissions = [...new Set([...(derived.host_permissions ?? []), ...officialHosts])];

  const bgScript = derived.background?.service_worker ?? "entry/background.js";
  const bgType = derived.background?.type ?? "module";
  derived.background = {
    scripts: [bgScript],
    type: bgType,
  };

  derived.content_scripts = (derived.content_scripts ?? []).filter(
    (entry) => !(entry.matches ?? []).includes(LIVE_MATCH_PATTERN)
  );

  derived.web_accessible_resources = (derived.web_accessible_resources ?? [])
    .map((entry) => ({
      ...entry,
      matches: (entry.matches ?? []).filter((pattern) => pattern !== LIVE_MATCH_PATTERN),
    }))
    .filter((entry) => entry.matches.length > 0);

  const existingGecko = derived.browser_specific_settings?.gecko ?? {};
  const nextSettings = {
    ...(derived.browser_specific_settings ?? {}),
    gecko: {
      ...existingGecko,
      id: FIREFOX_GECKO_SETTINGS.id,
      strict_min_version: FIREFOX_GECKO_SETTINGS.strict_min_version,
      data_collection_permissions: {
        required: [...FIREFOX_GECKO_SETTINGS.data_collection_permissions.required],
      },
    },
  };
  delete nextSettings.gecko_android;
  derived.browser_specific_settings = nextSettings;

  derived.content_security_policy = {
    ...(derived.content_security_policy ?? {}),
    extension_pages:
      derived.content_security_policy?.extension_pages ?? FIREFOX_EXTENSION_PAGES_CSP,
  };

  return derived;
}

module.exports = {
  FIREFOX_GECKO_SETTINGS,
  FIREFOX_EXTENSION_PAGES_CSP,
  LIVE_MATCH_PATTERN,
  toOfficialHttpsHostPattern,
  extractOfficialHttpsHostPermissions,
  loadExtensionPresets,
  deriveFirefoxManifest,
};
