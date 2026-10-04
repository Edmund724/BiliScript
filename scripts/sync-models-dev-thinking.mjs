// 构建期生成思考事实产物（工单 upstream-model-facts/02）。
//
// 抓 https://models.dev/api.json，读 12 个上游 provider 的 `reasoning_options`，
// 归一成值集并去重，产出 extension/ai/catalog/models-dev-thinking.generated.ts：
//   - VALUESETS：值集常量表（稳定 id + 结构 + 人可读 label）；
//   - ASSIGNMENTS：(上游 provider, modelId) → valuesetId 的指派表。
// 产物是零 import 的叶子模块，提交进仓库；构建只做打包，不在构建时现场生成。
//
// 与 01（UI 目录）的分工：01 只带展示字段，刻意裁掉 reasoning_options；本脚本是
// 思考事实的唯一读点。两者共用 scripts/models-dev-upstream-providers.mjs 的 12 家映射，
// 口径必须一致。
//
// 三条纪律：
//   1. 不猜上游没有的值：词表为空就标「未知词表」（查表函数返回 null，请求侧不发参），
//      宁可 fail-closed 也不臆造档位；
//   2. 生成期对账：模型总数 / reasoning 数 / 有词表数 / 缺口数 / effort 值集数不是常量
//      就 fail（上游漂移必须吵，不能悄悄换一份产物）；
//   3. 重跑幂等：产物里没有生成/抓取时间戳，同一份上游数据两次输出字节相同。
//
// 用法：
//   pnpm catalog:sync:thinking
//   node scripts/sync-models-dev-thinking.mjs \
//     [--input <path|url>] [--out <path>] [--expect-counts a/b/c/d/e] \
//     [--report <path>] [--matrix <path>]
//
//   --input          读本地 api.json 快照（默认直连 https://models.dev/api.json）。
//   --out            产物落点（默认 extension/ai/catalog/models-dev-thinking.generated.ts）。
//   --expect-counts  对账常量，形如 `<模型数>/<reasoning 数>/<有词表数>/<缺口数>/<effort 值集数>`；
//                    只给 fixture 用，生产不许改（改了等于关掉对账）。
//   --report         另把本次 sync 的摘要 + 63 个缺口的逐条处理写成文件。
//   --matrix         另把逐 (provider, 模型, 档位空间) 矩阵写成 TSV（后续 golden 的数据来源）。

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SOURCE, UPSTREAM_PROVIDERS } from "./models-dev-upstream-providers.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_FILE = "extension/ai/catalog/models-dev-thinking.generated.ts";

// 上游 reasoning_options 只有这三种类型（spec §上游形态：toggle 205 / effort 194 /
// budget_tokens 43）。出现第四种必须吵：静默丢掉一种等于对整批模型丢档。
// 每种类型的合法键也在下面钉死（上游加新键 = 形状漂移）。
const OPTION_KEYS = {
  toggle: ["type"],
  effort: ["type", "values"],
  budget_tokens: ["type", "min", "max"]
};
const REASONING_OPTION_TYPES = new Set(Object.keys(OPTION_KEYS));

// effort 档位词表（spec 实测 30 种值集只用这些词）。上游新增词必须吵：UI 的三档
// 投影（05/06 号票）按词表认档，静默接受新词会让投影悄悄掉档。
const EFFORT_VOCABULARY = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

// 显式别名表（spec 裁定 13：精确匹配 + 折叠大小写 + 别名表）。一张表两个用途：
//   1. 查表兜底：请求里的本仓/历史口径 id → 上游 id 的同一份事实；
//   2. 缺词表补录：上游该网关没有 canonical_model_id 可借时，按上游 id 借原生词表。
// 每条必须写清上游 id 与理由（可审）。生成期校验：目标模型必须存在且有 reasoning_options，
// 否则 fail —— 别名指错等于静默落空（fail-closed 的兜底是「未知词表」，不是猜档位）。
// 刻意不做的：openrouter 的 `:batch` / `:free` / `auto` 变体（上游没有对应 id，有 78 个），
// modelscope 的 `Qwen/…` 命名空间 id（上游 alibaba-cn 没有同名 id，见 --report 的缺口清单）
// —— 这些一律落「未知词表」，不臆造映射。
const MODEL_ID_ALIASES = [
  {
    provider: "kimi-code-plan-cn",
    localId: "kimi-k3",
    upstream: "kimi-code-plan-cn/k3",
    reason: "上游没有 kimi-k3，实际 id 是 k3（canonical_model_id = moonshotai/kimi-k3）；本仓 thinking-profiles 的 EXCEPTIONS/TAXONOMY 用 kimi-k3 称呼它。"
  },
  {
    provider: "kimi-code-plan-cn",
    localId: "kimi-k2.6",
    upstream: "moonshotai/kimi-k2.6",
    reason: "上游 kimi-code-plan-cn 没有 kimi-k2.6；本仓 TAXONOMY 的 kimi-k2.6 模式指原生 moonshotai 的 K2.6（词表 toggle）。"
  },
  {
    provider: "stepfun-step-plan",
    localId: "step-3.7",
    upstream: "stepfun-step-plan/step-3.7-flash",
    reason: "上游只有 step-3.7-flash（没有 step-3.7 本身）；本仓 TAXONOMY 用前缀 step-3.7 命中它。"
  },
  {
    provider: "opencode-go",
    localId: "kimi-k2.6",
    upstream: "moonshotai/kimi-k2.6",
    reason: "上游 opencode-go/kimi-k2.6 词表为空数组（deprecated）且无 canonical 可借；原生 moonshotai 同名模型是 toggle。"
  },
  {
    provider: "modelscope",
    localId: "GLM-4.6",
    upstream: "modelscope/ZhipuAI/GLM-4.6",
    reason: "上游 modelscope 的 id 带命名空间前缀且大小写混排（ZhipuAI/GLM-4.6，name 是裸 GLM-4.6）；本仓/用户口径是裸 id。"
  },
  {
    provider: "modelscope",
    localId: "GLM-4.5",
    upstream: "modelscope/ZhipuAI/GLM-4.5",
    reason: "同上：上游 id 是 ZhipuAI/GLM-4.5，本仓/用户口径是裸 GLM-4.5。"
  }
];

