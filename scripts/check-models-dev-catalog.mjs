// scripts/check-models-dev-catalog.mjs —— 只读对账命令（工单 upstream-model-facts/03）。
//
//   pnpm catalog:check
//
// 回答两个问题，**只报告不改动**：
//   1. 漂移：仓库快照（01 产物的 12 家裁剪子集）相对当前上游旧了没有、差在哪；
//   2. 分歧：02 的指派表（上游逐模型词表）与手写表（thinking-profiles.ts）逐格比，
//      哪些格子上游更对（Q1=B 上游胜 → 手写表删除候选）、哪些上游新增、哪些只有手写表有。
//
// 口径（为什么这么算，逐条有据）：
//   - 漂移 = **裁剪后 12 家子集**的 sha256 与 01 产物里的 contentHash 比对。上游没有版本号
//     （只有弱 ETag，覆盖 200+ provider，其中 190 个与本仓无关），所以口径是内容哈希，
//     且必须与 scripts/sync-models-dev-catalog.mjs 的裁剪逐字节等效（字段白名单与键序都照抄，
//     否则本命令会对同一份上游数据误报漂移）。12 家之外的 provider 变了不算漂移。
//   - 分歧单元 = 12 家 × 每个 `reasoning: true` 模型（逐格）。上游侧事实取 02 产物的值集
//     指派（含 canonical_model_id 借词与 MODEL_ID_ALIASES 的结论）；手写侧事实取
//     extension/ai/thinking-profiles.ts 的**文本解析**（本脚本不执行仓库代码：手写表与产物
//     都是零依赖文本，解析出结构后按 resolveThinkingProfile 的同序解析：
//       PROVIDERS[preset].override 短路 >> EXCEPTIONS >> TAXONOMY >> unknownClass >> 无结论
//     模型名 = 上游 id（折叠大小写）优先，其次去命名空间前缀（最后一个 "/" 之后），
//     再有 02 别名表的 localId 优先命中（如上游 k3 ↔ 本仓 kimi-k3）。
//   - 三类分歧：
//       upstream-wins  双方都有结论且不相容 → Q1=B：上游胜，这里是**删除候选**（删减归 04 号票）；
//       upstream-new   上游有词表、手写表没覆盖（EXCEPTIONS/TAXONOMY/unknownClass 全没命中）；
//       hand-only      上游没有词表（缺口）、手写表有结论 → **保留**。
//   - **override 型平台**（openrouter / amd / sensenova / opencodego）单列不逐格对比：那四家的
//     手写表给的是**平台级产品裁定**（整域只认某种词汇 / 顶层参数透传，见各 PROVIDERS 注释），
//     与上游的**逐模型**词表不是同一层事实；逐格比会产出上百条不可执行的"分歧"，淹没真正的
//     删除候选。报告 §6 给平台级形状 + 上游逐模型形状分布，可见性不降级。
//   - 已知"不是分歧"：手写 low/high 共用一个写点（开关型 on，或 low/high 同 effort 值）而上游
//     没有 effort 词表时，本仓把 low/high 落成同一份参数（如 qwen3-max 的 budget_tokens 塌陷）
//     是唯一形状。报告 §5 逐组列出，不混进 upstream-wins。
//
// 只读纪律：本命令不改任何仓库文件、不提交快照、不写产物；唯一的输出是报告文件（默认
// `.scratch/tickets/upstream-model-facts/artifacts/03-catalog-check.md`）。抓取时间只出现在报告里，
// stdout 只有摘要与退出码。
//
// 用法：
//   node scripts/check-models-dev-catalog.mjs \
//     [--input <path|url>] [--catalog <path>] [--assignments <path>] [--profiles <path>] [--report <path>]
//
//   --input        当前上游（默认直连 https://models.dev/api.json；离线/测试传本地快照）。
//   --catalog      01 的 UI 目录产物（contentHash + 逐模型字段，漂移与字段级差异的比对基准）。
//   --assignments  02 的思考事实产物（值集 + 指派 + 别名表）。
//   --profiles     手写表（默认 extension/ai/thinking-profiles.ts；只读文本，测试可喂小样）。
//   --report       报告落点。
//
// 退出码：
//   0 = in sync（12 家子集内容哈希一致；**分歧清单仍可能有内容**，那是要人核对的，不是失败）；
//   1 = drift（快照与上游不同，或上游形状解析出问题；报告给逐家差异）；
//   2 = 硬错（输入读不到/不是 JSON、产物或手写表解析不了）。

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SOURCE, UPSTREAM_PROVIDERS } from "./models-dev-upstream-providers.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CATALOG_MODULE = "extension/ai/catalog/models-dev-catalog.generated.ts";
const ASSIGNMENTS_MODULE = "extension/ai/catalog/models-dev-thinking.generated.ts";
const PROFILES_MODULE = "extension/ai/thinking-profiles.ts";
const REPORT_FILE = ".scratch/tickets/upstream-model-facts/artifacts/03-catalog-check.md";

// 与 01 产物一致的字段白名单（漂移哈希必须与 scripts/sync-models-dev-catalog.mjs 等效）。
const KEEP_FIELDS = ["name", "reasoning", "input", "contextWindow", "maxTokens"];

const EXIT_IN_SYNC = 0;
const EXIT_DRIFT = 1;
const EXIT_ERROR = 2;

function fail(message) {
  console.error(`check-models-dev-catalog: ${message}`);
  process.exit(EXIT_ERROR);
}

function parseArgs(argv) {
  const options = {
    input: DEFAULT_SOURCE,
    catalog: CATALOG_MODULE,
    assignments: ASSIGNMENTS_MODULE,
    profiles: PROFILES_MODULE,
    report: REPORT_FILE
  };
  const flags = {
    "--input": "input",
    "--catalog": "catalog",
    "--assignments": "assignments",
    "--profiles": "profiles",
    "--report": "report"
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const key = flags[flag];
    if (!key) {
      fail(
        `未知参数 "${flag}"。用法：--input <path|url> --catalog <path> --assignments <path> ` +
          `--profiles <path> --report <path>（本命令只读，没有 --out）`
      );
    }
    const value = argv[i + 1];
    if (value === undefined) fail(`${flag} 缺参数值`);
    i += 1;
    options[key] = value;
  }
  return options;
}

function readTextFile(filePath) {
  const resolved = path.resolve(rootDir, filePath);
  if (!fs.existsSync(resolved)) {
    fail(`文件不存在：${filePath}`);
  }
  return fs.readFileSync(resolved, "utf8");
}

async function readInput(input) {
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
    return { text: await response.text(), label: input };
  }
  return { text: readTextFile(input), label: input };
}

const normalizeEol = (text) => text.replace(/\r\n/g, "\n");

function sliceSection(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start < 0) return null;
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (end < 0) return null;
  return text.slice(start + startMarker.length, end);
}

// 标记只到 annotation 前缀的表（PROVIDERS：真表与 fixture 的泛型实参不同）：扫描体从
// 该行的 `{` 之后开始，其余与 sliceSection 相同。
function sliceObjectBody(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start < 0) return null;
  const open = text.indexOf("{", start);
  if (open < 0) return null;
  const end = text.indexOf(endMarker, open);
  if (end < 0) return null;
  return text.slice(open + 1, end);
}

