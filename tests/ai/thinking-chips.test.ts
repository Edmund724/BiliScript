// tests/ai/thinking-chips.test.ts
// 票据 06（upstream-model-facts/06）：面板档位 chip 的集合来源 —— 只渲染「该模型
// 实际可用的档位」，来源三层（① 上游逐模型词表 ② 借词类默认 ③ 回落今日口径；
// override 平台单列），off 独立成 chip、上游 none 不产生 chip。
//
// 2026-10-04 用户裁定（本文件的核心语义）：**A' = 上游逐模型词表 ∩ 平台线格式可表达集**
// 既是 chip 集合又是 clamp 的可用集；全局偏好不迁移，逐模型向下取，实发档 = 有效档。
//
// 本文件是 **resolver 侧**的守护（UI 侧在 tests/reader/chat-model-panel.test.ts 与
// tests/reader/chat-tab-thinking-hint.test.ts）：chip 集合 = resolveThinkingAdjustment()
// .availableLevels（= availableLevelsOf(rule)），与请求落线同一次解析；source 字段是
// 同一次解析按来源分层的审计列（三层来源清单的列，不是 chip 的第二套推导）。
//
// 先列系统可能失败的方式（每条都有对应用例）：
//   1. chip 集合变成第二套推导（显示某档而请求不发 / 请求发某档而 chip 里没有）；
//   2. A' 算错：上游词表与平台可表达集只取一侧（上游有 max 就显示 max，或平台声明
//      三档就显示三档），或交集之外还留着写点；
//   3. 三层来源判错（上游命中记成手写兜底 / override 记成上游）→ 清单审计失真；
//   4. 上游 `none` 被物化成档位（产生 "None" chip）；off 不是独立 chip；
//   5. off 可用性判错：toggle 有开关形状、effort 含 none、两者都无（关不掉）；
//   6. minimax-m3（厂商文档：关不掉）被填成默认三档 → 显示了请求不发的选择；
//   7. 未登记词表 / 无结论的模型仍显示档位 chip；
//   8. 无上游平台（ollama / custom）不再回落今日三档；
//   9. A' 与偏好的「向下兼容」例外格（A' = ∅ 而平台声明非空）被静默吞掉；
//  10. 06-chip-source.tsv / 06-chip-sets.tsv / 06-chip-changes.tsv 与解析结果漂移。

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AI_THINKING_LEVELS,
  PROVIDERS,
  availableLevelsOf,
  resolveThinkingAdjustment,
  resolveThinkingProfile,
  ruleFromUpstreamFact,
  upstreamVocabularyOf,
  type ThinkingLevel,
  type ThinkingRuleSource
} from "../../extension/ai/thinking-profiles.js";
import { lookupThinkingFact } from "../../extension/ai/catalog/models-dev-thinking.generated.js";
import { THINKING_LEVEL_LABELS } from "../../extension/reader/chat-model-panel.js";

const DEEPSEEK_URL = "https://api.deepseek.com/v1";
const ZHIPU_URL = "https://open.bigmodel.cn/api/paas/v4";
const KIMI_URL = "https://api.kimi.com/coding/v1";
const QWEN_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const MINIMAX_URL = "https://api.minimaxi.com/v1";
const OPENROUTER_URL = "https://openrouter.ai/api/v1";
const OPENCODEGO_URL = "https://opencode.ai/zen/go/v1";
const SENSENOVA_URL = "https://token.sensenova.cn/v1";
const AMD_URL = "https://developer.amd.com.cn/radeon/api/v1";
const OLLAMA_URL = "http://localhost:11434/v1";
const CUSTOM_URL = "https://api.example.com/v1";

function adjustment(presetId: string, baseUrl: string, model: string, level = "off") {
  return resolveThinkingAdjustment({ presetId, baseUrl, model, level, stream: true });
}

function sent(presetId: string, baseUrl: string, model: string, level: ThinkingLevel) {
  return resolveThinkingProfile({ presetId, baseUrl, model, level, stream: true });
}

// 平台声明档位（override 表；无 override 的 preset 返回 null）。
function platformLevelsOf(presetId: string): readonly ThinkingLevel[] | null {
  const override = PROVIDERS[presetId]?.override;
  if (!override) return null;
  return AI_THINKING_LEVELS.filter((level) => Boolean(override.levels[level]));
}

