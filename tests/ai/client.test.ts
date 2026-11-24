import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { streamChat, TRUNCATED_NOTICE } from "../../extension/ai/client.js";
import { resetLearnedBudgetsForTests } from "../../extension/ai/learned-budget.js";

beforeEach(() => {
  resetModuleState();
  resetLearnedBudgetsForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function runStreamChatWithFakeTimers(input: Parameters<typeof streamChat>[0]) {
  vi.useFakeTimers();
  try {
    const pending = streamChat(input);
    await vi.runAllTimersAsync();
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

const PROVIDER = { baseUrl: "https://api.example.com/v1", model: "test-model", apiKey: "sk-test" };

interface PortMessage {
  type: string;
  data?: unknown;
  error?: string;
  reason?: string;
  status?: string;
  query?: string;
  resultCount?: number;
  platform?: string;
  generation?: number;
  messages?: Array<{ role: string; content?: string; tool_calls?: unknown[] }>;
}

function makePort() {
  const messages: PortMessage[] = [];
  return {
    messages,
    postMessage(message: unknown) {
      messages.push(message as PortMessage);
    }
  };
}

function textResponse(text: string, ok = false, status = 400) {
  return { ok, status, text: async () => text, json: async () => ({}) };
}

function sseResponse(chunks: string[]) {
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
  };
}

function sseData(delta: unknown) {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
}

describe("streamChat port 协议：事件序列与旧实现一致", () => {
  it("流式成功：token/reasoning 逐条回吐 + 收尾 done，返回 { done: true }", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        sseData({ reasoning_content: "思路" }),
        sseData({ content: "正文" }),
        "data: [DONE]\n\n"
      ])
    ));
    const port = makePort();
    const onActivity = vi.fn();

    const result = await streamChat({
      provider: PROVIDER,
      context: { title: "t", subtitleBody: [{ from: 0, to: 5, content: "字幕" }] },
      userPrompt: "总结",
      history: [],
      port,
      onActivity
    });

    expect(result).toEqual({ done: true });
    expect(port.messages).toEqual([
      { type: "reasoning", data: "思路" },
      { type: "token", data: "正文" },
      { type: "done" }
    ]);
    expect(onActivity).toHaveBeenCalledTimes(2);
  });

  it("预检：缺 baseUrl / 缺 model → post error 且不发请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const port1 = makePort();
    await streamChat({ provider: { model: "m" }, context: {}, userPrompt: "", history: [], port: port1 });
    expect(port1.messages).toEqual([{ type: "error", error: "baseUrl 未配置" }]);

    const port2 = makePort();
    await streamChat({ provider: { baseUrl: "https://x" }, context: {}, userPrompt: "", history: [], port: port2 });
    expect(port2.messages).toEqual([{ type: "error", error: "模型未配置" }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("非溢出 HTTP 错误：重试 notice ×2 后 post error，正常返回（不抛）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => textResponse("Unauthorized", false, 401)));
    const port = makePort();

    const result = await runStreamChatWithFakeTimers({
      provider: PROVIDER,
      context: { title: "t", subtitleBody: [] },
      userPrompt: "总结",
      history: [],
      port
    });

    expect(result).toBeUndefined();
    const errors = port.messages.filter((m) => m.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toBe("HTTP 401: [openai] Unauthorized");
    const notices = port.messages.filter((m) => m.type === "notice");
    expect(notices).toHaveLength(2);
    expect(notices[0].data).toBe("HTTP 401: [openai] Unauthorized，正在重试...");
    expect(port.messages.some((m) => m.type === "done")).toBe(false);
  });

  it("网络错误：重试 notice（连接中断文案）后 post error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("Failed to fetch");
    }));
    const port = makePort();

    await runStreamChatWithFakeTimers({
      provider: PROVIDER,
      context: { title: "t", subtitleBody: [] },
      userPrompt: "总结",
      history: [],
      port
    });

    const notices = port.messages.filter((m) => m.type === "notice");
    expect(notices.map((n) => n.data)).toEqual([
      "连接中断，正在重新连接（1/2）...",
      "连接中断，正在重新连接（2/2）..."
    ]);
    const errors = port.messages.filter((m) => m.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toBe("网络错误：Failed to fetch");
  });

  it("abort：post stopped，无 done / error", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", vi.fn(async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }));
    const port = makePort();

    const result = await streamChat({
      provider: PROVIDER,
      context: { title: "t", subtitleBody: [] },
      userPrompt: "总结",
      history: [],
      port,
      signal: controller.signal
    });

    expect(result).toBeUndefined();
    expect(port.messages).toEqual([{ type: "stopped", reason: "已停止生成" }]);
  });
});