// 去掉行尾 `// …` 注释（不动字符串里的 `//`）。
function stripLineComment(line) {
  let out = "";
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += line[i + 1] ?? "";
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") break;
    out += ch;
  }
  return out.replace(/\s+$/, "");
}

function commentText(line) {
  const index = line.indexOf("//");
  return index < 0 ? "" : line.slice(index + 2).trim();
}

// 注释里的出处域名（报告的"本仓证据"一栏）。只认常见 TLD，避免把中文注释里的词当域名。
const DOMAIN_RE = /\b(?:[a-z0-9][a-z0-9-]*\.)+(?:com|cn|ai|io|org|dev|net)(?:\.[a-z]{2})?\b/g;
function domainsOf(commentLines) {
  const found = [];
  for (const line of commentLines) {
    for (const match of line.matchAll(DOMAIN_RE)) {
      if (!found.includes(match[0])) found.push(match[0]);
    }
  }
  return found;
}

// ───────────────────────────── 01 产物的裁剪（漂移口径）─────────────────────────────

// 与 sync-models-dev-catalog.mjs 的 cropCatalog/pickModel 逐字段等效，但**宽容**：上游形状
// 出问题时记 problem 继续算（检查命令的职责是把问题报出来，不是像生成器那样中止）。
function pickModelForCheck(providerId, modelId, model, problems) {
  const at = `${providerId}/${modelId}`;
  if (!model || typeof model !== "object") {
    problems.push(`${at}：模型不是对象`);
    return { id: modelId };
  }
  const meta = { id: modelId };
  if (model.id !== modelId) {
    problems.push(`${at}：模型自带 id 与键不一致（${JSON.stringify(model.id)}）`);
  }
  if (typeof model.name !== "string" || model.name.length === 0) {
    problems.push(`${at}：缺 name`);
  } else {
    meta.name = model.name;
  }
  if (typeof model.reasoning !== "boolean") {
    problems.push(`${at}：缺 reasoning`);
  } else {
    meta.reasoning = model.reasoning;
  }
  const input = model.modalities && model.modalities.input;
  if (!Array.isArray(input) || input.length === 0 || input.some((item) => typeof item !== "string" || item.length === 0)) {
    problems.push(`${at}：缺 modalities.input`);
  } else {
    meta.input = [...input];
  }
  const context = model.limit && model.limit.context;
  if (!Number.isInteger(context) || context <= 0) {
    problems.push(`${at}：缺 limit.context`);
  } else {
    meta.contextWindow = context;
  }
  const output = model.limit && model.limit.output;
  if (!Number.isInteger(output) || output <= 0) {
    problems.push(`${at}：缺 limit.output`);
  } else {
    meta.maxTokens = output;
  }
  return meta;
}

function cropForCheck(api) {
  const upstreams = [];
  const problems = [];
  for (const { preset, id } of UPSTREAM_PROVIDERS) {
    const provider = api[id];
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
      problems.push(`${id}（preset ${preset}）：快照里没有这个上游 provider —— 上游改了 provider id？`);
      continue;
    }
    let doc;
    if (typeof provider.doc === "string" && provider.doc.length > 0) {
      doc = provider.doc;
    } else {
      problems.push(`${id}：doc 为空（产物溯源信息失效）`);
    }
    const upstreamModels = provider.models && typeof provider.models === "object" ? provider.models : {};
    const ids = Object.keys(upstreamModels);
    if (ids.length === 0) {
      problems.push(`${id}：models 为空`);
    }
    const models = {};
    for (const modelId of ids) {
      models[modelId] = pickModelForCheck(id, modelId, upstreamModels[modelId], problems);
    }
    upstreams.push({ id, doc, models });
  }
  return { upstreams, problems };
}

// 与 01 逐字节同口径：JSON.stringify 的键序就是产物的键序。
function hashCatalog(upstreams) {
  return createHash("sha256").update(JSON.stringify(upstreams), "utf8").digest("hex");
}

// ───────────────────────────── 产物文本解析 ─────────────────────────────

function jsonString(literal) {
  try {
    return JSON.parse(literal);
  } catch {
    return literal.replace(/^"|"$/g, "");
  }
}

function parseCatalogModule(text, label) {
  const source = normalizeEol(text);
  const hash = source.match(/contentHash: "(sha256:[0-9a-f]{64})"/);
  if (!hash) {
    fail(`${label} 里找不到 contentHash —— 01 产物形状变了（本命令的漂移基准）。`);
  }
  const marker = "export const UPSTREAM_CATALOG: Readonly<Record<string, Readonly<Record<string, CatalogModelMeta>>>> = {";
  const body = sliceSection(source, marker, "\n};");
  if (body === null) {
    fail(`${label} 里找不到 UPSTREAM_CATALOG —— 01 产物形状变了。`);
  }
  const docs = new Map();
  for (const match of source.matchAll(/^ {4}\{ id: "([^"]+)", doc: "([^"]+)", models: (\d+) \},$/gm)) {
    docs.set(match[1], { doc: match[2], models: Number(match[3]) });
  }
  const upstreams = [];
  let current = null;
  for (const raw of body.split("\n")) {
    const provider = raw.match(/^ {2}"([^"]+)": \{$/);
    if (provider) {
      current = { id: provider[1], doc: docs.get(provider[1])?.doc, models: {} };
      upstreams.push(current);
      continue;
    }
    const model = raw.match(/^ {4}"((?:[^"\\]|\\.)*)": \{ (.*) \},$/);
    if (model && current) {
      current.models[jsonString(`"${model[1]}"`)] = parseCatalogMeta(model[2]);
    }
  }
  if (upstreams.length === 0 || upstreams.every((entry) => Object.keys(entry.models).length === 0)) {
    fail(`${label} 的 UPSTREAM_CATALOG 解析出空表 —— 01 产物形状变了。`);
  }
  return { contentHash: hash[1], upstreams };
}

function parseCatalogMeta(text) {
  const meta = {};
  const id = text.match(/id: ("(?:[^"\\]|\\.)*")/);
  if (id) meta.id = jsonString(id[1]);
  const name = text.match(/name: ("(?:[^"\\]|\\.)*")/);
  if (name) meta.name = jsonString(name[1]);
  const reasoning = text.match(/reasoning: (true|false)/);
  if (reasoning) meta.reasoning = reasoning[1] === "true";
  const input = text.match(/input: \[(.*?)\]/);
  if (input) meta.input = [...input[1].matchAll(/"(?:[^"\\]|\\.)*"/g)].map((match) => jsonString(match[0]));
  const context = text.match(/contextWindow: (\d+)/);
  if (context) meta.contextWindow = Number(context[1]);
  const maxTokens = text.match(/maxTokens: (\d+)/);
  if (maxTokens) meta.maxTokens = Number(maxTokens[1]);
  return meta;
}

function parseBudget(text) {
  const range = text.match(/budget: \{ (.*) \}/);
  if (!range) return null;
  const budget = {};
  const min = range[1].match(/min: (\d+)/);
  const max = range[1].match(/max: (\d+)/);
  if (min) budget.min = Number(min[1]);
  if (max) budget.max = Number(max[1]);
  return budget;
}