describe("chip 集合 = A'（与请求落线同源，不是第二套推导）", () => {
  it("集合内每档都发得出去；集合外的档位绝不会被原样发出", () => {
    const samples: ReadonlyArray<[string, string, string]> = [
      ["deepseek", DEEPSEEK_URL, "deepseek-v4-pro"],
      ["zhipu", ZHIPU_URL, "glm-5.2"],
      ["qwen", QWEN_URL, "glm-5.2"],
      ["qwen", QWEN_URL, "qwen3.8-max"],
      ["sensenova", SENSENOVA_URL, "glm-5.2"]
    ];
    for (const [presetId, baseUrl, model] of samples) {
      const adj = adjustment(presetId, baseUrl, model);
      for (const level of AI_THINKING_LEVELS) {
        const response = sent(presetId, baseUrl, model, level);
        const at = `${presetId}/${model} 偏好 ${level}`;
        if (adj.availableLevels.includes(level)) {
          expect(Object.keys(response.fields).length, at).toBeGreaterThan(0);
        } else {
          expect(JSON.stringify(response.fields).includes(`"${level}"`), `${at} 不该被原样发出`).toBe(false);
        }
      }
    }
  });

  it("空可用集 = 逐档都不发（qwen 的上游缺口 qwq-32b：手写 always，无档位写点）", () => {
    const adj = adjustment("qwen", QWEN_URL, "qwq-32b");
    expect(adj.availableLevels).toEqual([]);
    expect(adj.effectiveLevel).toBeNull();
    for (const level of AI_THINKING_LEVELS) {
      expect(sent("qwen", QWEN_URL, "qwq-32b", level).fields, level).toEqual({});
    }
  });

  it("只显示存在的档位：qwen3.8-max 的 chip 里没有 High（偏好 high 被 clamp 到 medium）", () => {
    const adj = adjustment("qwen", QWEN_URL, "qwen3.8-max", "high");
    expect(adj.availableLevels).toEqual(["off", "low", "medium", "xhigh"]);
    expect(adj.effectiveLevel).toBe("medium");
    expect(adj.reason).toBe("model-vocabulary");
  });

  it("开关型模型（上游词表只有 toggle）仍显示全 7 档：zhipu/glm-4.6 的 on 写点服务所有非 off 档", () => {
    expect(adjustment("zhipu", ZHIPU_URL, "glm-4.6").availableLevels).toEqual([...AI_THINKING_LEVELS]);
  });
});

describe("A' = 上游词表 ∩ 平台可表达集（2026-10-04 用户裁定）", () => {
  const cases: Array<[string, string, string, readonly string[], ThinkingRuleSource]> = [
    // ---- ① 上游逐模型词表（非 override 平台：写点集天然等于 A'）----
    ["deepseek", DEEPSEEK_URL, "deepseek-v4-pro", ["off", "low", "high", "max"], "upstream"],
    ["zhipu", ZHIPU_URL, "glm-4.6", ["off", "minimal", "low", "medium", "high", "xhigh", "max"], "upstream"],
    ["zhipu", ZHIPU_URL, "glm-5.2", ["high", "max"], "upstream"],
    // canonical 优先（13 号票）：k3 的 canonical（无 toggle）成为词表主人 → off 不再可得。
    ["moonshot", KIMI_URL, "kimi-k3", ["low", "high", "max"], "upstream"],
    // ---- ② 借词（qwen 的 glm-5.2 借 zhipuai/glm-5.2 的 high-max）----
    ["qwen", QWEN_URL, "glm-5.2", ["high", "max"], "upstream"],
    // ---- ③ 无上游平台 / 上游缺口（今日口径）----
    ["ollama", OLLAMA_URL, "llama3.2", ["off", "low", "high"], "handwritten"],
    ["custom", CUSTOM_URL, "deepseek-v4-pro", ["off", "low", "high"], "handwritten"],
    ["moonshot", KIMI_URL, "kimi-k2.7-code", [], "handwritten"],
    ["custom", CUSTOM_URL, "vendor-future-1", [], "unknown"],
    // ---- 平台级裁定平台：A' = 平台声明 ∩ 上游词表（本裁定的主战场）----
    // toggle-only 上游：非 off 域整体可表达 → A' = 平台两档（canonical 优先后模型侧不再有 off，
    // 见 13 号票「丢 off 照收」）。
    ["openrouter", OPENROUTER_URL, "anthropic/claude-opus-4.5", ["low", "high"], "override"],
    // none-low-medium-high：medium 平台没登记 → 不显示
    ["sensenova", SENSENOVA_URL, "sensenova-6.8-flash-lite", ["off", "low", "high"], "override"],
    // low-medium：平台有 off/high，模型只有 low → A' = {low}
    ["amd", AMD_URL, "Qwen3.8-27B", ["low"], "override"],
    // low-medium-xhigh：同理 A' = {low}
    ["amd", AMD_URL, "Qwen3.8-Flash-Next", ["low"], "override"],
    // toggle+low-medium-xhigh：high/xhigh 不在模型词表 → A' = {low}（max 声明补上也不多显示）
    ["opencodego", OPENCODEGO_URL, "qwen3.8-flash", ["low"], "override"],
    // toggle+low-high-max：上游多出的 max 平台没有 → 不显示（「发不出去」）
    ["openrouter", OPENROUTER_URL, "deepseek/deepseek-v4-pro-0813", ["off", "low", "high"], "override"],
    // low-high-max（模型侧无 off）：平台声明两档也收窄成 {low, high}
    ["openrouter", OPENROUTER_URL, "z-ai/glm-5.3", ["low", "high"], "override"],
    // high-max（模型侧无 off、无 low）：平台声明补 max 后 → {high, max}
    ["opencodego", OPENCODEGO_URL, "glm-5.2", ["high", "max"], "override"],
    // 13 号票：canonical 优先后 kimi-k3 的模型侧词表是 low/high/max（无 off），平台声明补
    // max → A' = {low, high, max}（不再需要 12 号票的单点裁决镜像）。
    ["opencodego", OPENCODEGO_URL, "kimi-k3", ["low", "high", "max"], "override"],
    // toggle+medium-xhigh：两边只共有 off → chip 只剩 Off
    ["openrouter", OPENROUTER_URL, "prism-ml/ternary-bonsai-2-27b", ["off"], "override"]
  ];

  for (const [presetId, baseUrl, model, levels, source] of cases) {
    it(`${presetId}/${model} → ${source}，chip = {${levels.join(",")}}`, () => {
      const adj = adjustment(presetId, baseUrl, model);
      expect(adj.source).toBe(source);
      expect(adj.availableLevels).toEqual([...levels]);
    });
  }

  it("非 override 平台：写点集 == 上游词表（A' 不改今日口径）", () => {
    const rows: ReadonlyArray<[string, string, string]> = [
      ["deepseek", "deepseek", "deepseek-v4-pro"],
      ["zhipu", "zhipuai", "glm-5.2"],
      ["qwen", "alibaba-cn", "glm-5.2"],
      ["modelscope", "modelscope", "GLM-4.6"],
      ["minimax", "minimax-cn", "MiniMax-M3"]
    ];
    for (const [presetId, upstreamId, model] of rows) {
      const fact = lookupThinkingFact(upstreamId, model);
      expect(fact, `${upstreamId}/${model}`).toBeTruthy();
      const projected = availableLevelsOf(ruleFromUpstreamFact(fact!, presetId));
      expect(adjustment(presetId, "", model).availableLevels, `${presetId}/${model}`).toEqual([...projected]);
      // 且投影 ⊆ 上游词表（A' 的模型侧约束对非 override 行同样成立）
      const vocabulary = new Set(upstreamVocabularyOf(fact!));
      for (const level of projected) {
        expect(vocabulary.has(level), `${presetId}/${model} · ${level}`).toBe(true);
      }
    }
  });

  it("override 平台：A' 同时 ⊆ 上游词表与 ⊆ 平台声明（逐格交集，不取单侧）", () => {
    const rows: ReadonlyArray<[string, string, string]> = [
      ["openrouter", "openrouter", "mistralai/mistral-medium-3-5"],
      ["openrouter", "openrouter", "deepseek/deepseek-v4-pro-0813"],
      ["openrouter", "openrouter", "z-ai/glm-5.3"],
      ["opencodego", "opencode-go", "hy4-preview"],
      ["opencodego", "opencode-go", "deepseek-v4-flash"],
      ["sensenova", "sensenova", "glm-5.2"],
      ["amd", "amd", "Qwen3.8-Flash-Next"]
    ];
    for (const [presetId, upstreamId, model] of rows) {
      const fact = lookupThinkingFact(upstreamId, model);
      expect(fact, `${upstreamId}/${model}`).toBeTruthy();
      const vocabulary = new Set(upstreamVocabularyOf(fact!));
      const platformLevels = new Set(platformLevelsOf(presetId) ?? []);
      const levels = adjustment(presetId, "", model).availableLevels;
      for (const level of levels) {
        expect(vocabulary.has(level), `${presetId}/${model} · ${level} 不在上游词表`).toBe(true);
        expect(platformLevels.has(level), `${presetId}/${model} · ${level} 不在平台声明`).toBe(true);
      }
    }
  });
});