describe("streamChat token 合帧（07 票）：窗口预算批传，输出逐字节一致", () => {
  it("1000 token 一次成流 → 按 maxPending 分批，消息条数 ≥90% 下降，拼接不丢不重", async () => {
    const tokens = Array.from({ length: 1000 }, (_, i) => `t${i}`);
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([...tokens.map((t) => sseData({ content: t })), "data: [DONE]\n\n"])
    ));
    const port = makePort();

    const result = await streamChat({
      provider: PROVIDER,
      context: { title: "t", subtitleBody: [{ from: 0, to: 5, content: "字幕" }] },
      userPrompt: "总结",
      history: [],
      port
    });

    expect(result).toEqual({ done: true });
    const batches = port.messages.filter((m) => m.type === "token-batch");
    const singles = port.messages.filter((m) => m.type === "token");
    expect(batches.length + singles.length).toBeLessThanOrEqual(34);
    expect(batches.length + singles.length).toBeLessThan(1000 * 0.1);
    expect(batches.flatMap((b) => b.data)).toEqual(tokens);
    expect(port.messages.at(-1)).toEqual({ type: "done" });
  });

  it("单 token 批次回落普通 token 事件（慢速流线格式与旧一致）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([sseData({ content: "唯" }), sseData({ content: "一" }), "data: [DONE]\n\n"])
    ));
    const port = makePort();

    await streamChat({
      provider: PROVIDER,
      context: { title: "t", subtitleBody: [] },
      userPrompt: "总结",
      history: [],
      port
    });

    expect(port.messages).toEqual([
      { type: "token-batch", data: ["唯", "一"] },
      { type: "done" }
    ]);
  });

  it("reasoning 事件先把积压 token 收口再回吐（渲染顺序不颠倒）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        sseData({ content: "正文一" }),
        sseData({ reasoning_content: "思路" }),
        sseData({ content: "正文二" }),
        "data: [DONE]\n\n"
      ])
    ));
    const port = makePort();

    await streamChat({
      provider: PROVIDER,
      context: { title: "t", subtitleBody: [] },
      userPrompt: "总结",
      history: [],
      port
    });

    expect(port.messages).toEqual([
      { type: "token", data: "正文一" },
      { type: "reasoning", data: "思路" },
      { type: "token", data: "正文二" },
      { type: "done" }
    ]);
  });

  it("stream-reset 前先 flush 旧流尾巴（不丢 token），reset 仍先于重试流", async () => {
    let readCount = 0;
    const flakyBody = {
      getReader() {
        return {
          async read() {
            readCount += 1;
            if (readCount === 1) {
              const encoder = new TextEncoder();
              return { value: encoder.encode(sseData({ content: "旧一" }) + sseData({ content: "旧二" })), done: false };
            }
            throw new Error("stream closed");
          }
        };
      }
    };
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => ({ ok: true, status: 200, body: flakyBody }))
      .mockImplementationOnce(async () =>
        sseResponse([sseData({ content: "新" }), "data: [DONE]\n\n"]));
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();

    const result = await runStreamChatWithFakeTimers({
      provider: PROVIDER,
      context: { title: "t", subtitleBody: [] },
      userPrompt: "总结",
      history: [],
      port
    });

    expect(result).toEqual({ done: true });
    const types = port.messages.map((m) => m.type);
    const resetIdx = types.indexOf("stream-reset");
    expect(resetIdx).toBeGreaterThan(0);
    expect(port.messages[resetIdx - 1]).toEqual({ type: "token-batch", data: ["旧一", "旧二"] });
    expect(resetIdx).toBeLessThan(types.indexOf("token"));
    expect(port.messages.at(-1)).toEqual({ type: "done" });
  });
});

describe("streamChat 溢出语义（catch 查标记）", () => {
  it("HTTP 400 body 含 maximum context length → 抛 { overflow: true }，不再 post overflow/error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      textResponse("This model's maximum context length is 8192 tokens, but you requested 12000 tokens.", false, 400)
    ));
    const port = makePort();

    await expect(
      streamChat({
        provider: PROVIDER,
        context: { title: "t", subtitleBody: [] },
        userPrompt: "总结",
        history: [],
        port
      })
    ).rejects.toMatchObject({ overflow: true });
    expect(port.messages).toHaveLength(0);
  });

  it("普通错误不误判为溢出（post error、不上抛）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => textResponse("Unauthorized", false, 401)));
    const port = makePort();

    const result = await runStreamChatWithFakeTimers({
      provider: PROVIDER,
      context: { title: "t", subtitleBody: [] },
      userPrompt: "总结",
      history: [],
      port
    });

    expect(result).toBeUndefined();
    expect(port.messages.some((m) => m.type === "error")).toBe(true);
  });
});

