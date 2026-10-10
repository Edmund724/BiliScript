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
//     [--aliases <path|none>] [--redirects <path|none>] [--overrides <path|none>]
//     [--off-declarations <path|none>] [--report <path>] [--matrix <path>]
//
//   --input          读本地 api.json 快照（默认直连 https://models.dev/api.json）。
//   --out            产物落点（默认 extension/ai/catalog/models-dev-thinking.generated.ts）。
//   --expect-counts  对账常量，形如 `<模型数>/<reasoning 数>/<有词表数>/<缺口数>/<effort 值集数>`；
//                    只给 fixture 用，生产不许改（改了等于关掉对账）。
//   --aliases        显式别名表（默认脚本里的 MODEL_ID_ALIASES；`none` = 不加载）。
//   --redirects      canonical 重定向表（默认脚本里的 CANONICAL_MODEL_REDIRECTS；`none` = 不加载）。
//   --overrides      值集覆盖表（默认脚本里的 VOCABULARY_OVERRIDES；`none` = 不加载）。
//   --off-declarations 能力补声明表（默认脚本里的 OFF_CAPABILITY_DECLARATIONS；`none` = 不加载）。
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

// canonical 重定向表（13 号票裁定 2）：行的 canonical_model_id 指向上游**并不存在**的 id 时，
// 改借另一条上游记录的词表。取值序见 compileFacts 第一遍：direct 非空时先查 canonical
// （→ 本表 → 目标词表）；本表让悬空指针落到真实存在的目标上。
// 与 MODEL_ID_ALIASES 同纪律：每条必须写清上游依据（可审），生成期逐条 fail-loud 校验
// redirect 目标存在且有 reasoning_options —— 指错等于静默落空，宁可硬错也不猜档位。
const CANONICAL_MODEL_REDIRECTS = [
  {
    canonical: "deepseek/deepseek-v4.1-flash",
    redirect: "deepseek/deepseek-flash",
    reason:
      "上游 deepseek provider 没有 4.1-flash 这个 id（只有 deepseek-flash / deepseek-v4-flash / " +
      "deepseek-v4-flash-vision-exp / deepseek-v4-pro）；用户 2026-10-05 裁定「所有的 " +
      "DeepSeek-v4.1-flash 都可以直接用上游 deepseek provider 的 deepseek-flash 参数」。"
  },
  {
    canonical: "deepseek/deepseek-v4-pro-0813",
    redirect: "deepseek/deepseek-v4-pro",
    reason:
      "上游 deepseek provider 没有 deepseek-v4-pro-0813 这个 id（只有 deepseek-v4-pro，且它自己的 " +
      "canonical_model_id 正是 -0813 —— 上游对这一族统一用带日期后缀的 id 当指针）；" +
      "用户 2026-10-05 裁定加。影响面：3 行，其中只有 sensenova/deepseek-v4-pro 的值集真变" +
      "（toggle+[high,max] → toggle+[low,high,max]，拿回 low）。"
  },
  {
    canonical: "deepseek/deepseek-v4-flash-0731",
    redirect: "deepseek/deepseek-v4-flash",
    reason:
      "上游 deepseek provider 没有 deepseek-v4-flash-0731 这个 id（只有 deepseek-v4-flash，且它自己的 " +
      "canonical_model_id 正是 -0731）；用户 2026-10-05 裁定加。影响面：3 行，其中只有 " +
      "amd/DeepSeek-V4-Flash 的值集真变（effort[none,minimal,low,medium,high,xhigh,max] → " +
      "toggle+[low,high,max]，7 档收窄到 3 档并丢 off）——用户已知悉并接受：与 13 号票已收窄的 " +
      "amd/DeepSeek-V4.1-Flash、amd/DeepSeek-V4-Flash-Vision-Exp 对齐，三兄弟同形。"
  }
];

