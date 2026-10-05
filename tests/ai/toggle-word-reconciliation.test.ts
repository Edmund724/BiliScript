// tests/ai/toggle-word-reconciliation.test.ts
// 票 toggle-shape-registration/02：开关词在两处字面的**测试期静态对账**——事实层的形状表
// （extension/ai/thinking-profiles.ts 的 UPSTREAM_TOGGLE_SHAPES）与写法层的两张出口表
// （extension/ai/thinking-wire-map.ts 的 MESSAGES_OFF_EXIT / MESSAGES_ON_EXIT）逐平台逐侧
// 比「这个词是什么」：一侧改了词、另一侧没跟 → 红。
//
// 为什么需要第三条防线：两侧各自有测试（thinking-wire-map.test.ts / thinking-upstream-facts.test.ts），
// 但都只管自己那一层的语义；「同一平台的同一个开关词两处抄了两遍」没有任何静态绑定，
// 漏改一处只表现为线上请求体悄悄漂移。本文件只加对账、不改运行时；写法层仍是零运行时
// import 的纯叶（对账在测试期读两张表，写法层不反向依赖形状表）。
//
// ## 对账口径（票面之外的判准，逐条修正见票的 Comments「2026-10-05 落地注记」）
// 1. 域 = 形状表**登记了形状**的平台（今天 7 家 × off/on = 14 格）。
// 2. 比的是**词载荷**不是表示形状：形状侧用 openaiVocabularyFields 把中转词汇
//    （ThinkingVocabulary 判别联合）摊成词字段；出口侧把出口格摊成该通道实际发出的词字段
//    （word → fields；native / 未研究 / 缺格 → 协议原生词；silent → 不发）。
// 3. 判据两态：
//    - **同词**：形状词住在 Anthropic 原生 thinking 词汇里（kind = thinkingType）时，两侧词字段
//      必须逐字相等（native 格的原生词就是形状词；word 格必须抄同一个词）。
//    - **有据的原生替换**：形状词是别的方言（enableThinking / reasoningEffort）时，Messages
//      通道按 ADR-0014 决定 2 全局归一成协议原生词——这是**登记过的分歧**（ADR-0014「后果」
//      节点名的正是 qwen），不是冲突；但必须 ① 出口格不是平台自有词格（不许给 Messages 通道
//      发明 enable_thinking 字段）、② 进下面的分歧账，改动要红。
// 4. 出口格是 unresearched / 表外默认（含缺格）→ **不算词不一致冲突**，进「单侧有据、对侧
//    未研究」注记账（今天为空；非空时必须先在这里登记再改）。
//
// ## 先列失败方式（每条都有对应用例）
//   ① 对账漏平台：循环按硬编码平台清单跑，形状表新增平台却不进对账 → 「对账域自检」钉 7 家 / 14 格；
//   ② 口径不对导致**恒真**（这类对账最大的失败方式）：直接比 vocabulary 对象、或比字段名
//      （enable_thinking 与 thinking 永远不等）而不是词载荷 → 全量用 openaiVocabularyFields 摊词，
//      并用合成错词反向自检判据真的会红；
//   ③ 词载荷解析错：word 格不看 fields、native / unresearched / 缺格混成同一态 → 四态各自取值；
//   ④ unresearched 被误判成词冲突（口径 4）→ 注记账 + 机制自检；
//   ⑤ 有据的原生替换被当成冲突（口径 3）或反之被静默放过 → 分歧账逐格钉住；
//   ⑥ 形状侧缺词 / 空词 / 哨兵被当成「有词可对」→ 对账域自检 + 哨兵反向自检。
// ⑤ 的另一半是**测试期造不出的漂移**（「改一处」这个动作在运行时不存在）：除合成错词自检外，
//    落地时用人工实验把真表里的词临时改掉验证过本文件真的会红（见票的 Comments）。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  UPSTREAM_TOGGLE_SHAPES,
  UNKNOWN_VOCABULARY,
  enableThinking,
  thinkingType,
  type ThinkingVocabulary
} from "../../extension/ai/thinking-profiles.js";
import {
  MESSAGES_OFF_EXIT,
  MESSAGES_ON_EXIT,
  openaiVocabularyFields
} from "../../extension/ai/thinking-wire-map.js";

type ToggleSide = "off" | "on";
const SIDES: readonly ToggleSide[] = ["off", "on"];

// Messages 通道在「原生」出口上发出的词（出口格 native / 未研究 / 缺格；与 thinking-wire-map
// 的 off 分支 ④ 支和 onThinkingFields 的原生回退逐字一致）。它是本文件的**比对基准**，
// 不是第二份事实：比对只回答「出口格声明的是不是这个协议原生词」。
const MESSAGES_NATIVE_WORD: Readonly<Record<ToggleSide, Record<string, unknown>>> = {
  off: { thinking: { type: "disabled" } },
  on: { thinking: { type: "enabled" } }
};