function parseAssignmentsModule(text, label) {
  const source = normalizeEol(text);
  const valuesetBody = sliceSection(
    source,
    "export const VALUESETS: Readonly<Record<string, ThinkingValueset>> = {",
    "\n};"
  );
  const assignmentBody = sliceSection(
    source,
    "export const ASSIGNMENTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {",
    "\n};"
  );
  const aliasBody = sliceSection(source, "export const MODEL_ID_ALIASES: readonly ThinkingModelAlias[] = [", "\n];");
  if (valuesetBody === null || assignmentBody === null || aliasBody === null) {
    fail(`${label} 里找不到 VALUESETS / ASSIGNMENTS / MODEL_ID_ALIASES —— 02 产物形状变了。`);
  }
  const valuesets = new Map();
  for (const raw of valuesetBody.split("\n")) {
    const match = raw.trim().match(/^"((?:[^"\\]|\\.)*)": \{ (.*) \},?$/);
    if (!match) continue;
    const id = jsonString(`"${match[1]}"`);
    const text = match[2];
    const effort = text.match(/effort: \[(.*?)\]/);
    valuesets.set(id, {
      id,
      toggle: /toggle: true/.test(text),
      effort: effort ? [...effort[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]) : null,
      budget: parseBudget(text),
      label: jsonString(text.match(/label: (".*?")/)?.[1] ?? '""')
    });
  }
  const assignments = new Map();
  let provider = null;
  for (const raw of assignmentBody.split("\n")) {
    const providerLine = raw.match(/^ {2}"((?:[^"\\]|\\.)*)": \{$/);
    if (providerLine) {
      provider = jsonString(`"${providerLine[1]}"`);
      assignments.set(provider, new Map());
      continue;
    }
    const row = raw.match(/^ {4}"((?:[^"\\]|\\.)*)": "((?:[^"\\]|\\.)*)",$/);
    if (row && provider) {
      assignments.get(provider).set(jsonString(`"${row[1]}"`), jsonString(`"${row[2]}"`));
    }
  }
  const aliases = [];
  for (const raw of aliasBody.split("\n")) {
    const match = raw
      .trim()
      .match(
        /^\{ provider: "([^"]+)", localId: "((?:[^"\\]|\\.)*)", upstream: "([^"]+)", valuesetId: "([^"]+)", reason: "([\s\S]*)" \},?$/
      );
    if (!match) continue;
    aliases.push({
      provider: match[1],
      localId: jsonString(`"${match[2]}"`),
      upstream: match[3],
      valuesetId: match[4]
    });
  }
  if (valuesets.size === 0 || assignments.size === 0) {
    fail(`${label} 的 VALUESETS / ASSIGNMENTS 解析出空表 —— 02 产物形状变了。`);
  }
  for (const [providerId, rows] of assignments) {
    for (const [modelId, valuesetId] of rows) {
      if (!valuesets.has(valuesetId)) {
        fail(`${label}：${providerId}/${modelId} 指派到不存在的值集 "${valuesetId}" —— 02 产物自相矛盾。`);
      }
    }
  }
  // 别名指向的 (provider, modelId) → localId：本仓口径 id 的上游 id 映射（对比时用它查手写表）。
  const aliasByUpstream = new Map();
  for (const alias of aliases) {
    const slash = alias.upstream.indexOf("/");
    if (slash <= 0) continue;
    aliasByUpstream.set(`${alias.upstream.slice(0, slash)}\u0000${alias.upstream.slice(slash + 1)}`, alias);
  }
  return { valuesets, assignments, aliases, aliasByUpstream };
}

// ───────────────────────────── 手写表文本解析 ─────────────────────────────

const PROFILE_MARKERS = {
  CLASSES: "export const CLASSES: Record<string, ClassRule> = {",
  EXCEPTIONS: "export const EXCEPTIONS: readonly TaxonomyEntry[] = [",
  TAXONOMY: "export const TAXONOMY: readonly TaxonomyEntry[] = [",
  // 平台身份键表自候选 6 起以封闭键词表叶索引：真表 annotation = Record<PlatformKey, ProviderRule>，
  // fixture 仍是刻意不全的 Record<string, ProviderRule>（12 键小样）→ 标记取两行共有的前缀，
  // 扫描体从该行的 `{` 之后开始（见 sliceObjectBody）。前导换行 = 只认**行首**的声明
  // （注释里提到这个前缀不算命中）。
  PROVIDERS: "\nexport const PROVIDERS: Record<"
};

// 行级扫描：注释归到下一条目（条目内注释归该条目），单行/多行条目都吃。
// 解析不了的代码行一律硬错 —— 静默漏读整表会把所有模型误报成"手写未覆盖"。
function scanObjectEntries(body, keyPattern, inlineKeyPattern, label) {
  const entries = [];
  const byKey = new Map();
  let pendingComments = [];
  let current = null;
  for (const raw of body.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("//")) {
      (current ? current.comments : pendingComments).push(commentText(trimmed));
      continue;
    }
    const code = stripLineComment(raw);
    if (code.trim() === "") continue;
    if (current) {
      if (/^ {2}\},?$/.test(code)) {
        current = null;
        continue;
      }
      current.lines.push(code.trim());
      continue;
    }
    const multi = code.match(keyPattern);
    if (multi) {
      current = { key: multi[1], comments: pendingComments, lines: [] };
      const trailing = commentText(raw);
      if (trailing) current.comments.push(trailing);
      pendingComments = [];
      entries.push(current);
      byKey.set(current.key, current);
      continue;
    }
    const inline = code.match(inlineKeyPattern);
    if (inline) {
      const entry = { key: inline[1], comments: pendingComments, lines: [inline[2].trim()] };
      const trailing = commentText(raw);
      if (trailing) entry.comments.push(trailing);
      pendingComments = [];
      entries.push(entry);
      byKey.set(entry.key, entry);
      continue;
    }
    fail(`${label} 里有解析不了的行：${JSON.stringify(raw)} —— 手写表结构变了，先核对本脚本的解析口径。`);
  }
  if (current) {
    fail(`${label} 的条目 "${current.key}" 没有闭合 —— 手写表结构变了。`);
  }
  return { entries, byKey };
}