describe("off / none 分离（决策 #7）", () => {
  it("off 永远独立成 chip：最多一次、永远排第一", () => {
    const samples: ReadonlyArray<[string, string, string]> = [
      ["deepseek", DEEPSEEK_URL, "deepseek-v4-pro"],
      ["zhipu", ZHIPU_URL, "glm-5.2"],
      ["ollama", OLLAMA_URL, "llama3.2"],
      ["qwen", QWEN_URL, "glm-5.2"],
      ["minimax", MINIMAX_URL, "MiniMax-M3"]
    ];
    for (const [presetId, baseUrl, model] of samples) {
      const levels = adjustment(presetId, baseUrl, model).availableLevels;
      expect(levels.filter((level) => level === "off").length, `${presetId}/${model}`).toBeLessThanOrEqual(1);
      if (levels.includes("off")) {
        expect(levels[0], `${presetId}/${model}`).toBe("off");
      }
    }
  });

  it("上游 none 不物化成档位（sensenova-6.8-flash-lite 的 none-low-medium-high：off 走 effort none，无 none 档位）", () => {
    const fact = lookupThinkingFact("sensenova", "sensenova-6.8-flash-lite");
    expect(fact?.effort).toContain("none");
    const projection = ruleFromUpstreamFact(fact!, "sensenova");
    expect(projection.off).toEqual({ fields: { reasoning_effort: "none" } });
    expect(projection.low).toEqual({ fields: { reasoning_effort: "low" } });
    expect(projection.high).toEqual({ fields: { reasoning_effort: "high" } });
    expect(projection["none" as never]).toBeUndefined();
    expect(adjustment("sensenova", SENSENOVA_URL, "sensenova-6.8-flash-lite").availableLevels).not.toContain("none");
  });

  it("off 可用性三形态：toggle 有开关形状可用 / effort 含 none 可用 / 两者都无则关不掉", () => {
    // toggle + 平台登记了开关形状（zhipu → thinking.type）
    expect(adjustment("zhipu", ZHIPU_URL, "glm-4.6").availableLevels).toContain("off");
    // effort 含 none（上游 none-high 值集 → 关思考是线值 none）
    expect(adjustment("openrouter", OPENROUTER_URL, "mistralai/mistral-medium-3-5").availableLevels).toContain("off");
    // effort 不含 none 且无 toggle → off 不可用
    expect(adjustment("zhipu", ZHIPU_URL, "glm-5.2").availableLevels).not.toContain("off");
    // 平台声明里有 off，但模型侧没有（opencodego/hy4-preview：上游 none-high 有 off，
    // 平台无 off 写点）→ A' 不含 off，偏好 off 落 high + 关不掉文案通道。
    const boundary = adjustment("opencodego", OPENCODEGO_URL, "hy4-preview", "off");
    expect(boundary.availableLevels).toEqual(["high"]);
    expect(sent("opencodego", OPENCODEGO_URL, "hy4-preview", "off")).toEqual({
      fields: { reasoning_effort: "high" },
      offUnavailable: true,
      offFallback: "low",
      thinkingClass: "always"
    });
  });
});

