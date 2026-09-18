// ai/protocol-vocab.ts — 平台协议词表叶（CONTEXT.md「平台协议」）。
// 纯叶模块：零运行时依赖，合法值清单的唯一来源（multi-protocol-ai）。
// 词表消费者（normalize 校验、设置 UI）只 import 本叶，不拖入分发表
// PROTOCOL_ADAPTERS 及其 adapters/thinking-profiles/sse-parser 依赖。
// 分发表键必须覆盖本词表（protocol-adapter.ts 以 Record<AiProtocol, ...>
// 注解强制），单源，禁止第二份词表。

export const AI_PROTOCOLS = ["openai", "anthropic", "responses"] as const;

export type AiProtocol = (typeof AI_PROTOCOLS)[number];
