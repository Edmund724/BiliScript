// 上游 provider 映射（构建期数据源脚本共享的单源）。
//
// preset → models.dev provider id。**临时单源**：10 号票会把它搬到
// extension/core/presets.ts（那里已有 baseUrl 与 piProvider）。
// spec §preset → 上游 provider 的 11 家按 `api` 字段逐字相同匹配，minimax 是人工
// 裁定的一家（本仓 api.minimaxi.com/v1 与上游 minimax-cn 的
// api.minimax.cn/anthropic/v1 判为同一平台）。ollama（本地）/ custom（用户自填
// 端点）没有上游身份，不进产物。
//
// 顺序 = 产物内键序，固定以保证幂等；不按字母排是为了让产物读者按 spec 的表演表核对。
// 01（UI 目录）与 02（思考事实）共用这一张表：两份产物对「12 家是谁」必须同一口径，
// 各自脚本里再抄一份就是第二个事实源。

export const DEFAULT_SOURCE = "https://models.dev/api.json";

export const UPSTREAM_PROVIDERS = [
  { preset: "deepseek", id: "deepseek" },
  { preset: "qwen", id: "alibaba-cn" },
  { preset: "zhipu", id: "zhipuai" },
  { preset: "moonshot", id: "kimi-code-plan-cn" },
  { preset: "mimo", id: "xiaomi" },
  { preset: "opencodego", id: "opencode-go" },
  { preset: "openrouter", id: "openrouter" },
  { preset: "stepfun", id: "stepfun-step-plan" },
  { preset: "modelscope", id: "modelscope" },
  { preset: "amd", id: "amd" },
  { preset: "sensenova", id: "sensenova" },
  { preset: "minimax", id: "minimax-cn" }
];
