// tests/ai/model-catalog.test.ts
// 模型目录（model-catalog/01–03）：构建期产物的形状与叶子纪律、preset→piProvider
// 的覆盖/反向对账、查表语义（键 = (piProvider, modelId)，protocol 不参与）。
//
// 叶子不变式与"只准懒加载"两条在这里静态把关（对齐
// tests/ai/protocol-vocab.test.ts 的读源码手法 + tests/layer-deps.test.ts 的
// 相对 import 扫描手法）：产物零 import，且静态 import 产物的只有
// ai/model-catalog.ts、静态 import ai/model-catalog 的一个都没有。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { NO_CATALOG_PRESETS, PRESETS } from "../../extension/core/presets.js";
import { lookupCatalogMeta, resolvePiProvider } from "../../extension/ai/model-catalog.js";
import {
  PI_AI_CATALOG,
  PI_AI_CATALOG_SOURCE,
  lookupModelMeta
} from "../../extension/ai/catalog/pi-ai-catalog.generated.js";

const GENERATED_MODULE = "extension/ai/catalog/pi-ai-catalog.generated.ts";
// 静态引用形状里的路径口径 = 相对 extension/（walk 的口径）
const CATALOG_CONSUMER = "ai/model-catalog.ts";

// spec §数据来源与范围 的 11 个 vendor 文件（顺序 = 产物键序）
const VENDORED_PI_PROVIDERS = [
  "openai",
  "deepseek",
  "zai-coding-cn",
  "kimi-coding",
  "minimax-cn",
  "xiaomi",
  "opencode-go",
  "openrouter",
  "zai",
  "moonshotai",
  "minimax"
];

