// ai/adapters/anthropic.ts — Anthropic 协议适配器占位（multi-protocol-ai 第一部分：
// 骨架落地）。已登记注册表，任何调用即抛清晰错误；buildBody/parseResponse/
// drainStream 与限制点 capabilities 在第二部分实现（spec 建议排期，
// 线格式对照 research/anthropic-wire-mapping.md）。
import type { AiProtocol, ProtocolAdapter } from "../protocol-adapter.js";

function notImplemented(protocol: AiProtocol): Error {
  return new Error(`协议 ${protocol} 尚未实现（multi-protocol-ai 排期第二部分/第三部分）`);
}

export const anthropicAdapter: ProtocolAdapter = {
  protocol: "anthropic",
  capabilities: {
    // 占位声明（调用即抛，尚无消费者）：spec 明确 anthropic 支持 tool 双向翻译
    // 与思考档位；真实能力字段在第二部分落地时按 spec「被有意不支持的能力」
    // 逐条核定。
    tools: true,
    thinkingProfiles: true,
    unsupported: {}
  },

  endpoint(): string {
    throw notImplemented("anthropic");
  },
  authHeaders(): Record<string, string> {
    throw notImplemented("anthropic");
  },
  buildBody(): Record<string, unknown> {
    throw notImplemented("anthropic");
  },
  extractErrorDetail(): string {
    throw notImplemented("anthropic");
  },
  drainStream(): Promise<never> {
    throw notImplemented("anthropic");
  },
  parseResponse(): never {
    throw notImplemented("anthropic");
  }
};
