// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { ASR_PROVIDER_PRESETS, PRESETS } from "../../extension/core/presets.js";
import { deriveFirefoxManifest } from "../../scripts/firefox-manifest.js";

const ROOT = process.cwd();
const readJson = <T>(rel: string): T => JSON.parse(readFileSync(resolve(ROOT, rel), "utf8")) as T;
const readText = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");

function collectGroupTargetSources(extensionRoot: string, buildContentText: string): Set<string> {
  const targets = new Set<string>();
  const start = buildContentText.indexOf("const ALL_GROUPS =");
  const end = buildContentText.indexOf("const ACTIVE_GROUPS =");
  const block = buildContentText.slice(start, end);
  for (const match of block.matchAll(/"([a-z0-9-]+\/[a-z0-9-]+\.ts)"/g)) {
    targets.add(resolve(extensionRoot, match[1]));
  }
  return targets;
}

async function buildResidentBundleForBudgetTest() {
  const extensionRoot = resolve(ROOT, "extension");
  const buildContentText = readText("scripts/build-content.js");
  const targetSources = collectGroupTargetSources(extensionRoot, buildContentText);
  const bridgePlugin = {
    name: "test-b2-dynamic-bridge",
    setup(buildApi: {
      onResolve: (
        opts: { filter: RegExp },
        cb: (args: { kind: string; resolveDir: string; path: string }) =>
          | { path: string; namespace: string }
          | undefined
      ) => void;
      onLoad: (
        opts: { filter: RegExp; namespace: string },
        cb: (args: { path: string }) => { contents: string; loader: "js" }
      ) => void;
    }) {
      buildApi.onResolve({ filter: /^\.\.?\// }, (args) => {
        if (args.kind !== "dynamic-import") return undefined;
        const resolved = resolve(args.resolveDir, args.path);
        const candidates = resolved.endsWith(".js")
          ? [resolved, `${resolved.slice(0, -3)}.ts`]
          : [resolved];
        const hit = candidates.find((c) => targetSources.has(c));
        return hit ? { path: hit, namespace: "test-b2-remote" } : undefined;
      });
      buildApi.onLoad({ filter: /.*/, namespace: "test-b2-remote" }, (args) => ({
        contents: `module.exports = globalThis.__BILISCRIPT_LOAD_CHUNK__("g-test", ${JSON.stringify(args.path)}, false);`,
        loader: "js",
      }));
    },
  };

  const result = await build({
    stdin: {
      contents: `import "./entry/content.ts";\nglobalThis.__BILISCRIPT_LOAD_CHUNK__ = globalThis.__BILISCRIPT_LOAD_CHUNK__ || (async () => ({}));`,
      resolveDir: extensionRoot,
      loader: "ts",
      sourcefile: "test-resident-entry.ts",
    },
    bundle: true,
    splitting: false,
    write: false,
    format: "iife",
    platform: "browser",
    minify: true,
    target: "chrome120",
    metafile: true,
    plugins: [bridgePlugin],
  });

  const out = result.outputFiles[0];
  return {
    residentBytes: out.contents.byteLength,
    residentText: out.text,
    residentInputs: Object.keys(result.metafile.inputs),
  };
}

async function buildBackgroundBundleForBudgetTest() {
  const extensionRoot = resolve(ROOT, "extension");
  const result = await build({
    entryPoints: [resolve(extensionRoot, "entry", "background.ts")],
    bundle: true,
    splitting: false,
    write: false,
    format: "esm",
    platform: "browser",
    minify: true,
    target: "chrome120",
    metafile: true,
  });

  return {
    backgroundBytes: result.outputFiles[0].contents.byteLength,
    backgroundInputs: Object.keys(result.metafile.inputs),
  };
}