// 值集覆盖表（19 号票裁定 3）：本仓显式声明「这一行的档位词表主人是另一条上游记录」。
// 与 CANONICAL_MODEL_REDIRECTS 的分工：后者修的是**指针指向**（上游 canonical_model_id 悬空，
// 换到同族真实存在的目标）；本表修的是**这一行归谁**——指针没有、或有但不足以代表该网关事实时。
// 与 MODEL_ID_ALIASES 的分工：别名只对**缺口行**生效（运行期也只在指派表未命中时才查，
// 见 resolveThinkingKey），对已有 direct 词表的行是死条目；本表在有 direct 词表时就生效。
// 取值序（19 号票）：本表 > canonical_model_id（13 号票）> direct —— 本表插在最前，
// 所以「本仓声明的词表主人」压过上游自己写的那一行（两表指向同一条时二者同值，无矛盾）。
// 纪律同前两张表：每条必须写清上游依据（可审），生成期逐条 fail-loud 校验「被覆盖的行确实存在」
// 与「目标存在且有 reasoning_options」——覆盖指错等于静默发错档位，宁可硬错也不猜。
const VOCABULARY_OVERRIDES = [
  {
    key: "opencode-go/deepseek-v4-pro",
    upstream: "deepseek/deepseek-v4-pro",
    reason:
      "上游 opencode-go/deepseek-v4-pro 直挂 effort[high,max]（无 canonical 指针），而同网关三个 " +
      "flash 系兄弟都是 low/high/max，pro 系独缺 low —— 用户查过 opencode.ai 文档未登记思考参数，" +
      "网关侧无从核实，故采信官方 deepseek/deepseek-v4-pro 的 toggle+[low,high,max]（用户 2026-10-05 " +
      "裁定）。登记的反向证据：全上游 30 家登记 deepseek-v4-pro，其中 9 家（含 opencode 自己的 Zen " +
      "网关）写的是 toggle+[high,max]，与 opencode-go 同形 —— 本条与该多数共识相左，是产品判断" +
      "而非上游事实。opencodego 未在 UPSTREAM_TOGGLE_SHAPES 登记开关形状，故值集里的 toggle 不产 " +
      "off 写点：chips 只从 high/max 变 low/high/max，thinkingClass 仍 always、offUnavailable 仍 true。"
  }
];

// 能力补声明表（D1=A2，2026-10-05 用户裁定；本仓第一次「能力补声明」）：本仓显式给**一行**补上
// 它缺失的 off 能力（结构里插一个 {"type":"toggle"}），不改词表主人、不改档位词表。
// 与三张既有表的分工：MODEL_ID_ALIASES 管 id 解析（本仓/历史口径 → 上游 id）、
// CANONICAL_MODEL_REDIRECTS 管**指针指向**（悬空 canonical → 真实目标）、
// VOCABULARY_OVERRIDES 管**归属**（这一行的词表主人是另一条上游记录）；
// **本表是第一次「能力补声明」** —— 词表主人不动（仍是这一行自己，canonical 子行照旧继承），
// 只把它缺失的 off 写点来源补进上游事实，使上游投影与本仓既有口径一致。
// 纪律同前三张表：每条必须写清依据（可审），生成期逐条 fail-loud 校验三件事（见 compileFacts）：
//   ① key 形状合法、存在于快照、reasoning_options 非空；
//   ② 该行**当前不得**已有 toggle —— 上游将来补上就硬报错提醒删除本条（**自退役**）；
//   ③ 增强后的 effort 词表必须等于声明里写的期望值 —— 上游改词表时硬报错，防静默漂移。
const OFF_CAPABILITY_DECLARATIONS = [
  {
    key: "zhipuai/glm-5.2",
    effort: ["high", "max"],
    reason:
      "上游 zhipuai/glm-5.2 的 reasoning_options 只有 effort[high,max]、漏了 {\"type\":\"toggle\"}，" +
      "本仓补上 off 能力（结构增强，不改词表主人）。依据只许引两处：①厂商文档 " +
      "docs.z.ai/guides/capabilities/thinking-mode 只把 GLM-5.3 / 5.3-FLASH 列为不可关闭" +
      "（GLM-5.2 不在其中），docs.bigmodel.cn/cn/guide/capabilities/thinking 里 thinking.type 是 " +
      "GLM-5.2 的原生参数、reasoning_effort 仅 5.2 及以上支持 —— 「按轮开关」是该族既有能力；" +
      "②本仓先例：extension/ai/thinking-profiles.ts 的 CLASSES[\"glm-hybrid-effort\"] 本来就带 " +
      "off:{thinking:{type:\"disabled\"}}，今天只服务目录外 id（同一 zhipu 预设下手填 glm-5.2-air " +
      "能选 Off、目录里的 glm-5.2 不能），本声明让上游投影与它对齐。**不许用「家族 N 行也有 " +
      "toggle」当依据**：中转站会造词面（glm-4.6/glm-4.7 被造出厂商没有的 effort 词），且全库 " +
      "toggle+[high,max] 的 42 行里 37 行是 DeepSeek，不是 GLM-5.2 家族。13 号票 canonical 优先让 " +
      "本行成为全家族词表主人，缺口因此外溢到 alibaba-cn / opencode-go / openrouter / sensenova " +
      "四行；其中只有 zhipu（thinking:{type:\"disabled\"}）与 qwen（enable_thinking:false）已登记 " +
      "开关形状 → 行为 2 行，其余 3 家事实带 toggle 但无写点（裁定 3 不发明新形状，面板逐字节不变）。"
  }
];

