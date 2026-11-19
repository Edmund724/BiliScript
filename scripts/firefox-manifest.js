// 构建期 Firefox Manifest 派生纯函数模块（ADR-0028 / 工单 01）。
//
// 设计原则：
//   - extension/manifest.json 维持 Chromium 120 单一事实源；
//   - 本模块提供纯函数 deriveFirefoxManifest 与官方 HTTPS 预设提取函数，
//     供 scripts/build.js --target=firefox 与 Vitest 单测直接复用；
//   - 不依赖静态手抄域名表：build 时从 extension/core/presets.ts 实时加载
//     PRESETS（含 protocolBaseUrls）与 ASR_PROVIDER_PRESETS，自动合并去重。

const path = require("path");

const DEFAULT_PRESETS_PATH = path.join(__dirname, "..", "extension", "core", "presets.ts");
const LIVE_MATCH_PATTERN = "https://live.bilibili.com/*";
const FIREFOX_REMOVED_PERMISSIONS = new Set(["offscreen", "tts"]);
const FIREFOX_EXTENSION_PAGES_CSP = "script-src 'self'";

const FIREFOX_GECKO_SETTINGS = Object.freeze({
  id: "biliscript@edmund724.github.io",
  strict_min_version: "140.0",
  data_collection_permissions: Object.freeze({
    required: Object.freeze(["websiteContent", "searchTerms", "authenticationInfo"]),
  }),
});

/**
 * 将单个预设 URL 归一化为无端口 HTTPS host permission（`${protocol}//${hostname}/*`）。
 * 非 https 协议、空串、非法 URL 及 localhost/127.0.0.1 返回 null。
 */
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

/**
 * @typedef {{ id?: string; baseUrl?: string; protocolBaseUrls?: Record<string, string | undefined> }} PresetLike
 */

/**
 * 从 PRESETS（含 protocolBaseUrls）与 ASR_PROVIDER_PRESETS 提取全部官方 HTTPS 预设域。
 * @param {readonly PresetLike[]} [presets]
 * @param {readonly PresetLike[]} [asrPresets]
 * @returns {string[]}
 */
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

/**
 * 在 Node CJS 构建期环境编译并读取 extension/core/presets.ts 的 PRESETS 与 ASR_PROVIDER_PRESETS。
 */
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

/**
 * 纯函数：由 Chromium manifest 与 presets.ts 数据派生桌面端 Firefox 140+ manifest。
 * 不修改入参对象。
 * @param {Record<string, any>} chromiumManifest
 * @param {{ presets?: readonly PresetLike[]; asrPresets?: readonly PresetLike[] }} [options]
 */
function deriveFirefoxManifest(chromiumManifest, { presets = [], asrPresets = [] } = {}) {
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

  // Firefox MV3 默认 extension_pages CSP 含 upgrade-insecure-requests，会将后台对本机
  // Agent Bridge（ws://127.0.0.1）与本地模型服务（http://localhost）的连接强制升级为
  // wss:///https:// 导致握手失败；显式声明 script-src 'self' 仅解除该自动升级。
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
