// tests/ai/model-catalog.test.ts
// 模型目录（upstream-model-facts/10 起数据源 = models.dev 上游目录）：
//   - 产物形状与叶子纪律（零 import、只准懒加载、SW 静态图禁区）；
//   - preset → catalogProvider 的覆盖/反向对账（单源 = core/presets.ts）；
//   - 查表语义：键 = (上游 provider, modelId)，protocol 不参与；精确 → 折叠大小写
//     → 别名表（唯一一份在 02 产物里）；
//   - 切源带来的**集合变化**按 09 §7.1 的裁定被接受（用户 2026-10-04）：11 号票删掉
//     pi-ai 快照后，逐格比较不再可执行（重算需要已删的 pi 表），守卫改写成
//     「后果冻结」——只钉与 pi 数据无关的现状事实（zhipu → zhipuai 的登记值、
//     提示面消失的 8 条在新目录里有意缺席），完整历史数字见 commit e255e64 与 ADR-0013。
//
// 叶子不变式与"只准懒加载"两条在这里静态把关（对齐
// tests/ai/protocol-vocab.test.ts 的读源码手法 + tests/layer-deps.test.ts 的
// 相对 import 扫描手法）：产物零 import，且静态 import 产物的只有
// ai/model-catalog.ts、静态 import ai/model-catalog 的一个都没有。

import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { staticImportersOf, walkExtensionFiles } from "../helpers/static-imports.js";
import { NO_CATALOG_PRESETS, PRESETS } from "../../extension/core/presets.js";
import { lookupCatalogMeta, resolveCatalogProvider } from "../../extension/ai/model-catalog.js";
import {
  UPSTREAM_CATALOG,
  UPSTREAM_CATALOG_SOURCE,
  lookupUpstreamModelMeta
} from "../../extension/ai/catalog/models-dev-catalog.generated.js";
import { MODEL_ID_ALIASES } from "../../extension/ai/catalog/models-dev-thinking.generated.js";

// 静态引用形状里的路径口径 = 相对 extension/（walk 的口径）
const CATALOG_CONSUMER = "ai/model-catalog.ts";
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
  ["sensenova", "sensenova"],
  ["gemini", "google"]
];

// pi-ai ↔ 上游的 7 家逐家映射（旧 PI_TO_UPSTREAM 常量）随 11 号票删除 pi-ai 快照一并
// 删除：逐格比较需要 pi 表才可执行，而本 effort 的方向正是「不内置上游数据」。留下的
// 「后果冻结」用例只断言与 pi 数据无关的现状事实；完整历史数字（共有 355 / 只 pi
// 80(图 72) / 只上游 109(图 47)；贴图提示面 消失 8 / 新增 62，差额 100% 出自 zhipu
// 一行）见 commit e255e64 的 tests/ai/model-catalog.test.ts 与 ADR-0013「后果」。

// 静态边扫描的单源见 tests/helpers/static-imports.ts（与
// tests/ai/preset-registration-view.test.ts 共用）。

function extensionFilesReferencing(pattern: RegExp): string[] {
  return walkExtensionFiles("extension")
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => relative("extension", file).split(sep).join("/"))
    .sort();
}