// 对账常量（spec §词汇覆盖缺口 + §上游形态，主 agent 复核实测）。不是这些数说明上游
// 内容或路径变了 —— 先确认快照 contentHash 与 spec 记录，再同步本常量与 spec
// （产物事实面由 tests/ai/thinking-upstream-facts.test.ts 逐行钉住）。
// effortSets 是**派生计数**（被引用值集里的 effort 词表去重）：13 号票 canonical 优先后
// effort[max] 只被 opencode-go/kimi-k3 引用，该行改借 canonical 的 low-high-max →
// 值集 "max" 不再登记，故 30 → 29（上游原始 30 种 effort 值集不变，见 spec §上游形态）。
const EXPECTED_COUNTS = {
  models: 578,
  reasoning: 415,
  withOptions: 352,
  gaps: 63,
  effortSets: 29
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
    redirects: null,
    overrides: null,
    offDeclarations: null,
    expectCounts: EXPECTED_COUNTS
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (
      ["--input", "--out", "--report", "--matrix", "--aliases", "--redirects", "--overrides", "--off-declarations", "--expect-counts"].includes(flag)
    ) {
      if (value === undefined) fail(`${flag} 缺参数值`);
      i += 1;
      if (flag === "--input") options.input = value;
      else if (flag === "--out") options.out = value;
      else if (flag === "--report") options.report = value;
      else if (flag === "--matrix") options.matrix = value;
      else if (flag === "--aliases") options.aliases = value;
      else if (flag === "--redirects") options.redirects = value;
      else if (flag === "--overrides") options.overrides = value;
      else if (flag === "--off-declarations") options.offDeclarations = value;
      else options.expectCounts = parseExpectCounts(value);
      continue;
    }
    fail(
      `未知参数 "${flag}"。用法：--input <path|url> --out <path> --aliases <path|none> ` +
        `--redirects <path|none> --overrides <path|none> --off-declarations <path|none> ` +
        `--expect-counts <a/b/c/d/e> --report <path> --matrix <path>`
    );
  }
  return options;
}

// 重定向表来源：默认脚本里的 CANONICAL_MODEL_REDIRECTS（本仓事实，生产路径）；fixture 用
// 小表，`none` = 不加载（同 --aliases 的纪律）。表里的条目生成期逐条校验（见 compileFacts）。
function loadRedirects(option) {
  if (option === null) {
    return CANONICAL_MODEL_REDIRECTS;
  }
  if (option === "none") {
    return [];
  }
  if (!fs.existsSync(option)) {
    fail(`--redirects 指向的文件不存在：${option}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(option, "utf8"));
  } catch (error) {
    fail(`--redirects 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) {
    fail(`--redirects 顶层必须是数组（每条 {canonical, redirect, reason}）。`);
  }
  for (const [index, entry] of parsed.entries()) {
    if (!entry || typeof entry !== "object") {
      fail(`--redirects[${index}] 不是对象。`);
    }
    for (const field of ["canonical", "redirect", "reason"]) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        fail(`--redirects[${index}] 缺非空字符串字段 ${field}（每条 reason 必填，可审）。`);
      }
    }
  }
  return parsed;
}

