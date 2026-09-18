// ai/protocol-vocab.js 词表叶单测（protocol-vocab-leaf）：
// 词表叶是协议合法值的唯一来源（纯叶、零运行时依赖）；分发表
// PROTOCOL_ADAPTERS 的键必须覆盖词表叶（单源，禁止两份词表）。
// normalize 的词表校验行为（合法值通过、未知值兜底）由
// tests/core/ai-provider-store.normalize.test.js 覆盖。

import { describe, expect, it } from "vitest";
import { AI_PROTOCOLS } from "../../extension/ai/protocol-vocab.js";
import { PROTOCOL_ADAPTERS } from "../../extension/ai/protocol-adapter.js";

describe("AI_PROTOCOLS 词表叶", () => {
  it("合法值清单 = openai / anthropic / responses", () => {
    expect([...AI_PROTOCOLS]).toEqual(["openai", "anthropic", "responses"]);
  });

  it("纯叶：模块源码无 import（零运行时依赖，不拖入分发表/adapters）", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("extension/ai/protocol-vocab.ts", "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
  });

  it("分发表键与词表叶完全一致（单源）", () => {
    expect(Object.keys(PROTOCOL_ADAPTERS).sort()).toEqual([...AI_PROTOCOLS].sort());
  });
});