describe("streamChat 读流中断重试：stream-reset 代际重置信号", () => {
  it("读流中断重试 → port 收到 stream-reset（在新流 token 之前）+ 恢复后 done", async () => {
    const brokenReader = () => ({
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            read: async () => {
              throw new Error("stream closed");
            }
          };
        }
      }
    });
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => brokenReader())
      .mockResolvedValueOnce(sseResponse([sseData({ content: "二代正文" }), "data: [DONE]\n\n"]));
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();

    const result = await runStreamChatWithFakeTimers({
      provider: PROVIDER,
      context: { title: "t", subtitleBody: [{ from: 0, to: 5, content: "字幕" }] },
      userPrompt: "总结",
      history: [],
      port
    });

    expect(result).toEqual({ done: true });
    const resetIdx = port.messages.findIndex((m) => m.type === "stream-reset");
    const tokenIdx = port.messages.findIndex((m) => m.type === "token");
    expect(resetIdx).toBeGreaterThanOrEqual(0);
    expect(port.messages.filter((m) => m.type === "stream-reset")).toHaveLength(1);
    expect(resetIdx).toBeLessThan(tokenIdx);
    expect(port.messages.at(-1)).toEqual({ type: "done" });
  });

  it("fetch/http 阶段重试不发 stream-reset（未吐过事件）", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => "Unauthorized" })
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => "Unauthorized" })
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => "Unauthorized" });
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();

    await runStreamChatWithFakeTimers({
      provider: PROVIDER,
      context: { title: "t", subtitleBody: [{ from: 0, to: 5, content: "字幕" }] },
      userPrompt: "总结",
      history: [],
      port
    });

    expect(port.messages.some((m) => m.type === "stream-reset")).toBe(false);
    expect(port.messages.at(-1)?.type).toBe("error");
  });
});