describe("验收第一条：none/high 类（13 号票 canonical 优先后剩 3 行，双证据）", () => {
  // 上游投影 = {off, high}（模型侧事实）；UI chip = A' = 上游词表 ∩ 平台声明；
  // 偏好 low → 向下取：平台有 off 的行落 off（线上词 none），平台无 off 写点的
  // opencodego 落 high。三件事都用同一个 resolver 示例钉死。
  // 13 号票前这一组是 6 行；canonical 优先后 3 行的 canonical 换成别的词表
  // （sakana/sakana-namazu → toggle、sensenova/glm-5.2 → high-max、
  // sensenova/deepseek-v4-flash → toggle+low-high-max），见下面的补充用例。
  const UPSTREAM_BY_PRESET: Record<string, string> = {
    opencodego: "opencode-go",
    openrouter: "openrouter",
    sensenova: "sensenova"
  };
  const NONE_HIGH: ReadonlyArray<[string, string, string, readonly ThinkingLevel[]]> = [
    ["opencodego", OPENCODEGO_URL, "hy4-preview", ["high"]],
    ["openrouter", OPENROUTER_URL, "mistralai/mistral-medium-3-5", ["off", "high"]],
    ["openrouter", OPENROUTER_URL, "mistralai/mistral-small-2603", ["off", "high"]]
  ];

  it("3 行的上游值集都是 none-high，上游投影恒为 {off, high}（不含 low/medium）", () => {
    expect(NONE_HIGH).toHaveLength(3);
    for (const [presetId, , model] of NONE_HIGH) {
      const provider = UPSTREAM_BY_PRESET[presetId];
      const fact = lookupThinkingFact(provider, model);
      expect(fact?.valuesetId, `${presetId}/${model}`).toBe("none-high");
      const projection = ruleFromUpstreamFact(fact!, provider);
      const levels = AI_THINKING_LEVELS.filter((level) =>
        level === "off" ? Boolean(projection.off) : Boolean(projection[level])
      );
      expect(levels, `${presetId}/${model}`).toEqual(["off", "high"]);
      expect(upstreamVocabularyOf(fact!), `${presetId}/${model}`).toEqual(["off", "high"]);
    }
  });

  it("UI chip = A'（验收第一条：{off,high}，不含 low/medium；opencodego 无 off 写点故 {high}）", () => {
    for (const [presetId, baseUrl, model, levels] of NONE_HIGH) {
      const adj = adjustment(presetId, baseUrl, model);
      expect(adj.source, `${presetId}/${model}`).toBe("override");
      expect(adj.availableLevels, `${presetId}/${model}`).toEqual([...levels]);
      expect(adj.availableLevels).not.toContain("low");
      expect(adj.availableLevels).not.toContain("medium");
    }
  });

  it("偏好 low 的落线格：有 off 写点 → effort none（向下兼容落 none）；无 off → high", () => {
    for (const [presetId, baseUrl, model, levels] of NONE_HIGH) {
      const adj = adjustment(presetId, baseUrl, model, "low");
      const response = sent(presetId, baseUrl, model, "low");
      if (levels.includes("off")) {
        // 全局偏好保留不改写：low 不迁移，只是本模型 clamp 到 off（线上 none）。
        expect(adj.effectiveLevel, `${presetId}/${model}`).toBe("off");
        expect(adj.reason, `${presetId}/${model}`).toBe("model-vocabulary");
        expect(response.fields, `${presetId}/${model}`).toEqual({ reasoning_effort: "none" });
      } else {
        expect(adj.effectiveLevel, `${presetId}/${model}`).toBe("high");
        expect(response.fields, `${presetId}/${model}`).toEqual({ reasoning_effort: "high" });
      }
    }
    // 换回有 low 的正常模型：同一个偏好 low 原样可用（偏好没有被迁移/改写）。
    const normal = adjustment("deepseek", DEEPSEEK_URL, "deepseek-v4-pro", "low");
    expect(normal.effectiveLevel).toBe("low");
    expect(normal.reason).toBeNull();
    expect(sent("deepseek", DEEPSEEK_URL, "deepseek-v4-pro", "low").fields).toEqual({ reasoning_effort: "low" });
  });

  it("13 号票 canonical 优先：另外 3 行的模型侧词表已换（off 得/失按新事实）", () => {
    // openrouter/sakana/sakana-namazu：canonical = toggle → off 保留，low 由不可用变可用。
    const namazu = adjustment("openrouter", OPENROUTER_URL, "sakana/sakana-namazu");
    expect(lookupThinkingFact("openrouter", "sakana/sakana-namazu")?.valuesetId).toBe("toggle");
    expect(namazu.availableLevels).toEqual(["off", "low", "high"]);
    expect(sent("openrouter", OPENROUTER_URL, "sakana/sakana-namazu", "low").fields).toEqual({ reasoning_effort: "low" });
    // sensenova/glm-5.2：canonical = high-max（模型侧无 off）→ off 失去，A' = {high}。
    const glm = adjustment("sensenova", SENSENOVA_URL, "glm-5.2");
    expect(lookupThinkingFact("sensenova", "glm-5.2")?.valuesetId).toBe("high-max");
    expect(glm.availableLevels).toEqual(["high"]);
    expect(sent("sensenova", SENSENOVA_URL, "glm-5.2", "low").fields).toEqual({ reasoning_effort: "high" });
    // sensenova/deepseek-v4-flash：重定向行（canonical → deepseek-flash = toggle+low-high-max
    // → 模型侧 off 走 toggle 形态）→ A' = {off, low, high}（low 由不可用变可用）。
    const flash = adjustment("sensenova", SENSENOVA_URL, "deepseek-v4-flash");
    expect(lookupThinkingFact("sensenova", "deepseek-v4-flash")?.valuesetId).toBe("toggle+low-high-max");
    expect(flash.availableLevels).toEqual(["off", "low", "high"]);
    expect(sent("sensenova", SENSENOVA_URL, "deepseek-v4-flash", "low").fields).toEqual({ reasoning_effort: "low" });
  });
});

