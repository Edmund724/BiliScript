// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ASR_PROVIDER_PRESETS, PRESETS } from "../../extension/core/presets.js";
import {
  getEsbuildTarget,
  getTargetDefine,
  resolveTargetPlatform,
} from "../../scripts/build-guards.js";
import {
  FIREFOX_EXTENSION_PAGES_CSP,
  FIREFOX_GECKO_SETTINGS,
  LIVE_MATCH_PATTERN,
  deriveFirefoxManifest,
  extractOfficialHttpsHostPermissions,
  loadExtensionPresets,
} from "../../scripts/firefox-manifest.js";

const chromiumManifest = JSON.parse(readFileSync("extension/manifest.json", "utf8")) as {
  minimum_chrome_version?: string;
  permissions: string[];
  host_permissions: string[];
  background: { service_worker?: string; scripts?: string[]; type?: string };
  content_scripts: Array<{ matches: string[] }>;
  web_accessible_resources: Array<{ resources: string[]; matches: string[] }>;
};

function expectedOfficialHttpsOriginsFromPresets(): string[] {
  const urls: string[] = [];
  for (const preset of PRESETS) {
    if (preset.id === "custom") continue;
    urls.push(preset.baseUrl, ...Object.values(preset.protocolBaseUrls ?? {}));
  }
  for (const preset of ASR_PROVIDER_PRESETS) {
    if (preset.id === "custom") continue;
    urls.push(preset.baseUrl);
  }
  const patterns = new Set<string>();
  for (const raw of urls) {
    if (!raw) continue;
    const parsed = new URL(raw);
    if (parsed.protocol === "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      patterns.add(`${parsed.protocol}//${parsed.hostname}/*`);
    }
  }
  return [...patterns];
}