// 对账常量（spec §词汇覆盖缺口 + §上游形态，主 agent 复核实测）。不是这些数说明上游
// 内容或路径变了 —— 先确认快照 contentHash 与 spec 记录，再同步本常量、spec 与
// tests/ai/models-dev-thinking.test.ts 的期望值。
const EXPECTED_COUNTS = {
  models: 578,
  reasoning: 415,
  withOptions: 352,
  gaps: 63,
  effortSets: 30
};

function fail(message) {
  console.error(`sync-models-dev-thinking: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    input: DEFAULT_SOURCE,
    out: MODULE_FILE,
    report: null,
    matrix: null,
    aliases: null,
    expectCounts: EXPECTED_COUNTS
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (["--input", "--out", "--report", "--matrix", "--aliases", "--expect-counts"].includes(flag)) {
      if (value === undefined) fail(`${flag} 缺参数值`);
      i += 1;
      if (flag === "--input") options.input = value;
      else if (flag === "--out") options.out = value;
      else if (flag === "--report") options.report = value;
      else if (flag === "--matrix") options.matrix = value;
      else if (flag === "--aliases") options.aliases = value;
      else options.expectCounts = parseExpectCounts(value);
      continue;
    }
    fail(
      `未知参数 "${flag}"。用法：--input <path|url> --out <path> --aliases <path|none> ` +
        `--expect-counts <a/b/c/d/e> --report <path> --matrix <path>`
    );
  }
  return options;
}

// 别名表来源：默认脚本里的 MODEL_ID_ALIASES（本仓事实，生产路径）；fixture 用小表，
// `none` = 不加载（只跑 canonical 借词路径）。表里的条目生成期逐条校验。
function loadAliases(option) {
  if (option === null) {
    return MODEL_ID_ALIASES;
  }
  if (option === "none") {
    return [];
  }
  if (!fs.existsSync(option)) {
    fail(`--aliases 指向的文件不存在：${option}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(option, "utf8"));
  } catch (error) {
    fail(`--aliases 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) {
    fail(`--aliases 顶层必须是数组（每条 {provider, localId, upstream, reason}）。`);
  }
  for (const [index, alias] of parsed.entries()) {
    if (!alias || typeof alias !== "object") {
      fail(`--aliases[${index}] 不是对象。`);
    }
    for (const field of ["provider", "localId", "upstream", "reason"]) {
      if (typeof alias[field] !== "string" || alias[field].length === 0) {
        fail(`--aliases[${index}] 缺非空字符串字段 ${field}。`);
      }
    }
  }
  return parsed;
}

// `<模型数>/<reasoning 数>/<有词表数>/<缺口数>/<effort 值集数>`
function parseExpectCounts(value) {
  const parts = String(value).split("/");
  const keys = ["models", "reasoning", "withOptions", "gaps", "effortSets"];
  if (parts.length !== keys.length) {
    fail(`--expect-counts 需要 ${keys.length} 个用 "/" 分隔的非负整数，收到 "${value}"`);
  }
  const counts = {};
  parts.forEach((part, index) => {
    const parsed = Number(part);
    if (!Number.isInteger(parsed) || parsed < 0) {
      fail(`--expect-counts 的第 ${index + 1} 项不是非负整数："${part}"`);
    }
    counts[keys[index]] = parsed;
  });
  return counts;
}

async function readSnapshot(input) {
  if (/^https?:\/\//.test(input)) {
    let response;
    try {
      response = await fetch(input);
    } catch (error) {
      fail(`抓取 ${input} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      fail(`抓取 ${input} 失败：HTTP ${response.status} ${response.statusText}`);
    }
    return await response.text();
  }
  if (!fs.existsSync(input)) {
    fail(`输入快照不存在：${input}`);
  }
  return fs.readFileSync(input, "utf8");
}