describe("minimax-cn/minimax-m3：实际可用集为空（05 的 hand-wins 裁定）", () => {
  // 厂商文档（platform.minimax.cn）确认思考关不掉，上游 `[toggle]` 不可采信；本仓
  // 又没给 minimax 登记开关方言 → 无 off 写点、无 effort 写点 = 一个档位都不显示，
  // off 也不可用（沿用工单 03 的「关不掉思考」提示通道）。
  it("chip 集合为空、off 不可用 → 短版提示通道（offFallback null）", () => {
    const adj = adjustment("minimax", MINIMAX_URL, "MiniMax-M3");
    expect(adj.availableLevels).toEqual([]);
    expect(adj.effectiveLevel).toBeNull();
    expect(adj.source).toBe("upstream");
    const response = sent("minimax", MINIMAX_URL, "MiniMax-M3", "off");
    expect(response.offUnavailable).toBe(true);
    expect(response.offFallback).toBeNull();
    expect(response.fields).toEqual({});
  });

  it("偏好任意档位都不发（不能显示请求根本不发的选择）", () => {
    for (const level of AI_THINKING_LEVELS) {
      expect(sent("minimax", MINIMAX_URL, "MiniMax-M3", level).fields, level).toEqual({});
    }
  });
});

describe("无上游平台仍显示今日三档（ollama / custom）", () => {
  it("ollama：未列模型走手写 unknownClass（ollama-effort）→ {off, low, high}", () => {
    const adj = adjustment("ollama", OLLAMA_URL, "llama3.2");
    expect(adj.source).toBe("handwritten");
    expect(adj.availableLevels).toEqual(["off", "low", "high"]);
  });

  it("ollama：模式表命中的模型按模式表（deepseek-r1:8b → deepseek-reasoner-always，隐藏档位）", () => {
    const adj = adjustment("ollama", OLLAMA_URL, "deepseek-r1:8b");
    expect(adj.source).toBe("handwritten");
    expect(adj.availableLevels).toEqual([]);
  });

  it("custom：模式表命中的模型仍三档；模式表也不命中的模型隐藏档位", () => {
    expect(adjustment("custom", CUSTOM_URL, "gpt-5.1").availableLevels).toEqual(["off", "low", "high"]);
    const unknown = adjustment("custom", CUSTOM_URL, "vendor-future-1");
    expect(unknown.source).toBe("unknown");
    expect(unknown.availableLevels).toEqual([]);
  });
});

describe("边界：A' = ∅ 而平台声明非空（openrouter 5 行，2026-10-04 已裁决 fail-closed）", () => {
  // 上游唯一的档位词平台表达不了（budget-only 值集）→ 交集为空：不显示任何 chip、逐档都
  // 不发（对齐 minimax-m3 的 fail-closed）。2026-10-04 用户裁定（原话：「openrouter 的不发
  // 参数」）：openrouter 的这三行**维持不发参**。13 号票 canonical 优先后，
  // anthropic/claude-haiku-4.5 与 claude-sonnet-4.5 的 canonical 也变成 budget-only →
  // 同样落入 A' = ∅（丢 off 照收 + 不发参），共 5 行。这些格不属于「向下兼容」，已在
  // 06-chip-changes.tsv + 06-report.md §6.1 逐条记录。
  const EMPTY: ReadonlyArray<[string, string, string]> = [
    ["openrouter", OPENROUTER_URL, "google/gemini-2.5-pro"],
    ["openrouter", OPENROUTER_URL, "google/gemini-2.5-pro-preview"],
    ["openrouter", OPENROUTER_URL, "qwen/qwen3-next-80b-a3b-thinking"],
    ["openrouter", OPENROUTER_URL, "anthropic/claude-haiku-4.5"],
    ["openrouter", OPENROUTER_URL, "anthropic/claude-sonnet-4.5"]
  ];

  it("5 行 chip 为空、逐档都不发（平台声明非空也不再照发）", () => {
    for (const [presetId, baseUrl, model] of EMPTY) {
      const adj = adjustment(presetId, baseUrl, model);
      expect(adj.availableLevels, `${presetId}/${model}`).toEqual([]);
      expect(adj.effectiveLevel, `${presetId}/${model}`).toBeNull();
      for (const level of AI_THINKING_LEVELS) {
        expect(sent(presetId, baseUrl, model, level).fields, `${presetId}/${model} · ${level}`).toEqual({});
      }
    }
  });
});

