// defaults.js / validators.js 纯函数归一化测试：
// aiThinkingLevel（思考档位）自 05 号票起是上游词表的 7 档；非法值回落 off。

import { describe, expect, it } from "vitest";
import { normalizeAiThinkingLevel } from "../../extension/core/validators.js";

describe("normalizeAiThinkingLevel", () => {
  it("7 档全部原样保留（off/minimal/low/medium/high/xhigh/max）", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(normalizeAiThinkingLevel(level), level).toBe(level);
    }
  });

  it("非法值（含未定义/空串/上游的 none）回落为 off", () => {
    expect(normalizeAiThinkingLevel("none")).toBe("off");
    expect(normalizeAiThinkingLevel("bogus")).toBe("off");
    expect(normalizeAiThinkingLevel("")).toBe("off");
    expect(normalizeAiThinkingLevel(undefined)).toBe("off");
    expect(normalizeAiThinkingLevel(null)).toBe("off");
  });
});