describe("models.dev 上游目录产物（10 号票起的 UI 数据源）", () => {
  it("13 家上游 / 617 个模型，preset 登记的 provider 全在其中", () => {
    const registered = new Set(EXPECTED_CATALOG_PROVIDERS.map(([, provider]) => provider));
    expect(Object.keys(UPSTREAM_CATALOG).filter((id) => registered.has(id)).sort()).toEqual(
      [...registered].sort()
    );
    const total = Object.values(UPSTREAM_CATALOG).reduce(
      (sum, models) => sum + Object.keys(models).length,
      0
    );
    expect(total).toBe(617);
    expect(Object.keys(UPSTREAM_CATALOG)).toHaveLength(13);
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

  it("13 家 preset 全部命中目录（每家至少一条模型可查），ollama / custom 全 null", () => {
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

// 09 §7.1 后果冻结（用户 2026-10-04 裁定接受，不做 deprecated 保留标记）：pi-ai 快照
// 已在 11 号票删除，逐格比较不再可执行（重算需要已删的 pi 表，而本 effort 的方向正是
// 不内置上游数据）。这里只钉**与 pi 数据无关**的现状事实与裁决本身，防后人误修：
//   - 2026-10-05 裁定：`zhipu` 登记 `zhipuai`（spec §preset → 上游 provider），**不改**
//     `zhipuai-coding-plan`——那是 09 号票做 pi-ai 对账时用的兄弟家 id，不是本仓登记值；
//   - 09 §7.1 的「提示面消失 8 条」按 id 逐个断言在新目录查不到（= 有意缺席，不是缺口）。
// 完整集合差（共有 355 / 只 pi 80(图 72) / 只上游 109(图 47)；提示面 消失 8 / 新增 62，
// 差额 100% 出自 zhipu 一行）见 commit e255e64 的 tests/ai/model-catalog.test.ts 与
// 10 号票工件 10-catalog-coverage.tsv / 10-report.md；本条不再持有 pi 侧数据。
describe("09 §7.1 后果冻结（用户裁定接受的后果，不是 bug）", () => {
  it("zhipu 的上游 identity = zhipuai（不是 09 对账用的兄弟家 zhipuai-coding-plan）", () => {
    const preset = PRESETS.find((item) => item.id === "zhipu")!;
    expect(resolveCatalogProvider("zhipu", preset.baseUrl)).toBe("zhipuai");
    expect(Object.keys(UPSTREAM_CATALOG["zhipuai"] ?? {})).toHaveLength(17);
    expect(UPSTREAM_CATALOG["zhipuai-coding-plan"]).toBeUndefined();
  });

  it("提示面消失的 8 条：新目录查不到（有意缺席，不回落猜测值）", () => {
    // [本仓 presetId, 模型 id, 历史出处：pi-ai 口径的 (provider, modelId)]
    const deliberatelyAbsent: ReadonlyArray<readonly [string, string, string]> = [
      ["opencodego", "glm-5.1", "opencode-go/glm-5.1"],
      ["openrouter", "inclusionai/ling-3.0-flash-fin:free", "openrouter/inclusionai/ling-3.0-flash-fin:free"],
      ["openrouter", "mistralai/codestral-2508:batch", "openrouter/mistralai/codestral-2508:batch"],
      ["openrouter", "openai/gpt-3.5-turbo:batch", "openrouter/openai/gpt-3.5-turbo:batch"],
      ["openrouter", "openai/gpt-oss-20b:batch", "openrouter/openai/gpt-oss-20b:batch"],
      ["openrouter", "openai/o3-mini:batch", "openrouter/openai/o3-mini:batch"],
      ["openrouter", "z-ai/glm-5.3:batch", "openrouter/z-ai/glm-5.3:batch"],
      ["zhipu", "glm-5.3-highspeed", "zai-coding-cn/glm-5.3-highspeed"]
    ];
    for (const [presetId, modelId, origin] of deliberatelyAbsent) {
      expect(lookupCatalogMeta(presetId, "", modelId), `${origin} 不该在新目录里查到`).toBeNull();
    }
  });

  it("模态列口径（09 §6）：只看该 provider 条目的 input 是否含 image，pdf/video/audio 不进判定", () => {
    // 上游这些条目带 image 以外的模态，展示层只取 image 布尔；不借用别家模态
    expect(lookupCatalogMeta("zhipu", "", "glm-5v-turbo")?.input).toEqual(["text", "image", "video", "pdf"]);
    expect(lookupCatalogMeta("zhipu", "", "glm-5v-turbo")?.input.includes("image")).toBe(true);
    expect(lookupCatalogMeta("deepseek", "", "deepseek-v4-pro")?.input).toEqual(["text"]);
  });
});