// 值集覆盖表来源：默认脚本里的 VOCABULARY_OVERRIDES（本仓事实，生产路径）；fixture 用小表，
// `none` = 不加载（只跑 canonical 优先 + direct 回落路径）。表里的条目生成期逐条校验。
function loadOverrides(option) {
  if (option === null) {
    return VOCABULARY_OVERRIDES;
  }
  if (option === "none") {
    return [];
  }
  if (!fs.existsSync(option)) {
    fail(`--overrides 指向的文件不存在：${option}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(option, "utf8"));
  } catch (error) {
    fail(`--overrides 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) {
    fail(`--overrides 顶层必须是数组（每条 {key, upstream, reason}）。`);
  }
  for (const [index, entry] of parsed.entries()) {
    if (!entry || typeof entry !== "object") {
      fail(`--overrides[${index}] 不是对象。`);
    }
    for (const field of ["key", "upstream", "reason"]) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        fail(`--overrides[${index}] 缺非空字符串字段 ${field}（每条 reason 必填，可审）。`);
      }
    }
  }
  return parsed;
}

// 能力补声明表来源：默认脚本里的 OFF_CAPABILITY_DECLARATIONS（本仓事实，生产路径）；fixture
// 用小表，`none` = 不加载（fixture 快照里没有这些行，默认表会触发校验①硬错）。
function loadOffDeclarations(option) {
  if (option === null) {
    return OFF_CAPABILITY_DECLARATIONS;
  }
  if (option === "none") {
    return [];
  }
  if (!fs.existsSync(option)) {
    fail(`--off-declarations 指向的文件不存在：${option}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(option, "utf8"));
  } catch (error) {
    fail(`--off-declarations 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) {
    fail(`--off-declarations 顶层必须是数组（每条 {key, effort, reason}）。`);
  }
  for (const [index, entry] of parsed.entries()) {
    if (!entry || typeof entry !== "object") {
      fail(`--off-declarations[${index}] 不是对象。`);
    }
    for (const field of ["key", "reason"]) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        fail(`--off-declarations[${index}] 缺非空字符串字段 ${field}（每条 reason 必填，可审）。`);
      }
    }
    if (
      !Array.isArray(entry.effort) ||
      entry.effort.length === 0 ||
      entry.effort.some((value) => typeof value !== "string" || value.length === 0)
    ) {
      fail(`--off-declarations[${index}] 缺非空字符串数组字段 effort（声明期望的 effort 词表，防上游静默漂移）。`);
    }
  }
  return parsed;
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
function compileFacts(api, aliases, redirects, overrides, offDeclarations) {
  const valuesets = new Map();
  const structureOf = new Map();
  const gaps = [];
  const counts = { models: 0, reasoning: 0, withOptions: 0, gaps: 0, effortSets: 0 };
  const effortSets = new Set();

  // 上游缺口对账（交接单 §8.4；只报告不改动）：在本行被增强**之前**扫原始快照，回答
  // 「本行缺 toggle/none，但同为 <该模型 id> 的上游行里有多少条有」。口径 = 上游模型 id 含
  // 声明里的模型 id（大小写不敏感，覆盖 openrouter 的 `z-ai/glm-5.2` 与 zai-coding-plan 的
  // `glm-5.2-highspeed` 这类同族写法）。报表专用，不改任何事实、不建规则。
  const offDeclarationGaps = offDeclarations.map((entry) => {
    const parts = splitUpstreamId(entry.key);
    const needle = parts ? parts.modelId.toLowerCase() : entry.key.toLowerCase();
    const rows = [];
    for (const [providerId, provider] of Object.entries(api)) {
      const models = provider && typeof provider === "object" ? provider.models : undefined;
      if (!models || typeof models !== "object") continue;
      for (const [modelId, model] of Object.entries(models)) {
        if (!model || typeof model !== "object") continue;
        if (!modelId.toLowerCase().includes(needle)) continue;
        const options = Array.isArray(model.reasoning_options) ? model.reasoning_options : [];
        rows.push({
          key: `${providerId}/${modelId}`,
          toggle: options.some((option) => option && option.type === "toggle"),
          none: options.some(
            (option) => option && option.type === "effort" && Array.isArray(option.values) && option.values.includes("none")
          )
        });
      }
    }
    return {
      key: entry.key,
      total: rows.length,
      toggle: rows.filter((row) => row.toggle).length,
      none: rows.filter((row) => row.none).length,
      neither: rows.filter((row) => !row.toggle && !row.none).map((row) => row.key)
    };
  });

  // 能力补声明解析（D1=A2）：逐条 fail-loud 校验（见 OFF_CAPABILITY_DECLARATIONS 注释的
  // ① ② ③），校验通过后就地增强快照对象。增强必须发生在逐 provider 循环**之前**：
  // canonical 借词在循环里读 target.reasoning_options，override 表也在循环前解析目标数组。
  const offDeclarationHits = [];
  for (const entry of offDeclarations) {
    const parts = splitUpstreamId(entry.key);
    if (!parts) {
      fail(`能力补声明 key 必须是 "<上游 provider>/<模型 id>"，收到 "${entry.key}"。`);
    }
    const model = api[parts.providerId]?.models?.[parts.modelId];
    if (!model || typeof model !== "object") {
      fail(`能力补声明 ${entry.key}: 快照里没有这个模型（上游删了或改了 id？这条补声明已失效，请删）。`);
    }
    const where = `${entry.key}（能力补声明）`;
    const structure = normalizeOptions(where, model.reasoning_options);
    if (structure.toggle) {
      fail(
        `能力补声明 ${entry.key}: 上游已经补上了 {"type":"toggle"} —— 本条已无必要，请删除（自退役）；` +
          `同时核对--report 的上游缺口对账节是否已归零。`
      );
    }
    if (!structure.effort || structure.effort.join(",") !== entry.effort.join(",")) {
      fail(
        `能力补声明 ${entry.key}: 期望 effort[${entry.effort.join(",")}]，快照里是 ` +
          `${structure.effort ? `effort[${structure.effort.join(",")}]` : "（无 effort 词表）"} —— ` +
          `上游词表变了，先核对厂商文档与 spec，再同步本条。`
      );
    }
    model.reasoning_options = [...model.reasoning_options, { type: "toggle" }];
    const enhanced = normalizeOptions(where, model.reasoning_options);
    offDeclarationHits.push({
      key: entry.key,
      before: `effort[${structure.effort.join(",")}]`,
      after: `toggle+effort[${structure.effort.join(",")}]`,
      valuesetBefore: slugOf(structure),
      valuesetAfter: slugOf(enhanced),
      reason: entry.reason
    });
  }

  // 重定向表解析：逐条 fail-loud 校验目标存在且有词表（见 CANONICAL_MODEL_REDIRECTS 注释）；
  // 同一个 canonical 出现两条也硬错（静默取后者等于表里有条死条目）。key = canonical id。
  const redirectByCanonical = new Map();
  for (const entry of redirects) {
    if (redirectByCanonical.has(entry.canonical)) {
      fail(`canonical 重定向表有重复的 canonical "${entry.canonical}" —— 一条指针只能重定向到一个目标。`);
    }
    const parts = splitUpstreamId(entry.redirect);
    if (!parts) {
      fail(`canonical 重定向表 ${entry.canonical}: redirect 必须是 "<上游 provider>/<模型 id>"，收到 "${entry.redirect}"。`);
    }
    const target = api[parts.providerId]?.models?.[parts.modelId];
    if (!target || typeof target !== "object") {
      fail(`canonical 重定向表 ${entry.canonical} 指向的上游模型不存在：${entry.redirect}（上游改 id 了？）。`);
    }
    const options = target.reasoning_options;
    if (!Array.isArray(options) || options.length === 0) {
      fail(`canonical 重定向表 ${entry.canonical} 指向的 ${entry.redirect} 自己没有 reasoning_options —— 重定向指错了。`);
    }
    redirectByCanonical.set(entry.canonical, entry.redirect);
  }

  // 值集覆盖表解析（19 号票）：本仓声明「被覆盖行的词表主人是另一条上游记录」。
  // 逐条 fail-loud 校验两件事——被覆盖的行确实在快照里（覆盖一个不存在的行 = 表里有条死条目，
  // 上游删了模型也不会有人发现）、目标存在且有 reasoning_options（覆盖指错等于静默发错档位）。
  // 同一个 key 两条也硬错（同 redirect 表的纪律）。
  const overrideByKey = new Map();
  for (const entry of overrides) {
    const keyParts = splitUpstreamId(entry.key);
    if (!keyParts) {
      fail(`值集覆盖表 key 必须是 "<上游 provider>/<模型 id>"，收到 "${entry.key}"。`);
    }
    if (overrideByKey.has(entry.key)) {
      fail(`值集覆盖表有重复的 key "${entry.key}" —— 一行只能有一个词表主人。`);
    }
    const host = api[keyParts.providerId];
    const hostModel = host && typeof host === "object" ? host.models?.[keyParts.modelId] : undefined;
    if (!hostModel || typeof hostModel !== "object") {
      fail(`值集覆盖表 ${entry.key}: 快照里没有这个模型（上游删了或改了 id？这条覆盖已失效，请删）。`);
    }
    const targetParts = splitUpstreamId(entry.upstream);
    if (!targetParts) {
      fail(`值集覆盖表 ${entry.key}: upstream 必须是 "<上游 provider>/<模型 id>"，收到 "${entry.upstream}"。`);
    }
    const target = api[targetParts.providerId]?.models?.[targetParts.modelId];
    if (!target || typeof target !== "object") {
      fail(`值集覆盖表 ${entry.key} 指向的上游模型不存在：${entry.upstream}（上游改 id 了？）。`);
    }
    if (!Array.isArray(target.reasoning_options) || target.reasoning_options.length === 0) {
      fail(`值集覆盖表 ${entry.key} 指向的 ${entry.upstream} 自己没有 reasoning_options —— 覆盖指错了。`);
    }
    overrideByKey.set(entry.key, { ...entry, options: target.reasoning_options });
  }

  // canonical 优先改写（13 号票裁定 1）与回落 direct 的逐行留档（--report 新增节的数据源）。
  const canonicalPriority = [];
  const canonicalFallbacks = [];
  const redirectHits = [];
  const overrideHits = [];
  const overriddenRows = new Map();
  const recordRedirectHit = (key, canonical, target) => {
    redirectHits.push(`${key} ← canonical:${canonical} → ${target}`);
  };

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

      // 值集覆盖优先（19 号票裁定 3，序：覆盖 > canonical > direct）：本仓显式声明了这一行
      // 的词表主人，压过该行自己的 direct，也压过它的 canonical_model_id。命中即整行改写，
      // direct / canonical / 缺口三条路径都不再看这条模型 —— 这正是它与别名表的分工。
      const override = overrideByKey.get(`${providerId}/${modelId}`);
      if (override) {
        const where = `${providerId}/${modelId} ← override:${override.upstream}`;
        rows[modelId] = registerValueset(where, normalizeOptions(where, override.options));
        overrideHits.push(`${providerId}/${modelId} → ${override.upstream} → ${rows[modelId]}`);
        overriddenRows.set(`${providerId}/${modelId}`, override.upstream);
        counts.withOptions += 1;
        stats.assigned += 1;
        continue;
      }

      const options = model.reasoning_options;
      if (Array.isArray(options) && options.length > 0) {
        counts.withOptions += 1;
        stats.assigned += 1;
        // canonical 优先（13 号票裁定 1）：direct 非空时先查 canonical（→ 重定向表 → 目标
        // 词表），命中就用 canonical 的结构 —— 上游给了更宽词表的那一行，canonical 才是词表
        // 主人；direct 的窄词表在命中时不再登记。无指针 / 悬空 / 目标无词表 → 回落 direct
        // （现行行为不变）。
        const canonical = borrowOptions(api, model.canonical_model_id, redirectByCanonical);
        if (canonical) {
          const where = `${providerId}/${modelId} ← canonical:${canonical.from}`;
          rows[modelId] = registerValueset(where, normalizeOptions(where, canonical.options));
          canonicalPriority.push({
            provider: providerId,
            modelId,
            canonical: canonical.redirectedFrom ?? canonical.from,
            target: canonical.from,
            redirected: canonical.redirectedFrom !== null,
            valuesetId: rows[modelId]
          });
          if (canonical.redirectedFrom) {
            recordRedirectHit(`${providerId}/${modelId}`, canonical.redirectedFrom, canonical.from);
          }
          continue;
        }
        rows[modelId] = registerValueset(`${providerId}/${modelId}`, normalizeOptions(`${providerId}/${modelId}`, options));
        if (typeof model.canonical_model_id === "string" && model.canonical_model_id.length > 0) {
          canonicalFallbacks.push({
            provider: providerId,
            modelId,
            canonical: model.canonical_model_id,
            reason: "canonical 悬空（目标不存在或无词表）"
          });
        } else {
          canonicalFallbacks.push({ provider: providerId, modelId, canonical: null, reason: "上游没有 canonical_model_id" });
        }
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
    const canonical = borrowOptions(api, gap.canonical, redirectByCanonical);
    const alias = canonical ? null : aliasByLocal.get(`${gap.provider}\u0000${gap.modelId}`);
    const target = canonical
      ? { from: canonical.from, options: canonical.options, via: "canonical" }
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
    // 重定向表在缺口路径同样生效：from = 真实目标（重定向表命中时重定向事实记进
    // --report 的新节；06 工件的 upstreamSource 列按 "canonical:" 前缀解析）。
    gap.resolution = `${target.via}:${target.from}`;
    if (canonical?.redirectedFrom) {
      recordRedirectHit(`${gap.provider}/${gap.modelId}`, canonical.redirectedFrom, canonical.from);
    }
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
        source: overriddenRows.has(`${providerId}/${modelId}`)
          ? `override:${overriddenRows.get(`${providerId}/${modelId}`)}`
          : gap
            ? gap.resolution
            : "direct",
        valuesetId: typeof valuesetId === "string" ? valuesetId : null,
        valueset: typeof valuesetId === "string" ? valuesets.get(valuesetId) : null
      });
    }
  }

  return {
    valuesets,
    assignments,
    deprecated,
    gaps,
    coverage,
    counts,
    aliases: resolvedAliases,
    matrix,
    canonicalPriority,
    canonicalFallbacks,
    redirectHits,
    redirects,
    overrideHits,
    overrides,
    offDeclarations,
    offDeclarationHits,
    offDeclarationGaps
  };
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