/** 出口格需要的结构（两张出口表的公共面；off 表多 silent/reason，on 表多 word/fields）。 */
interface ExitCellLike {
  kind: string;
  fields?: Record<string, unknown>;
  provenance?: { level: string; source: string };
}

/** 出口格摊成的「该通道实际发出的词」：kind = 格形态（missing = 本表里没有这个格）。 */
interface ExitWord {
  kind: string;
  fields: Record<string, unknown>;
  provenance: string;
}

function exitWordOf(cell: ExitCellLike | undefined, side: ToggleSide): ExitWord {
  if (!cell) return { kind: "missing", fields: {}, provenance: "—" };
  const provenance = cell.provenance?.level ?? "—";
  if (cell.kind === "native") return { kind: "native", fields: MESSAGES_NATIVE_WORD[side], provenance };
  if (cell.kind === "word") return { kind: "word", fields: { ...(cell.fields ?? {}) }, provenance };
  return { kind: cell.kind, fields: {}, provenance };
}

// 对账判据的三种结论 + 冲突（冲突带一句人读的理由，失败时直接进断言消息）。
type WordVerdict =
  | { state: "match"; word: Record<string, unknown> }
  | { state: "dialect-substitution"; platformWord: Record<string, unknown>; messagesWord: Record<string, unknown> }
  | { state: "exit-unresearched" }
  | { state: "conflict"; reason: string };

/** 单格对账：形状词（事实层）↔ 出口格（写法层）。口径见文件头。 */
function reconcileToggleWord(side: ToggleSide, shapeWord: ThinkingVocabulary, cell: ExitWord): WordVerdict {
  if (cell.kind === "missing" || cell.kind === "unresearched") return { state: "exit-unresearched" };
  const shapeWordFields = openaiVocabularyFields(shapeWord);
  if (Object.keys(shapeWordFields).length === 0) {
    return { state: "conflict", reason: `形状词是哨兵/空词（kind=${shapeWord.kind}），没有可对的词载荷` };
  }
  if (cell.kind === "silent") {
    return {
      state: "conflict",
      reason: `形状表登记了 ${side} 词 ${JSON.stringify(shapeWordFields)}，出口表该格却声明「明确不发」（silent）`
    };
  }
  const nativeWord = MESSAGES_NATIVE_WORD[side];
  if (cell.kind === "word") {
    if (shapeWord.kind !== "thinkingType") {
      return {
        state: "conflict",
        reason: `形状词是 ${shapeWord.kind}（不在 Anthropic 原生 thinking 词汇里），出口表却声明了平台自有词 ${JSON.stringify(cell.fields)}——Messages 通道没有这个字段`
      };
    }
    if (JSON.stringify(cell.fields) !== JSON.stringify(shapeWordFields)) {
      return {
        state: "conflict",
        reason: `平台自有词 ${JSON.stringify(cell.fields)} ≠ 形状词 ${JSON.stringify(shapeWordFields)}`
      };
    }
    return { state: "match", word: cell.fields };
  }
  if (cell.kind !== "native") {
    return { state: "conflict", reason: `出口格形态不在登记的四态内：${cell.kind}` };
  }
  // native 格：Messages 通道发协议原生词。
  if (shapeWord.kind === "thinkingType") {
    return JSON.stringify(nativeWord) === JSON.stringify(shapeWordFields)
      ? { state: "match", word: nativeWord }
      : {
          state: "conflict",
          reason: `形状词 ${JSON.stringify(shapeWordFields)} 与 Messages 原生词 ${JSON.stringify(nativeWord)} 不同——该格要么登记为 word（平台自有词），要么订正形状词`
        };
  }
  // 形状词不在 Messages 通道的词汇里（enable_thinking / reasoning_effort）：ADR-0014 决定 2 的全局归一。
  return { state: "dialect-substitution", platformWord: shapeWordFields, messagesWord: nativeWord };
}

interface ReconciledRow {
  key: string;
  platform: string;
  side: ToggleSide;
  verdict: WordVerdict;
  /** 出口格形态与 provenance 等级（审计列：分歧账里逐格钉住）。 */
  exitKind: string;
  provenance: string;
}

/** 全量对账：形状表**登记了形状**的每个平台 × off/on。 */
function reconcileAll(): ReconciledRow[] {
  const rows: ReconciledRow[] = [];
  for (const platform of Object.keys(UPSTREAM_TOGGLE_SHAPES).sort()) {
    const shape = UPSTREAM_TOGGLE_SHAPES[platform];
    for (const side of SIDES) {
      const shapeWord = shape?.[side] ?? UNKNOWN_VOCABULARY;
      const cell = (side === "off" ? MESSAGES_OFF_EXIT[platform] : MESSAGES_ON_EXIT[platform]) as ExitCellLike | undefined;
      const exitWord = exitWordOf(cell, side);
      rows.push({
        key: `${platform}.${side}`,
        platform,
        side,
        verdict: reconcileToggleWord(side, shapeWord, exitWord),
        exitKind: exitWord.kind,
        provenance: exitWord.provenance
      });
    }
  }
  return rows;
}

