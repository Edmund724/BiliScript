import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  UPSTREAM_TOGGLE_SHAPES,
  UNKNOWN_VOCABULARY,
  enableThinking,
  thinkingType,
  type ThinkingVocabulary
} from "../../extension/ai/thinking-profiles.js";
import { isPlatformKey } from "../../extension/ai/platform-identity-vocab.js";
import {
  MESSAGES_OFF_EXIT,
  MESSAGES_ON_EXIT,
  openaiVocabularyFields
} from "../../extension/ai/thinking-wire-map.js";

type ToggleSide = "off" | "on";
const SIDES: readonly ToggleSide[] = ["off", "on"];

const MESSAGES_NATIVE_WORD: Readonly<Record<ToggleSide, Record<string, unknown>>> = {
  off: { thinking: { type: "disabled" } },
  on: { thinking: { type: "enabled" } }
};

interface ExitCellLike {
  kind: string;
  fields?: Record<string, unknown>;
  provenance?: { level: string; source: string };
}

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

type WordVerdict =
  | { state: "match"; word: Record<string, unknown> }
  | { state: "dialect-substitution"; platformWord: Record<string, unknown>; messagesWord: Record<string, unknown> }
  | { state: "exit-unresearched" }
  | { state: "conflict"; reason: string };

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
  if (shapeWord.kind === "thinkingType") {
    return JSON.stringify(nativeWord) === JSON.stringify(shapeWordFields)
      ? { state: "match", word: nativeWord }
      : {
          state: "conflict",
          reason: `形状词 ${JSON.stringify(shapeWordFields)} 与 Messages 原生词 ${JSON.stringify(nativeWord)} 不同——该格要么登记为 word（平台自有词），要么订正形状词`
        };
  }
  return { state: "dialect-substitution", platformWord: shapeWordFields, messagesWord: nativeWord };
}

interface ReconciledRow {
  key: string;
  platform: string;
  side: ToggleSide;
  verdict: WordVerdict;
  exitKind: string;
  provenance: string;
}

function reconcileAll(): ReconciledRow[] {
  const rows: ReconciledRow[] = [];
  for (const platform of Object.keys(UPSTREAM_TOGGLE_SHAPES).sort()) {
    const shape = UPSTREAM_TOGGLE_SHAPES[platform];
    for (const side of SIDES) {
      const shapeWord = shape?.[side] ?? UNKNOWN_VOCABULARY;
      const cell = (
        isPlatformKey(platform)
          ? side === "off"
            ? MESSAGES_OFF_EXIT[platform]
            : MESSAGES_ON_EXIT[platform]
          : undefined
      ) as ExitCellLike | undefined;
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
    expect({ matched: matched.length, substitutions: substitutions.length, unresearched: unresearched.length }).toEqual({
      matched: 8,
      substitutions: 6,
      unresearched: 0
    });

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
    expect(annotated).toEqual([]);
    expect(reconcileToggleWord("off", thinkingType("disabled"), { kind: "missing", fields: {}, provenance: "—" }).state).toBe(
      "exit-unresearched"
    );
    expect(
      reconcileToggleWord("off", thinkingType("disabled"), { kind: "unresearched", fields: {}, provenance: "推断" }).state
    ).toBe("exit-unresearched");
  });

  it("判据非恒真：故意改词 / 错形态都被判冲突，真格仍按两态落判", () => {
    expect(
      reconcileToggleWord("on", thinkingType("adaptive"), { kind: "native", fields: {}, provenance: "文档" }).state
    ).toBe("conflict");
    expect(
      reconcileToggleWord("on", thinkingType("adaptive"), {
        kind: "word",
        fields: { thinking: { type: "enabled" } },
        provenance: "文档"
      }).state
    ).toBe("conflict");
    expect(
      reconcileToggleWord("off", enableThinking(false), {
        kind: "word",
        fields: { enable_thinking: false },
        provenance: "推断"
      }).state
    ).toBe("conflict");
    expect(
      reconcileToggleWord("off", thinkingType("disabled"), { kind: "silent", fields: {}, provenance: "文档" }).state
    ).toBe("conflict");
    expect(
      reconcileToggleWord("off", UNKNOWN_VOCABULARY, { kind: "native", fields: {}, provenance: "文档" }).state
    ).toBe("conflict");
    expect(
      reconcileToggleWord("on", UPSTREAM_TOGGLE_SHAPES.minimax!.on, exitWordOf(MESSAGES_ON_EXIT.minimax, "on")).state
    ).toBe("match");
    expect(
      reconcileToggleWord("off", UPSTREAM_TOGGLE_SHAPES.qwen!.off, exitWordOf(MESSAGES_OFF_EXIT.qwen, "off")).state
    ).toBe("dialect-substitution");
  });

  it("对账只在测试期：写法层仍是零运行时 import 的纯叶（不许为对账运行期读形状表）", () => {
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
