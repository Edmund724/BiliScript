// 概览首配错误分类（票 provider-onboarding-consistency/01）：
// - 无平台 / 缺 Key 两个解析期文案精确命中 → 对应设置类目；
// - 其余错误（网络 / 鉴权 / 额度 / 相似但不等的文案）→ null，不伪装成配置问题；
// - provider-handlers 的 re-export 与叶子同源（SW 产生点不漂移）。

import { describe, expect, it } from "vitest";
import {
  classifyOverviewSetupError,
  MISSING_PROVIDER_KEY_MESSAGE,
  NO_ACTIVE_PROVIDER_MESSAGE
} from "../../extension/core/overview-setup-error.js";
import { NO_ACTIVE_PROVIDER_MESSAGE as HANDLERS_REEXPORT } from "../../extension/core/provider-handlers.js";

describe("classifyOverviewSetupError", () => {
  it("无平台文案 → no-provider", () => {
    expect(classifyOverviewSetupError(NO_ACTIVE_PROVIDER_MESSAGE)).toBe("no-provider");
  });

  it("缺 Key 文案 → missing-key", () => {
    expect(classifyOverviewSetupError(MISSING_PROVIDER_KEY_MESSAGE)).toBe("missing-key");
  });

  it("provider-handlers re-export 与叶子同源", () => {
    expect(HANDLERS_REEXPORT).toBe(NO_ACTIVE_PROVIDER_MESSAGE);
  });

  it("非配置类错误 → null", () => {
    expect(classifyOverviewSetupError("模型请求失败")).toBeNull();
    expect(classifyOverviewSetupError("HTTP 401: invalid api key")).toBeNull();
    expect(classifyOverviewSetupError("Insufficient Balance")).toBeNull();
  });

  it("相似但不等的文案不误判（精确匹配，不前缀/不包含）", () => {
    expect(classifyOverviewSetupError(`${NO_ACTIVE_PROVIDER_MESSAGE}（额外说明）`)).toBeNull();
    expect(classifyOverviewSetupError(`概览生成失败：${MISSING_PROVIDER_KEY_MESSAGE}`)).toBeNull();
  });

  it("空值 → null", () => {
    expect(classifyOverviewSetupError("")).toBeNull();
    expect(classifyOverviewSetupError(null)).toBeNull();
    expect(classifyOverviewSetupError(undefined)).toBeNull();
  });
});