const PLATFORMS = ["deepseek", "mimo", "minimax", "modelscope", "moonshot", "qwen", "zhipu"];

describe("开关词两处字面的静态对账（形状表 ↔ Messages 出口表）", () => {
  it("对账域自检：形状表 7 家 × off/on = 14 格都真的被对到，且形状词都带载荷（防循环空转/漏平台）", () => {
    expect(Object.keys(UPSTREAM_TOGGLE_SHAPES).sort()).toEqual(PLATFORMS);
    for (const platform of PLATFORMS) {
      const shape = UPSTREAM_TOGGLE_SHAPES[platform];
      expect(shape, `${platform} 在形状表里登记为空形状`).toBeTruthy();
      for (const side of SIDES) {
        const word = openaiVocabularyFields(shape![side]);
        expect(Object.keys(word).length, `${platform}.${side} 的形状词摊不出词载荷`).toBeGreaterThan(0);
      }
    }
    const rows = reconcileAll();
    expect(rows).toHaveLength(14);
    expect(rows.map((row) => row.key)).toEqual(PLATFORMS.flatMap((platform) => SIDES.map((side) => `${platform}.${side}`)));
  });

  it("逐平台逐侧：形状词载荷 ≡ 出口表发出的词载荷（同词，或登记过的原生替换）；冲突即红", () => {
    const rows = reconcileAll();
    const conflicts = rows.flatMap(({ key, verdict }) =>
      verdict.state === "conflict" ? [`${key}：${verdict.reason}`] : []
    );
    expect(conflicts).toEqual([]);

    const matched = rows.flatMap(({ key, verdict }) =>
      verdict.state === "match" ? [`${key}=${JSON.stringify(verdict.word)}`] : []
    );
    const substitutions = rows.flatMap(({ key, verdict }) =>
      verdict.state === "dialect-substitution" ? [key] : []
    );
    const unresearched = rows.flatMap(({ key, verdict }) => (verdict.state === "exit-unresearched" ? [key] : []));
    // 计数是**口径自检**：循环若空转 / 跳过某态，这里先红（14 = 8 同词 + 6 原生替换 + 0 未研究）。
    expect({ matched: matched.length, substitutions: substitutions.length, unresearched: unresearched.length }).toEqual({
      matched: 8,
      substitutions: 6,
      unresearched: 0
    });

    // 同词侧的逐格取值：形状词与出口词逐字相同（minimax 的 adaptive 这一格正是本票的动因）。
    expect(matched).toEqual([
      'deepseek.off={"thinking":{"type":"disabled"}}',
      'deepseek.on={"thinking":{"type":"enabled"}}',
      'minimax.off={"thinking":{"type":"disabled"}}',
      'minimax.on={"thinking":{"type":"adaptive"}}',
      'moonshot.off={"thinking":{"type":"disabled"}}',
      'moonshot.on={"thinking":{"type":"enabled"}}',
      'zhipu.off={"thinking":{"type":"disabled"}}',
      'zhipu.on={"thinking":{"type":"enabled"}}'
    ]);
  });

  it("跨方言替换逐格钉住：enable_thinking 三家的 Messages 侧是**有据的原生替换**（ADR-0014 决定 2）", () => {
    const substitutions = reconcileAll().flatMap(({ key, exitKind, provenance, verdict }) =>
      verdict.state === "dialect-substitution"
        ? [{ key, exitKind, provenance, platformWord: verdict.platformWord, messagesWord: verdict.messagesWord }]
        : []
    );
    // 分歧账 = 可审清单：这三家（qwen / mimo / modelscope）的开关词在 OpenAI 通道是
    // enable_thinking，Messages 通道按决定 2 归一成原生 thinking——ADR-0014「后果」节
    // 点名的 qwen 就是这一格。任何一侧改了词，下面的逐格取值先红。
    expect(substitutions).toEqual([
      {
        key: "mimo.off",
        exitKind: "native",
        provenance: "推断",
        platformWord: { enable_thinking: false },
        messagesWord: { thinking: { type: "disabled" } }
      },
      {
        key: "mimo.on",
        exitKind: "native",
        provenance: "推断",
        platformWord: { enable_thinking: true },
        messagesWord: { thinking: { type: "enabled" } }
      },
      {
        key: "modelscope.off",
        exitKind: "native",
        provenance: "实测",
        platformWord: { enable_thinking: false },
        messagesWord: { thinking: { type: "disabled" } }
      },
      {
        key: "modelscope.on",
        exitKind: "native",
        provenance: "推断",
        platformWord: { enable_thinking: true },
        messagesWord: { thinking: { type: "enabled" } }
      },
      {
        key: "qwen.off",
        exitKind: "native",
        provenance: "推断",
        platformWord: { enable_thinking: false },
        messagesWord: { thinking: { type: "disabled" } }
      },
      {
        key: "qwen.on",
        exitKind: "native",
        provenance: "文档",
        platformWord: { enable_thinking: true },
        messagesWord: { thinking: { type: "enabled" } }
      }
    ]);
  });

  it("「单侧有据、对侧未研究」的格子显式注记（口径 4：不算词冲突，但出现时必须先登记）", () => {
    const annotated = reconcileAll().flatMap(({ key, exitKind, verdict }) =>
      verdict.state === "exit-unresearched" ? [`${key}（出口格=${exitKind}）`] : []
    );
    // 今天为空：形状表 7 家在两张出口表里都有明确表态的格。非空 = 有人给某平台登记了形状、
    // 但没（或只以 unresearched/缺格）在出口表表态——**不是词冲突**，而是必须登记进本清单的
    // 「待研究」注记（新增平台不在 PROVIDERS 键空间时，姊妹表的键集对账抓不到它）。
    expect(annotated).toEqual([]);
    // 机制自检：缺格 / unresearched 走的是注记账，而不是被误判成词漂移。
    expect(reconcileToggleWord("off", thinkingType("disabled"), { kind: "missing", fields: {}, provenance: "—" }).state).toBe(
      "exit-unresearched"
    );
    expect(
      reconcileToggleWord("off", thinkingType("disabled"), { kind: "unresearched", fields: {}, provenance: "推断" }).state
    ).toBe("exit-unresearched");
  });

  it("判据非恒真：故意改词 / 错形态都被判冲突，真格仍按两态落判", () => {
    // 词漂移 A：形状 adaptive（平台自有词）而出口格声明 native（= 改回原生 enabled）→ 红。
    expect(
      reconcileToggleWord("on", thinkingType("adaptive"), { kind: "native", fields: {}, provenance: "文档" }).state
    ).toBe("conflict");
    // 词漂移 B：word 格的载荷与形状词不同（adaptive 被写成 enabled）→ 红。
    expect(
      reconcileToggleWord("on", thinkingType("adaptive"), {
        kind: "word",
        fields: { thinking: { type: "enabled" } },
        provenance: "文档"
      }).state
    ).toBe("conflict");
    // 替换侧被反向漂移：形状 enable_thinking，出口格却给 Messages 通道发明同名词 → 红。
    expect(
      reconcileToggleWord("off", enableThinking(false), {
        kind: "word",
        fields: { enable_thinking: false },
        provenance: "推断"
      }).state
    ).toBe("conflict");
    // 形状登记了词、出口声明不发 → 红（今天是 stepfun / amd 的形态，它们没登记形状，故不入域）。
    expect(
      reconcileToggleWord("off", thinkingType("disabled"), { kind: "silent", fields: {}, provenance: "文档" }).state
    ).toBe("conflict");
    // 形状词是哨兵（没有词可对）→ 红，而不是被当成「同词」。
    expect(
      reconcileToggleWord("off", UNKNOWN_VOCABULARY, { kind: "native", fields: {}, provenance: "文档" }).state
    ).toBe("conflict");
    // 正向对照（证明上面的判据不是恒假）：minimax.on 的真格 = 同词；qwen.off 的真格 = 原生替换。
    expect(
      reconcileToggleWord("on", UPSTREAM_TOGGLE_SHAPES.minimax!.on, exitWordOf(MESSAGES_ON_EXIT.minimax, "on")).state
    ).toBe("match");
    expect(
      reconcileToggleWord("off", UPSTREAM_TOGGLE_SHAPES.qwen!.off, exitWordOf(MESSAGES_OFF_EXIT.qwen, "off")).state
    ).toBe("dialect-substitution");
  });

  it("对账只在测试期：写法层仍是零运行时 import 的纯叶（不许为对账运行期读形状表）", () => {
    // 票面硬约束：thinking-wire-map.ts 是纯叶（SW 静态图安全），对账不得逼它运行期读事实层。
    // 判据 = 它引用 thinking-profiles 的每一行都是 `import type`（对账靠本文件的两张表比对）。
    const stripped = readFileSync("extension/ai/thinking-wire-map.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const referencing = stripped
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("thinking-profiles.js"));
    expect(referencing.length, "扫描空转：写法层根本没引用事实层").toBeGreaterThan(0);
    for (const line of referencing) {
      expect(line.startsWith("import type"), `非 type-only 引用：${line}`).toBe(true);
    }
  });
});
