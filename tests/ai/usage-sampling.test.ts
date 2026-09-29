// ai-usage-telemetry T2a 单测：completion.ts 的采样接线（零用户可见变化）。
// 锁三件事：
// 1. 一次带 usage 的成功响应（流式 / 非流式各一）→ 样本进了正确的 (baseUrl, model) 桶；
// 2. 响应无 usage（或平台拒收）→ 不产生样本；
// 3. payloadChars 口径 = 本次请求 messages[].content 字符合计——用可断言的输入
//    （system 5 字 + user 10 字 = 15）与一份超长 tools 定义锁死：若误用整份 JSON
//    body 长度，比值会与 15/inputTokens 差一个数量级。
// 失败方式先行：非流式路径忘了记、流式路径另写一份导致口径漂移、无 usage 却记了 0、
// 用 body 长度当分子被 tools/JSON 语法污染、scope 拼错（两处各自拼键）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatCompletion } from "../../extension/ai/completion.js";
import { learnedCharsPerToken, resetUsageStatsForTests } from "../../extension/ai/usage-stats.js";
import { resetLearnedBudgetsForTests } from "../../extension/ai/learned-budget.js";
import type { ChatToolDefinition } from "../../extension/ai/protocol-adapter.js";
import type { ChatMessage } from "../../extension/ai/types.js";

const PROVIDER = { baseUrl: "https://api.example.com/v1", model: "test-model", apiKey: "sk-test" };
const OTHER = { baseUrl: "https://api.other.com/v1", model: "test-model", apiKey: "sk-test" };

// 可断言的输入：payloadChars = 5 + 10 = 15。
const MESSAGES: ChatMessage[] = [
  { role: "system", content: "12345" },
  { role: "user", content: "1234567890" }
];

// 一份明显大于 15 字符的 tools 定义：整份 body 长度会远大于 payloadChars。
const TOOLS: ChatToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "搜索".repeat(200),
      parameters: { type: "object", properties: { query: { type: "string" } } }
    }
  }
];

function jsonResponse(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as unknown as Response;
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (i < chunks.length) {
              return { value: encoder.encode(chunks[i++]), done: false };
            }
            return { done: true };
          }
        };
      }
    }
  } as unknown as Response;
}

function openaiData(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

beforeEach(() => {
  resetUsageStatsForTests();
  resetLearnedBudgetsForTests();
});

describe("completion 采样接线", () => {
  it("非流式：带 usage 的成功响应记样本，比值 = payloadChars / inputTokens，落在本 scope", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 3 }
      })
    );
    const result = await chatCompletion({
      provider: PROVIDER,
      messages: MESSAGES,
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    expect(result).toBe("ok");
    expect(learnedCharsPerToken(PROVIDER)).toBeCloseTo(1.5);
    expect(learnedCharsPerToken(OTHER)).toBeUndefined();
  });

  it("流式：末块 usage 同样记样本（两路径共用同一采样点，口径一致）", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        openaiData({ choices: [{ delta: { content: "甲" } }] }),
        openaiData({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        openaiData({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } }),
        "data: [DONE]\n\n"
      ])
    );
    await chatCompletion({
      provider: PROVIDER,
      messages: MESSAGES,
      stream: true,
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    expect(learnedCharsPerToken(PROVIDER)).toBeCloseTo(1.5);
    expect(learnedCharsPerToken(OTHER)).toBeUndefined();
  });

  it("响应无 usage → 不产生样本（流式与非流式都一样）", async () => {
    const nonStream = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    await chatCompletion({ provider: PROVIDER, messages: MESSAGES, fetchImpl: nonStream as unknown as typeof fetch });
    expect(learnedCharsPerToken(PROVIDER)).toBeUndefined();

    const stream = vi.fn(async () =>
      sseResponse([openaiData({ choices: [{ delta: { content: "甲" } }] }), "data: [DONE]\n\n"])
    );
    await chatCompletion({
      provider: PROVIDER,
      messages: MESSAGES,
      stream: true,
      fetchImpl: stream as unknown as typeof fetch
    });
    expect(learnedCharsPerToken(PROVIDER)).toBeUndefined();
  });

  it("payloadChars 口径 = messages[].content 合计：超长 tools 定义不参与分子", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 3 } })
    );
    await chatCompletion({
      provider: PROVIDER,
      messages: MESSAGES,
      tools: TOOLS,
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    const bodyChars = init.body.length;
    // 前提：整份 body 确实远大于 15（tools 定义注入成功），否则这条用例锁不住错口径。
    expect(bodyChars).toBeGreaterThan(300);
    expect(learnedCharsPerToken(PROVIDER)).toBeCloseTo(1.5);
    expect(learnedCharsPerToken(PROVIDER)).not.toBeCloseTo(bodyChars / 10, 1);
  });

  it("越界比值被丢弃：不记样本也不抛错（成功响应照常返回）", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1000, completion_tokens: 3 } })
    );
    const result = await chatCompletion({
      provider: PROVIDER,
      messages: MESSAGES,
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    expect(result).toBe("ok");
    expect(learnedCharsPerToken(PROVIDER)).toBeUndefined();
  });

  it("失败响应（非 2xx）不记样本", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "boom"
    } as unknown as Response));
    await expect(
      chatCompletion({ provider: PROVIDER, messages: MESSAGES, fetchImpl: fetchMock as unknown as typeof fetch })
    ).rejects.toThrow();
    expect(learnedCharsPerToken(PROVIDER)).toBeUndefined();
  });

  it("同一 scope 连续两次成功 → 学到的比取最近样本的中位数", async () => {
    const first = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 1 } })
    );
    await chatCompletion({ provider: PROVIDER, messages: MESSAGES, fetchImpl: first as unknown as typeof fetch });

    const second = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } })
    );
    await chatCompletion({ provider: PROVIDER, messages: MESSAGES, fetchImpl: second as unknown as typeof fetch });

    // 样本 1.5 与 3 → 中位数 2.25
    expect(learnedCharsPerToken(PROVIDER)).toBeCloseTo(2.25);
  });
});