// "<上游 provider id>/<上游模型 id>" 切分：模型 id 本身可含 "/"（如
// cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6），按第一个 "/" 切；形状不合法返回 null。
function splitUpstreamId(id) {
  if (typeof id !== "string" || id.length === 0) {
    return null;
  }
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) {
    return null;
  }
  return { providerId: id.slice(0, slash), modelId: id.slice(slash + 1) };
}

// canonical 借词：canonical_model_id 形如 "<上游 provider id>/<上游模型 id>"（模型 id
// 本身可含 "/"），按第一个 "/" 切。先过 canonical 重定向表（13 号票裁定 2），再查目标。
// 目标 provider 不在快照里 / 没有前缀 / 目标模型本身也没有词表 → 都返回 null（软失败）。
// 返回的 from = 实际借词目标；redirectedFrom = 命中的重定向 key（没命中为 null）。
function borrowOptions(api, canonicalModelId, redirectByCanonical) {
  const redirectedFrom = typeof canonicalModelId === "string" ? redirectByCanonical.get(canonicalModelId) ?? null : null;
  const parts = splitUpstreamId(redirectedFrom ?? canonicalModelId);
  if (!parts) {
    return null;
  }
  const provider = api[parts.providerId];
  const models = provider && typeof provider === "object" ? provider.models : undefined;
  const model = models && typeof models === "object" ? models[parts.modelId] : undefined;
  const options = model && typeof model === "object" ? model.reasoning_options : undefined;
  if (!Array.isArray(options) || options.length === 0) {
    return null;
  }
  return { from: `${parts.providerId}/${parts.modelId}`, options, redirectedFrom };
}

