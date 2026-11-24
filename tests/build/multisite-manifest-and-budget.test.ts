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

function collectLazyExternals(extensionRoot: string, buildContentText: string): Map<string, string> {
  const lazyExternals = new Map<string, string>();
  for (const match of buildContentText.matchAll(
    /\{\s*name:\s*"([^"]+)",\s*source:\s*"([^"]+)"\s*\}/g
  )) {
    lazyExternals.set(resolve(extensionRoot, match[2]), `./chunks/${match[1]}.mjs`);
  }
  return lazyExternals;
}

function resolveLazyExternalTarget(
  lazyExternals: Map<string, string>,
  resolveDir: string,
  importPath: string
): { path: string; external: boolean } | undefined {
  const resolved = resolve(resolveDir, importPath);
  const candidates = resolved.endsWith(".js")
    ? [resolved, `${resolved.slice(0, -3)}.ts`]
    : [resolved];
  for (const candidate of candidates) {
    const externalPath = lazyExternals.get(candidate);
    if (externalPath) {
      return { path: externalPath, external: true };
    }
  }
  return undefined;
}

async function buildResidentBundleForBudgetTest() {
  const extensionRoot = resolve(ROOT, "extension");
  const lazyExternals = collectLazyExternals(extensionRoot, readText("scripts/build-content.js"));
  const lazyPlugin = {
    name: "test-lazy-external",
    setup(buildApi: {
      onResolve: (
        opts: { filter: RegExp },
        cb: (args: { resolveDir: string; path: string }) => { path: string; external: boolean } | undefined
      ) => void;
    }) {
      buildApi.onResolve({ filter: /^\.\.?\// }, (args) =>
        resolveLazyExternalTarget(lazyExternals, args.resolveDir, args.path)
      );
    }
  };

  const [bootstrapResult, mainResult] = await Promise.all([
    build({
      entryPoints: [resolve(extensionRoot, "entry", "content-bootstrap-entry.ts")],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      minify: true,
      target: "chrome120"
    }),
    build({
      entryPoints: [resolve(extensionRoot, "entry", "content.ts")],
      bundle: true,
      splitting: false,
      write: false,
      format: "esm",
      platform: "browser",
      minify: true,
      target: "chrome120",
      metafile: true,
      plugins: [lazyPlugin]
    })
  ]);

  const bootstrapBytes = bootstrapResult.outputFiles[0].contents.byteLength;
  const mainBytes = mainResult.outputFiles[0].contents.byteLength;
  return {
    residentBytes: bootstrapBytes + mainBytes,
    mainText: mainResult.outputFiles[0].text,
    mainInputs: Object.keys(mainResult.metafile.inputs)
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
    metafile: true
  });

  return {
    backgroundBytes: result.outputFiles[0].contents.byteLength,
    backgroundInputs: Object.keys(result.metafile.inputs)
  };
}

describe("多站点 Manifest 与多语言文案", () => {
  const manifest = readJson<{
    host_permissions: string[];
    content_scripts: Array<{ matches: string[] }>;
    web_accessible_resources: Array<{ matches: string[] }>;
    action: { default_title: string };
  }>("extension/manifest.json");

  it("extension/manifest.json 显式声明 YouTube 桌面权限、内容脚本、资源匹配与泛化标题", () => {
    expect(manifest.host_permissions).toContain("https://www.bilibili.com/*");
    expect(manifest.host_permissions).toContain("https://www.youtube.com/*");
    expect(manifest.host_permissions).not.toContain("<all_urls>");
    expect(manifest.host_permissions).not.toContain("https://*/*");
    expect(manifest.host_permissions).not.toContain("https://*.youtube.com/*");

    expect(manifest.content_scripts[0]?.matches).toContain("https://www.youtube.com/watch*");
    expect(manifest.web_accessible_resources[0]?.matches).toContain("https://www.youtube.com/*");
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

  it("Firefox 派生清单同步包含 YouTube 显式声明", () => {
    const derived = deriveFirefoxManifest(manifest, {
      presets: PRESETS,
      asrPresets: ASR_PROVIDER_PRESETS
    });
    expect(derived.host_permissions).toContain("https://www.youtube.com/*");
    expect(derived.content_scripts[0]?.matches).toContain("https://www.youtube.com/watch*");
    expect(derived.web_accessible_resources[0]?.matches).toContain("https://www.youtube.com/*");
  });
});

describe("常驻内容包瘦身与 40 KB 预算", () => {
  it("message-handler 懒加载 agent-bridge/content，kick-subtitle-fetch 不导入 video-probe / host-selectors", () => {
    const buildContentText = readText("scripts/build-content.js");
    expect(buildContentText).toContain('{ name: "agent-bridge-content", source: "agent-bridge/content.ts" }');

    const messageHandlerText = readText("extension/entry/message-handler.ts");
    expect(messageHandlerText).toContain('import("../agent-bridge/content.js")');
    expect(messageHandlerText).not.toMatch(/from\s+["'][^"']*agent-bridge\/content/);

    const kickText = readText("extension/subtitle/kick-subtitle-fetch.ts");
    expect(kickText).not.toContain("video-probe");
    expect(kickText).not.toContain("host-selectors");
  });

  it("实包打包：常驻包（bootstrap + main）严格低于 40960 B 且不含 host-selectors / agent-bridge-content / youtube/ 静态代码", async () => {
    const { residentBytes, mainText, mainInputs } = await buildResidentBundleForBudgetTest();

    expect(residentBytes).toBeLessThanOrEqual(40960);
    expect(mainText).not.toContain(".bpx-player-container");
    expect(mainText).toContain("./chunks/agent-bridge-content.mjs");
    expect(mainInputs.some((input) => input.replace(/\\/g, "/").includes("extension/youtube/"))).toBe(false);
  });

  it("background 静态打包不含 extension/youtube/，subtitle/body 不直连 youtube/gateway，且 build.js 禁区清单已登记", async () => {
    const { backgroundBytes, backgroundInputs } = await buildBackgroundBundleForBudgetTest();
    const buildJsText = readText("scripts/build.js");
    const forbiddenBlock = buildJsText.slice(
      buildJsText.indexOf("BACKGROUND_FORBIDDEN_STATIC_SOURCES"),
      buildJsText.indexOf("function assertBackgroundStaticGraphSlim")
    );
    const bodyText = readText("extension/subtitle/body.ts");

    expect(backgroundBytes).toBeLessThanOrEqual(256 * 1024);
    expect(backgroundInputs.some((input) => input.replace(/\\/g, "/").includes("extension/youtube/"))).toBe(false);
    expect(bodyText).not.toContain("youtube/gateway");
    expect(forbiddenBlock).toContain("youtube\\/");
  });
});