function patchFacts(line) {
  if (!line) return null;
  const facts = { fields: [] };
  // 两套形状都吃（2026-10-05「封闭词汇」改造后真表换了形状，override 分支仍是旧记录形状）：
  // - 中转词汇构造子（真表 CLASSES）：thinkingType(...) / enableThinking(...) / reasoningEffort("...")；
  // - 记录形状（fixture 的平台级 override 分支本地声明）：thinking: / enable_thinking: / reasoning_effort: "..."。
  if (/\bthinkingType\(/.test(line) || /\bthinking:/.test(line)) facts.fields.push("thinking");
  if (/\benableThinking\(/.test(line) || /\benable_thinking:/.test(line)) facts.fields.push("enable_thinking");
  const effort = line.match(/reasoningEffort\("([^"]+)"\)/) ?? line.match(/reasoning_effort: "([^"]+)"/);
  if (effort) {
    facts.fields.push("reasoning_effort");
    facts.effort = effort[1];
  }
  if (/streamOnly: true/.test(line)) facts.streamOnly = true;
  if (facts.fields.length === 0) {
    // 静默空读会把整个 class 误报成「未表达任何档位」——与上面「解析不了的行硬错」同一条纪律。
    fail(`patch 行解析不出任何词汇：${JSON.stringify(line)} —— 手写表结构变了，先核对本脚本的解析口径。`);
  }
  return facts;
}

function classFacts(entry) {
  const text = entry.lines.join(" ");
  const lineOf = (key) => entry.lines.find((line) => line.startsWith(`${key}:`)) ?? null;
  const off = patchFacts(lineOf("off"));
  const on = patchFacts(lineOf("on"));
  const low = patchFacts(lineOf("low"));
  const high = patchFacts(lineOf("high"));
  const tierValues = [];
  for (const patch of [low, high]) {
    if (patch && patch.effort && !tierValues.includes(patch.effort)) tierValues.push(patch.effort);
  }
  const singleWritePoint =
    (on !== null && !low && !high) || (low?.effort !== undefined && low.effort === high?.effort);
  return {
    name: entry.key,
    comments: entry.comments,
    domains: domainsOf(entry.comments),
    thinkingClass: text.match(/thinkingClass: "([^"]+)"/)?.[1],
    off,
    on,
    low,
    high,
    hasOff: off !== null,
    hasTiers: Boolean(on || low || high),
    tierValues,
    singleWritePoint,
    tokenParam: text.match(/tokenParam: "([^"]+)"/)?.[1]
  };
}

function overrideFacts(entry) {
  const lineOf = (key) => entry.lines.find((line) => line.startsWith(`${key}:`)) ?? null;
  const text = entry.lines.join(" ");
  const off = patchFacts(lineOf("off"));
  const low = patchFacts(lineOf("low"));
  const high = patchFacts(lineOf("high"));
  return {
    name: `${entry.key}.override`,
    comments: entry.comments,
    domains: domainsOf(entry.comments),
    thinkingClass: text.match(/thinkingClass: "([^"]+)"/)?.[1],
    off,
    low,
    high,
    hasOff: off !== null,
    hasTiers: Boolean(low || high),
    tierValues: [low?.effort, high?.effort].filter((value) => value !== undefined),
    singleWritePoint: low?.effort !== undefined && low.effort === high?.effort
  };
}

function parseProfilesModule(text, label) {
  const source = normalizeEol(text);
  const missing = Object.values(PROFILE_MARKERS).filter((marker) => !source.includes(marker));
  if (missing.length > 0) {
    fail(
      `${label} 解析失败：找不到 ${missing.join(" / ")} —— 手写表结构变了（或被换成了别的文件），` +
        `先核对本脚本的解析口径（票据 03）。`
    );
  }
  const classesTable = scanObjectEntries(
    sliceSection(source, PROFILE_MARKERS.CLASSES, "\n};"),
    /^ {2}"([^"]+)": \{$/,
    /^ {2}"([^"]+)": \{([^}]*)\},?$/,
    `${label} 的 CLASSES`
  );
  const providersTable = scanObjectEntries(
    sliceObjectBody(source, PROFILE_MARKERS.PROVIDERS, "\n};"),
    /^ {2}([A-Za-z_$][\w$]*): \{$/,
    /^ {2}([A-Za-z_$][\w$]*): \{([^}]*)\},?$/,
    `${label} 的 PROVIDERS`
  );
  const classes = new Map();
  for (const entry of classesTable.entries) {
    const facts = classFacts(entry);
    if (!facts.thinkingClass) {
      fail(`${label} 的 CLASSES["${entry.key}"] 解析不出 thinkingClass —— 手写表结构变了。`);
    }
    classes.set(entry.key, facts);
  }
  const providers = new Map();
  for (const entry of providersTable.entries) {
    const text2 = entry.lines.join(" ");
    const override = /\boverride: \{/.test(text2) ? overrideFacts(entry) : null;
    if (override && !override.thinkingClass) {
      fail(`${label} 的 PROVIDERS.${entry.key}.override 解析不出 thinkingClass —— 手写表结构变了。`);
    }
    providers.set(entry.key, {
      id: entry.key,
      comments: entry.comments,
      domains: domainsOf(entry.comments),
      unknownClass: text2.match(/unknownClass: "([^"]+)"/)?.[1] ?? null,
      override
    });
  }
  const parseRuleEntries = (marker, tableLabel) => {
    const body = sliceSection(source, marker, "\n];");
    const entries = [];
    let pendingComments = [];
    for (const raw of body.split("\n")) {
      const trimmed = raw.trim();
      if (trimmed === "") continue;
      if (trimmed.startsWith("//")) {
        pendingComments.push(commentText(trimmed));
        continue;
      }
      const code = stripLineComment(raw).trim();
      if (code === "") continue;
      const match = code.match(/^\{ class: "([^"]+)", patterns: \[(.*?)\] \},?$/);
      if (!match) {
        fail(`${tableLabel} 里有解析不了的行：${JSON.stringify(raw)} —— 手写表结构变了。`);
      }
      const trailing = commentText(raw);
      const comments = trailing ? [...pendingComments, trailing] : pendingComments;
      entries.push({
        className: match[1],
        patterns: [...match[2].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]),
        comments,
        domains: domainsOf(comments)
      });
      pendingComments = [];
    }
    return entries;
  };
  const exceptions = parseRuleEntries(PROFILE_MARKERS.EXCEPTIONS, `${label} 的 EXCEPTIONS`);
  const taxonomy = parseRuleEntries(PROFILE_MARKERS.TAXONOMY, `${label} 的 TAXONOMY`);

  // 引用完整性：引用了不存在的 class 就是解析/结构问题，必须吵（静默会让整片模型"未覆盖"）。
  for (const [tableName, entries] of [["EXCEPTIONS", exceptions], ["TAXONOMY", taxonomy]]) {
    entries.forEach((entry, index) => {
      if (!classes.has(entry.className)) {
        fail(`${label} 的 ${tableName}[${index}] 引用了不存在的 class "${entry.className}"。`);
      }
    });
  }
  for (const provider of providers.values()) {
    if (provider.unknownClass && !classes.has(provider.unknownClass)) {
      fail(`${label} 的 PROVIDERS.${provider.id}.unknownClass 引用了不存在的 class "${provider.unknownClass}"。`);
    }
  }
  return {
    classes,
    providers,
    exceptions,
    taxonomy,
    counts: {
      classes: classes.size,
      exceptions: exceptions.length,
      taxonomy: taxonomy.length,
      providers: providers.size
    }
  };
}

function modelMatches(pattern, model) {
  if (!pattern.includes("*")) return model.startsWith(pattern);
  const regex = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return regex.test(model);
}

function matchRule(entries, model) {
  for (const entry of entries) {
    for (const pattern of entry.patterns) {
      if (modelMatches(pattern, model)) return { entry, pattern };
    }
  }
  return null;
}

