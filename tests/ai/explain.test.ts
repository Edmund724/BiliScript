// ai/explain.ts 选区解释的单测：上下文窗口截取、提示词组装、请求口径与空回复判定。
// chatCompletion 以 vi.mock 替身（协议层自身有 completion.test.js 覆盖）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import type { ToolStatusPayload } from "../../extension/ai/tool-loop.js";

// chatCompletion 替身：非流式返回文本，工具轮返回 tool_calls 结果对象
// （返回类型放宽到 any——mockResolvedValueOnce 两种形态都要能塞进去）。
const completionMock = vi.hoisted(() => ({
  chatCompletion: vi.fn(async (_args?: any): Promise<any> => "  解释文本  ")
}));

// parseToolArgs 用真实实现（tool-loop 回填 tool 消息复用；JSON 宽容解析）。
vi.mock("../../extension/ai/completion.js", () => ({
  chatCompletion: completionMock.chatCompletion,
  parseToolArgs: (raw: string) => {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && typeof parsed.query === "string") {
        return { query: parsed.query };
      }
    } catch {}
    return { query: raw };
  }
}));

let explain: typeof import("../../extension/ai/explain.js");

const BODY = [
  { from: 0, content: "我们习惯把语言视为空气" },
  { from: 10, content: "我们习惯将其视为传递信息的工具" },
  { from: 20, content: "但语言同时也是权力的载体" },
  { from: 30, content: "这一点很少被讨论" }
];

beforeEach(async () => {
  resetModuleState();
  completionMock.chatCompletion.mockReset();
  completionMock.chatCompletion.mockResolvedValue("  解释文本  ");
  explain = await import("../../extension/ai/explain.js");
});

describe("buildExplainContext", () => {
  it("以锚点句为中心取前后各 2 句，锚点行带 → 标记", () => {
    const context = explain.buildExplainContext(BODY, 2);
    const lines = context.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^ {2}\[0:00\] 我们习惯把语言视为空气$/);
    expect(lines[2]).toMatch(/^→ \[0:20\] 但语言同时也是权力的载体$/);
    expect(lines[3]).toMatch(/^ {2}\[0:30\] 这一点很少被讨论$/);
  });

  it("锚点在首/尾时窗口收敛不越界", () => {
    expect(explain.buildExplainContext(BODY, 0).split("\n")).toHaveLength(3);
    expect(explain.buildExplainContext(BODY, 3).split("\n")).toHaveLength(3);
  });

  it("body 为空 / index 缺失或越界 → 空串（调用方按无上下文出词）", () => {
    expect(explain.buildExplainContext([], 0)).toBe("");
    expect(explain.buildExplainContext(undefined, 1)).toBe("");
    expect(explain.buildExplainContext(BODY, undefined)).toBe("");
    expect(explain.buildExplainContext(BODY, 99)).toBe("");
    expect(explain.buildExplainContext(BODY, -1)).toBe("");
  });
});

