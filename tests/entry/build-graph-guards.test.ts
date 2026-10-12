// 构建图「种子产物不得含禁区」判据（scripts/build-guards.js 的 findForbiddenInputs）：
// build.js 的 ladder chunk 守卫与 build-content.js 的 reader 装载图守卫共用这一份判定。
// 判定收进零依赖叶之后，首次可由合成 metafile 驱动——不必跑真实构建、也不必断言两份
// 脚本正文里的循环字面量。
//
// 锁三件事：
//   1. 被检产物（模块图含种子）命中禁区即报违例，hits 保持禁区书写顺序；
//   2. 不含种子的产物不参与判定（别的 chunk 静态引用禁区不算本守卫的违例）；
//   3. 产物扩展名过滤生效（ladder chunk 看 .js、reader 轮 B 看 .mjs）。

import { describe, expect, it } from "vitest";
import { findForbiddenInputs } from "../../scripts/build-guards.js";

// 与 build.js 的 LADDER_CHUNK_FORBIDDEN_INPUTS 同形（本用例只驱动判据本身，不复制清单）。
const FORBIDDEN = ["notes/render.ts", "subtitle/selection.ts", "core/cache-lru.ts"];

type Meta = { outputs: Record<string, { inputs: Record<string, unknown> }> };

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
});