// pin 版本下的事实（spec 表逐文件计数之和）；产物与上游一致时必然相等，
// 不等即「pin 变了/上游内容变了」——先确认再同步 spec 与 scripts 里的期望值。
const EXPECTED_MODEL_COUNT = 475;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "chunks" || name === "icons") continue;
      walk(full, out);
      continue;
    }
    if (/\.(ts|js)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

// 静态边：import|export <clause> from "<相对路径>"。纯类型引入（import type）
// 构建后消失、不构成运行时边，故跳过（与 tests/layer-deps.test.ts 同口径——
// UI 片用 import type 取 CatalogModelMeta 是允许的）。注释先掐掉（块注释起点锚在
// 行首——行内出现的 `/*` 如 `adapters/*` 不算注释起点，否则会把后面的真 import
// 一起吞掉，tests/layer-deps.test.ts 的 `/\*[\s\S]*?\*\//` 手法在这里会误伤）。
const STATIC_EDGE_RE = /(?:^|\n)[ \t]*(?:import|export)\s+([^;]*?)\s+from\s*["'](\.[^"']+)["']/g;
const BLOCK_COMMENT_RE = /^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm;
const TYPE_ONLY_CLAUSE_RE = /^\s*type\b|^\{\s*type\s/;

function staticImportersOf(fragment: string): string[] {
  // 同一文件的 import 与 export-from 都算边，去重后给「哪些文件静态引用」这一事实
  const importers = new Set<string>();
  for (const file of walk("extension")) {
    const source = readFileSync(file, "utf8").replace(BLOCK_COMMENT_RE, "");
    for (const match of source.matchAll(STATIC_EDGE_RE)) {
      if (match[2].includes(fragment) && !TYPE_ONLY_CLAUSE_RE.test(match[1])) {
        importers.add(relative("extension", file).split(sep).join("/"));
      }
    }
  }
  return [...importers];
}

describe("pi-ai 目录产物（01）", () => {
  it("vendor 了 11 个 provider、475 个模型，与源文件计数之和一致", () => {
    expect(Object.keys(PI_AI_CATALOG)).toEqual(VENDORED_PI_PROVIDERS);
    const total = Object.values(PI_AI_CATALOG).reduce(
      (sum, models) => sum + Object.keys(models).length,
      0
    );
    expect(total).toBe(EXPECTED_MODEL_COUNT);
    expect(PI_AI_CATALOG_SOURCE.models).toBe(total);
    expect(PI_AI_CATALOG_SOURCE.providers).toBe(VENDORED_PI_PROVIDERS.length);
  });

  it("每个模型只带 6 个白名单字段，且字段口径正确", () => {
    for (const [provider, models] of Object.entries(PI_AI_CATALOG)) {
      for (const [modelId, model] of Object.entries(models)) {
        expect(Object.keys(model).sort(), `${provider}/${modelId}`).toEqual(
          ["contextWindow", "id", "input", "maxTokens", "name", "reasoning"].sort()
        );
        // 键与自带 id 同值（生成脚本对上游压平后的不变量）
        expect(model.id, `${provider}/${modelId}`).toBe(modelId);
        expect(typeof model.name).toBe("string");
        expect(typeof model.reasoning).toBe("boolean");
        expect(Array.isArray(model.input)).toBe(true);
        expect(Number.isInteger(model.contextWindow)).toBe(true);
        expect(Number.isInteger(model.maxTokens)).toBe(true);
      }
    }
  });

  it("产物头的数据版本 = package.json 里的精确 pin（升 pin 忘重跑即红）", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(PI_AI_CATALOG_SOURCE.package).toBe("@earendil-works/pi-ai");
    expect(pkg.devDependencies[PI_AI_CATALOG_SOURCE.package]).toBe(PI_AI_CATALOG_SOURCE.version);
  });

  it("叶子：产物模块零 import（静态与动态都没有）", () => {
    const source = readFileSync(GENERATED_MODULE, "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/^\s*export\s+[^;]*?\s+from\s/m);
    expect(source).not.toMatch(/\bimport\s*\(/);
  });

  it("只准懒加载：产物只被 ai/model-catalog.ts 静态引用，且它自己不被人静态引用", () => {
    expect(staticImportersOf("pi-ai-catalog.generated")).toEqual([CATALOG_CONSUMER]);
    expect(staticImportersOf("/model-catalog.js")).toEqual([]);
  });
});

describe("preset → piProvider 映射（02）", () => {
  it("覆盖：每个 preset 恰好是「有 piProvider」或「在无数据白名单」之一", () => {
    const white = new Set<string>(NO_CATALOG_PRESETS);
    const unregistered = PRESETS.filter((preset) => !preset.piProvider && !white.has(preset.id)).map(
      (preset) => preset.id
    );
    const contradictory = PRESETS.filter((preset) => preset.piProvider && white.has(preset.id)).map(
      (preset) => preset.id
    );
    expect(unregistered, `preset 既无 piProvider 又不在白名单：${unregistered.join(", ")}`).toEqual([]);
    expect(contradictory, `preset 登记了 piProvider 又在白名单：${contradictory.join(", ")}`).toEqual([]);
  });

  it("白名单单源：条目都是真实 preset、且都没登记 piProvider", () => {
    const ids = new Set(PRESETS.map((preset) => preset.id));
    for (const id of NO_CATALOG_PRESETS) {
      expect(ids.has(id), `白名单里的 ${id} 不是现存 preset`).toBe(true);
    }
    expect(PRESETS.filter((preset) => !preset.piProvider).map((preset) => preset.id).sort()).toEqual(
      [...NO_CATALOG_PRESETS].sort()
    );
  });

  it("反向：每个 piProvider 值都能在产物里查到条目（写错文件名即红）", () => {
    for (const preset of PRESETS) {
      if (!preset.piProvider) continue;
      const table = PI_AI_CATALOG[preset.piProvider];
      expect(table, `${preset.id} → ${preset.piProvider} 在产物里没有该 provider`).toBeTruthy();
      expect(Object.keys(table).length, `${preset.id} → ${preset.piProvider} 目录为空`).toBeGreaterThan(0);
    }
  });

  it("映射表 = spec 的 8 家（多一个少一个都要显式复核）", () => {
    const mapped = PRESETS.filter((preset) => preset.piProvider).map(
      (preset) => `${preset.id} → ${preset.piProvider}`
    );
    expect(mapped).toEqual([
      "openai_compat → openai",
      "deepseek → deepseek",
      "zhipu → zai-coding-cn",
      "moonshot → kimi-coding",
      "minimax → minimax-cn",
      "mimo → xiaomi",
      "opencodego → opencode-go",
      "openrouter → openrouter"
    ]);
  });
});

describe("查表（03）", () => {
  it("命中：(piProvider, modelId) 精确匹配，protocol 不参与", () => {
    expect(lookupModelMeta("deepseek", "deepseek-v4-flash")).toEqual({
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      reasoning: true,
      input: ["text"],
      contextWindow: 1000000,
      maxTokens: 384000
    });
  });

  it("未命中：未知 provider / 未知 model / 跨 provider 的 id 都返回 null", () => {
    expect(lookupModelMeta("no-such-provider", "gpt-4")).toBeNull();
    expect(lookupModelMeta("deepseek", "no-such-model")).toBeNull();
    // gpt-4 属于 openai 目录，拿 deepseek 查应当落空（键含 provider）
    expect(lookupModelMeta("deepseek", "gpt-4")).toBeNull();
  });

  it("同名模型在不同 provider 下各归各的登记值（键为什么含 provider 的实证）", () => {
    // mimo-v2.5 同时挂在 xiaomi 与 opencode-go 两家目录下，窗口/展示名登记都不同
    expect(lookupModelMeta("xiaomi", "mimo-v2.5")?.contextWindow).toBe(1_048_576);
    expect(lookupModelMeta("opencode-go", "mimo-v2.5")?.contextWindow).toBe(1_000_000);
    expect(lookupModelMeta("xiaomi", "mimo-v2.5")?.name).toBe("MiMo-V2.5");
    expect(lookupModelMeta("opencode-go", "mimo-v2.5")?.name).toBe("MiMo V2.5");
  });

  it("非字符串入参一律 null，不抛错、不回落猜测值", () => {
    expect(lookupModelMeta(undefined, "gpt-4")).toBeNull();
    expect(lookupModelMeta("openai", null)).toBeNull();
    expect(lookupModelMeta(42, {})).toBeNull();
  });

  it("presetId 优先于 host：已知预设不因 baseUrl 漂移", () => {
    // ollama 是已知预设但不在目录数据里 → 不得被 mimo 的 host 兜底命中
    expect(resolvePiProvider("ollama", "https://api.xiaomimimo.com/v1")).toBeNull();
    // 已知预设命中显式映射，即使 baseUrl 被填成别家
    expect(resolvePiProvider("deepseek", "https://api.openai.com/v1")).toBe("deepseek");
  });

  it("host 兜底：custom / 未知 presetId 按 baseUrl 推断", () => {
    expect(resolvePiProvider("custom", "https://api.xiaomimimo.com/v1")).toBe("xiaomi");
    expect(resolvePiProvider("no-such-preset", "https://openrouter.ai/api/v1")).toBe("openrouter");
    // host 匹配只看域名不看路径：minimax 的 anthropic 专端点也按 host 落回预设
    expect(resolvePiProvider("custom", "https://api.minimaxi.com/anthropic")).toBe("minimax-cn");
  });

  it("查不到即 null：白名单平台、空/非法 baseUrl、无 host 都落空", () => {
    expect(resolvePiProvider("qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1")).toBeNull();
    expect(resolvePiProvider("custom", "")).toBeNull();
    expect(resolvePiProvider("custom", "not-a-url")).toBeNull();
    expect(resolvePiProvider(undefined, undefined)).toBeNull();
  });

  it("一步查表：draft 的 (presetId, baseUrl) + 模型 id", () => {
    expect(lookupCatalogMeta("deepseek", "", "deepseek-v4-pro")?.contextWindow).toBe(1000000);
    expect(lookupCatalogMeta("custom", "https://api.xiaomimimo.com/v1", "mimo-v2.5-pro")?.reasoning).toBe(
      true
    );
    expect(lookupCatalogMeta("qwen", "", "qwen3.8-max")).toBeNull();
    expect(lookupCatalogMeta("deepseek", "", "no-such-model")).toBeNull();
  });
});