describe("webSearch 工具循环 port 回吐（spec §2.3）", () => {
  function sseDataFinish(delta: unknown, finishReason?: string) {
    return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] })}\n\n`;
  }
  const TOOL_ROUND = [
    sseDataFinish({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"x"}' } }] }),
    sseDataFinish({}, "tool_calls")
  ];
  const FINAL_ROUND = [sseDataFinish({ content: "回答" }), sseDataFinish({}, "stop")];

  it("tool 轮：port 依次收到 tool-status / tool-turn / token / done；历史中的 tool 消息透传", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse(TOOL_ROUND))
      .mockResolvedValueOnce(sseResponse(FINAL_ROUND));
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();

    const result = await streamChat({
      provider: PROVIDER,
      context: { title: "t", subtitleBody: [{ from: 0, to: 5, content: "字幕" }] },
      userPrompt: "问",
      history: [],
      port,
      webSearch: {
        maxToolCalls: 5,
        executeSearch: async () => ({ results: [{ title: "t", url: "u", snippet: "s" }], platform: "Tavily" })
      }
    });

    expect(result).toEqual({ done: true });
    const types = port.messages.map((m) => m.type);
    expect(types).toEqual(["tool-status", "tool-status", "tool-turn", "token", "done"]);
    expect(port.messages[0]).toMatchObject({ type: "tool-status", status: "searching", query: "x" });
    expect(port.messages[1]).toMatchObject({ type: "tool-status", status: "done", query: "x", resultCount: 1, platform: "Tavily" });
    expect(port.messages[2].type).toBe("tool-turn");
    expect(port.messages[2].messages!.map((m) => m.role)).toEqual(["assistant", "tool"]);
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(firstBody.tools).toEqual([expect.anything()]);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondBody.messages.some((m: { role: string }) => m.role === "tool")).toBe(true);
  });

  it("空正文整轮重跑：第二代不带旧工具消息，事件按 generation 隔离", async () => {
    const secondToolRound = [
      sseDataFinish({ tool_calls: [{ index: 0, id: "call_2", type: "function", function: { name: "web_search", arguments: '{"query":"x"}' } }] }),
      sseDataFinish({}, "tool_calls")
    ];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse(TOOL_ROUND))
      .mockResolvedValueOnce(sseResponse([sseDataFinish({}, "length")]))
      .mockResolvedValueOnce(sseResponse(secondToolRound))
      .mockResolvedValueOnce(sseResponse(FINAL_ROUND));
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();

    await streamChat({
      provider: PROVIDER,
      context: {},
      userPrompt: "问",
      history: [],
      port,
      webSearch: {
        maxToolCalls: 5,
        executeSearch: async () => ({ results: [{ title: "t", url: "u", snippet: "s" }], platform: "Tavily" })
      }
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(bodies[1].messages.some((message: { role: string }) => message.role === "tool")).toBe(true);
    expect(bodies[2].messages).toEqual(bodies[0].messages);
    expect(bodies[2].messages.some((message: { role: string; tool_calls?: unknown[] }) => message.role === "tool" || message.tool_calls)).toBe(false);
    expect(bodies[2].max_tokens).toBe(65536);
    const finalAssistant = bodies[3].messages.find((message: { role: string; tool_calls?: Array<{ id: string }> }) => message.tool_calls);
    expect(finalAssistant.tool_calls[0].id).toBe("call_2");
    expect(bodies[3].messages.some((message: { tool_calls?: Array<{ id: string }> }) => message.tool_calls?.[0]?.id === "call_1")).toBe(false);
    expect(port.messages.filter((message) => message.type === "tool-status").map((message) => message.generation)).toEqual([0, 0, 1, 1]);
    expect(port.messages.filter((message) => message.type === "tool-turn").map((message) => message.generation)).toEqual([0, 1]);
    expect(port.messages.find((message) => message.type === "stream-reset")).toEqual({ type: "stream-reset", generation: 1 });
    expect(port.messages.at(-1)).toEqual({ type: "done" });
  });

  it("无 webSearch：行为回归（不解析工具、事件序列与旧实现一致）", async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init: { body: string }) => sseResponse([sseData({ content: "正文" }), "data: [DONE]\n\n"]));
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();

    await streamChat({ provider: PROVIDER, context: {}, userPrompt: "", history: [], port });
    expect(port.messages.map((m) => m.type)).toEqual(["token", "done"]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
  });
});

describe("输出上限截断（finish_reason=length）", () => {
  function sseChoices(delta: unknown, finishReason?: string) {
    return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] })}\n\n`;
  }

  function anthropicSseData(event: Record<string, unknown>) {
    return `data: ${JSON.stringify(event)}\n\n`;
  }

  it("正文后补一条带 code 的截断 notice，再收口 done（宿主据此渲染常驻徽标）", async () => {
    const fetchMock = vi.fn(async () => sseResponse([sseChoices({ content: "半句" }), sseChoices({}, "length")]));
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();

    const result = await streamChat({ provider: PROVIDER, context: {}, userPrompt: "", history: [], port });

    expect(result).toEqual({ done: true });
    expect(port.messages).toEqual([
      { type: "token", data: "半句" },
      { type: "notice", data: TRUNCATED_NOTICE, code: "truncated" },
      { type: "done" }
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("空正文截断 → 显式带双倍预算重跑一次，stream-reset 清空重放，不挂徽标", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse([sseChoices({}, "length")]))
      .mockResolvedValueOnce(sseResponse([sseChoices({ content: "正文" }), sseChoices({}, "stop")]));
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();

    const result = await streamChat({ provider: PROVIDER, context: {}, userPrompt: "", history: [], port });

    expect(result).toEqual({ done: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBeUndefined();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).max_tokens).toBe(65536);
    expect(port.messages).toEqual([
      { type: "stream-reset" },
      { type: "token", data: "正文" },
      { type: "done" }
    ]);
  });

  it("anthropic 协议：空正文截断 → 首发走 adapter 兜底 32768、重试显式 65536，思考随 reset 重放", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse([
        anthropicSseData({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想" } }),
        anthropicSseData({ type: "message_delta", delta: { stop_reason: "max_tokens" } })
      ]))
      .mockResolvedValueOnce(sseResponse([
        anthropicSseData({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "正文" } }),
        anthropicSseData({ type: "message_delta", delta: { stop_reason: "end_turn" } })
      ]));
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();

    await streamChat({ provider: { ...PROVIDER, protocol: "anthropic" }, context: {}, userPrompt: "问", history: [], port });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(32768);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).max_tokens).toBe(65536);
    expect(port.messages).toEqual([
      { type: "reasoning", data: "想" },
      { type: "stream-reset" },
      { type: "token", data: "正文" },
      { type: "done" }
    ]);
  });

  it("正文只有空白也算空正文：同样触发重跑", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse([sseChoices({ content: " \n " }), sseChoices({}, "length")]))
      .mockResolvedValueOnce(sseResponse([sseChoices({ content: "正文" }), sseChoices({}, "stop")]));
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();

    await streamChat({ provider: PROVIDER, context: {}, userPrompt: "", history: [], port });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(port.messages.map((m) => m.type)).toEqual(["token", "stream-reset", "token", "done"]);
  });

  it("重跑后仍空正文截断 → 只重跑一次，仍挂带 code 的截断 notice", async () => {
    const fetchMock = vi.fn(async () => sseResponse([sseChoices({}, "length")]));
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();

    await streamChat({ provider: PROVIDER, context: {}, userPrompt: "", history: [], port });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(port.messages).toEqual([
      { type: "stream-reset" },
      { type: "notice", data: TRUNCATED_NOTICE, code: "truncated" },
      { type: "done" }
    ]);
  });

  it("联网轮：空正文截断同样重跑一次（工具循环整体重放）", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse([sseChoices({}, "length")]))
      .mockResolvedValueOnce(sseResponse([sseChoices({ content: "回答" }), sseChoices({}, "stop")]));
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();

    await streamChat({
      provider: PROVIDER,
      context: {},
      userPrompt: "问",
      history: [],
      port,
      webSearch: {
        maxToolCalls: 5,
        executeSearch: async () => ({ results: [{ title: "t", url: "u", snippet: "s" }], platform: "Tavily" })
      }
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).max_tokens).toBe(65536);
    expect(port.messages.filter((m) => m.type === "stream-reset")).toHaveLength(1);
    expect(port.messages.at(-1)?.type).toBe("done");
  });

  it("finish_reason=stop：不补提示，事件序列与旧实现一致", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([sseChoices({ content: "答完" }), sseChoices({}, "stop")])));
    const port = makePort();

    await streamChat({ provider: PROVIDER, context: {}, userPrompt: "", history: [], port });

    expect(port.messages.map((m) => m.type)).toEqual(["token", "done"]);
  });

  it("anthropic 协议未传 maxTokens：请求体走 adapter 兜底 32768（放得下思考预算）", async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init: { body: string }) =>
      sseResponse([
        anthropicSseData({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "正文" } }),
        anthropicSseData({ type: "message_delta", delta: { stop_reason: "end_turn" } })
      ])
    );
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();

    await streamChat({
      provider: { baseUrl: "https://api-inference.modelscope.cn", model: "Qwen/Qwen3-8B", apiKey: "k", protocol: "anthropic" },
      context: {},
      userPrompt: "总结",
      history: [],
      port
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(32768);
  });

  it("anthropic 协议：兜底 32768 被平台按超上限拒收 → 自动退回 8192 重发，界面只见正常回答", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(textResponse(JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "max_tokens: 32768 > 8192, which is the maximum allowed number of output tokens for Qwen/Qwen3-8B"
        }
      })))
      .mockResolvedValueOnce(sseResponse([
        anthropicSseData({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "正文" } }),
        anthropicSseData({ type: "message_delta", delta: { stop_reason: "end_turn" } })
      ]));
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();

    const result = await streamChat({
      provider: { baseUrl: "https://api-inference.modelscope.cn", model: "Qwen/Qwen3-8B", apiKey: "k", protocol: "anthropic" },
      context: {},
      userPrompt: "总结",
      history: [],
      port
    });

    expect(result).toEqual({ done: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(32768);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).max_tokens).toBe(8192);
    expect(port.messages).toEqual([{ type: "token", data: "正文" }, { type: "done" }]);
  });

  it("联网轮：工具轮的 finish_reason 不外泄成截断提示（最终轮 stop → 无 notice）", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse([
        sseChoices({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"x"}' } }] }),
        sseChoices({}, "tool_calls")
      ]))
      .mockResolvedValueOnce(sseResponse([sseChoices({ content: "回答" }), sseChoices({}, "stop")]));
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();

    await streamChat({
      provider: PROVIDER,
      context: {},
      userPrompt: "问",
      history: [],
      port,
      webSearch: {
        maxToolCalls: 5,
        executeSearch: async () => ({ results: [{ title: "t", url: "u", snippet: "s" }], platform: "Tavily" })
      }
    });

    expect(port.messages.filter((m) => m.type === "notice")).toEqual([]);
    expect(port.messages.at(-1)?.type).toBe("done");
  });
});