// 与 resolveThinkingProfile 同序：override 短路 >> EXCEPTIONS >> TAXONOMY >> unknownClass >> 无结论。
// domains = 本仓注释里的出处域名（class 条目 + 规则条目/平台条目的注释），报告的"本仓证据"。
function resolveHandwriting(profiles, presetId, candidates) {
  const provider = profiles.providers.get(presetId);
  const providerDomains = provider?.domains ?? [];
  if (provider?.override) {
    return {
      kind: "override",
      provider,
      rule: provider.override,
      domains: [...new Set([...(provider.override.domains ?? []), ...providerDomains])]
    };
  }
  const names = [...new Set(candidates.map((candidate) => String(candidate).trim().toLowerCase()).filter(Boolean))];
  for (const [table, entries] of [
    ["EXCEPTIONS", profiles.exceptions],
    ["TAXONOMY", profiles.taxonomy]
  ]) {
    for (const name of names) {
      const matched = matchRule(entries, name);
      if (matched) {
        const rule = profiles.classes.get(matched.entry.className);
        return {
          kind: "class",
          via: table,
          pattern: matched.pattern,
          className: matched.entry.className,
          rule,
          evidence: matched.entry,
          domains: [...new Set([...(rule?.domains ?? []), ...(matched.entry.domains ?? []), ...providerDomains])]
        };
      }
    }
  }
  if (provider?.unknownClass) {
    const rule = profiles.classes.get(provider.unknownClass);
    return {
      kind: "class",
      via: "unknownClass",
      pattern: null,
      className: provider.unknownClass,
      rule,
      evidence: provider,
      domains: [...new Set([...(rule?.domains ?? []), ...providerDomains])]
    };
  }
  return { kind: "uncovered", presetKnown: Boolean(provider) };
}

// ───────────────────────────── 分歧判定 ─────────────────────────────

function shapeOf(valueset) {
  if (!valueset) return "无词表";
  const parts = [];
  if (valueset.toggle) parts.push("toggle");
  if (valueset.effort) parts.push(`effort[${valueset.effort.join(",")}]`);
  if (valueset.budget) {
    const min = valueset.budget.min === undefined ? "" : valueset.budget.min;
    const max = valueset.budget.max === undefined ? "" : valueset.budget.max;
    parts.push(`budget_tokens ${min}-${max}`);
  }
  return parts.length > 0 ? parts.join(" + ") : "空词表";
}

function handwritingShapeOf(rule) {
  const parts = [];
  parts.push(`thinkingClass=${rule.thinkingClass}`);
  if (rule.hasOff) {
    parts.push(`off=<${rule.off.fields.join("+")}${rule.off.effort ? ` ${rule.off.effort}` : ""}>`);
  } else {
    parts.push("off=无");
  }
  if (rule.low) parts.push(`low=<${rule.low.effort ?? rule.low.fields.join("+")}>`);
  if (rule.high) parts.push(`high=<${rule.high.effort ?? rule.high.fields.join("+")}>`);
  if (rule.on) parts.push(`on=<${rule.on.fields.join("+")}>`);
  if (!rule.hasTiers) parts.push("档位=无");
  return parts.join("；");
}

function offLabelOf(rule) {
  if (!rule.hasOff) return "无 off";
  if (rule.off.fields.includes("thinking")) return "thinking 开关";
  if (rule.off.fields.includes("enable_thinking")) return "enable_thinking 开关";
  if (rule.off.effort) return `effort ${rule.off.effort}`;
  return rule.off.fields.join("+") || "未知字段";
}

// 手写侧 low/high 的写点描述（"不是分歧"分区用）：开关型 on 是唯一写点，或 low/high 同 effort 值。
function writePointOf(rule) {
  if (rule.on && !rule.low && !rule.high) {
    return `switch on=<${rule.on.fields.join("+")}${rule.on.effort ? ` ${rule.on.effort}` : ""}>`;
  }
  if (rule.low && rule.high && rule.low.effort !== undefined && rule.low.effort === rule.high.effort) {
    return `low/high 同 effort 值 ${rule.low.effort}`;
  }
  return null;
}

// 分歧判据（只对逐模型事实、class 型手写表用；override 平台走平台级分区）。
function compareClasses(hw, upstream) {
  const reasons = [];
  if (hw.hasOff && !upstream.off) {
    reasons.push(`手写声明可关闭（${offLabelOf(hw)}），上游没有 toggle、effort 里也没有 none`);
  }
  if (!hw.hasOff && hw.thinkingClass === "always" && upstream.off) {
    reasons.push(`手写声明关不掉（always），上游有 ${upstream.off === "toggle" ? "toggle" : "effort none"}`);
  }
  if (hw.thinkingClass === "always" && !hw.hasTiers && (upstream.effort || upstream.budget)) {
    reasons.push(`手写未表达任何档位，上游有 ${upstream.effort ? `effort[${upstream.effort.join(",")}]` : "budget_tokens"}`);
  }
  if (hw.tierValues.length > 0 && upstream.effort) {
    const missing = hw.tierValues.filter((value) => !upstream.effort.includes(value));
    if (missing.length > 0) {
      reasons.push(`手写档位值 ${missing.join("/")} 不在上游 effort[${upstream.effort.join(",")}]`);
    }
  }
  if (hw.tierValues.length > 0 && !upstream.effort) {
    reasons.push(
      `手写档位值 ${hw.tierValues.join("/")}（effort），上游词表没有 effort` +
        (upstream.toggle ? "（只有 toggle）" : "")
    );
  }
  if (hw.thinkingClass === "never" && (upstream.toggle || upstream.effort || upstream.budget)) {
    reasons.push("手写声明从不思考（never），上游有词表");
  }
  // "不是分歧"：手写 low/high 共用一个写点（开关型 on 或同 effort 值）而上游没有 effort 词表。
  if (reasons.length === 0 && hw.singleWritePoint && !upstream.effort) {
    return { kind: "note", reasons };
  }
  return reasons.length > 0 ? { kind: "upstream-wins", reasons } : { kind: "agree", reasons };
}

// ───────────────────────────── 对账主流程 ─────────────────────────────