// 值集 id 文法（产物头注释同源）："toggle" / effort 档位以 "-" 连接 / "b" 或 "b:<min>-<max>"。
function slugOf({ toggle, effort, budget }) {
  const parts = [];
  if (toggle) parts.push("toggle");
  if (effort) parts.push(effort.join("-"));
  if (budget) {
    if (budget.min === undefined && budget.max === undefined) {
      parts.push("b");
    } else {
      parts.push(`b:${budget.min === undefined ? "" : budget.min}-${budget.max === undefined ? "" : budget.max}`);
    }
  }
  return parts.join("+");
}

// label 沿用 ai/thinking-profiles.ts 的 CLASSES 命名（hybrid/always/switch/effort/budget/none）：
// 关得掉（有开关，或 effort 词表含 none）→ hybrid，关不掉 → always；后接机制词。
function labelOf({ toggle, effort, budget, off }) {
  const parts = [off === null ? "always" : "hybrid"];
  if (toggle) parts.push("switch");
  if (effort) parts.push("effort");
  if (budget) parts.push("budget");
  if (off === "effort-none") parts.push("none");
  return parts.join("-");
}

// 把上游 reasoning_options 归一成内部值集结构。任何形状越界都 fail（见文件头纪律 1、2）。
function normalizeOptions(where, options) {
  if (!Array.isArray(options) || options.length === 0) {
    fail(`${where}: reasoning_options 不是非空数组（收到 ${JSON.stringify(options)}）`);
  }
  let toggle = false;
  let effort = null;
  let budget = null;
  for (const option of options) {
    const type = option && option.type;
    if (!REASONING_OPTION_TYPES.has(type)) {
      fail(`${where}: 上游出现未知 reasoning_option 类型 ${JSON.stringify(type)} —— 先核对 spec 的三种类型口径。`);
    }
    for (const key of Object.keys(option)) {
      if (!OPTION_KEYS[type].includes(key)) {
        fail(
          `${where}: ${type} 选项出现未知字段 "${key}"（合法键：${OPTION_KEYS[type].join("/")}）—— ` +
            `上游形状变了，先核对 spec 再同步 OPTION_KEYS。`
        );
      }
    }
    if (type === "toggle") {
      toggle = true;
      continue;
    }
    if (type === "effort") {
      const values = option.values;
      if (!Array.isArray(values) || values.length === 0) {
        fail(`${where}: effort 缺非空 values（收到 ${JSON.stringify(values)}）。`);
      }
      for (const value of values) {
        if (typeof value !== "string" || !EFFORT_VOCABULARY.has(value)) {
          fail(
            `${where}: effort 出现未知档位词 ${JSON.stringify(value)} —— 先确认上游新词与 05/06 号票的三档投影，` +
              `再同步 EFFORT_VOCABULARY 与 spec。`
          );
        }
      }
      effort = [...values];
      continue;
    }
    // budget_tokens：min/max 都可选，给了就必须是非负整数（上游用 min: 0 表示没有
    // 下界，如 alibaba-cn/qwen3.8-max 的 { min: 0, max: 262144 }）。
    budget = {};
    for (const key of ["min", "max"]) {
      const value = option[key];
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < 0) {
        fail(`${where}: budget_tokens.${key} 不是非负整数（收到 ${JSON.stringify(value)}）。`);
      }
      budget[key] = value;
    }
    if (budget.min !== undefined && budget.max !== undefined && budget.min > budget.max) {
      fail(`${where}: budget_tokens.min (${budget.min}) 大于 max (${budget.max})。`);
    }
  }
  if (effort && new Set(effort).size !== effort.length) {
    fail(`${where}: effort 词表有重复档位（${effort.join("/")}）。`);
  }
  // 归一后的结构：三种可共存（spec §范围 1）。
  const off = toggle ? "toggle" : effort && effort.includes("none") ? "effort-none" : null;
  return { toggle, effort, budget, off };
}

// 取上游 provider，缺 / 空都 fail（对账第一道：12 家少一家必须是硬错）。
function pickUpstreamProvider(api, upstreamId, preset) {
  const provider = api[upstreamId];
  if (!provider || typeof provider !== "object") {
    fail(`快照里没有上游 provider "${upstreamId}"（preset ${preset}）。上游改了 provider id？先核对 spec 的映射表。`);
  }
  const models = provider.models;
  if (!models || typeof models !== "object" || Object.keys(models).length === 0) {
    fail(`上游 provider "${upstreamId}" 的 models 为空，思考事实表会是空的。`);
  }
  return provider;
}

