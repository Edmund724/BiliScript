// defaults.js / validators.js 纯函数归一化测试：
// aiThinkingLevel（思考档位）自 05 号票起是上游词表的 7 档 + ADR-0015 的 `default`（8 个可选值）。
// 缺省 / 非法值的回退自 2026-10-05 用户裁定起是 **`default`（不干预）**——存储侧与请求侧
// 同一条归一化（extension/ai/thinking-levels.ts；裁决记录见 docs/adr/0015 的 2026-10-05 修订块），
// 此前回落 `off`（= 把「没有偏好」读成「显式关思考」）。

import { describe, expect, it } from "vitest";
import { normalizeAiThinkingLevel } from "../../extension/core/validators.js";

describe("normalizeAiThinkingLevel", () => {
  it("8 个可选值全部原样保留（default/off/minimal/low/medium/high/xhigh/max）", () => {
    for (const level of ["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(normalizeAiThinkingLevel(level), level).toBe(level);
    }
  });

  it("缺省 / 非法值（含未定义/空串/上游的 none）回落为 default", () => {
    expect(normalizeAiThinkingLevel("none")).toBe("default");
    expect(normalizeAiThinkingLevel("bogus")).toBe("default");
    expect(normalizeAiThinkingLevel("")).toBe("default");
    expect(normalizeAiThinkingLevel(undefined)).toBe("default");
    expect(normalizeAiThinkingLevel(null)).toBe("default");
  });
});