describe("buildExplainMessages", () => {
  it("system 定口径（短句/不臆造/跟随字幕语言），user 带标题·选中·所在句·上下文", () => {
    const messages = explain.buildExplainMessages({
      videoTitle: "语言与权力",
      selection: "传递信息的工具",
      line: "我们习惯将其视为传递信息的工具",
      from: 10,
      body: BODY,
      index: 2
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("最多 3 句话");
    expect(messages[0].content).toContain("不要臆造");

    const user = messages[1].content;
    expect(user).toContain("视频标题：语言与权力");
    expect(user).toContain("选中内容：「传递信息的工具」");
    expect(user).toContain("所在字幕句（0:10）：「我们习惯将其视为传递信息的工具」"); // arch-slim-2/08 拍板 Q1：不补零
    expect(user).toContain("字幕上下文");
    expect(user).toContain("我们习惯把语言视为空气");
  });

  it("无上下文时如实标注，不放假语境", () => {
    const messages = explain.buildExplainMessages({
      videoTitle: "",
      selection: "词",
      line: "句子",
      from: 5,
      body: [],
      index: undefined
    });
    expect(messages[1].content).toContain("（无可用上下文）");
    expect(messages[1].content).toContain("视频标题：未知");
  });
});

describe("explainSelection", () => {
  it("走非流式单次请求，思考档位钉死 off（协议层据此发显式关思考字段），返回 trim 后的解释", async () => {
    const text = await explain.explainSelection({
      provider: { baseUrl: "https://api.test/v1", apiKey: "sk", model: "m" },
      videoTitle: "T",
      selection: "传递信息的工具",
      line: "我们习惯将其视为传递信息的工具",
      from: 10,
      body: BODY,
      index: 2
    });

    expect(text).toBe("解释文本");
    const args = completionMock.chatCompletion.mock.calls[0][0];
    expect(args.stream).toBe(false);
    expect(args.thinkingLevel).toBe("off");
    expect(args.maxTokens).toBeGreaterThan(0);
    expect(args.messages[1].content).toContain("传递信息的工具");
  });

  // 解释在 content script 里发起：直连 fetch 服从网页 CORS，平台网关不支持
  // 浏览器预检时必然「Failed to fetch」。传输层必须走 SW 代发（与探针同路），
  // 请求构造仍留在 completion 链。
  it("传输层注入 providerFetchViaBackground（经 SW 代发，绕开网页 CORS）", async () => {
    const { providerFetchViaBackground } = await import("../../extension/core/provider-http.js");

    await explain.explainSelection({
      provider: { baseUrl: "https://api.test/v1", apiKey: "sk", model: "m" },
      selection: "词",
      line: "句",
      from: 0
    });

    expect(completionMock.chatCompletion.mock.calls[0][0].fetchImpl).toBe(providerFetchViaBackground);
  });

  it("provider 原样透传 chatCompletion：presetId（preset 词表键）不丢，请求构造单缝据此优先识别平台", async () => {
    const provider = { baseUrl: "https://thinking-proxy.example.com/v1", apiKey: "sk", model: "qwen3-max", presetId: "qwen" };
    await explain.explainSelection({
      provider,
      videoTitle: "T",
      selection: "传递信息的工具",
      line: "我们习惯将其视为传递信息的工具",
      from: 10,
      body: BODY,
      index: 2
    });

    const args = completionMock.chatCompletion.mock.calls[0][0];
    expect(args.provider).toEqual(provider);
  });

  it("系统提示词带「不要思考过程，直接给解释」的措辞（兜住服务端默认开思考的平台）", async () => {
    const messages = explain.buildExplainMessages({
      videoTitle: "T",
      selection: "词",
      line: "句",
      from: 0
    });
    expect(messages[0].content).toContain("不要思考过程");
  });

  it("空回复按失败抛错（模型没给东西不算成功）", async () => {
    completionMock.chatCompletion.mockResolvedValue("   ");
    await expect(
      explain.explainSelection({
        provider: { baseUrl: "https://api.test/v1", model: "m" },
        selection: "词",
        line: "句",
        from: 0
      })
    ).rejects.toThrow("模型没有给出解释");
  });

  it("请求失败原样上抛（由调用方落 error 态）", async () => {
    completionMock.chatCompletion.mockRejectedValue(new Error("HTTP 401"));
    await expect(
      explain.explainSelection({ provider: { baseUrl: "https://api.test/v1", model: "m" }, selection: "词", line: "句", from: 0 })
    ).rejects.toThrow("HTTP 401");
  });

  it("联网链走 tool-loop：注入 web_search 工具 + 联网变体提示词，搜索结果回填 tool 消息，返回最终文本", async () => {
    completionMock.chatCompletion
      .mockResolvedValueOnce({
        done: true,
        finishReason: "tool_calls",
        assistantContent: "",
        toolCalls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"传递信息的工具"}' } }]
      })
      .mockResolvedValueOnce("  最终解释  ");
    const statuses: ToolStatusPayload[] = [];
    const notices: string[] = [];
    const text = await explain.explainSelection({
      provider: { baseUrl: "https://api.test/v1", apiKey: "sk", model: "m" },
      selection: "传递信息的工具",
      line: "我们习惯将其视为传递信息的工具",
      from: 10,
      body: BODY,
      index: 2,
      webSearch: {
        maxToolCalls: 2,
        executeSearch: async () => ({ results: [{ title: "t", url: "u", snippet: "s" }], platform: "Tavily" })
      },
      onSearchStatus: (p) => statuses.push(p),
      onNotice: (n) => notices.push(n)
    });

    expect(text).toBe("最终解释");
    // 非流式 + off 档位 + 320 输出上限（解释口径不因联网改变）
    const first = completionMock.chatCompletion.mock.calls[0][0];
    expect(first.stream).toBe(false);
    expect(first.thinkingLevel).toBe("off");
    expect(first.maxTokens).toBe(320);
    // 重试能力与非联网链一致（chatCompletion 非流式默认 0，解释链钉 1）
    expect(first.retries).toBe(1);
    // 工具注入 + 联网变体系统提示词（允许 web_search）；[n] 引用要求不进解释链
    expect(first.tools).toHaveLength(1);
    expect(first.tools[0].function.name).toBe("web_search");
    expect(first.tools[0].function.description).not.toContain("[n]");
    expect(first.messages[0].content).toContain("web_search");
    // 二次调用带 tool 结果消息
    const second = completionMock.chatCompletion.mock.calls[1][0];
    expect(second.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", tool_call_id: "call_1", content: JSON.stringify([{ title: "t", url: "u", snippet: "s" }]) })
    ]));
    // 搜索状态透传，无失败 notice
    expect(statuses.map((p) => p.status)).toEqual(["searching", "done"]);
    expect(notices).toEqual([]);
  });

  it("联网链搜索失败降级：「搜索失败」tool 消息 + notice，回答不中断", async () => {
    completionMock.chatCompletion
      .mockResolvedValueOnce({
        done: true,
        finishReason: "tool_calls",
        assistantContent: "",
        toolCalls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"术语"}' } }]
      })
      .mockResolvedValueOnce("解释");
    const statuses: ToolStatusPayload[] = [];
    const notices: string[] = [];
    const text = await explain.explainSelection({
      provider: { baseUrl: "https://api.test/v1", apiKey: "sk", model: "m" },
      selection: "术语",
      line: "句",
      from: 0,
      webSearch: {
        maxToolCalls: 2,
        executeSearch: async () => {
          throw new Error("HTTP 429");
        }
      },
      onSearchStatus: (p) => statuses.push(p),
      onNotice: (n) => notices.push(n)
    });

    expect(text).toBe("解释");
    const second = completionMock.chatCompletion.mock.calls[1][0];
    expect(second.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", tool_call_id: "call_1", content: expect.stringContaining("搜索失败：HTTP 429") })
    ]));
    expect(statuses.at(-1)!.status).toBe("failed");
    expect(notices).toEqual([expect.stringContaining("联网搜索失败")]);
  });

  it("联网变体提示词：允许 web_search 核实 + 依据口径收口（纯函数）", () => {
    const messages = explain.buildExplainMessages({
      videoTitle: "T",
      selection: "词",
      line: "句",
      from: 0,
      webSearch: { maxToolCalls: 2, executeSearch: async () => ({ results: [], platform: "Tavily" }) }
    });
    expect(messages[0].content).toContain("可调用 web_search 工具联网核实");
    expect(messages[0].content).toContain("不要臆造");
    // 无联网时提示词不变（不出现工具措辞）
    const plain = explain.buildExplainMessages({ videoTitle: "T", selection: "词", line: "句", from: 0 });
    expect(plain[0].content).not.toContain("web_search");
  });
});