describe("canonical 优先（13 号票）：opencodego/kimi-k3 = 平台声明 ∩ canonical 词表", () => {
  // 12 号票的单点裁决（ADJUDICATED_MODEL_RULES，按 kimi 官方 k3 方言发参）随 13 号票删除：
  // canonical 优先后 kimi-k3 的模型侧词表就是 low/high/max（上游 canonical 的 toggle 已不在），
  // 平台声明补 max 后 A' = {low, high, max}——不再需要跨平台镜像。
  it("chip 集合 = {low, high, max}，来源层 = override（不再走裁决短路）", () => {
    const adj = adjustment("opencodego", OPENCODEGO_URL, "kimi-k3");
    expect(adj.source).toBe("override");
    expect(adj.availableLevels).toEqual(["low", "high", "max"]);
  });

  it("逐档落线（chat 通道）：off 关不掉 → 级联落 low；low/high/max → 顶层 reasoning_effort", () => {
    const expected: Array<[string, Record<string, unknown>]> = [
      ["off", { reasoning_effort: "low" }],
      ["minimal", { reasoning_effort: "low" }],
      ["low", { reasoning_effort: "low" }],
      ["medium", { reasoning_effort: "low" }],
      ["high", { reasoning_effort: "high" }],
      ["xhigh", { reasoning_effort: "high" }],
      ["max", { reasoning_effort: "max" }]
    ];
    for (const [level, fields] of expected) {
      expect(sent("opencodego", OPENCODEGO_URL, "kimi-k3", level as ThinkingLevel).fields, level).toEqual(fields);
    }
    // off 的级联标记：关不掉（平台没声明 off 写点），落最低可用档。
    const off = sent("opencodego", OPENCODEGO_URL, "kimi-k3", "off");
    expect(off.offUnavailable).toBe(true);
    expect(off.offFallback).toBe("low");
    expect(off.thinkingClass).toBe("always");
  });

  it("与上游 canonical 同源：模型侧词表 == canonical 目标（moonshotai/kimi-k3）的事实", () => {
    // canonical 目标 provider（moonshotai）不在 12 家里，故查表只认本产物的指派。
    expect(lookupThinkingFact("opencode-go", "kimi-k3")?.valuesetId).toBe("low-high-max");
    expect(lookupThinkingFact("opencode-go", "kimi-k3")?.effort).toEqual(["low", "high", "max"]);
    expect(lookupThinkingFact("moonshotai", "kimi-k3")).toBeNull();
    // moonshot（kimi-code-plan-cn）托管的同一个模型也按 canonical（无 toggle）服务。
    expect(adjustment("moonshot", KIMI_URL, "kimi-k3").availableLevels).toEqual(["low", "high", "max"]);
    expect(adjustment("moonshot", KIMI_URL, "kimi-k3").source).toBe("upstream");
  });

  it("范围锁：opencodego 其它模型与其它平台的 kimi 托管行都不受影响", () => {
    const others: Array<[string, readonly string[]]> = [
      ["glm-5.2", ["high", "max"]],
      ["hy4-preview", ["high"]],
      ["qwen3.8-flash", ["low"]],
      ["qwen3.8-max", ["low"]]
    ];
    for (const [model, levels] of others) {
      const adj = adjustment("opencodego", OPENCODEGO_URL, model);
      expect(adj.source, model).toBe("override");
      expect(adj.availableLevels, model).toEqual([...levels]);
    }
    for (const [presetId, baseUrl, model] of [
      ["modelscope", "https://api-inference.modelscope.cn/v1", "kimi-k3"],
      ["qwen", QWEN_URL, "kimi-k3"]
    ] as ReadonlyArray<[string, string, string]>) {
      // 单点裁决层已删除（13 号票）：这两行走手写兜底，不是旧裁决短路。
      expect(["handwritten", "upstream", "unknown"], `${presetId}/${model}`).toContain(
        adjustment(presetId, baseUrl, model).source
      );
    }
  });
});

// ===== 工件对账（清单与解析结果一致；工件缺失时跳过，同 catalog:check 先例）=====
const ARTIFACTS = ".scratch/tickets/upstream-model-facts/artifacts";
const CHIP_SOURCE = `${ARTIFACTS}/06-chip-source.tsv`;
const CHIP_SETS = `${ARTIFACTS}/06-chip-sets.tsv`;
const CHIP_CHANGES = `${ARTIFACTS}/06-chip-changes.tsv`;

interface ChipRow {
  preset: string;
  upstreamProvider: string;
  model: string;
  layer: string;
  upstreamSource: string;
  upstreamValuesetId: string;
  availableLevels: string;
}

function parseTsv(path: string): ChipRow[] {
  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0);
  const header = lines[0].split("\t");
  const cell = (cells: string[], name: string): string => {
    const index = header.indexOf(name);
    return index >= 0 ? cells[index] ?? "" : "";
  };
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    return {
      preset: cell(cells, "preset"),
      upstreamProvider: cell(cells, "upstreamProvider"),
      model: cell(cells, "model"),
      layer: cell(cells, "layer"),
      upstreamSource: cell(cells, "upstreamSource"),
      upstreamValuesetId: cell(cells, "upstreamValuesetId"),
      availableLevels: cell(cells, "availableLevels")
    };
  });
}

function levelsOf(row: ChipRow): string[] {
  return row.availableLevels === "-" || row.availableLevels === "" ? [] : row.availableLevels.split(",");
}