// 编译一遍：值集去重 + 逐模型指派。返回的都是纯数据，渲染与报告共用。
function compileFacts(api, aliases) {
  const valuesets = new Map();
  const structureOf = new Map();
  const gaps = [];
  const counts = { models: 0, reasoning: 0, withOptions: 0, gaps: 0, effortSets: 0 };
  const effortSets = new Set();

  // 值集去重 + 登记：同一个 slug 只登记一次；两条不同结构撞同一个 slug 直接 fail
  // （去重过头 = 指派指向错误的档位空间，是最危险的失败方式）。
  const registerValueset = (where, structure) => {
    const valuesetId = slugOf(structure);
    const fingerprint = JSON.stringify(structure);
    const existing = structureOf.get(valuesetId);
    if (existing && existing !== fingerprint) {
      fail(
        `${where}: 两条不同结构撞同一个值集 id "${valuesetId}"（${existing} vs ${fingerprint}）—— id 文法需要改。`
      );
    }
    if (!existing) {
      structureOf.set(valuesetId, fingerprint);
      valuesets.set(valuesetId, { id: valuesetId, ...structure, label: labelOf(structure) });
    }
    if (structure.effort) effortSets.add(structure.effort.join("/"));
    return valuesetId;
  };

  // 第一遍：有词表的直接登记；缺口只记形状，借词放第二遍（canonical / 别名都可能指向
  // 本表其它 provider 的模型，必须等全部直接指派就位）。
  const rowsByProvider = {};
  const statsByProvider = {};

  for (const { preset, id: providerId } of UPSTREAM_PROVIDERS) {
    const provider = pickUpstreamProvider(api, providerId, preset);
    const rows = {};
    const stats = { models: Object.keys(provider.models).length, reasoning: 0, assigned: 0, borrowed: 0, unknown: 0 };
    counts.models += stats.models;

    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!model || typeof model !== "object") {
        fail(`${providerId}/${modelId}: 上游模型不是对象`);
      }
      if (model.id !== modelId) {
        fail(
          `${providerId}/${modelId}: 模型自带 id 与它的键不一致（${JSON.stringify(model.id)}），` +
            `产物以键为查表键，需重新审议。`
        );
      }
      if (typeof model.reasoning !== "boolean") {
        fail(`${providerId}/${modelId}: 上游缺 reasoning，无法判定是否进思考事实表。`);
      }
      if (!model.reasoning) continue;
      stats.reasoning += 1;
      counts.reasoning += 1;

      const options = model.reasoning_options;
      if (Array.isArray(options) && options.length > 0) {
        counts.withOptions += 1;
        stats.assigned += 1;
        rows[modelId] = registerValueset(`${providerId}/${modelId}`, normalizeOptions(`${providerId}/${modelId}`, options));
        continue;
      }
      // 词表缺口：占位 null，第二遍借词；借不到就删掉（不进表 = 未知词表）。
      counts.gaps += 1;
      rows[modelId] = null;
      gaps.push({
        provider: providerId,
        modelId,
        canonical: typeof model.canonical_model_id === "string" ? model.canonical_model_id : null,
        resolution: null,
        valuesetId: null
      });
    }

    rowsByProvider[providerId] = rows;
    statsByProvider[providerId] = stats;
  }

  // 别名表解析：目标必须在快照里存在且有词表；目标已在本表里就直接引用它的值集，
  // 否则把目标自己的词表也登记进 VALUESETS（别名是它的唯一使用者）。
  const resolvedAliases = aliases.map((alias) => resolveAlias(api, alias, rowsByProvider, registerValueset));
  const aliasByLocal = new Map(resolvedAliases.map((alias) => [`${alias.provider}\u0000${alias.localId}`, alias]));

  // 第二遍：缺口按 canonical_model_id 到原生 provider 借词表（spec 裁定 4）；没有
  // canonical 可借时看别名表补录；都借不到就标「未知词表」（查表返回 null，请求侧
  // 不发任何思考参数）。借错平台或臆造档位是硬错误，所以两条路径都只认上游原文。
  for (const gap of gaps) {
    const canonical = borrowOptions(api, gap.canonical);
    const alias = canonical ? null : aliasByLocal.get(`${gap.provider}\u0000${gap.modelId}`);
    const target = canonical
      ? { from: gap.canonical, options: canonical.options, via: "canonical" }
      : alias
        ? { from: alias.upstream, options: alias.options, via: "alias" }
        : null;
    if (!target) {
      delete rowsByProvider[gap.provider][gap.modelId];
      statsByProvider[gap.provider].unknown += 1;
      gap.resolution = "unknown";
      continue;
    }
    const where = `${gap.provider}/${gap.modelId} ← ${target.from}`;
    gap.valuesetId = registerValueset(where, normalizeOptions(where, target.options));
    gap.resolution = `${target.via}:${target.from}`;
    rowsByProvider[gap.provider][gap.modelId] = gap.valuesetId;
    statsByProvider[gap.provider].borrowed += 1;
    statsByProvider[gap.provider].assigned += 1;
  }

  const assignments = {};
  const coverage = [];
  for (const { id: providerId } of UPSTREAM_PROVIDERS) {
    const rows = rowsByProvider[providerId];
    if (Object.keys(rows).length > 0) assignments[providerId] = rows;
    coverage.push({ id: providerId, ...statsByProvider[providerId] });
  }

  // deprecated 保留并标记（spec 裁定 12：「表里有但废弃」与「表里没有」行为不同）。
  // 只标进表的（查表能返回 deprecated 才有意义），顺序 = 上游 provider/模型顺序。
  const deprecated = [];
  for (const { id: providerId } of UPSTREAM_PROVIDERS) {
    for (const modelId of Object.keys(rowsByProvider[providerId])) {
      if (api[providerId].models[modelId].status === "deprecated") {
        deprecated.push(`${providerId}/${modelId}`);
      }
    }
  }

  counts.effortSets = effortSets.size;

  // 逐 (provider, 模型, 档位空间) 矩阵：--matrix 工件的数据源，也是后续 golden 的数据来源。
  // 顺序 = 上游 provider 顺序 + 逐家上游模型顺序（缺口也在，档位列留空）。
  const gapByKey = new Map(gaps.map((gap) => [`${gap.provider}\u0000${gap.modelId}`, gap]));
  const matrix = [];
  for (const { id: providerId } of UPSTREAM_PROVIDERS) {
    for (const [modelId, model] of Object.entries(api[providerId].models)) {
      if (!model.reasoning) continue;
      const valuesetId = rowsByProvider[providerId][modelId];
      const gap = gapByKey.get(`${providerId}\u0000${modelId}`);
      matrix.push({
        provider: providerId,
        modelId,
        deprecated: model.status === "deprecated",
        source: gap ? gap.resolution : "direct",
        valuesetId: typeof valuesetId === "string" ? valuesetId : null,
        valueset: typeof valuesetId === "string" ? valuesets.get(valuesetId) : null
      });
    }
  }

  return { valuesets, assignments, deprecated, gaps, coverage, counts, aliases: resolvedAliases, matrix };
}

