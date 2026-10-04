// tests/fixtures/models-dev/check-profiles.ts —— 03 检查脚本 fixture 用的「手写表」小样。
//
// 格式刻意照抄 extension/ai/thinking-profiles.ts 的被解析面：引号 class 键 + 裸 provider
// 键、单行条目（`"x": { thinkingClass: "always" },`）与多行条目混排、行尾注释、注释里
// 写出处域名。解析器必须两种形状都吃，且注释里的域名要能被抄进报告当证据。
//
// 这里只放 fixture 用得到的条目：六个 class、两条例外、四条模式、12 个平台键
// （其中 4 个 override 型）。类型只借真表的（本文件只被 03 的检查脚本按文本读，
// 不会被执行；import type 只为通过 tsc）。
import type { ClassRule, ProviderRule, TaxonomyEntry } from "../../../extension/ai/thinking-profiles.js";

export const CLASSES: Record<string, ClassRule> = {
  // GLM-5.2 起 effort 三档（关闭仍走 thinking 开关）。（docs.bigmodel.cn）
  "fx-glm-effort": {
    thinkingClass: "hybrid",
    off: { fields: { thinking: { type: "disabled" } } },
    low: { fields: { reasoning_effort: "low" } },
    high: { fields: { reasoning_effort: "high" } }
  },
  // glm-5.3 起 disabled 直接报错 → 永远思考，档位无文档化事实。（docs.bigmodel.cn）
  "fx-glm-always": { thinkingClass: "always" },
  // kimi-k3：永远思考 + effort 三档。（platform.kimi.ai）
  "fx-kimi-k3-effort": {
    thinkingClass: "always",
    low: { fields: { reasoning_effort: "low" } },
    high: { fields: { reasoning_effort: "high" } }
  },
  // MiniMax m 系永远思考。（platform.minimax.io）
  "fx-minimax-always": { thinkingClass: "always" },
  // 百炼/托管模型的原生开关词汇。（alibabacloud.com）
  "fx-qwen-switch": {
    thinkingClass: "hybrid",
    off: { fields: { enable_thinking: false } },
    on: { fields: { enable_thinking: true } }
  },
  // Mimo v2 系混合开关。（aliyun.com）
  "fx-mimo-switch": {
    thinkingClass: "hybrid",
    off: { fields: { enable_thinking: false } },
    on: { fields: { enable_thinking: true } }
  }
};

// 例外表：数组序 = 优先级。
export const EXCEPTIONS: readonly TaxonomyEntry[] = [
  // glm-5.3*：disabled 直接报错 → 永远思考。（docs.bigmodel.cn）
  { class: "fx-glm-always", patterns: ["glm-5.3"] },
  // kimi-k3*：永远思考 + effort 三档。（platform.kimi.ai）
  { class: "fx-kimi-k3-effort", patterns: ["kimi-k3"] }
];

export const TAXONOMY: readonly TaxonomyEntry[] = [
  // glm-5.2 先于 glm-5 前缀（数组序 = 优先级）。（docs.bigmodel.cn）
  { class: "fx-glm-effort", patterns: ["glm-5.2"] },
  { class: "fx-minimax-always", patterns: ["minimax-m1", "minimax-m2", "minimax-m3"] },
  { class: "fx-qwen-switch", patterns: ["qwen3-max"] },
  { class: "fx-mimo-switch", patterns: ["mimo-v2"] }
];

export const PROVIDERS: Record<string, ProviderRule> = {
  deepseek: {},      // fixture：按模型定协议（api-docs.deepseek.com）
  qwen: {},          // fixture（alibabacloud.com）
  zhipu: {},         // fixture（docs.bigmodel.cn）
  moonshot: {},      // fixture（platform.kimi.ai）
  minimax: {},       // fixture（platform.minimax.io）
  mimo: { unknownClass: "fx-mimo-switch" },
  openrouter: {
    // override 型：官方顶层合法参数，对任何模型生效。（openrouter.ai/docs）
    override: {
      thinkingClass: "hybrid",
      levels: {
        off: { fields: { reasoning_effort: "none" } },
        low: { fields: { reasoning_effort: "low" } },
        high: { fields: { reasoning_effort: "high" } }
      }
    }
  },
  stepfun: {},       // fixture（platform.stepfun.com）
  modelscope: { unknownClass: "fx-qwen-switch" }, // 托管模型用原生 enable_thinking（modelscope.cn）
  amd: {
    override: {
      thinkingClass: "hybrid",
      levels: {
        off: { fields: { reasoning_effort: "none" } },
        low: { fields: { reasoning_effort: "low" } },
        high: { fields: { reasoning_effort: "high" } }
      }
    }
  },
  sensenova: {
    override: {
      thinkingClass: "hybrid",
      levels: {
        off: { fields: { reasoning_effort: "none" } },
        low: { fields: { reasoning_effort: "low" } },
        high: { fields: { reasoning_effort: "high" } }
      }
    }
  },
  opencodego: {
    override: {
      thinkingClass: "always",
      levels: {
        low: { fields: { reasoning_effort: "low" } },
        high: { fields: { reasoning_effort: "high" } }
      }
    }
  }
};