function assertCounts(counts, expected) {
  for (const key of ["models", "reasoning", "withOptions", "gaps", "effortSets"]) {
    if (counts[key] !== expected[key]) {
      fail(
        `${key} 为 ${counts[key]}，对账常量是 ${expected[key]}。上游内容或路径变了 —— ` +
          `先确认上游这份快照（contentHash）与 spec 记录，再同步脚本常量与 spec ` +
          `（产物事实面由 tests/ai/thinking-upstream-facts.test.ts 逐行钉住）。`
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
//       reasoning_options（取值序 19 号票：值集覆盖表 > canonical_model_id（13 号票 canonical
//       优先：direct 非空时也先借 canonical_model_id 的词表，悬空才回落 direct）> direct；
//       canonical 重定向表见 --report 的 canonical 优先节，值集覆盖表见 --report 的值集覆盖节；
//       能力补声明（本仓给一行补 off 写点，先增强上游事实再走同一取值序）见 --report 的本仓补声明节）；
//       ${facts.counts.gaps} 个缺口里 ${borrowedTotal} 个按 canonical_model_id /
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
  // canonical 优先节（13 号票）：改写行数 / 重定向命中行 / 回落 direct 行逐条可追。
  lines.push(
    "",
    `canonical 优先（13 号票）：改写 ${facts.canonicalPriority.length} 行 / 重定向命中 ${facts.redirectHits.length} 行 / ` +
      `回落 direct ${facts.canonicalFallbacks.length} 行`
  );
  lines.push(`  重定向表（${facts.redirects.length}）：`);
  for (const entry of facts.redirects) {
    lines.push(`    ${entry.canonical} → ${entry.redirect}：${entry.reason}`);
  }
  lines.push(`  改写逐行（← canonical → 值集）：`);
  for (const row of facts.canonicalPriority) {
    const via = row.redirected ? `canonical:${row.canonical} → ${row.target}` : `canonical:${row.target}`;
    lines.push(`    ${row.provider}/${row.modelId} ← ${via} → ${row.valuesetId}`);
  }
  lines.push(`  重定向命中逐行（${facts.redirectHits.length}）：`);
  for (const hit of facts.redirectHits) {
    lines.push(`    ${hit}`);
  }
  lines.push(`  回落 direct 逐行（${facts.canonicalFallbacks.length}）：`);
  for (const row of facts.canonicalFallbacks) {
    lines.push(`    ${row.provider}/${row.modelId}（${row.reason}${row.canonical ? `：${row.canonical}` : ""}）`);
  }
  lines.push("", `别名表（${facts.aliases.length}）：`);
  for (const alias of facts.aliases) {
    lines.push(`  ${alias.provider}/${alias.localId} → ${alias.upstream}（值集 ${alias.valuesetId}）：${alias.reason}`);
  }
  // 值集覆盖节（19 号票）：本仓声明的词表主人逐条可追（表内容 + 实际命中的行）。
  lines.push(
    "",
    `值集覆盖（19 号票）：表 ${facts.overrides.length} 条 / 命中 ${facts.overrideHits.length} 行`
  );
  for (const entry of facts.overrides) {
    lines.push(`    ${entry.key} → ${entry.upstream}：${entry.reason}`);
  }
  for (const hit of facts.overrideHits) {
    lines.push(`    命中 ${hit}`);
  }
  // 本仓补声明节（D1=A2）：能力补声明逐条可追（表内容 + 实际命中的行 before/after + 理由）。
  lines.push(
    "",
    `本仓补声明（能力补声明，D1=A2）：表 ${facts.offDeclarations.length} 条 / 命中 ${facts.offDeclarationHits.length} 行`
  );
  for (const hit of facts.offDeclarationHits) {
    lines.push(
      `    ${hit.key}  before: ${hit.before}（值集 ${hit.valuesetBefore}）  after: ${hit.after}（值集 ${hit.valuesetAfter}）`
    );
    lines.push(`      reason: ${hit.reason}`);
  }
  // 上游缺口对账（交接单 §8.4）：只报告不改动 —— 本行缺 toggle/none，但同为该模型的上游行
  // 有多少条有；以及仍缺的行清单。不建规则、不逐条修。
  lines.push("", "上游缺口对账（只报告不改动；交接单 §8.4）：");
  for (const gap of facts.offDeclarationGaps) {
    lines.push(
      `  ${gap.key}：上游同族口径 = 模型 id 含 "${gap.key.slice(gap.key.indexOf("/") + 1)}"（大小写不敏感），共 ${gap.total} 行；` +
        `显式带 toggle ${gap.toggle} 行 / effort 含 none ${gap.none} 行；两者都缺 ${gap.neither.length} 行（含本行，本补声明只修本行）：`
    );
    for (const key of gap.neither) {
      lines.push(`    ${key}`);
    }
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

  const facts = compileFacts(
    api,
    loadAliases(options.aliases),
    loadRedirects(options.redirects),
    loadOverrides(options.overrides),
    loadOffDeclarations(options.offDeclarations)
  );
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