// 别名解析（见 MODEL_ID_ALIASES 的注释）。返回渲染与借词共用的纯数据。
function resolveAlias(api, alias, rowsByProvider, registerValueset) {
  if (!UPSTREAM_PROVIDERS.some(({ id }) => id === alias.provider)) {
    fail(`别名表 ${alias.provider}/${alias.localId}: provider 不是 12 家上游之一（请求侧不会出现这个键）。`);
  }
  const slash = alias.upstream.indexOf("/");
  if (slash <= 0 || slash === alias.upstream.length - 1) {
    fail(`别名表 ${alias.provider}/${alias.localId}: upstream 必须是 "<provider>/<modelId>"，收到 "${alias.upstream}"。`);
  }
  const providerId = alias.upstream.slice(0, slash);
  const modelId = alias.upstream.slice(slash + 1);
  const provider = api[providerId];
  const model = provider && provider.models ? provider.models[modelId] : undefined;
  if (!model || typeof model !== "object") {
    fail(`别名表 ${alias.provider}/${alias.localId} 指向的上游模型不存在：${alias.upstream}（上游改 id 了？）。`);
  }
  const assigned = rowsByProvider[providerId] ? rowsByProvider[providerId][modelId] : undefined;
  if (typeof assigned === "string") {
    return { ...alias, options: model.reasoning_options, valuesetId: assigned };
  }
  const options = model.reasoning_options;
  if (!Array.isArray(options) || options.length === 0) {
    fail(`别名表 ${alias.provider}/${alias.localId} 指向的 ${alias.upstream} 自己也没有 reasoning_options —— 别名指错了。`);
  }
  const where = `别名 ${alias.provider}/${alias.localId} → ${alias.upstream}`;
  return { ...alias, options, valuesetId: registerValueset(where, normalizeOptions(where, options)) };
}

// canonical 借词：canonical_model_id 形如 "<上游 provider id>/<上游模型 id>"（模型 id
// 本身可含 "/"，如 cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6），按第一个 "/" 切。
// 目标 provider 不在快照里 / 没有前缀 / 目标模型本身也没有词表 → 都返回 null（软失败）。
function borrowOptions(api, canonicalModelId) {
  if (typeof canonicalModelId !== "string" || canonicalModelId.length === 0) {
    return null;
  }
  const slash = canonicalModelId.indexOf("/");
  if (slash <= 0 || slash === canonicalModelId.length - 1) {
    return null;
  }
  const provider = api[canonicalModelId.slice(0, slash)];
  const models = provider && typeof provider === "object" ? provider.models : undefined;
  const model = models && typeof models === "object" ? models[canonicalModelId.slice(slash + 1)] : undefined;
  const options = model && typeof model === "object" ? model.reasoning_options : undefined;
  if (!Array.isArray(options) || options.length === 0) {
    return null;
  }
  return { from: canonicalModelId, options };
}

function assertCounts(counts, expected) {
  for (const key of ["models", "reasoning", "withOptions", "gaps", "effortSets"]) {
    if (counts[key] !== expected[key]) {
      fail(
        `${key} 为 ${counts[key]}，对账常量是 ${expected[key]}。上游内容或路径变了 —— ` +
          `先确认上游这份快照（contentHash）与 spec 记录，再同步脚本常量、spec 与 ` +
          `tests/ai/models-dev-thinking.test.ts 的期望值。`
      );
    }
  }
}

