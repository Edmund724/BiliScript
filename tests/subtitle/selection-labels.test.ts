// 字幕「来源 + 语言」标签投影（2026-09 用户决议）：
//   - 三种来源在 meta 行与字幕轨下拉里说同一套词：人工上传 / B站 AI 识别 /
//     自配平台转写（平台名不再出现在任何字幕标签里）；
//   - 语言先归一：B 站 AI 轨的 lanDoc 自带「（自动生成）」这类机器尾巴，剥掉后
//     再拼括号，避免「（自动生成）（AI）」双标；
//   - isAi 判定（lan 前缀 ai-）此前全仓无测试覆盖，本文件首次锁真分支。

import { describe, expect, it } from "vitest";
import {
  buildAsrSubtitleLabel,
  buildSubtitleSourceLabel,
  isAiSubtitle,
  isAsrSubtitle,
  normalizeSubtitleLanguageLabel
} from "../../extension/subtitle/selection.js";

describe("normalizeSubtitleLanguageLabel：AI 尾巴归一", () => {
  it("剥掉中文括号的「（自动生成）/（AI生成）/（AI 识别）」", () => {
    expect(normalizeSubtitleLanguageLabel("中文（自动生成）")).toBe("中文");
    expect(normalizeSubtitleLanguageLabel("中文（AI生成）")).toBe("中文");
    expect(normalizeSubtitleLanguageLabel("英文（AI 识别）")).toBe("英文");
  });

  it("剥掉半角括号的「(AI)」", () => {
    expect(normalizeSubtitleLanguageLabel("中文 (AI)")).toBe("中文");
    expect(normalizeSubtitleLanguageLabel("中文(AI)")).toBe("中文");
  });

  it("非 AI 尾巴不动：中文（简体）", () => {
    expect(normalizeSubtitleLanguageLabel("中文（简体）")).toBe("中文（简体）");
  });

  it("无尾巴与空值", () => {
    expect(normalizeSubtitleLanguageLabel("中文")).toBe("中文");
    expect(normalizeSubtitleLanguageLabel("")).toBe("");
    expect(normalizeSubtitleLanguageLabel(undefined)).toBe("");
    expect(normalizeSubtitleLanguageLabel(null)).toBe("");
  });
});

describe("isAiSubtitle / isAsrSubtitle：轨道身份判定", () => {
  it("ai- 前缀（ai-zh/ai-en）判 AI", () => {
    expect(isAiSubtitle({ lan: "ai-zh" })).toBe(true);
    expect(isAiSubtitle({ lan: "ai-en" })).toBe(true);
    expect(isAiSubtitle({ lan: "AI-ZH" })).toBe(true);
  });

  it("人工轨（zh-CN/en）不是 AI", () => {
    expect(isAiSubtitle({ lan: "zh-CN" })).toBe(false);
    expect(isAiSubtitle({ lan: "en" })).toBe(false);
    expect(isAiSubtitle({ lan: "" })).toBe(false);
    expect(isAiSubtitle(null)).toBe(false);
  });

  it("asr- 前缀判本扩展转写，且不算 AI", () => {
    expect(isAsrSubtitle({ lan: "asr-zh" })).toBe(true);
    expect(isAsrSubtitle({ lan: "asr-auto" })).toBe(true);
    expect(isAsrSubtitle({ lan: "ai-zh" })).toBe(false);
    expect(isAsrSubtitle({ lan: "zh-CN" })).toBe(false);
    expect(isAsrSubtitle(undefined)).toBe(false);
  });
});

describe("buildAsrSubtitleLabel：本扩展转写的来源串", () => {
  it("语言档位 zh/en 附中文/英文", () => {
    expect(buildAsrSubtitleLabel("zh")).toBe("自配平台转写（中文）");
    expect(buildAsrSubtitleLabel("en")).toBe("自配平台转写（英文）");
  });

  it("auto/空值不附语言（宁缺勿猜）", () => {
    expect(buildAsrSubtitleLabel("auto")).toBe("自配平台转写");
    expect(buildAsrSubtitleLabel("")).toBe("自配平台转写");
    expect(buildAsrSubtitleLabel(undefined)).toBe("自配平台转写");
  });
});

describe("buildSubtitleSourceLabel：meta 行的「字幕：」值", () => {
  it("人工轨：人工上传（中文）", () => {
    expect(buildSubtitleSourceLabel({ id: "1", lan: "zh-CN", lanDoc: "中文" })).toBe("人工上传（中文）");
  });

  it("B站 AI 轨：B站 AI 识别（中文），语言尾巴已归一", () => {
    expect(buildSubtitleSourceLabel({ id: "2", lan: "ai-zh", lanDoc: "中文（自动生成）" })).toBe(
      "B站 AI 识别（中文）"
    );
  });

  it("ASR 伪轨：lanDoc 是生成时定型的显示串，原样采用", () => {
    expect(buildSubtitleSourceLabel({ id: "asr", lan: "asr-zh", lanDoc: "自配平台转写（中文）" })).toBe(
      "自配平台转写（中文）"
    );
    expect(buildSubtitleSourceLabel({ id: "asr", lan: "asr-auto", lanDoc: "自配平台转写" })).toBe(
      "自配平台转写"
    );
  });

  it("轨道缺失：退回归一后的原始语言值（分类不了就不编来源）", () => {
    expect(buildSubtitleSourceLabel(null, "中文（自动生成）")).toBe("中文");
    expect(buildSubtitleSourceLabel(undefined, "中文")).toBe("中文");
    expect(buildSubtitleSourceLabel(null, "")).toBe("");
  });
});