describe("多站点 Manifest 与多语言文案", () => {
  const manifest = readJson<{
    permissions: string[];
    optional_permissions?: string[];
    host_permissions: string[];
    content_scripts: Array<{ matches: string[]; js: string[]; all_frames?: boolean }>;
    web_accessible_resources: Array<{ resources: string[]; matches: string[] }>;
    action: { default_title: string };
  }>("extension/manifest.json");

  it("extension/manifest.json 显式声明桌面与直播权限、经典首帧注入与最小 WAR 暴露面", () => {
    expect(manifest.host_permissions).toContain("https://www.bilibili.com/*");
    expect(manifest.host_permissions).toContain("https://www.youtube.com/*");
    expect(manifest.host_permissions).toContain("https://live.bilibili.com/*");
    expect(manifest.host_permissions).not.toContain("<all_urls>");
    expect(manifest.host_permissions).not.toContain("https://*/*");
    expect(manifest.host_permissions).not.toContain("https://*.youtube.com/*");

    expect(manifest.content_scripts[0]?.matches).toContain("https://www.youtube.com/watch*");
    expect(manifest.content_scripts[0]?.js).toEqual(["entry/content-resident.iife.js"]);
    expect(manifest.content_scripts[1]?.matches).toEqual(["https://live.bilibili.com/*"]);
    expect(manifest.content_scripts[1]?.js).toEqual(["entry/content-resident.iife.js"]);
    expect(manifest.content_scripts[1]?.all_frames).toBe(true);

    expect(manifest.web_accessible_resources).toEqual([
      {
        resources: ["entry/chunks/pcm-capture-worklet.mjs"],
        matches: ["https://www.bilibili.com/*", "https://live.bilibili.com/*"],
      },
    ]);
    expect(manifest.action.default_title).toBe("BiliScript｜视频文摘");
  });

  it("_locales/zh_CN/messages.json 保持 appName 不变且 appDesc 覆盖 B 站与 YouTube", () => {
    const messages = readJson<{
      appName: { message: string };
      appDesc: { message: string };
    }>("extension/_locales/zh_CN/messages.json");

    expect(messages.appName.message).toBe("BiliScript｜B站视频文摘");
    expect(messages.appDesc.message).toContain("B 站");
    expect(messages.appDesc.message).toContain("YouTube");
  });

  it("Firefox 派生清单保留 YouTube 显式声明，剔除 live 权限/脚本并清空 WAR", () => {
    const derived = deriveFirefoxManifest(manifest, {
      presets: PRESETS,
      asrPresets: ASR_PROVIDER_PRESETS,
    });
    expect(derived.host_permissions).toContain("https://www.youtube.com/*");
    expect(derived.host_permissions).not.toContain("https://live.bilibili.com/*");
    expect(derived.content_scripts[0]?.matches).toContain("https://www.youtube.com/watch*");
    expect(derived.web_accessible_resources).toBeUndefined();
    expect(manifest.optional_permissions).toContain("downloads");
    expect(derived.optional_permissions).toContain("downloads");
    expect(manifest.permissions).not.toContain("downloads");
    expect(derived.permissions).not.toContain("downloads");
  });
});

describe("常驻内容包瘦身与 45 KB 预算", () => {
  it("message-handler 懒加载 agent-bridge/content，kick-subtitle-fetch 不导入 video-probe / host-selectors", () => {
    const buildContentText = readText("scripts/build-content.js");
    expect(buildContentText).toContain('"agent-bridge/content.ts"');

    const messageHandlerText = readText("extension/entry/message-handler.ts");
    expect(messageHandlerText).toContain('import("../agent-bridge/content.js")');
    expect(messageHandlerText).not.toMatch(/from\s+["'][^"']*agent-bridge\/content/);

    const kickText = readText("extension/subtitle/kick-subtitle-fetch.ts");
    expect(kickText).not.toContain("video-probe");
    expect(kickText).not.toContain("host-selectors");
  });

  it("实包打包：经典常驻包严格低于 46080 B 且不含 host-selectors / youtube/ 静态代码", async () => {
    const { residentBytes, residentText, residentInputs } = await buildResidentBundleForBudgetTest();

    expect(residentBytes).toBeLessThanOrEqual(46080);
    expect(residentText).not.toContain(".bpx-player-container");
    expect(residentText).toContain("__BILISCRIPT_LOAD_CHUNK__");
    expect(residentInputs.some((input) => input.replace(/\\/g, "/").includes("extension/youtube/"))).toBe(false);
  });

  it("background 静态打包不含 extension/youtube/，subtitle/body 不直连 youtube/gateway，且 build.js 禁区清单已登记", async () => {
    const { backgroundBytes, backgroundInputs } = await buildBackgroundBundleForBudgetTest();
    const buildJsText = readText("scripts/build.js");
    const forbiddenBlock = buildJsText.slice(
      buildJsText.indexOf("BACKGROUND_FORBIDDEN_STATIC_SOURCES"),
      buildJsText.indexOf("function assertBackgroundStaticGraphSlim")
    );
    const bodyText = readText("extension/subtitle/body.ts");

    expect(backgroundBytes).toBeLessThanOrEqual(300 * 1024);
    expect(backgroundInputs.some((input) => input.replace(/\\/g, "/").includes("extension/youtube/"))).toBe(false);
    expect(bodyText).not.toContain("youtube/gateway");
    expect(forbiddenBlock).toContain("youtube\\/");
  });

  it("g-subtitle 独立分组就绪且双端 ZIP/运行时/常驻预算配置一致", () => {
    const buildContentText = readText("scripts/build-content.js");
    const buildJsText = readText("scripts/build.js");
    const buildReleaseText = readText("scripts/build_release.py");

    expect(buildContentText).toContain('"g-subtitle"');
    expect(buildContentText).toContain("MAX_RESIDENT_BYTES = 46080");
    expect(buildJsText).toContain('targetPlatform === "firefox" ? 4050000 : 4350000');
    expect(buildReleaseText).toContain("MAX_CHROMIUM_ZIP_BYTES = 1_200_000");
    expect(buildReleaseText).toContain("MAX_FIREFOX_ZIP_BYTES = 1_200_000");
  });
});