// source（运行期分支）↔ layer（工件的来源分层）：一对多（上游行再分直接 / 借词）。
// 13 号票删掉单点裁决层后剩四层来源（upstream 再分直接 / 借词）。
const SOURCE_TO_LAYER: Record<ThinkingRuleSource, string[]> = {
  upstream: ["upstream-direct", "upstream-borrowed"],
  override: ["platform-override"],
  handwritten: ["fallback-handwritten"],
  unknown: ["fallback-unknown"]
};

describe.skipIf(!existsSync(CHIP_SOURCE) || !existsSync(CHIP_SETS) || !existsSync(CHIP_CHANGES))(
  "06 工件与解析结果一致",
  () => {
    const rows = existsSync(CHIP_SOURCE) ? parseTsv(CHIP_SOURCE) : [];

    it("逐条：清单里的可用集 == resolver 的 A'，层 == resolver 的 source", () => {
      let checked = 0;
      for (const row of rows) {
        const adj = adjustment(row.preset, "", row.model);
        expect(adj.availableLevels, `${row.preset}/${row.model}`).toEqual(levelsOf(row));
        expect(SOURCE_TO_LAYER[adj.source], `${row.preset}/${row.model}`).toContain(row.layer);
        if (row.layer === "upstream-borrowed") {
          expect(row.upstreamSource, `${row.preset}/${row.model}`).not.toBe("");
        }
        checked += 1;
      }
      expect(checked).toBeGreaterThan(300);
    });

    it("A' ⊆ 上游词表（逐条，含 override 行）——这是「只显示实际存在的档位」的机械证据", () => {
      let withFact = 0;
      for (const row of rows) {
        if (!row.upstreamProvider || row.upstreamValuesetId === "-") continue;
        const fact = lookupThinkingFact(row.upstreamProvider, row.model);
        expect(fact, `${row.upstreamProvider}/${row.model}`).toBeTruthy();
        const vocabulary = new Set<string>(upstreamVocabularyOf(fact!));
        for (const level of levelsOf(row)) {
          expect(vocabulary.has(level), `${row.preset}/${row.model} · ${level}`).toBe(true);
        }
        withFact += 1;
      }
      expect(withFact).toBeGreaterThan(300);
    });

    it("13 号票后不再有单点裁决层：opencodego/kimi-k3 走 platform-override，A' = {low,high,max}", () => {
      // 12 号票的 ADJUDICATED_MODEL_RULES 已删除；canonical 优先后该行的模型侧词表就是
      // canonical 的 low/high/max，平台声明补 max 后 A' 恰为这三档（收窄/扩张都不是了）。
      expect(rows.filter((row) => row.layer === "adjudicated")).toHaveLength(0);
      const row = rows.find((candidate) => candidate.preset === "opencodego" && candidate.model === "kimi-k3");
      expect(row?.layer).toBe("platform-override");
      expect(levelsOf(row!)).toEqual(["low", "high", "max"]);
      expect(row?.upstreamValuesetId).toBe("low-high-max");
    });

    it("三层来源每层都非空，借词行的来源是 canonical/alias（逐条 canonical id）", () => {
      const layers = new Map<string, number>();
      for (const row of rows) {
        layers.set(row.layer, (layers.get(row.layer) ?? 0) + 1);
      }
      for (const layer of ["upstream-direct", "upstream-borrowed", "platform-override", "fallback-handwritten", "fallback-unknown"]) {
        expect(layers.get(layer) ?? 0, layer).toBeGreaterThan(0);
      }
      const borrowed = rows.filter((row) => row.layer === "upstream-borrowed");
      expect(borrowed.length).toBeGreaterThan(0);
      expect(
        borrowed.every((row) => row.upstreamSource.startsWith("canonical:") || row.upstreamSource.startsWith("alias:"))
      ).toBe(true);
      // 02 矩阵里标了借词的 7 行（缺口借词；13 号票的 canonical 优先改写仍记 source=direct，
      // 见 13-report.md「已知副作用」——那是 02 矩阵 source 列的既有口径，本票未改）。
      const borrowedFact = rows.filter(
        (row) => row.upstreamSource.startsWith("canonical:") || row.upstreamSource.startsWith("alias:")
      );
      expect(borrowedFact).toHaveLength(7);
    });

    it("chip 集合工件（逐 preset × 代表模型）逐条与解析结果一致，标签表覆盖全部 7 档", () => {
      const sets = parseTsv(CHIP_SETS);
      expect(sets.length).toBeGreaterThan(0);
      for (const row of sets) {
        const adj = adjustment(row.preset, "", row.model);
        expect(adj.availableLevels, `${row.preset}/${row.model}`).toEqual(levelsOf(row));
        for (const level of levelsOf(row)) {
          expect(THINKING_LEVEL_LABELS[level], level).toBeTruthy();
        }
      }
      expect(Object.keys(THINKING_LEVEL_LABELS)).toEqual([...AI_THINKING_LEVELS]);
    });

    it("chip 变化清单（平台声明 → A'）：全部是 platform-override 收窄（裁决扩张行已随 13 号票消失）", () => {
      const changes = parseTsv(CHIP_CHANGES);
      expect(changes.length).toBeGreaterThan(0);
      for (const row of changes) {
        const platformLevels = platformLevelsOf(row.preset);
        expect(platformLevels, row.preset).not.toBeNull();
        // before（平台声明）必须真的不同，否则不该进清单。
        expect(platformLevels!.join(","), `${row.preset}/${row.model}`).not.toBe(levelsOf(row).join(","));
        expect(row.layer, `${row.preset}/${row.model}`).toBe("platform-override");
        for (const level of levelsOf(row)) {
          expect(platformLevels!.includes(level as ThinkingLevel), `${row.preset}/${row.model} · ${level}`).toBe(true);
        }
      }
      // 12 号票的裁决扩张行（opencodego/kimi-k3：平台声明 ⊂ A'）已不存在。
      expect(changes.filter((row) => row.layer === "adjudicated")).toHaveLength(0);
      expect(changes.some((row) => row.preset === "opencodego" && row.model === "kimi-k3")).toBe(false);
    });

    it("清单里没有 none 档位（上游 none 只是 off 的线值实现）", () => {
      for (const row of rows) {
        expect(row.availableLevels).not.toContain("none");
      }
    });
  }
);