function sortIds(ids) {
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function diffCatalog(snapshot, fresh) {
  const providerIds = [];
  for (const { id } of UPSTREAM_PROVIDERS) providerIds.push(id);
  for (const entry of snapshot) if (!providerIds.includes(entry.id)) providerIds.push(entry.id);
  for (const entry of fresh) if (!providerIds.includes(entry.id)) providerIds.push(entry.id);

  const snapshotById = new Map(snapshot.map((entry) => [entry.id, entry]));
  const freshById = new Map(fresh.map((entry) => [entry.id, entry]));
  const providers = [];
  let changed = 0;
  for (const id of providerIds) {
    const before = snapshotById.get(id);
    const after = freshById.get(id);
    const beforeModels = before ? before.models : {};
    const afterModels = after ? after.models : {};
    const added = sortIds(Object.keys(afterModels).filter((modelId) => !(modelId in beforeModels)));
    const removed = sortIds(Object.keys(beforeModels).filter((modelId) => !(modelId in afterModels)));
    const changes = [];
    for (const modelId of sortIds(Object.keys(afterModels).filter((key) => key in beforeModels))) {
      const left = beforeModels[modelId];
      const right = afterModels[modelId];
      for (const field of KEEP_FIELDS) {
        const leftValue = JSON.stringify(left[field] ?? null);
        const rightValue = JSON.stringify(right[field] ?? null);
        if (leftValue !== rightValue) {
          changes.push({ modelId, field, before: leftValue, after: rightValue });
        }
      }
    }
    if (before && after && before.doc !== after.doc) {
      changes.push({
        modelId: null,
        field: "doc",
        before: JSON.stringify(before.doc ?? null),
        after: JSON.stringify(after.doc ?? null)
      });
    }
    changed += added.length + removed.length + changes.length;
    providers.push({ id, added, removed, changes });
  }
  return { providers, changed };
}

function collectDivergences(options, api, catalogModule, assignmentsModule, profiles) {
  const rows = [];
  const platformRows = new Map();
  let artifactStale = 0;

  for (const { preset, id: providerId } of UPSTREAM_PROVIDERS) {
    const provider = api[providerId];
    if (!provider || typeof provider !== "object" || !provider.models) continue;
    const table = assignmentsModule.assignments.get(providerId) ?? new Map();
    for (const modelId of sortIds(Object.keys(provider.models))) {
      const model = provider.models[modelId];
      if (!model || model.reasoning !== true) continue;
      const hasOptions = Array.isArray(model.reasoning_options) && model.reasoning_options.length > 0;
      const valuesetId = table.get(modelId);
      const valueset = valuesetId ? assignmentsModule.valuesets.get(valuesetId) : null;
      if (hasOptions && !valueset) {
        // 上游有词表、02 产物没有指派 → 产物过期（漂移症状），不算手写表的分歧。
        artifactStale += 1;
        continue;
      }
      const upstream = valueset
        ? {
            toggle: valueset.toggle,
            effort: valueset.effort,
            budget: valueset.budget,
            off: valueset.toggle ? "toggle" : valueset.effort?.includes("none") ? "effort-none" : null
          }
        : null;
      const alias = assignmentsModule.aliasByUpstream.get(`${providerId}\u0000${modelId}`) ?? null;
      const slash = modelId.lastIndexOf("/");
      const candidates = [];
      if (alias) candidates.push(alias.localId);
      candidates.push(modelId);
      if (slash >= 0) candidates.push(modelId.slice(slash + 1));
      const handwriting = resolveHandwriting(profiles, preset, candidates);
      const base = {
        preset,
        providerId,
        modelId,
        lookupId: alias ? alias.localId : modelId,
        alias,
        valuesetId: valuesetId ?? null,
        upstreamShape: shapeOf(valueset),
        upstream,
        valueset,
        handwriting,
        handwritingShape: handwriting.rule ? handwritingShapeOf(handwriting.rule) : "无手写结论",
        lastUpdated: typeof model.last_updated === "string" ? model.last_updated : null,
        doc: catalogModule.upstreams.find((entry) => entry.id === providerId)?.doc ?? null
      };

      if (handwriting.kind === "override") {
        const list = platformRows.get(preset) ?? [];
        list.push(base);
        platformRows.set(preset, list);
        continue;
      }
      if (handwriting.kind === "uncovered") {
        rows.push({ ...base, kind: valueset ? "upstream-new" : "both-absent" });
        continue;
      }
      if (!valueset) {
        rows.push({ ...base, kind: "hand-only", canonical: typeof model.canonical_model_id === "string" ? model.canonical_model_id : null });
        continue;
      }
      const verdict = compareClasses(handwriting.rule, upstream);
      rows.push({ ...base, kind: verdict.kind, reasons: verdict.reasons });
    }
  }
  return { rows, platformRows, artifactStale };
}

// ───────────────────────────── 报告渲染 ─────────────────────────────

function winShapeLabel(row) {
  return row.upstreamShape;
}

function rootCauseKey(row) {
  return `${row.handwriting.className}（${row.handwriting.rule.thinkingClass}）× 上游 ${winShapeLabel(row)}`;
}

function groupRows(rows, keyOf) {
  const groups = [];
  const index = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!index.has(key)) {
      index.set(key, { key, rows: [] });
      groups.push(index.get(key));
    }
    index.get(key).rows.push(row);
  }
  return groups;
}

