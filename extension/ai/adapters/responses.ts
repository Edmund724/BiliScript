// ai/adapters/responses.ts — Responses API 协议适配器占位（multi-protocol-ai 第一
// 部分：骨架落地）。已登记注册表，任何调用即抛清晰错误；buildBody/parseResponse/
// drainStream 与限制点 capabilities 在第三部分实现（spec 建议排期，
// 线格式对照 research/responses-wire-mapping.md）。
import type { AiProtocol, ProtocolAdapter } from "../protocol-adapter.js";

function notImplemented(protocol: AiProtocol): Error {
  return new Error(`协议 ${protocol} 尚未实现（multi-protocol-ai 排期第二部分/第三部分）`);
}

export const responsesAdapter: ProtocolAdapter = {
  protocol: "responses",
  capabilities: {
    // 占位声明（调用即抛，尚无消费者）：spec 明确 responses 支持 tool 双向翻译
    // 与思考档位（reasoning.effort 改写）；真实能力字段在第三部分落地时按
    // spec「被有意不支持的能力」逐条核定。
    tools: true,
    thinkingProfiles: true,
    unsupported: {}
  },

  endpoint(): string {
    throw notImplemented("responses");
  },
  authHeaders(): Record<string, string> {
    throw notImplemented("responses");
  },
  buildBody(): Record<string, unknown> {
    throw notImplemented("responses");
  },
  extractErrorDetail(): string {
    throw notImplemented("responses");
  },
  drainStream(): Promise<never> {
    throw notImplemented("responses");
  },
  parseResponse(): never {
    throw notImplemented("responses");
  }
};
