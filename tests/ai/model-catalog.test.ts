// tests/ai/model-catalog.test.ts
// 模型目录（upstream-model-facts/10 起数据源 = models.dev 上游目录）：
//   - 产物形状与叶子纪律（零 import、只准懒加载、SW 静态图禁区）；
//   - preset → catalogProvider 的覆盖/反向对账（单源 = core/presets.ts）；
//   - 查表语义：键 = (上游 provider, modelId)，protocol 不参与；精确 → 折叠大小写
//     → 别名表（唯一一份在 02 产物里）；
//   - 切源带来的**集合变化**按 09 §7.1 的裁定钉死（用户 2026-10-04 明确接受），
//     防止后来者把已接受的后果当 bug 修。
//
// 叶子不变式与"只准懒加载"两条在这里静态把关（对齐
// tests/ai/protocol-vocab.test.ts 的读源码手法 + tests/layer-deps.test.ts 的
// 相对 import 扫描手法）：产物零 import，且静态 import 产物的只有
// ai/model-catalog.ts、静态 import ai/model-catalog 的一个都没有。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { NO_CATALOG_PRESETS, PRESETS } from "../../extension/core/presets.js";
import { lookupCatalogMeta, resolveCatalogProvider } from "../../extension/ai/model-catalog.js";
import {
  UPSTREAM_CATALOG,
  UPSTREAM_CATALOG_SOURCE,
  lookupUpstreamModelMeta
} from "../../extension/ai/catalog/models-dev-catalog.generated.js";
import { MODEL_ID_ALIASES } from "../../extension/ai/catalog/models-dev-thinking.generated.js";
import { PI_AI_CATALOG, PI_AI_CATALOG_SOURCE } from "../../extension/ai/catalog/pi-ai-catalog.generated.js";

// 静态引用形状里的路径口径 = 相对 extension/（walk 的口径）
const CATALOG_CONSUMER = "ai/model-catalog.ts";
const PI_GENERATED_MODULE = "extension/ai/catalog/pi-ai-catalog.generated.ts";
const UPSTREAM_GENERATED_MODULE = "extension/ai/catalog/models-dev-catalog.generated.ts";
const THINKING_GENERATED_MODULE = "extension/ai/catalog/models-dev-thinking.generated.ts";

// spec §preset → 上游 provider（10 号票落地口径）：12 家按 `api` 与 preset baseUrl
// 逐字相同，minimax 是人工裁定。多一个少一个都要显式复核。
const EXPECTED_CATALOG_PROVIDERS: ReadonlyArray<readonly [string, string]> = [
  ["deepseek", "deepseek"],
  ["qwen", "alibaba-cn"],
  ["zhipu", "zhipuai"],
  ["moonshot", "kimi-code-plan-cn"],
  ["minimax", "minimax-cn"],
  ["mimo", "xiaomi"],
  ["opencodego", "opencode-go"],
  ["openrouter", "openrouter"],
  ["stepfun", "stepfun-step-plan"],
  ["modelscope", "modelscope"],
  ["amd", "amd"],
  ["sensenova", "sensenova"]
];

// pi-ai 快照（旧数据源，11 号票删除）7 个 vendor → 10 号票的 12 家上游 provider 映射。
// 注意 zai-coding-cn → `zhipuai`（preset zhipu 的登记值，spec §preset → 上游 provider），
// **不是** 09 号票做 pi-ai vendor 逐对比时用的兄弟家 `zhipuai-coding-plan`。
const PI_TO_UPSTREAM: ReadonlyArray<readonly [string, string]> = [
  ["deepseek", "deepseek"],
  ["zai-coding-cn", "zhipuai"],
  ["kimi-coding", "kimi-code-plan-cn"],
  ["minimax-cn", "minimax-cn"],
  ["xiaomi", "xiaomi"],
  ["opencode-go", "opencode-go"],
  ["openrouter", "openrouter"]
];

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
  return [...importers].sort();
}

function extensionFilesReferencing(pattern: RegExp): string[] {
  return walk("extension")
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => relative("extension", file).split(sep).join("/"))
    .sort();
}