function renderReport(context) {
  const {
    options,
    capturedAt,
    catalogModule,
    upstreamHash,
    drift,
    problems,
    profileCounts,
    divergences,
    rows
  } = context;
  const wins = rows.filter((row) => row.kind === "upstream-wins");
  const fresh = rows.filter((row) => row.kind === "upstream-new");
  const handOnly = rows.filter((row) => row.kind === "hand-only");
  const notes = rows.filter((row) => row.kind === "note");
  const bothAbsent = rows.filter((row) => row.kind === "both-absent");
  const platformTotal = [...divergences.platformRows.values()].reduce((total, list) => total + list.length, 0);

  const lines = [];
  lines.push("# 03 catalog:check —— 漂移与分歧报告");
  lines.push("");
  lines.push(`- 抓取时间：${capturedAt}（时间戳只在本报告里；产物与 stdout 都不带）`);
  lines.push(`- 上游来源：${DEFAULT_SOURCE}`);
  lines.push(`- 输入：${options.input}`);
  lines.push(`- 仓库快照（01 产物）：${options.catalog}`);
  lines.push(`- 快照 contentHash：${catalogModule.contentHash}`);
  lines.push(`- 上游子集 contentHash：sha256:${upstreamHash}`);
  lines.push(`- 判定：**${drift.changed === 0 && problems.length === 0 ? "in sync" : "DRIFT"}**`);
  lines.push("");
  lines.push("## 0. 口径（本报告怎么算分歧）");
  lines.push("");
  lines.push(
    "- 漂移 = **裁剪后 12 家子集**的 sha256（字段白名单 " +
      `${KEEP_FIELDS.join(" / ")} + 上游 doc）与 01 产物的 contentHash 比对；` +
      "上游其余 200+ provider 变了不算漂移。"
  );
  lines.push(
    "- 分歧单元 = 12 家 × 每个 `reasoning: true` 模型（逐格）。上游侧事实取 02 产物的值集指派" +
      "（含 canonical_model_id 借词与别名表结论）；手写侧事实取 `extension/ai/thinking-profiles.ts` 的" +
      "**文本解析**（本命令不执行仓库代码），解析顺序与 `resolveThinkingProfile` 同：" +
      "`PROVIDERS[preset].override` 短路 >> EXCEPTIONS >> TAXONOMY >> unknownClass >> 无结论。"
  );
  lines.push(
    `- 手写表（文本解析口径）：CLASSES ${profileCounts.classes} / TAXONOMY ${profileCounts.taxonomy} / ` +
      `EXCEPTIONS ${profileCounts.exceptions} / PROVIDERS ${profileCounts.providers}（引用完整性已校验）。`
  );
  lines.push(
    "- 三类：`upstream-wins`（双方都有结论且不相容；Q1=B **上游胜 → 手写表删除候选**，删减归 04 号票）、" +
      "`upstream-new`（上游有词表、手写表未覆盖）、`hand-only`（上游无词表、手写表有结论；**保留**）。"
  );
  lines.push(
    "- **override 型平台**（openrouter / amd / sensenova / opencodego）单列不逐格对比：那四家手写表给的是" +
      "平台级产品裁定（整域只认某种词汇 / 顶层参数透传），与上游逐模型词表不是同一层事实；见 §6。"
  );
  lines.push(
    "- 只读：本命令不改任何仓库文件、不提交快照；`--report` 是唯一输出。分歧清单只是待核对清单，" +
      "处置（删减手写条目）由人决定。"
  );
  lines.push("");

  lines.push("## 1. 漂移（快照 vs 上游）");
  lines.push("");
  if (drift.changed === 0 && problems.length === 0) {
    lines.push(`- **in sync**：12 家子集内容哈希一致（${catalogModule.contentHash}），无需同步。`);
  } else {
    lines.push(`- **DRIFT**：${drift.changed} 处差异 / ${problems.length} 个形状问题。`);
    lines.push(
      "- 先同步：跑 `pnpm catalog:sync:upstream`（必要时 `catalog:sync:thinking`）刷新产物，" +
        "**再**把本报告 §2 的清单当删减依据 —— 漂移时 §2 下面是「提交的旧 02 指派表 vs 当前上游」的比对。"
    );
    lines.push("");
    lines.push("### 逐家差异（快照 → 上游）");
    lines.push("");
    for (const provider of drift.providers) {
      lines.push(
        `- ${provider.id}: 新增 ${provider.added.length} / 移除 ${provider.removed.length} / ` +
          `字段变化 ${provider.changes.length}`
      );
      for (const modelId of provider.added) lines.push(`  - 新增：${provider.id}/${modelId}`);
      for (const modelId of provider.removed) lines.push(`  - 移除：${provider.id}/${modelId}`);
      for (const change of provider.changes) {
        const where = change.modelId === null ? `${provider.id}（provider 级）` : `${provider.id}/${change.modelId}`;
        lines.push(`  - 字段变化：${where} ${change.field}: ${change.before} → ${change.after}`);
      }
    }
    if (problems.length > 0) {
      lines.push("");
      lines.push(`### 上游形状问题（${problems.length}）`);
      lines.push("");
      for (const problem of problems) lines.push(`- ${problem}`);
    }
  }
  if (divergences.artifactStale > 0) {
    lines.push("");
    lines.push(
      `- 产物过期：上游有 reasoning_options 但 02 产物没有指派的有 ${divergences.artifactStale} 条` +
        "（漂移症状；本报告不把它们算作手写表分歧）。"
    );
  }
  lines.push("");

  lines.push(`## 2. upstream-wins（上游胜 → 手写表删除候选）${wins.length} 条 / ${groupRows(wins, rootCauseKey).length} 个根因`);
  lines.push("");
  if (wins.length === 0) {
    lines.push("- 无：手写表与上游逐模型词表没有不相容的格子。");
  }
  groupRows(wins, rootCauseKey).forEach((group, index) => {
    lines.push("");
    lines.push(`### 根因 ${index + 1}：${group.key} —— ${group.rows.length} 条`);
    lines.push("");
    for (const row of group.rows) {
      const aliasText = row.alias
        ? `（**别名 ${row.alias.localId}** → 上游 id \`${row.modelId}\`；本仓口径 id \`${row.alias.localId}\`）`
        : "";
      lines.push(`- **${row.providerId}/${row.modelId}**${aliasText}`);
      lines.push(
        `  - 上游：值集 \`${row.valuesetId}\`（${row.upstreamShape}）；last_updated ${row.lastUpdated ?? "未知"}；` +
          `doc ${row.doc ?? "未知"}`
      );
      const evidence = row.handwriting.evidence;
      const domains = [...(row.handwriting.domains ?? []), ...(evidence?.domains ?? [])];
      const uniqueDomains = [...new Set(domains)];
      lines.push(
        `  - 手写：CLASSES.${row.handwriting.className}（经 ${row.handwriting.via}` +
          `${row.handwriting.pattern ? ` 模式 \`${row.handwriting.pattern}\`` : ""} 命中；` +
          `${row.handwritingShape}；出处 ${uniqueDomains.length > 0 ? uniqueDomains.join("、") : "注释里没写域名"}）`
      );
      lines.push(`  - 分歧：${row.reasons.map((reason, position) => `${position + 1}. ${reason}`).join("；")}`);
      lines.push("  - 处置：**删除候选项**（Q1=B 上游胜；删减归 04 号票，本票只报告）");
    }
  });
  lines.push("");

  lines.push(`## 3. upstream-new（上游有词表、手写表未覆盖）${fresh.length} 条`);
  lines.push("");
  if (fresh.length === 0) {
    lines.push("- 无。");
  }
  for (const group of groupRows(fresh, (row) => row.providerId)) {
    lines.push("");
    lines.push(`### ${group.key}（preset ${group.rows[0].preset}，${group.rows.length} 条）`);
    lines.push("");
    for (const row of group.rows) {
      lines.push(`- **${row.providerId}/${row.modelId}**：上游值集 \`${row.valuesetId}\`（${row.upstreamShape}）；last_updated ${row.lastUpdated ?? "未知"}；doc ${row.doc ?? "未知"}`);
      lines.push(
        `  - 手写侧：EXCEPTIONS / TAXONOMY / unknownClass 都没命中` +
          `${row.handwriting.presetKnown ? "" : "（该 preset 也不在 PROVIDERS 里）"} → 需要新增条目（不是本票的删减范围）`
      );
    }
  }
  lines.push("");

  lines.push(`## 4. hand-only（只有手写表有；保留）${handOnly.length} 条`);
  lines.push("");
  if (handOnly.length === 0) {
    lines.push("- 无。");
  }
  for (const group of groupRows(handOnly, (row) => row.providerId)) {
    lines.push("");
    lines.push(`### ${group.key}（preset ${group.rows[0].preset}，${group.rows.length} 条）`);
    lines.push("");
    for (const row of group.rows) {
      const canonical = row.canonical
        ? `上游有 canonical_model_id=${row.canonical}，它的目标也没有词表`
        : "上游也没有 canonical_model_id / 别名可借";
      lines.push(`- **${row.providerId}/${row.modelId}**：上游 reasoning:true 但无 reasoning_options（缺口；${canonical}）→ **保留**`);
      const evidence = row.handwriting.evidence;
      const domains = [...new Set([...(row.handwriting.domains ?? []), ...(evidence?.domains ?? [])])];
      lines.push(
        `  - 手写：CLASSES.${row.handwriting.className}（经 ${row.handwriting.via}` +
          `${row.handwriting.pattern ? ` 模式 \`${row.handwriting.pattern}\`` : ""} 命中；` +
          `${row.handwritingShape}；出处 ${domains.length > 0 ? domains.join("、") : "注释里没写域名"}）`
      );
    }
  }
  lines.push("");

  lines.push(`## 5. 注记：不是分歧（手写 low/high 同写点、上游无 effort 词表）${notes.length} 条`);
  lines.push("");
  if (notes.length === 0) {
    lines.push("- 无。");
  } else {
    lines.push(
      "- 口径：手写表的 low/high 只经由一个写点表达（开关型 `on`，或 low/high 同 effort 值），" +
        "而上游词表**没有 effort** —— 本仓把 low/high 落成同一份参数（同值塌陷）是唯一形状，不是档位分歧。"
    );
    for (const group of groupRows(notes, rootCauseKey)) {
      lines.push("");
      lines.push(`### ${group.key} —— ${group.rows.length} 条`);
      lines.push("");
      lines.push(`- 判定：**不是分歧**。上游无 effort 档位可对标（${group.rows[0].upstreamShape}），塌陷是唯一形状。`);
      const writePoint = writePointOf(group.rows[0].handwriting.rule);
      lines.push(
        `- 手写侧：low/high 共用一个写点${writePoint ? `（${writePoint}）` : ""} → 无论哪一档都发同一份参数；` +
          "上游没有 effort 词表可对标，这个「塌陷」就是唯一形状。"
      );
      const budget = group.rows.find((row) => row.valueset?.budget);
      if (budget) {
        const range = budget.valueset.budget;
        const shown = `${range.min === undefined ? "" : `min=${range.min} `}${range.max === undefined ? "" : `max=${range.max}`}`.trim();
        lines.push(
          `- 上游仍声明 budget_tokens（${shown}）而本仓在 Messages 通道落固定 budget：budget **数值**是平台侧归一取舍` +
            "（spec 决策 11 的折叠层），同样不是档位分歧。"
        );
      }
      lines.push(`- 涉及模型：${group.rows.map((row) => `${row.providerId}/${row.modelId}`).join("、")}`);
    }
  }
  lines.push("");

  const platformGroups = [...divergences.platformRows.entries()];
  lines.push(
    `## 6. 平台级声明（override 平台，不逐格对比）${platformGroups.length} 家 / ${platformTotal} 条`
  );
  lines.push("");
  lines.push(
    "- 口径：这些 preset 的手写表是 **platform-level** 产品裁定（`PROVIDERS.<preset>.override`：整域只认某种词汇、" +
      "或对任何模型透传顶层参数），不是逐模型词表结论。逐格比会产出上百条不可执行的「分歧」，淹没 §2 的删除候选；" +
      "所以这里只给平台级形状 + 上游逐模型形状分布（可见性不降级，人照样能核对）。"
  );
  for (const [preset, list] of platformGroups) {
    const providerId = list[0].providerId;
    const override = list[0].handwriting.rule;
    const shapes = new Map();
    let noVocab = 0;
    for (const row of list) {
      const key = row.valuesetId
        ? `${row.valuesetId}（${row.valueset.label}）`
        : "无词表";
      if (!row.valuesetId) noVocab += 1;
      shapes.set(key, (shapes.get(key) ?? 0) + 1);
    }
    lines.push("");
    lines.push(`### ${preset}（上游 ${providerId}，${list.length} 个 reasoning 模型）`);
    lines.push("");
    lines.push(
      `- 手写平台级：\`${override.name}\`（${handwritingShapeOf(override)}；` +
        `出处 ${override.domains.length > 0 ? override.domains.join("、") : "注释里没写域名"}）`
    );
    lines.push(
      `- 上游逐模型形状分布：${[...shapes.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .map(([shape, count]) => `${count} × ${shape}`)
        .join(" / ")}（其中无词表 ${noVocab}）`
    );
  }
  lines.push("");

  lines.push("## 7. 双方都无结论");
  lines.push("");
  lines.push(
    `- ${bothAbsent.length} 条：上游是缺口（reasoning:true 无词表）且手写表也没命中 —— 两边都没事实，不是分歧；` +
      "列出来只为可见性。"
  );
  for (const row of bothAbsent) {
    lines.push(`  - ${row.providerId}/${row.modelId}（preset ${row.preset}）`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    "生成：`pnpm catalog:check`（scripts/check-models-dev-catalog.mjs）。本命令只读；同一份输入重跑，" +
      "除本报告标题块那一处时间戳外逐字节相同。"
  );
  return `${lines.join("\n")}\n`;
}

// ───────────────────────────── 主流程 ─────────────────────────────

function summaryLines(context) {
  const { drift, problems, rows, profileCounts, options } = context;
  const wins = rows.filter((row) => row.kind === "upstream-wins").length;
  const fresh = rows.filter((row) => row.kind === "upstream-new").length;
  const handOnly = rows.filter((row) => row.kind === "hand-only").length;
  const notes = rows.filter((row) => row.kind === "note").length;
  const bothAbsent = rows.filter((row) => row.kind === "both-absent").length;
  const platform = [...context.divergences.platformRows.values()].reduce((total, list) => total + list.length, 0);
  const drifted = drift.changed > 0 || problems.length > 0;

  const lines = [];
  lines.push(
    drifted
      ? `check-models-dev-catalog: DRIFT（上游 12 家子集内容哈希与仓库快照不同；${drift.changed} 处差异 / ${problems.length} 个形状问题）`
      : "check-models-dev-catalog: in sync（上游 12 家子集内容哈希与仓库快照一致）"
  );
  lines.push(`  上游来源: ${DEFAULT_SOURCE}`);
  lines.push(`  输入: ${options.input}`);
  lines.push(`  快照: ${options.catalog}`);
  lines.push(`  快照 contentHash: ${context.catalogModule.contentHash}`);
  lines.push(`  上游 contentHash: sha256:${context.upstreamHash}`);
  if (drifted) {
    lines.push("  逐家差异（快照 → 上游）:");
    for (const provider of drift.providers) {
      lines.push(
        `    ${provider.id}: 新增 ${provider.added.length} / 移除 ${provider.removed.length} / ` +
          `字段变化 ${provider.changes.length}`
      );
    }
  }
  lines.push(
    `  分歧: upstream-wins=${wins} / upstream-new=${fresh} / hand-only=${handOnly}` +
      `（+ 注记 ${notes} / 平台级 ${platform} / 双方都无 ${bothAbsent} / 产物过期 ${context.divergences.artifactStale}）`
  );
  lines.push(
    `  手写表: CLASSES ${profileCounts.classes} / TAXONOMY ${profileCounts.taxonomy} / ` +
      `EXCEPTIONS ${profileCounts.exceptions} / PROVIDERS ${profileCounts.providers}`
  );
  lines.push(`  报告: ${options.report}`);
  lines.push(
    drifted
      ? "  exit: 1（drift —— 先跑 pnpm catalog:sync:upstream 同步产物，再把报告当删减依据）"
      : "  exit: 0（in sync；upstream-wins 清单仍需人核对，删减归 04 号票）"
  );
  return lines;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { text } = await readInput(options.input);

  let api;
  try {
    api = JSON.parse(text);
  } catch (error) {
    fail(`输入不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!api || typeof api !== "object" || Array.isArray(api)) {
    fail(`输入顶层不是 provider 表（${options.input}）。`);
  }

  const catalogModule = parseCatalogModule(readTextFile(options.catalog), options.catalog);
  const assignmentsModule = parseAssignmentsModule(readTextFile(options.assignments), options.assignments);
  const profiles = parseProfilesModule(readTextFile(options.profiles), options.profiles);

  const { upstreams, problems } = cropForCheck(api);
  const upstreamHash = hashCatalog(upstreams);
  const drift = diffCatalog(catalogModule.upstreams, upstreams);
  const divergences = collectDivergences(options, api, catalogModule, assignmentsModule, profiles);
  const capturedAt = new Date().toISOString();

  const context = {
    options,
    capturedAt,
    catalogModule,
    upstreamHash,
    drift,
    problems,
    profileCounts: profiles.counts,
    divergences,
    rows: divergences.rows
  };

  const reportPath = path.resolve(rootDir, options.report);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, renderReport(context));

  const lines = summaryLines(context);
  console.log(lines.join("\n"));
  process.exit(drift.changed > 0 || problems.length > 0 ? EXIT_DRIFT : EXIT_IN_SYNC);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