function hashFacts(facts) {
  const sortedValuesets = [...facts.valuesets.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const payload = JSON.stringify({
    valuesets: sortedValuesets,
    assignments: facts.assignments,
    deprecated: facts.deprecated,
    // 别名表也进 hash（值集/上游 id 变了要换 hash），但 reason 是文档、不进 hash。
    aliases: facts.aliases.map(({ provider, localId, upstream, valuesetId }) => ({ provider, localId, upstream, valuesetId }))
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function emitBudget(budget) {
  const parts = [];
  if (budget.min !== undefined) parts.push(`min: ${budget.min}`);
  if (budget.max !== undefined) parts.push(`max: ${budget.max}`);
  return parts.length === 0 ? "{}" : `{ ${parts.join(", ")} }`;
}

// 值集行只写"有值"的部分：缺省 = toggle false / effort 无 / budget 无（见产物头注释）。
// 少写一半的 null/false 让表更短也更好读；查表结果一律补全（ThinkingModelFact）。
function emitValueset(valueset) {
  const parts = [`label: ${JSON.stringify(valueset.label)}`];
  if (valueset.toggle) parts.push("toggle: true");
  if (valueset.effort) parts.push(`effort: [${valueset.effort.map((value) => JSON.stringify(value)).join(", ")}]`);
  if (valueset.budget) parts.push(`budget: ${emitBudget(valueset.budget)}`);
  return `  ${JSON.stringify(valueset.id)}: { ${parts.join(", ")} },`;
}

function renderModule({ source, contentHash, facts }) {
  const valuesetRows = [...facts.valuesets.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(emitValueset);
  const assignmentBlocks = Object.entries(facts.assignments).map(([providerId, rows]) => {
    const modelRows = Object.entries(rows).map(
      ([modelId, valuesetId]) => `    ${JSON.stringify(modelId)}: ${JSON.stringify(valuesetId)},`
    );
    return `  ${JSON.stringify(providerId)}: {\n${modelRows.join("\n")}\n  },`;
  });
  const deprecatedRows = facts.deprecated.map((key) => `  ${JSON.stringify(key)},`);
  const borrowedTotal = facts.coverage.reduce((total, entry) => total + entry.borrowed, 0);
  const unknownTotal = facts.coverage.reduce((total, entry) => total + entry.unknown, 0);
  const aliasRows = facts.aliases.map(
    ({ provider, localId, upstream, valuesetId, reason }) =>
      `  { provider: ${JSON.stringify(provider)}, localId: ${JSON.stringify(localId)}, upstream: ${JSON.stringify(upstream)}, ` +
      `valuesetId: ${JSON.stringify(valuesetId)}, reason: ${JSON.stringify(reason)} },`
  );

  const header = `// ${MODULE_FILE} — 生成产物，勿手改。
//
// 来源：${source}（构建期抓取；上游无版本号，溯源靠 source + contentHash）
// 生成：pnpm catalog:sync:thinking（scripts/sync-models-dev-thinking.mjs）
// 口径：12 个上游 provider 的 reasoning 模型 → 归一值集常量表 VALUESETS + 指派表
//       ASSIGNMENTS。值集按结构去重；指派只回答「属于哪个值集」，线格式（怎么落请求体）
//       是 adapter 与 ai/thinking-wire-map.ts 的职责。${facts.counts.withOptions} 个模型直接有
//       reasoning_options；${facts.counts.gaps} 个缺口里 ${borrowedTotal} 个按 canonical_model_id /
//       别名表借到原生词表，其余 ${unknownTotal} 个标「未知词表」（不进表，查表返回 null =
//       请求侧不发参）。逐条借词来源与缺口清单在 --report / --matrix 工件。
//
// 值集 id 文法：<part>("+"<part>)*，part = "toggle" | effort 档位按上游顺序用 "-" 连接
// （如 low-medium-high）| "b" 或 "b:<min>-<max>"（缺省一边留空，如 b:-81920）。label 沿用
// ai/thinking-profiles.ts 的 CLASSES 命名（hybrid/always/switch/effort/budget/none）；
// 值集 id 才是键。刻意不带：reasoning_options 原文、线格式、offUnavailable / offFallback /
// streamOnly / probe 等产品语义（04/05/08 号票）。
//
// 叶子纪律：零 import（静态/动态都没有），只导出纯数据与纯查表函数；上游数据只在构建期
// 被读，请求路径（core/provider-http.ts → ai/completion.ts → ai/adapters/*）绝不引用本模块
// （scripts/build.js 的 assertBackgroundStaticGraphSlim 把本文件列为 SW 静态图禁区）。
// 同一份上游数据重跑幂等（git diff 为空）：没有生成/抓取时间戳，抓取时间只在 --report 里。
`;

  return `${header}
export interface ThinkingBudgetRange {
  readonly min?: number;
  readonly max?: number;
}

// 值集表存的结构（键 = 值集 id，见文件头 id 文法）。省缺 = toggle false / effort 无 /
// budget 无：表里只写真值（少一半 null/false，更好读），查表结果一律补全。
// off 是 (toggle, effort) 的纯函数，不重复存进表 —— 查表结果里按 offChannelOf 派生。
export interface ThinkingValueset {
  readonly label: string;
  readonly toggle?: boolean;
  readonly effort?: readonly string[];
  readonly budget?: ThinkingBudgetRange;
}

// 别名表条目：本仓/历史口径的 localId → 上游 id（upstream）+ 它对应的值集；reason 逐条
// 写清理由（可审），生成期保证 upstream 在快照里有词表。
export interface ThinkingModelAlias {
  readonly provider: string;
  readonly localId: string;
  readonly upstream: string;
  readonly valuesetId: string;
  readonly reason: string;
}

// 查表结果：归一后的档位空间 + 派生 off + deprecated（「表里有但废弃」≠「表里没有」）。
export interface ThinkingModelFact {
  readonly valuesetId: string;
  readonly label: string;
  readonly toggle: boolean;
  readonly effort: readonly string[] | null;
  readonly budget: ThinkingBudgetRange | null;
  readonly off: "toggle" | "effort-none" | null;
  readonly deprecated: boolean;
}

// 数据版本（UI 的 title 展示与漂移判定用）：contentHash = 值集 + 指派 + deprecated +
// 别名指向的 sha256（别名 reason 是文档，不进 hash）。同一份上游数据两次生成必然同值。
export const UPSTREAM_THINKING_SOURCE = {
  source: ${JSON.stringify(source)},
  contentHash: "sha256:${contentHash}",
  counts: {
    models: ${facts.counts.models},
    reasoning: ${facts.counts.reasoning},
    withOptions: ${facts.counts.withOptions},
    gaps: ${facts.counts.gaps},
    borrowed: ${borrowedTotal},
    unknown: ${unknownTotal},
    effortSets: ${facts.counts.effortSets},
    valuesets: ${facts.valuesets.size},
    deprecated: ${facts.deprecated.length},
    aliases: ${facts.aliases.length}
  }
} as const;

export const VALUESETS: Readonly<Record<string, ThinkingValueset>> = {
${valuesetRows.join("\n")}
};

// 指派表：上层键 = 上游 provider id（preset → 上游 provider 的映射留在调用侧），
// 下层键 = 上游模型 id（逐字大小写）。没有词表的模型不进表（fail-closed）。
export const ASSIGNMENTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
${assignmentBlocks.join("\n")}
};

// deprecated 模型（spec 裁定 12）：进表并标记，不删。
export const DEPRECATED_MODELS: readonly string[] = [
${deprecatedRows.join("\n")}
];

// 别名表（spec 裁定 13：精确匹配 + 折叠大小写 + 别名表）。生成期已校验每条 upstream
// 在快照里有词表；reason 是逐条理由（上游 id 依据），可审。
export const MODEL_ID_ALIASES: readonly ThinkingModelAlias[] = [
${aliasRows.join("\n")}
];

// 纯查表（请求路径的唯一入口）：键 = (上游 provider id, 模型 id)。
//   命中序：精确 → 折叠大小写 → 别名表；都不中返回 null（fail-closed：未知词表的模型
//   请求侧不发任何思考参数，行为同今日）。
// provider 也折叠大小写（上游 provider id 全小写，请求侧来源可能是 preset 名）。
export function lookupThinkingFact(upstreamId: unknown, modelId: unknown): ThinkingModelFact | null {
  if (typeof upstreamId !== "string" || typeof modelId !== "string") {
    return null;
  }
  const providerKey = upstreamId.trim().toLowerCase();
  const modelKey = modelId.trim();
  if (providerKey.length === 0 || modelKey.length === 0) {
    return null;
  }
  const resolved = resolveThinkingKey(providerKey, modelKey);
  if (!resolved) {
    return null;
  }
  const valueset = VALUESETS[resolved.valuesetId];
  if (!valueset) {
    return null;
  }
  return {
    valuesetId: resolved.valuesetId,
    label: valueset.label,
    toggle: valueset.toggle === true,
    effort: valueset.effort ?? null,
    budget: valueset.budget ?? null,
    off: offChannelOf(valueset),
    deprecated: DEPRECATED_MODELS.includes(\`\${resolved.provider}/\${resolved.modelId}\`)
  };
}

// 关思考怎么表达（单源派生）：有开关走平台开关；effort 词表含 none 走 effort none；
// 两者都没有 = 关不掉。与 spec §词汇覆盖缺口 的归一规则一一对应。
function offChannelOf(valueset: ThinkingValueset): "toggle" | "effort-none" | null {
  if (valueset.toggle === true) {
    return "toggle";
  }
  return valueset.effort && valueset.effort.includes("none") ? "effort-none" : null;
}

interface ResolvedThinkingKey {
  readonly provider: string;
  readonly modelId: string;
  readonly valuesetId: string;
}

function resolveThinkingKey(providerKey: string, modelKey: string): ResolvedThinkingKey | null {
  const table = ASSIGNMENTS[providerKey];
  if (table) {
    const exact = table[modelKey];
    if (exact) {
      return { provider: providerKey, modelId: modelKey, valuesetId: exact };
    }
    const folded = modelKey.toLowerCase();
    for (const candidate of Object.keys(table)) {
      if (candidate.toLowerCase() === folded) {
        return { provider: providerKey, modelId: candidate, valuesetId: table[candidate] };
      }
    }
  }
  const folded = modelKey.toLowerCase();
  for (const alias of MODEL_ID_ALIASES) {
    if (alias.provider !== providerKey || alias.localId.toLowerCase() !== folded) {
      continue;
    }
    const slash = alias.upstream.indexOf("/");
    if (slash > 0) {
      return {
        provider: alias.upstream.slice(0, slash),
        modelId: alias.upstream.slice(slash + 1),
        valuesetId: alias.valuesetId
      };
    }
  }
  return null;
}
`;
}

function summaryLines({ source, input, contentHash, facts, bytes }) {
  const lines = [
    `sync-models-dev-thinking: ${facts.valuesets.size} 个值集 / ${facts.counts.reasoning} 个 reasoning 模型 / ${bytes} B`,
    `  source: ${source}`,
    `  input: ${input}`,
    `  contentHash: sha256:${contentHash}`,
    `  有词表 ${facts.counts.withOptions} / 缺口 ${facts.counts.gaps} / effort 值集 ${facts.counts.effortSets} / deprecated ${facts.deprecated.length}`
  ];
  for (const { id, reasoning, assigned, borrowed, unknown } of facts.coverage) {
    lines.push(`  ${id}: reasoning ${reasoning} / 指派 ${assigned} / 借词 ${borrowed} / 未知词表 ${unknown}`);
  }
  return lines;
}

// 缺口逐条清单（票面验收：63 个缺口的处理逐条可追 —— 借到了 / 标未知）+ 别名表逐条理由。
// 报告文件是**唯一**允许出现抓取时间的地方（产物必须幂等）。
function renderReport(summary, facts, capturedAt) {
  const lines = [...summary, `  capturedAt: ${capturedAt}`];
  lines.push("", `缺口逐条（${facts.gaps.length}）：`);
  for (const gap of facts.gaps) {
    const key = `${gap.provider}/${gap.modelId}`;
    if (gap.resolution === "unknown") {
      lines.push(
        `  ${key}  未知词表（${gap.canonical ? `canonical_model_id=${gap.canonical} 的目标没有词表` : "上游没有 canonical_model_id 可借"}）`
      );
      continue;
    }
    lines.push(`  ${key} ← ${gap.resolution} → ${gap.valuesetId}`);
  }
  lines.push("", `别名表（${facts.aliases.length}）：`);
  for (const alias of facts.aliases) {
    lines.push(`  ${alias.provider}/${alias.localId} → ${alias.upstream}（值集 ${alias.valuesetId}）：${alias.reason}`);
  }
  lines.push("", `值集（${facts.valuesets.size}）：`);
  for (const valueset of [...facts.valuesets.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const effort = valueset.effort ? valueset.effort.join("/") : "-";
    const budget = valueset.budget
      ? `${valueset.budget.min === undefined ? "" : valueset.budget.min}-${valueset.budget.max === undefined ? "" : valueset.budget.max}`
      : "-";
    lines.push(
      `  ${valueset.id}  label=${valueset.label}  toggle=${valueset.toggle}  effort=${effort}  budget=${budget}  off=${valueset.off ?? "null"}`
    );
  }
  return `${lines.join("\n")}\n`;
}

// 逐 (provider, 模型, 档位空间) 矩阵 TSV（后续 golden 的数据来源）。未知词表的行也要在，
// 档位列留空 —— 这正是「静默不发参」的可见性。
function renderMatrix(facts) {
  const header = [
    "provider",
    "modelId",
    "deprecated",
    "source",
    "valuesetId",
    "label",
    "toggle",
    "effort",
    "budgetMin",
    "budgetMax",
    "off"
  ];
  const rows = facts.matrix.map((row) => {
    const valueset = row.valueset;
    return [
      row.provider,
      row.modelId,
      row.deprecated ? "true" : "false",
      row.source,
      row.valuesetId ?? "",
      valueset ? valueset.label : "",
      valueset ? String(valueset.toggle) : "",
      valueset && valueset.effort ? valueset.effort.join("/") : "",
      valueset && valueset.budget && valueset.budget.min !== undefined ? String(valueset.budget.min) : "",
      valueset && valueset.budget && valueset.budget.max !== undefined ? String(valueset.budget.max) : "",
      valueset ? valueset.off ?? "" : ""
    ].join("\t");
  });
  return `${[header.join("\t"), ...rows].join("\n")}\n`;
}

function writeFile(filePath, text) {
  const resolved = path.resolve(rootDir, filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, text);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const text = await readSnapshot(options.input);

  let api;
  try {
    api = JSON.parse(text);
  } catch (error) {
    fail(`输入不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!api || typeof api !== "object" || Array.isArray(api)) {
    fail(`输入顶层不是 provider 表（${options.input}）。`);
  }

  const facts = compileFacts(api, loadAliases(options.aliases));
  assertCounts(facts.counts, options.expectCounts);

  const contentHash = hashFacts(facts);
  const output = renderModule({ source: DEFAULT_SOURCE, contentHash, facts });
  writeFile(options.out, output);

  const bytes = Buffer.byteLength(output);
  const lines = summaryLines({
    source: DEFAULT_SOURCE,
    input: options.input,
    contentHash,
    facts,
    bytes
  });
  console.log(lines.join("\n"));

  if (options.report) {
    writeFile(options.report, renderReport(lines, facts, new Date().toISOString()));
  }
  if (options.matrix) {
    writeFile(options.matrix, renderMatrix(facts));
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