describe("pi-ai 目录产物（01 时期的数据源；10 号票切源后无消费者，11 号票删除）", () => {
  it("vendor 了 7 个 provider、435 个模型（pin 未变，产物不动）", () => {
    expect(Object.keys(PI_AI_CATALOG)).toEqual([
      "deepseek",
      "zai-coding-cn",
      "kimi-coding",
      "minimax-cn",
      "xiaomi",
      "opencode-go",
      "openrouter"
    ]);
    const total = Object.values(PI_AI_CATALOG).reduce(
      (sum, models) => sum + Object.keys(models).length,
      0
    );
    expect(total).toBe(435);
  });

  it("产物头的数据版本 = package.json 里的精确 pin（升 pin 忘重跑即红）", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(PI_AI_CATALOG_SOURCE.package).toBe("@earendil-works/pi-ai");
    expect(pkg.devDependencies[PI_AI_CATALOG_SOURCE.package]).toBe(PI_AI_CATALOG_SOURCE.version);
  });

  it("叶子：产物零 import（静态与动态都没有），切源不影响这一点", () => {
    const source = readFileSync(PI_GENERATED_MODULE, "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/^\s*export\s+[^;]*?\s+from\s/m);
    expect(source).not.toMatch(/\bimport\s*\(/);
  });

  it("切源后 extension/ 里已无静态消费者（消费点只出不进；删除归 11 号票）", () => {
    expect(staticImportersOf("pi-ai-catalog.generated")).toEqual([]);
  });
});

describe("models.dev 上游目录产物（10 号票起的 UI 数据源）", () => {
  it("12 家上游 / 578 个模型，preset 登记的 provider 全在其中", () => {
    const registered = new Set(EXPECTED_CATALOG_PROVIDERS.map(([, provider]) => provider));
    expect(Object.keys(UPSTREAM_CATALOG).filter((id) => registered.has(id)).sort()).toEqual(
      [...registered].sort()
    );
    const total = Object.values(UPSTREAM_CATALOG).reduce(
      (sum, models) => sum + Object.keys(models).length,
      0
    );
    expect(total).toBe(578);
    expect(Object.keys(UPSTREAM_CATALOG)).toHaveLength(12);
    expect(UPSTREAM_CATALOG_SOURCE.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(UPSTREAM_CATALOG_SOURCE.source).toBe("https://models.dev/api.json");
  });

  it("叶子：产物零 import（静态与动态都没有）", () => {
    const source = readFileSync(UPSTREAM_GENERATED_MODULE, "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/^\s*export\s+[^;]*?\s+from\s/m);
    expect(source).not.toMatch(/\bimport\s*\(/);
  });

  it("只准懒加载：产物只被 ai/model-catalog.ts 静态引用，且它自己不被人静态引用", () => {
    expect(staticImportersOf("models-dev-catalog.generated")).toEqual([CATALOG_CONSUMER]);
    expect(staticImportersOf("/model-catalog.js")).toEqual([]);
  });

  it("SW 静态图守卫：scripts/build.js 的禁区清单点名本产物（与新产物路径一起守）", () => {
    const build = readFileSync("scripts/build.js", "utf8");
    const list = build.slice(
      build.indexOf("BACKGROUND_FORBIDDEN_STATIC_SOURCES"),
      build.indexOf("function assertBackgroundStaticGraphSlim")
    );
    expect(list).toContain("models-dev-catalog\\.generated\\.ts");
    for (const other of ["models-dev-thinking\\.generated\\.ts", "model-catalog\\.ts"]) {
      expect(list).toContain(other);
    }
  });
});

describe("preset → catalogProvider（单源 = core/presets.ts）", () => {
  it("覆盖：每个 preset 恰好是「有 catalogProvider」或「在无数据白名单」之一", () => {
    const white = new Set<string>(NO_CATALOG_PRESETS);
    const unregistered = PRESETS.filter(
      (preset) => !preset.catalogProvider && !white.has(preset.id)
    ).map((preset) => preset.id);
    const contradictory = PRESETS.filter(
      (preset) => preset.catalogProvider && white.has(preset.id)
    ).map((preset) => preset.id);
    expect(unregistered, `preset 既无 catalogProvider 又不在白名单：${unregistered.join(", ")}`).toEqual([]);
    expect(contradictory, `preset 登记了 catalogProvider 又在白名单：${contradictory.join(", ")}`).toEqual([]);
  });

  it("白名单单源：条目都是真实 preset、且都没登记 catalogProvider", () => {
    const ids = new Set(PRESETS.map((preset) => preset.id));
    for (const id of NO_CATALOG_PRESETS) {
      expect(ids.has(id), `白名单里的 ${id} 不是现存 preset`).toBe(true);
    }
    expect(PRESETS.filter((preset) => !preset.catalogProvider).map((preset) => preset.id).sort()).toEqual(
      [...NO_CATALOG_PRESETS].sort()
    );
  });

  it("映射表 = spec 的 12 家（多一个少一个都要显式复核）", () => {
    const mapped = PRESETS.filter((preset) => preset.catalogProvider).map(
      (preset) => `${preset.id} → ${preset.catalogProvider}`
    );
    expect(mapped).toEqual(EXPECTED_CATALOG_PROVIDERS.map(([preset, provider]) => `${preset} → ${provider}`));
  });

  it("12 家 preset 全部命中目录（每家至少一条模型可查），ollama / custom 全 null", () => {
    for (const [presetId, providerId] of EXPECTED_CATALOG_PROVIDERS) {
      const preset = PRESETS.find((item) => item.id === presetId)!;
      expect(resolveCatalogProvider(presetId, preset.baseUrl), presetId).toBe(providerId);
      const table = UPSTREAM_CATALOG[providerId];
      expect(Object.keys(table ?? {}).length, `${providerId} 目录为空`).toBeGreaterThan(0);
      const [firstModel] = Object.keys(table);
      expect(
        lookupCatalogMeta(presetId, preset.baseUrl, firstModel),
        `${presetId}/${firstModel} 未命中`
      ).not.toBeNull();
    }
    for (const presetId of NO_CATALOG_PRESETS) {
      const preset = PRESETS.find((item) => item.id === presetId)!;
      expect(resolveCatalogProvider(presetId, preset.baseUrl), presetId).toBeNull();
      expect(lookupCatalogMeta(presetId, preset.baseUrl, "deepseek-v4-pro"), presetId).toBeNull();
    }
  });

  it("反向：每个 catalogProvider 值都能在产物里查到条目（写错 id 即红）", () => {
    for (const preset of PRESETS) {
      if (!preset.catalogProvider) continue;
      const table = UPSTREAM_CATALOG[preset.catalogProvider];
      expect(table, `${preset.id} → ${preset.catalogProvider} 在产物里没有该 provider`).toBeTruthy();
      expect(Object.keys(table).length, `${preset.id} → ${preset.catalogProvider} 目录为空`).toBeGreaterThan(0);
    }
  });
});

describe("查表（10 号票：精确 → 折叠大小写 → 别名表）", () => {
  it("命中：(上游 provider, modelId) 精确匹配，protocol 不参与", () => {
    expect(lookupUpstreamModelMeta("deepseek", "deepseek-v4-pro")).toEqual({
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      reasoning: true,
      input: ["text"],
      contextWindow: 1000000,
      maxTokens: 393216
    });
  });

  it("未命中：未知 provider / 未知 model / 跨 provider 的 id 都返回 null", () => {
    expect(lookupCatalogMeta("no-such-preset", "", "glm-5.3")).toBeNull();
    expect(lookupCatalogMeta("deepseek", "", "no-such-model")).toBeNull();
    // glm-5.3 属于 zhipuai 目录，拿 deepseek 查应当落空（键含 provider）
    expect(lookupCatalogMeta("deepseek", "", "glm-5.3")).toBeNull();
  });

  it("大小写折叠：ZhipuAI/GLM-4.6 与 zhipuai/glm-4.6 都命中（modelscope 的混排 id）", () => {
    const exact = lookupCatalogMeta("modelscope", "", "ZhipuAI/GLM-4.6");
    expect(exact?.id).toBe("ZhipuAI/GLM-4.6");
    expect(exact?.contextWindow).toBe(202752);
    expect(lookupCatalogMeta("modelscope", "", "zhipuai/glm-4.6")).toEqual(exact);
    // zhipu preset（上游 zhipuai）的裸 id 同样吃折叠：GLM-4.6 → 上游登记的 glm-4.6
    expect(lookupCatalogMeta("zhipu", "", "glm-4.6")?.id).toBe("glm-4.6");
    expect(lookupCatalogMeta("zhipu", "", "GLM-4.6")).toEqual(lookupCatalogMeta("zhipu", "", "glm-4.6"));
    // 大写 id 的另一家：minimax-cn 的 MiniMax-M2
    expect(lookupCatalogMeta("minimax", "", "minimax-m2")?.id).toBe("MiniMax-M2");
  });

  it("别名表：k3 ↔ kimi-k3 双向命中（02 产物 MODEL_ID_ALIASES，本模块只 import）", () => {
    const upstream = lookupCatalogMeta("moonshot", "", "k3");
    expect(upstream?.id).toBe("k3");
    expect(lookupCatalogMeta("moonshot", "", "kimi-k3")).toEqual(upstream);
    // modelscope 的 ZhipuAI/ 前缀别名：裸 id 也命中
    expect(lookupCatalogMeta("modelscope", "", "GLM-4.6")?.id).toBe("ZhipuAI/GLM-4.6");
    // 别名指向 12 家之外（moonshotai/kimi-k2.6）→ 查不到即 null，不回落猜测值
    expect(lookupCatalogMeta("moonshot", "", "kimi-k2.6")).toBeNull();
  });

  it("别名表唯一一份：声明只在 02 产物里，extension/ 里只有它和消费方提到它", () => {
    expect(extensionFilesReferencing(/export const MODEL_ID_ALIASES\b/)).toEqual([
      relative("extension", THINKING_GENERATED_MODULE).split(sep).join("/")
    ]);
    expect(extensionFilesReferencing(/MODEL_ID_ALIASES/)).toEqual([
      "ai/catalog/models-dev-thinking.generated.ts",
      "ai/model-catalog.ts"
    ]);
    const consumer = readFileSync("extension/ai/model-catalog.ts", "utf8");
    expect(consumer).toMatch(/import \{ MODEL_ID_ALIASES \} from "\.\/catalog\/models-dev-thinking\.generated\.js"/);
    // 消费方不得自带一份别名条目（别名形状 = localId + upstream）
    expect(consumer).not.toMatch(/localId\s*:/);
    // 唯一一份表内条目按 (provider, localId) 唯一（同名 localId 可挂在多家网关下）
    const keys = MODEL_ID_ALIASES.map((alias) => `${alias.provider}\u0000${alias.localId}`);
    expect(new Set(keys).size).toBe(MODEL_ID_ALIASES.length);
  });

  it("presetId 优先于 host：已知预设不因 baseUrl 漂移；protocol 字段完全不参与", () => {
    // ollama 是已知预设但不在目录数据里 → 不得被 mimo 的 host 兜底命中
    expect(resolveCatalogProvider("ollama", "https://api.xiaomimimo.com/v1")).toBeNull();
    // 已知预设命中显式映射，即使 baseUrl 被填成别家；deepseek 的 protocol=anthropic 不影响
    expect(resolveCatalogProvider("deepseek", "https://api.openai.com/v1")).toBe("deepseek");
    // 同 preset 记录无论 protocol 配成什么都走同一条识别（签名里根本没有 protocol 入参）
    expect(lookupCatalogMeta("minimax", "https://api.minimaxi.com/anthropic", "MiniMax-M2")).toEqual(
      lookupCatalogMeta("minimax", "https://api.minimaxi.com/v1", "MiniMax-M2")
    );
  });

  it("host 兜底：custom / 未知 presetId 按 baseUrl 推断", () => {
    expect(resolveCatalogProvider("custom", "https://api.xiaomimimo.com/v1")).toBe("xiaomi");
    expect(resolveCatalogProvider("no-such-preset", "https://openrouter.ai/api/v1")).toBe("openrouter");
    // host 匹配只看域名不看路径：minimax 的 anthropic 专端点也按 host 落回预设
    expect(resolveCatalogProvider("custom", "https://api.minimaxi.com/anthropic")).toBe("minimax-cn");
  });

  it("查不到即 null：空/非法 baseUrl、无 host、空模型 id 都落空", () => {
    expect(resolveCatalogProvider("custom", "")).toBeNull();
    expect(resolveCatalogProvider("custom", "not-a-url")).toBeNull();
    expect(resolveCatalogProvider(undefined, undefined)).toBeNull();
    expect(lookupCatalogMeta("custom", "", "mimo-v2.5")).toBeNull();
    expect(lookupCatalogMeta("deepseek", "", "   ")).toBeNull();
  });
});

// 09 §7.1 的裁定（用户 2026-10-04：接受目录集合可见变化，不做 deprecated 保留标记）：
// 切源后模型集合会变——只 pi 有的元数据消失、只上游有的出现，贴图提示面 ±N。
// 这些数字是**已接受的后果**，钉在这里防止后来者当 bug 修。
//
// 与 09 §7.1 的差：09 做的是「pi-ai vendor ↔ 同名兄弟家」逐对比（zai-coding-cn ↔
// zhipuai-coding-plan，4 个模型），本票落地的是 spec/工单的 preset 映射
// （zhipu → zhipuai，17 个模型）。差额全部出在 zhipu 这一行：共有 −1（glm-5.3-highspeed
// 只 pi 有）、只上游 +14（4 条带图）、提示面 消失 +1 / 新增 +10。09 的数（356 / 79(72)
// / 95(43) / ±7 / +52）与本次实测（355 / 80(72) / 109(47) / ±8 / +62）逐项对得上这条解释。
describe("集合变化（09 §7.1 用户裁定接受的后果，不是 bug）", () => {
  it("切源后：共有 0 翻转，只 pi 消失 80（72 带图），只上游出现 109（47 带图）", () => {
    let shared = 0;
    let imageFlips = 0;
    let onlyPi = 0;
    let onlyPiImage = 0;
    let onlyUpstream = 0;
    let onlyUpstreamImage = 0;
    const promptLost: string[] = [];
    for (const [piId, upstreamId] of PI_TO_UPSTREAM) {
      const piTable = PI_AI_CATALOG[piId] ?? {};
      const upstreamTable = UPSTREAM_CATALOG[upstreamId] ?? {};
      for (const [modelId, meta] of Object.entries(piTable)) {
        const upstream = upstreamTable[modelId];
        if (upstream) {
          shared += 1;
          if (meta.input.includes("image") !== upstream.input.includes("image")) imageFlips += 1;
          continue;
        }
        onlyPi += 1;
        if (meta.input.includes("image")) {
          onlyPiImage += 1;
        } else {
          promptLost.push(`${piId}/${modelId}`);
        }
      }
      for (const [modelId, meta] of Object.entries(upstreamTable)) {
        if (piTable[modelId]) continue;
        onlyUpstream += 1;
        if (meta.input.includes("image")) onlyUpstreamImage += 1;
      }
    }
    expect({ shared, imageFlips, onlyPi, onlyPiImage, onlyUpstream, onlyUpstreamImage }).toEqual({
      shared: 355,
      imageFlips: 0,
      onlyPi: 80,
      onlyPiImage: 72,
      onlyUpstream: 109,
      onlyUpstreamImage: 47
    });
    // 贴图提示面（chat/image-support.ts：查不到 → 静默放行；查到且不含 image → 提示）：
    // 元数据消失的 8 条非图条目从「会提示」变「静默放行」，出现的 62 条非图条目反向。
    expect(promptLost.sort()).toEqual(
      [
        "opencode-go/glm-5.1",
        "openrouter/inclusionai/ling-3.0-flash-fin:free",
        "openrouter/mistralai/codestral-2508:batch",
        "openrouter/openai/gpt-3.5-turbo:batch",
        "openrouter/openai/gpt-oss-20b:batch",
        "openrouter/openai/o3-mini:batch",
        "openrouter/z-ai/glm-5.3:batch",
        "zai-coding-cn/glm-5.3-highspeed"
      ].sort()
    );
    expect(onlyUpstream - onlyUpstreamImage).toBe(62);
  });

  it("模态列口径（09 §6）：只看该 provider 条目的 input 是否含 image，pdf/video/audio 不进判定", () => {
    // 上游这些条目带 image 以外的模态，展示层只取 image 布尔；不借用别家模态
    expect(lookupCatalogMeta("zhipu", "", "glm-5v-turbo")?.input).toEqual(["text", "image", "video", "pdf"]);
    expect(lookupCatalogMeta("zhipu", "", "glm-5v-turbo")?.input.includes("image")).toBe(true);
    expect(lookupCatalogMeta("deepseek", "", "deepseek-v4-pro")?.input).toEqual(["text"]);
  });
});