describe("Firefox Manifest 派生（scripts/firefox-manifest.js）", () => {
  it("实时同步 core/presets.ts 的官方 HTTPS 预设并与既有 15 域合并为 28 个常驻域", () => {
    const derived = deriveFirefoxManifest(chromiumManifest, {
      presets: PRESETS,
      asrPresets: ASR_PROVIDER_PRESETS,
    });

    const expectedPresetOrigins = expectedOfficialHttpsOriginsFromPresets();
    expect(expectedPresetOrigins).toHaveLength(14);
    for (const origin of expectedPresetOrigins) {
      expect(derived.host_permissions).toContain(origin);
    }

    expect(derived.host_permissions).toHaveLength(28);
    expect(new Set(derived.host_permissions).size).toBe(28);
    expect(new Set(derived.host_permissions)).toEqual(
      new Set([...chromiumManifest.host_permissions, ...expectedPresetOrigins])
    );
  });

  it("presets.ts 加载器与 Vitest 直接导入的官方预设完全一致", () => {
    const loaded = loadExtensionPresets();
    expect(extractOfficialHttpsHostPermissions(loaded.presets, loaded.asrPresets)).toEqual(
      extractOfficialHttpsHostPermissions(PRESETS, ASR_PROVIDER_PRESETS)
    );
  });

  it("排除 http://localhost*、custom 空串与宽泛通配符", () => {
    const derived = deriveFirefoxManifest(chromiumManifest, {
      presets: PRESETS,
      asrPresets: ASR_PROVIDER_PRESETS,
    });

    for (const pattern of derived.host_permissions) {
      expect(pattern).not.toBe("<all_urls>");
      expect(pattern).not.toBe("https://*/*");
      expect(pattern).not.toBe("http://*/*");
      expect(pattern).not.toBe("ws://*/*");
      expect(pattern).not.toBe("wss://*/*");
      expect(pattern).not.toMatch(/^http:\/\/localhost/);
    }
  });

  it("转换 background 为 scripts 数组，移除 minimum_chrome_version、offscreen 与 tts", () => {
    const snapshot = JSON.stringify(chromiumManifest);
    const derived = deriveFirefoxManifest(chromiumManifest, {
      presets: PRESETS,
      asrPresets: ASR_PROVIDER_PRESETS,
    });

    expect("minimum_chrome_version" in derived).toBe(false);
    expect(derived.background).toEqual({
      scripts: ["entry/background.js"],
      type: "module",
    });
    expect("service_worker" in derived.background).toBe(false);

    expect(derived.permissions).not.toContain("offscreen");
    expect(derived.permissions).not.toContain("tts");
    expect(derived.permissions).toEqual([
      "storage",
      "unlimitedStorage",
      "tabs",
      "alarms",
      "scripting",
      "declarativeNetRequest",
    ]);

    expect(JSON.stringify(chromiumManifest)).toBe(snapshot);
  });

  it("注入 browser_specific_settings.gecko 合规字段且不声明 gecko_android", () => {
    const derived = deriveFirefoxManifest(chromiumManifest, {
      presets: PRESETS,
      asrPresets: ASR_PROVIDER_PRESETS,
    });

    expect(derived.browser_specific_settings).toEqual({
      gecko: {
        id: FIREFOX_GECKO_SETTINGS.id,
        strict_min_version: "153.0",
        data_collection_permissions: {
          required: ["websiteContent", "searchTerms", "authenticationInfo"],
        },
      },
    });
    expect(derived.browser_specific_settings.gecko.id).toBe("biliscript@edmund724.github.io");
    expect("gecko_android" in derived.browser_specific_settings).toBe(false);
  });

  it("首期移除 live.bilibili.com 内容脚本与 web_accessible_resources 匹配项", () => {
    const derived = deriveFirefoxManifest(chromiumManifest, {
      presets: PRESETS,
      asrPresets: ASR_PROVIDER_PRESETS,
    });

    expect(
      derived.content_scripts.some((cs: { matches: string[] }) =>
        cs.matches.includes(LIVE_MATCH_PATTERN)
      )
    ).toBe(false);
    expect(derived.content_scripts).toHaveLength(1);

    for (const war of derived.web_accessible_resources) {
      expect(war.matches).not.toContain(LIVE_MATCH_PATTERN);
    }
    expect(derived.web_accessible_resources[0]?.matches).toEqual(["https://www.bilibili.com/*"]);
    expect(derived.content_scripts[0]?.matches).toContain("https://www.bilibili.com/list/*");
    expect(derived.content_scripts[0]?.matches).toContain("https://www.bilibili.com/festival/*");
  });

  it("显式声明 extension_pages CSP 为 script-src 'self'，解除 Firefox MV3 默认 upgrade-insecure-requests", () => {
    const derived = deriveFirefoxManifest(chromiumManifest, {
      presets: PRESETS,
      asrPresets: ASR_PROVIDER_PRESETS,
    });

    expect(derived.content_security_policy).toEqual({
      extension_pages: FIREFOX_EXTENSION_PAGES_CSP,
    });
    expect(derived.content_security_policy.extension_pages).toBe("script-src 'self'");
    expect(derived.content_security_policy.extension_pages).not.toContain("upgrade-insecure-requests");
  });
});

describe("构建目标解析（scripts/build-guards.js）", () => {
  it("默认解析为 chromium / chrome120，--target=firefox 解析为 firefox / firefox153", () => {
    expect(resolveTargetPlatform(["node", "scripts/build.js"])).toBe("chromium");
    expect(resolveTargetPlatform(["node", "scripts/build.js", "--target=firefox"])).toBe("firefox");
    expect(getEsbuildTarget("chromium")).toBe("chrome120");
    expect(getEsbuildTarget("firefox")).toBe("firefox153");
    expect(getTargetDefine("chromium")).toEqual({ __BILISCRIPT_TARGET__: '"chromium"' });
    expect(getTargetDefine("firefox")).toEqual({ __BILISCRIPT_TARGET__: '"firefox"' });
    expect(() => resolveTargetPlatform(["node", "scripts/build.js", "--target=safari"])).toThrow();
    expect(() => getTargetDefine("safari")).toThrow();
  });
});
