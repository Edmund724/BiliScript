import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSsePayload } from "../../extension/ai/sse-parser.js";
import { chatCompletion } from "../../extension/ai/completion.js";
import type { StreamChatEvent } from "../../extension/ai/types.js";

const PROVIDER = { baseUrl: "https://api.example.com/v1", model: "test-model", apiKey: "sk-test" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseSsePayload 纯函数", () => {
  it("reasoning_content 与 content 归一为事件序列（同帧双字段先 reasoning 后 content）", () => {
    expect(parseSsePayload(JSON.stringify({ choices: [{ delta: { content: "你好" } }] }))).toEqual([
      { type: "content", data: "你好" }
    ]);
    expect(parseSsePayload(JSON.stringify({ choices: [{ delta: { reasoning_content: "想一下" } }] }))).toEqual([
      { type: "reasoning", data: "想一下" }
    ]);
    expect(
      parseSsePayload(JSON.stringify({ choices: [{ delta: { reasoning_content: "r", content: "c" } }] }))
    ).toEqual([
      { type: "reasoning", data: "r" },
      { type: "content", data: "c" }
    ]);
  });

  it("[DONE] 与空输入终止：返回空事件列表", () => {
    expect(parseSsePayload("[DONE]")).toEqual([]);
    expect(parseSsePayload("")).toEqual([]);
    expect(parseSsePayload("   ")).toEqual([]);
    expect(parseSsePayload(undefined)).toEqual([]);
    expect(parseSsePayload(null)).toEqual([]);
  });

  it("非 JSON 行容错：注释行 / 心跳 / 畸形 JSON 不抛错、静默丢弃", () => {
    expect(parseSsePayload(": keep-alive")).toEqual([]);
    expect(parseSsePayload("not-json")).toEqual([]);
    expect(parseSsePayload('{"choices":[{"delta":{"content":"半截')).toEqual([]);
    expect(parseSsePayload('{"choices":[{}]}')).toEqual([]);
    expect(parseSsePayload('{"unexpected":true}')).toEqual([]);
  });

  it("delta 字段非字符串时按 String 归一，空串/假值不产事件", () => {
    expect(parseSsePayload(JSON.stringify({ choices: [{ delta: { content: "" } }] }))).toEqual([]);
    expect(parseSsePayload(JSON.stringify({ choices: [{ delta: { content: 0 } }] }))).toEqual([]);
    expect(parseSsePayload(JSON.stringify({ choices: [{ delta: { content: 42 } }] }))).toEqual([
      { type: "content", data: "42" }
    ]);
  });

  it("tool_calls 分片（联网搜索管线）：id/name/arguments 片段按事件透出", () => {
    expect(
      parseSsePayload(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "web_search", arguments: '{"qu' } }] } }] }))
    ).toEqual([
      { type: "tool-call-fragment", index: 0, id: "call_1", name: "web_search", argsFragment: '{"qu' }
    ]);
    expect(
      parseSsePayload(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ery":"x"}' } }] } }] }))
    ).toEqual([
      { type: "tool-call-fragment", index: 0, argsFragment: 'ery":"x"}' }
    ]);
  });

  it("finish_reason 透出为 finish 事件；缺省/null 不产事件", () => {
    expect(parseSsePayload(JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }))).toEqual([
      { type: "finish", reason: "tool_calls" }
    ]);
    expect(parseSsePayload(JSON.stringify({ choices: [{ delta: {}, finish_reason: null }] }))).toEqual([]);
  });
});

describe("SSE 字节级分包（经 chatCompletion 流式缝）", () => {
  function sseBytesResponse(byteChunks: Uint8Array[]): Response {
    let i = 0;
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            async read() {
              if (i < byteChunks.length) {
                return { value: byteChunks[i++], done: false };
              }
              return { done: true };
            }
          };
        }
      }
    } as unknown as Response;
  }

  it("多字节 UTF-8 字符跨 chunk 从字节中间切开：拼齐后逐字还原", async () => {
    const line = `data: ${JSON.stringify({ choices: [{ delta: { content: "字幕" } }] })}\n\n`;
    const bytes = new TextEncoder().encode(line);
    const charStart = bytes.findIndex((b, i) => i > 6 && b === 0xe5);
    expect(charStart).toBeGreaterThan(6);
    const cut = charStart + 1;
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => sseBytesResponse([bytes.slice(0, cut), bytes.slice(cut)]));

    const events: StreamChatEvent[] = [];
    await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      fetchImpl: fetchMock,
      onEvent: (e) => events.push(e)
    });
    expect(events).toEqual([{ type: "token", data: "字幕" }]);
  });

  it("一个 chunk 内多行 data: 前缀变体（无空格 / 多余空格）+ [DONE] 终止后不再产出", async () => {
    const payload = (delta: Record<string, unknown>) => JSON.stringify({ choices: [{ delta }] });
    const text =
      `data:${payload({ content: "甲" })}\n\n` +
      `data:  ${payload({ content: "乙" })}\n\n` +
      "data: [DONE]\n\n" +
      `data: ${payload({ content: "不该出现" })}\n\n`;
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => sseBytesResponse([new TextEncoder().encode(text)]));

    const events: StreamChatEvent[] = [];
    await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      fetchImpl: fetchMock,
      onEvent: (e) => events.push(e)
    });
    expect(events).toEqual([
      { type: "token", data: "甲" },
      { type: "token", data: "乙" },
      { type: "token", data: "不该出现" }
    ]);
  });
});
