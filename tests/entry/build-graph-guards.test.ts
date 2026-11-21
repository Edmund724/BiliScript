import { describe, expect, it } from "vitest";
import { findForbiddenInputs } from "../../scripts/build-guards.js";

const FORBIDDEN = ["notes/render.ts", "subtitle/selection.ts", "core/cache-lru.ts"];

type Meta = {
  outputs: Record<
    string,
    {
      inputs: Record<string, unknown>;
      imports?: Array<{ path: string; kind: string; external?: boolean }>;
    }
  >;
};

const metaWith = (outputs: Meta["outputs"]): Meta => ({ outputs });

describe("构建图禁区判据（findForbiddenInputs）", () => {
  it("种子产物的模块图命中禁区 → 报违例，hits 按禁区书写顺序", () => {
    const violations = findForbiddenInputs(
      metaWith({
        "entry/chunks/ladder.js": {
          inputs: {
            "extension/ai/ladder.ts": {},
            "extension/core/cache-lru.ts": {},
            "extension/notes/render.ts": {}
          }
        }
      }),
      { seed: "ai/ladder.ts", forbidden: FORBIDDEN, outputExtensions: [".js"] }
    );
    expect(violations).toEqual([
      { output: "entry/chunks/ladder.js", hits: ["notes/render.ts", "core/cache-lru.ts"] }
    ]);
  });

  it("不含种子的产物不参与判定（别的 chunk 引用禁区不算违例）", () => {
    const violations = findForbiddenInputs(
      metaWith({
        "entry/chunks/other.js": { inputs: { "extension/core/cache-lru.ts": {} } }
      }),
      { seed: "ai/ladder.ts", forbidden: FORBIDDEN, outputExtensions: [".js"] }
    );
    expect(violations).toEqual([]);
  });

  it("扩展名过滤：只看 .js 的守卫不判 .mjs 产物，反之亦然", () => {
    const outputs = {
      "entry/chunks/reader.mjs": {
        inputs: { "extension/reader/lifecycle.ts": {}, "extension/ai/analysis.ts": {} }
      }
    };
    expect(
      findForbiddenInputs(metaWith(outputs), {
        seed: "reader/lifecycle.ts",
        forbidden: ["ai/analysis.ts"],
        outputExtensions: [".js"]
      })
    ).toEqual([]);
    expect(
      findForbiddenInputs(metaWith(outputs), {
        seed: "reader/lifecycle.ts",
        forbidden: ["ai/analysis.ts"],
        outputExtensions: [".mjs"]
      })
    ).toEqual([{ output: "entry/chunks/reader.mjs", hits: ["ai/analysis.ts"] }]);
  });

  it("splitting:true 共享 chunk：沿静态 import-statement 传递命中禁区，忽略 dynamic-import", () => {
    const outputs: Meta["outputs"] = {
      "entry/chunks/player-ai.mjs": {
        inputs: { "extension/ai/player-ai.ts": {} },
        imports: [
          { path: "entry/chunks/chunk-shared.mjs", kind: "import-statement" },
          { path: "entry/chunks/player-interpret.mjs", kind: "dynamic-import" }
        ]
      },
      "entry/chunks/chunk-shared.mjs": {
        inputs: { "extension/subtitle/cache.ts": {} },
        imports: []
      },
      "entry/chunks/player-interpret.mjs": {
        inputs: { "extension/live/player-interpret.ts": {}, "extension/ai/l0-bm25.ts": {} },
        imports: []
      }
    };
    expect(
      findForbiddenInputs(metaWith(outputs), {
        seed: "ai/player-ai.ts",
        forbidden: ["live/player-interpret.ts", "subtitle/cache.ts", "ai/l0-bm25.ts"],
        outputExtensions: [".mjs"]
      })
    ).toEqual([{ output: "entry/chunks/player-ai.mjs", hits: ["subtitle/cache.ts"] }]);
  });
});