// ===== 请求矩阵逐格清单（裁定 #4：变化必须逐格可追溯）=====
const MATRIX_CELLS = `${ARTIFACTS}/06-request-matrix.cells.tsv`;

describe.skipIf(!existsSync(MATRIX_CELLS))("06 请求矩阵逐格变化清单", () => {
  const text = existsSync(MATRIX_CELLS) ? readFileSync(MATRIX_CELLS, "utf8") : "";
  const lines = text.split("\n").filter((line) => line.length > 0);
  const header = lines[0]?.split("\t") ?? [];
  const traceAt = header.indexOf("trace");
  const rows = lines.slice(1).map((line) => line.split("\t"));

  it("每个变化格都能追到 A'：向下兼容落别的档 / A' = ∅ 不发 / 值集换了线形状变（无第四种）", () => {
    const empty = rows.filter((cells) => cells[traceAt].includes("实发 (不发)"));
    const compatible = rows.filter((cells) => !cells[traceAt].includes("实发 (不发)"));
    expect(rows.length).toBeGreaterThan(0);
    expect(empty.length).toBeGreaterThan(0);
    expect(compatible.length).toBeGreaterThan(empty.length);
    // 第三类：偏好档 ∈ A'（没被 clamp，原因=-），字节变化来自**值集换了**（如 toggle 的
    // off 形态、预算区间）；13 号票 canonical 优先后这类格只出现在值集真变了的行上。
    const structureOnly: string[] = [];
    for (const cells of compatible) {
      const trace = cells[traceAt];
      if (trace.includes("原因=-")) {
        structureOnly.push(`${cells[0]}/${cells[1]}`);
        continue;
      }
      // 其余全部是向下兼容：源档 ≠ 实发档，且原因层非空（模型词表 / 平台词表 / 上游未登记）。
      expect(trace, cells.join("\t")).toMatch(
        /实发 (off|minimal|low|medium|high|xhigh|max)｜A'=\{[^}]+\}｜原因=(model-vocabulary|platform-vocabulary|upstream-unlisted)/
      );
    }
    expect([...new Set(structureOnly)].sort()).toEqual([
      "moonshot/kimi-k3",
      "qwen/deepseek-v4-flash",
      "qwen/deepseek-v4-pro"
    ]);
  });

  it("A' = ∅ 的变化格是 openrouter 5 行（已裁决 fail-closed；每行 7 格）", () => {
    const empty = rows.filter((cells) => cells[traceAt].includes("实发 (不发)"));
    const byModel = new Map<string, number>();
    for (const cells of empty) {
      const key = `${cells[0]}/${cells[1]}`;
      byModel.set(key, (byModel.get(key) ?? 0) + 1);
    }
    // 13 号票 canonical 优先后新增两行（claude-haiku-4.5 / claude-sonnet-4.5 的 canonical
    // 是 budget-only）→ A' = ∅ 从 3 行变 5 行，全部维持不发参（丢 off 照收 + fail-closed）。
    expect([...byModel.keys()].sort()).toEqual([
      "openrouter/anthropic/claude-haiku-4.5",
      "openrouter/anthropic/claude-sonnet-4.5",
      "openrouter/google/gemini-2.5-pro",
      "openrouter/google/gemini-2.5-pro-preview",
      "openrouter/qwen/qwen3-next-80b-a3b-thinking"
    ]);
    for (const count of byModel.values()) {
      expect(count).toBe(7);
    }
  });

  it("canonical 优先的逐格证据：moonshot/kimi-k3 相对 06 基线只有 5 格（off 两通道 + 3 个 resolve 标记）", () => {
    // 06 基线里 kimi-k3 的 direct toggle 让 off 可用；canonical 优先后 off 关不掉 →
    // 两通道的 off 格与三个 resolve 标记变，low/high 档位格不变。
    const kimiCells = rows.filter((cells) => `${cells[0]}/${cells[1]}` === "moonshot/kimi-k3");
    expect(kimiCells).toHaveLength(5);
    expect(kimiCells.every((cells) => !cells[traceAt].includes("实发 (不发)"))).toBe(true);
    expect(kimiCells.map((cells) => cells[2]).sort()).toEqual([
      "anthropic:off",
      "openai:off",
      "res:high",
      "res:low",
      "res:off"
    ]);
    // opencodego/kimi-k3 在新旧两侧都是 A' = {low,high}（旧侧裁决词的 off 不在 A'），逐格同值。
    expect(rows.filter((cells) => `${cells[0]}/${cells[1]}` === "opencodego/kimi-k3")).toHaveLength(0);
  });
});
