import { describe, expect, it, vi } from "vitest";
import { anthropicAdapter } from "../../extension/ai/adapters/anthropic.js";
import { planThinkingWire } from "../../extension/ai/plan-thinking.js";
import { PROTOCOL_ADAPTERS, resolveAdapter } from "../../extension/ai/protocol-adapter.js";
import type { ChatRequest } from "../../extension/ai/protocol-adapter.js";
import { chatCompletion } from "../../extension/ai/completion.js";
import type { StreamChatEvent } from "../../extension/ai/types.js";

type AnthropicBodyFacts = Omit<ChatRequest, "thinkingWire"> & {
  baseUrl?: string;
  presetId?: string;
  thinkingLevel?: unknown;
  probe?: boolean;
};
function anthropicBody({ baseUrl, presetId, thinkingLevel, probe, ...request }: AnthropicBodyFacts) {
  return anthropicAdapter.buildBody({
    ...request,
    thinkingWire: planThinkingWire({
      protocol: "anthropic",
      model: request.model,
      presetId,
      baseUrl,
      level: thinkingLevel,
      stream: request.stream,
      probe: probe ?? false
    })
  });
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

function anthropicSseData(event: Record<string, unknown>) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

describe("capabilities（spec「被有意不支持的能力」逐条落点）", () => {
  it("tools/thinkingProfiles 为 true；unsupported 空表（限制文案已删，只留 adapter 注释）", () => {
    const { capabilities } = anthropicAdapter;
    expect(capabilities.tools).toBe(true);
    expect(capabilities.thinkingProfiles).toBe(true);
    expect(capabilities.unsupported).toEqual({});
  });

  it("注册表读路径：resolveAdapter(\"anthropic\") 命中本 adapter", () => {
    expect(resolveAdapter("anthropic")).toBe(PROTOCOL_ADAPTERS.anthropic);
    expect(PROTOCOL_ADAPTERS.anthropic).toBe(anthropicAdapter);
  });
});

describe("endpoint / authHeaders", () => {
  it("endpoint = baseUrl + /v1/messages（baseUrl 已去尾斜杠）", () => {
    expect(anthropicAdapter.endpoint("https://api.anthropic.com")).toBe("https://api.anthropic.com/v1/messages");
  });

  it("鉴权：x-api-key + anthropic-version，非 Bearer；无 key 只带 version", () => {
    expect(anthropicAdapter.authHeaders("sk-ant")).toEqual({
      "x-api-key": "sk-ant",
      "anthropic-version": "2023-06-01"
    });
    expect(anthropicAdapter.authHeaders(undefined)).toEqual({ "anthropic-version": "2023-06-01" });
  });
});

describe("buildBody（请求映射，research §2/§4）", () => {
  const base = { model: "claude-x", stream: false, probe: false, baseUrl: "https://api.anthropic.com" };

  it("system 剥为顶层结构化块并挂 ephemeral 断点；多条按出现顺序 \\n\\n 拼接（限制点 2）", () => {
    const body = anthropicBody({
      ...base,
      messages: [
        { role: "system", content: "s1" },
        { role: "user", content: "hi" },
        { role: "system", content: "s2" }
      ]
    });
    expect(body.system).toEqual([
      { type: "text", text: "s1\n\ns2", cache_control: { type: "ephemeral" } }
    ]);
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("max_tokens 必填兜底 32768（与 adapter 声明的 defaultMaxTokens 同源）；显式值透传", () => {
    expect(anthropicBody({ ...base, messages: [] }).max_tokens).toBe(32768);
    expect(anthropicAdapter.defaultMaxTokens).toBe(32768);
    expect(anthropicBody({ ...base, messages: [], maxTokens: 4096 }).max_tokens).toBe(4096);
    expect(anthropicBody({ ...base, messages: [], maxTokens: 1 }).max_tokens).toBe(1);
  });

  it("tools：input_schema 改名透传 + tool_choice 显式压平并行（限制点 9）", () => {
    const body = anthropicBody({
      ...base,
      messages: [],
      tools: [{ type: "function", function: { name: "web_search", description: "d", parameters: { type: "object" } } }]
    });
    expect(body.tools).toEqual([{ name: "web_search", description: "d", input_schema: { type: "object" } }]);
    expect(body.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  it("标记为 execution: \"server\" 的服务端工具不翻译，带日期后缀的客户端工具正常翻译：server-tools 限制点", () => {
    const body = anthropicBody({
      ...base,
      messages: [],
      tools: [
        { type: "function", execution: "server", function: { name: "web_search_20250305", description: "原生", parameters: { type: "object" } } },
        { type: "function", function: { name: "custom_20250305", description: "客户端带日期", parameters: { type: "object" } } },
        { type: "function", function: { name: "web_search", description: "客户端", parameters: { type: "object" } } }
      ]
    });
    expect(body.tools).toEqual([
      { name: "custom_20250305", description: "客户端带日期", input_schema: { type: "object" } },
      { name: "web_search", description: "客户端", input_schema: { type: "object" } }
    ]);
    const onlyNative = anthropicBody({
      ...base,
      messages: [],
      tools: [{ type: "function", execution: "server", function: { name: "web_search_20250305", description: "原生", parameters: { type: "object" } } }]
    });
    expect(onlyNative.tools).toBeUndefined();
    expect(onlyNative.tool_choice).toBeUndefined();
  });

  it("assistant tool_calls → tool_use 块；合法 JSON 对象原样透传，非 JSON/非对象兜底 { query: 原文 }（限制点 4）", () => {
    const body = anthropicBody({
      ...base,
      messages: [
        { role: "assistant", content: "让我查一下", tool_calls: [
          { id: "tu_1", type: "function", function: { name: "web_search", arguments: "not-json" } },
          { id: "tu_2", type: "function", function: { name: "web_search", arguments: "{\"query\":\"abc\"}" } },
          { id: "tu_3", type: "function", function: { name: "capture_video_frame_at_time", arguments: "{\"targetTime\":12.5}" } },
          { id: "tu_4", type: "function", function: { name: "fetch_hot_comments", arguments: "{}" } }
        ] },
        { role: "tool", tool_call_id: "tu_1", content: "r1" },
        { role: "tool", tool_call_id: "tu_2", content: "r2" },
        { role: "tool", tool_call_id: "tu_3", content: "r3" },
        { role: "tool", tool_call_id: "tu_4", content: "r4" }
      ]
    });
    expect(body.messages).toEqual([
      { role: "assistant", content: [
        { type: "text", text: "让我查一下" },
        { type: "tool_use", id: "tu_1", name: "web_search", input: { query: "not-json" } },
        { type: "tool_use", id: "tu_2", name: "web_search", input: { query: "abc" } },
        { type: "tool_use", id: "tu_3", name: "capture_video_frame_at_time", input: { targetTime: 12.5 } },
        { type: "tool_use", id: "tu_4", name: "fetch_hot_comments", input: {}, cache_control: { type: "ephemeral" } }
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "tu_1", content: "r1" },
        { type: "tool_result", tool_use_id: "tu_2", content: "r2" },
        { type: "tool_result", tool_use_id: "tu_3", content: "r3" },
        { type: "tool_result", tool_use_id: "tu_4", content: "r4" }
      ] }
    ]);
  });

  it("思考档位分档：effort 血统按平台档位词发 output_config.effort（限制点 11；02 号票修塌陷）", () => {
    const body = anthropicBody({
      ...base,
      presetId: "deepseek",
      thinkingLevel: "high",
      messages: [{ role: "user", content: "hi" }],
      model: "deepseek-v3.2"
    });
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.max_tokens).toBe(32768);
  });

  it("deepseek 预设（默认 anthropic）+ deepseek-v4-pro：low 与 high 的请求体不同（02 号票的用户可感知判据）", () => {
    const build = (thinkingLevel: string) =>
      anthropicBody({
        ...base,
        presetId: "deepseek",
        thinkingLevel,
        messages: [{ role: "user", content: "hi" }],
        model: "deepseek-v4-pro"
      });
    const low = build("low");
    const high = build("high");
    expect(low.output_config).toEqual({ effort: "low" });
    expect(high.output_config).toEqual({ effort: "high" });
    expect(JSON.stringify(low)).not.toBe(JSON.stringify(high));
  });

  it("关思考三种词汇殊途同归：翻译成 thinking:{type:disabled} 发出", () => {
    const off = anthropicBody({
      ...base,
      presetId: "modelscope",
      thinkingLevel: "off",
      model: "deepseek-ai/DeepSeek-V4.1-Flash",
      messages: []
    });
    expect(off.thinking).toEqual({ type: "disabled" });
    const native = anthropicBody({
      ...base,
      presetId: "deepseek",
      thinkingLevel: "off",
      model: "deepseek-v3.2",
      messages: []
    });
    expect(native.thinking).toEqual({ type: "disabled" });
    const offCascade = anthropicBody({
      ...base,
      presetId: "moonshot",
      thinkingLevel: "off",
      model: "kimi-k3",
      messages: []
    });
    expect(offCascade.thinking).toBeUndefined();
    expect(offCascade.reasoning_effort).toBe("low");
    const tiered = anthropicBody({
      ...base,
      presetId: "moonshot",
      thinkingLevel: "high",
      model: "kimi-k3",
      messages: []
    });
    expect(tiered.reasoning_effort).toBe("high");
  });

  it("13 号票 canonical 优先：opencodego/kimi-k3 走平台 A'（off 关不掉 → 级联落 low）", () => {
    const off = anthropicBody({
      ...base,
      presetId: "opencodego",
      thinkingLevel: "off",
      model: "kimi-k3",
      messages: []
    });
    expect(off.thinking).toBeUndefined();
    expect(off.output_config).toEqual({ effort: "low" });
    const tiered = anthropicBody({
      ...base,
      presetId: "opencodego",
      thinkingLevel: "max",
      model: "kimi-k3",
      messages: []
    });
    expect(tiered.output_config).toEqual({ effort: "max" });
    expect(tiered.thinking).toBeUndefined();
  });

  it("probe 不发 thinking：探针只测连通，不发任何思考字段", () => {
    const body = anthropicBody({
      ...base,
      probe: true,
      maxTokens: 1,
      presetId: "deepseek",
      thinkingLevel: "high",
      model: "deepseek-v3.2",
      messages: []
    });
    expect(body.max_tokens).toBe(1);
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });

  it("maxTokens 大小与思考字段无关：预算通路已删，小上限不再吞掉档位字段", () => {
    const body = anthropicBody({
      ...base,
      maxTokens: 500,
      presetId: "deepseek",
      thinkingLevel: "high",
      model: "deepseek-v3.2",
      messages: []
    });
    expect(body.max_tokens).toBe(500);
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.output_config).toEqual({ effort: "high" });
  });

  it("查不到思考事实（unknown）不发 thinking 字段", () => {
    const body = anthropicBody({
      ...base,
      thinkingLevel: "high",
      messages: []
    });
    expect(body.thinking).toBeUndefined();
  });

  it("effort 词汇平台（stepfun）：发 output_config.effort，不发 thinking", () => {
    const high = anthropicBody({
      ...base,
      baseUrl: "https://api.stepfun.com/step_plan",
      presetId: "stepfun",
      thinkingLevel: "high",
      model: "step-3.7-flash",
      messages: []
    });
    expect(high.output_config).toEqual({ effort: "high" });
    expect(high.thinking).toBeUndefined();

    const low = anthropicBody({
      ...base,
      baseUrl: "https://api.stepfun.com/step_plan",
      presetId: "stepfun",
      thinkingLevel: "low",
      model: "step-3.7-flash",
      messages: []
    });
    expect(low.output_config).toEqual({ effort: "low" });
    expect(low.thinking).toBeUndefined();
  });

  it("effort 词汇平台（amd）：向上游投影出的 reasoning_effort 原样作为 effort", () => {
    const body = anthropicBody({
      ...base,
      baseUrl: "https://developer.amd.com.cn/radeon/api",
      presetId: "amd",
      thinkingLevel: "high",
      model: "DeepSeek-V4-Flash",
      messages: []
    });
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.thinking).toBeUndefined();
  });

  it("effort 词汇平台：off（reasoning_effort none）与探针一律不发 output_config", () => {
    const off = anthropicBody({
      ...base,
      baseUrl: "https://token.sensenova.cn/v1",
      presetId: "sensenova",
      thinkingLevel: "off",
      model: "sensenova-6.8-flash-lite",
      messages: []
    });
    expect(off.output_config).toBeUndefined();
    expect(off.thinking).toEqual({ type: "disabled" });

    const probe = anthropicBody({
      ...base,
      baseUrl: "https://api.stepfun.com/step_plan",
      presetId: "stepfun",
      probe: true,
      maxTokens: 1,
      thinkingLevel: "high",
      model: "step-3.7-flash",
      messages: []
    });
    expect(probe.output_config).toBeUndefined();
    expect(probe.thinking).toBeUndefined();
  });

  it("custom 平台直填 stepfun 域（host 推断）同样走 effort 词汇", () => {
    const body = anthropicBody({
      ...base,
      baseUrl: "https://api.stepfun.com/step_plan",
      presetId: "custom",
      thinkingLevel: "high",
      model: "step-3.7-flash",
      messages: []
    });
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.thinking).toBeUndefined();
  });

  it("openrouter：档位走 output_config.effort，不发 thinking（其 thinking.enabled 必带预算）", () => {
    const body = anthropicBody({
      ...base,
      baseUrl: "https://openrouter.ai/api",
      presetId: "openrouter",
      thinkingLevel: "high",
      model: "anthropic/claude-opus-4.5",
      messages: []
    });
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.thinking).toBeUndefined();
  });
});

describe("images 线格式（image-input 路线 B：content 翻译）", () => {
  const base = { model: "claude-x", stream: false, probe: false, baseUrl: "https://api.anthropic.com" };
  const IMAGE = { mime: "image/webp", data: "QUJD" };

  it("无图消息：images 字段不上线，多消息时仅在倒数第二条附加滚动缓存断点", () => {
    const body = anthropicBody({
      ...base,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "yo" }
      ]
    });
    expect(JSON.stringify(body)).toBe(
      '{"model":"claude-x","messages":[{"role":"user","content":[{"type":"text","text":"hi","cache_control":{"type":"ephemeral"}}]},{"role":"assistant","content":"yo"}],"stream":false,"max_tokens":32768}'
    );
  });

  it("images: []（空数组）与缺省同形：content 保持字符串", () => {
    const body = anthropicBody({ ...base, messages: [{ role: "user", content: "hi", images: [] }] });
    expect(JSON.stringify(body)).toBe(
      '{"model":"claude-x","messages":[{"role":"user","content":"hi"}],"stream":false,"max_tokens":32768}'
    );
  });

  it("带图消息：text 块 + image 块（base64 源，media_type 取消息 mime）", () => {
    const body = anthropicBody({
      ...base,
      messages: [{ role: "user", content: "这张图里是什么", images: [IMAGE, { mime: "image/png", data: "REVG" }] }]
    });
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "这张图里是什么" },
          { type: "image", source: { type: "base64", media_type: "image/webp", data: "QUJD" } },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "REVG" } }
        ]
      }
    ]);
  });

  it("纯图消息（正文空）：只发 image 块，不发空 text 块（空 text 块会 400）", () => {
    const body = anthropicBody({ ...base, messages: [{ role: "user", content: "", images: [IMAGE] }] });
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/webp", data: "QUJD" } }] }
    ]);
  });
});

describe("preserved thinking / signature 回放（buildBody / drainStream / parseResponse）", () => {
  const base = { model: "claude-opus-4-5", stream: false, probe: false, baseUrl: "https://api.anthropic.com" };

  it("buildBody: 含 tool_calls 的 assistant 消息在 text / tool_use 之前原样附带 thinking 与 redacted_thinking 块，并忽略无签名思考块", () => {
    const body = anthropicBody({
      ...base,
      messages: [
        { role: "user", content: "查一下资料" },
        {
          role: "assistant",
          content: "我先搜索一下",
          thinkingBlocks: [
            { type: "thinking", thinking: "第一步先检索", signature: "sig_abc_1" },
            { type: "thinking", thinking: "无签名应跳过", signature: "" },
            { type: "redacted_thinking", data: "redacted_blob_xyz" }
          ],
          tool_calls: [
            { id: "tu_1", type: "function", function: { name: "web_search", arguments: '{"query":"test"}' } }
          ]
        },
        { role: "tool", tool_call_id: "tu_1", content: "[]" }
      ]
    });

    expect(body.messages).toEqual([
      { role: "user", content: "查一下资料" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "第一步先检索", signature: "sig_abc_1" },
          { type: "redacted_thinking", data: "redacted_blob_xyz" },
          { type: "text", text: "我先搜索一下" },
          { type: "tool_use", id: "tu_1", name: "web_search", input: { query: "test" }, cache_control: { type: "ephemeral" } }
        ]
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "[]" }] }
    ]);
  });

  describe("Prompt Caching 显式 cache_control 断点（#28）", () => {
    function countCacheControlBlocks(body: Record<string, unknown>): number {
      let count = 0;
      const walk = (node: unknown) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) {
          for (const item of node) walk(item);
          return;
        }
        const record = node as Record<string, unknown>;
        if (record.cache_control) count += 1;
        for (const value of Object.values(record)) walk(value);
      };
      walk(body);
      return count;
    }

    it("单轮首问仅在顶层 system 挂载 1 个断点，单条 user 消息保持纯字符串不挂断点", () => {
      const body = anthropicBody({
        ...base,
        messages: [
          { role: "system", content: "静态系统指令" },
          { role: "user", content: "第一轮问题" }
        ]
      });

      expect(body.system).toEqual([
        { type: "text", text: "静态系统指令", cache_control: { type: "ephemeral" } }
      ]);
      expect(body.messages).toEqual([{ role: "user", content: "第一轮问题" }]);
      expect(countCacheControlBlocks(body)).toBe(1);
    });

    it("多轮对话在 system 与 anthropicMessages[len - 2] 挂 2 个断点，纯文本转为结构化块", () => {
      const body = anthropicBody({
        ...base,
        messages: [
          { role: "system", content: "静态系统指令" },
          { role: "user", content: "第一轮问题" },
          { role: "assistant", content: "第一轮回答" },
          { role: "user", content: "第二轮追问" }
        ]
      });

      expect(body.system).toEqual([
        { type: "text", text: "静态系统指令", cache_control: { type: "ephemeral" } }
      ]);
      expect(body.messages).toEqual([
        { role: "user", content: "第一轮问题" },
        { role: "assistant", content: [{ type: "text", text: "第一轮回答", cache_control: { type: "ephemeral" } }] },
        { role: "user", content: "第二轮追问" }
      ]);
      expect(countCacheControlBlocks(body)).toBe(2);
    });

    it("连续多条 role: tool 合并为单条 user 后，断点精准落在合并后目标数组倒数第二条的最后一个 tool_result 块", () => {
      const body = anthropicBody({
        ...base,
        messages: [
          { role: "system", content: "静态系统指令" },
          { role: "user", content: "查画面和搜索" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "tu_1", type: "function", function: { name: "web_search", arguments: '{"query":"a"}' } },
              { id: "tu_2", type: "function", function: { name: "capture_current_video_frame", arguments: "{}" } }
            ]
          },
          { role: "tool", tool_call_id: "tu_1", content: "search-result" },
          { role: "tool", tool_call_id: "tu_2", content: "已截取画面" },
          { role: "user", content: "附带截图", images: [{ mime: "image/jpeg", data: "QUJD" }] }
        ]
      });

      const msgs = body.messages as Array<{ role: string; content: unknown }>;
      expect(msgs).toHaveLength(4);
      expect(msgs[2]).toEqual({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "search-result" },
          { type: "tool_result", tool_use_id: "tu_2", content: "已截取画面", cache_control: { type: "ephemeral" } }
        ]
      });
      expect(countCacheControlBlocks(body)).toBe(2);
    });

    it("含 thinkingBlocks 的历史 assistant 消息绝不在 thinking / redacted_thinking 块上挂 cache_control", () => {
      const withText = anthropicBody({
        ...base,
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "q1" },
          {
            role: "assistant",
            content: "a1",
            thinkingBlocks: [
              { type: "thinking", thinking: "先思考", signature: "sig_1" },
              { type: "redacted_thinking", data: "opaque_1" }
            ]
          },
          { role: "user", content: "q2" }
        ]
      });
      expect(withText.messages).toEqual([
        { role: "user", content: "q1" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "先思考", signature: "sig_1" },
            { type: "redacted_thinking", data: "opaque_1" },
            { type: "text", text: "a1", cache_control: { type: "ephemeral" } }
          ]
        },
        { role: "user", content: "q2" }
      ]);
      expect(countCacheControlBlocks(withText)).toBe(2);

      const onlyThinking = anthropicBody({
        ...base,
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "q1" },
          {
            role: "assistant",
            content: "",
            thinkingBlocks: [
              { type: "thinking", thinking: "仅思考", signature: "sig_2" },
              { type: "redacted_thinking", data: "opaque_2" }
            ]
          },
          { role: "user", content: "q2" }
        ]
      });
      const onlyThinkingMsgs = onlyThinking.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
      expect(onlyThinkingMsgs[1].content.every((block) => block.cache_control === undefined)).toBe(true);
      expect(countCacheControlBlocks(onlyThinking)).toBe(1);
    });

    it("倒数第二条为图片消息时在最后一个 image 块挂断点，总断点数恒 <= 2", () => {
      const body = anthropicBody({
        ...base,
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "", images: [{ mime: "image/webp", data: "QUJD" }] },
          { role: "assistant", content: "看到了" }
        ]
      });
      expect(body.messages).toEqual([
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/webp", data: "QUJD" },
              cache_control: { type: "ephemeral" }
            }
          ]
        },
        { role: "assistant", content: "看到了" }
      ]);
      expect(countCacheControlBlocks(body)).toBe(2);
    });
  });

  it("drainStream: 收集 thinking_delta / signature_delta 与 redacted_thinking，按块 index 顺序返回 thinkingBlocks", async () => {
    const chunks = [
      anthropicSseData({ type: "message_start", message: { id: "msg_t1" } }),
      anthropicSseData({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      anthropicSseData({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "先分析" } }),
      anthropicSseData({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "再检索" } }),
      anthropicSseData({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_part1_" } }),
      anthropicSseData({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "part2" } }),
      anthropicSseData({ type: "content_block_stop", index: 0 }),
      anthropicSseData({ type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "opaque_data_99" } }),
      anthropicSseData({ type: "content_block_stop", index: 1 }),
      anthropicSseData({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu_7", name: "web_search" } }),
      anthropicSseData({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"query":"claude"}' } }),
      anthropicSseData({ type: "content_block_stop", index: 2 }),
      anthropicSseData({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
      anthropicSseData({ type: "message_stop" })
    ];
    const events: StreamChatEvent[] = [];
    const result = await anthropicAdapter.drainStream(sseResponse(chunks), { onEvent: (e) => events.push(e) });

    expect(result.thinkingBlocks).toEqual([
      { type: "thinking", thinking: "先分析再检索", signature: "sig_part1_part2" },
      { type: "redacted_thinking", data: "opaque_data_99" }
    ]);
    expect(result.toolCalls).toEqual([
      { id: "tu_7", type: "function", function: { name: "web_search", arguments: '{"query":"claude"}' } }
    ]);
    expect(result.finishReason).toBe("tool_calls");
    expect(events).toEqual([
      { type: "reasoning", data: "先分析" },
      { type: "reasoning", data: "再检索" },
      { type: "tool-call", name: "web_search", args: { query: "claude" } }
    ]);
  });

  it("drainStream: 仅有 thinking_delta 无 signature_delta 时正常吐 reasoning 且不产出无效 thinkingBlocks", async () => {
    const chunks = [
      anthropicSseData({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      anthropicSseData({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "草稿" } }),
      anthropicSseData({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "正文" } }),
      anthropicSseData({ type: "message_delta", delta: { stop_reason: "end_turn" } })
    ];
    const events: StreamChatEvent[] = [];
    const result = await anthropicAdapter.drainStream(sseResponse(chunks), { onEvent: (e) => events.push(e) });

    expect(result.thinkingBlocks).toBeUndefined();
    expect(result.content).toBe("正文");
    expect(events).toEqual([
      { type: "reasoning", data: "草稿" },
      { type: "token", data: "正文" }
    ]);
  });

  it("parseResponse: 非流式响应提取 thinking(带 signature) 与 redacted_thinking，跳过缺签名的 thinking 块", () => {
    const result = anthropicAdapter.parseResponse({
      content: [
        { type: "thinking", thinking: "深度推理", signature: "sig_nonstream_1" },
        { type: "thinking", thinking: "无签名块" },
        { type: "redacted_thinking", data: "redacted_nonstream_2" },
        { type: "text", text: "调用工具" },
        { type: "tool_use", id: "tu_2", name: "web_search", input: { query: "anthropic" } }
      ],
      stop_reason: "tool_use"
    });

    expect(result).toEqual({
      content: "调用工具",
      toolCalls: [{ id: "tu_2", type: "function", function: { name: "web_search", arguments: '{"query":"anthropic"}' } }],
      finishReason: "tool_calls",
      thinkingBlocks: [
        { type: "thinking", thinking: "深度推理", signature: "sig_nonstream_1" },
        { type: "redacted_thinking", data: "redacted_nonstream_2" }
      ]
    });
  });
});

describe("drainStream（SSE 事件映射，research §3）", () => {
  it("全事件会话：text/thinking 增量、tool_use 聚合、stop_reason、未知事件宽容", async () => {
    const chunks = [
      anthropicSseData({ type: "message_start", message: { id: "msg_1" } }),
      anthropicSseData({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      anthropicSseData({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想" } }),
      anthropicSseData({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } }),
      anthropicSseData({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "世界" } }),
      anthropicSseData({ type: "content_block_stop", index: 0 }),
      anthropicSseData({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_9", name: "web_search" } }),
      anthropicSseData({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"quer" } }),
      anthropicSseData({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "y\":\"x\"}" } }),
      anthropicSseData({ type: "content_block_stop", index: 1 }),
      "data: {bad json\n\n",
      anthropicSseData({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
      anthropicSseData({ type: "ping" }),
      anthropicSseData({ type: "future_unknown_event", foo: 1 }),
      anthropicSseData({ type: "message_stop" })
    ];
    const events: StreamChatEvent[] = [];
    const result = await anthropicAdapter.drainStream(sseResponse(chunks), { onEvent: (e) => events.push(e) });

    expect(result.content).toBe("你好世界");
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      { id: "tu_9", type: "function", function: { name: "web_search", arguments: "{\"query\":\"x\"}" } }
    ]);
    expect(events).toEqual([
      { type: "reasoning", data: "想" },
      { type: "token", data: "你好" },
      { type: "token", data: "世界" },
      { type: "tool-call", name: "web_search", args: { query: "x" } }
    ]);
  });

  it("流内 error 事件 → 抛错走 core 读流中断重试（overloaded_error 可重试语义）", async () => {
    const chunks = [
      anthropicSseData({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "部分" } }),
      anthropicSseData({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
      anthropicSseData({ type: "message_stop" })
    ];

    await expect(anthropicAdapter.drainStream(sseResponse(chunks), {})).rejects.toThrow("[anthropic] overloaded_error: Overloaded");
  });

  it("signal 已中止 → 抛 aborted 错误（core 统一收束）", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      anthropicAdapter.drainStream(sseResponse([anthropicSseData({ type: "message_start" })]), { signal: controller.signal })
    ).rejects.toMatchObject({ aborted: true });
  });
});

describe("parseResponse（非流式，research §5）", () => {
  it("text 块顺序拼接无分隔符；stop_reason 映射回 OpenAI 词表（限制点 7/13）", () => {
    const result = anthropicAdapter.parseResponse({
      content: [{ type: "text", text: "甲" }, { type: "text", text: "乙" }],
      stop_reason: "end_turn"
    });
    expect(result).toEqual({ content: "甲乙", toolCalls: [], finishReason: "stop" });
    for (const [raw, mapped] of [["tool_use", "tool_calls"], ["max_tokens", "length"], ["stop_sequence", "stop"], ["refusal", "stop"]]) {
      expect(anthropicAdapter.parseResponse({ content: [], stop_reason: raw }).finishReason).toBe(mapped);
    }
  });

  it("tool_use 块回转为 ChatToolCall（arguments JSON 化）", () => {
    const result = anthropicAdapter.parseResponse({
      content: [
        { type: "tool_use", id: "tu_1", name: "web_search", input: { query: "abc" } },
        { type: "text", text: "好的" }
      ],
      stop_reason: "tool_use"
    });
    expect(result.content).toBe("好的");
    expect(result.toolCalls).toEqual([
      { id: "tu_1", type: "function", function: { name: "web_search", arguments: "{\"query\":\"abc\"}" } }
    ]);
    expect(result.finishReason).toBe("tool_calls");
  });

  it("缺 content / stop_reason → 空串与 null", () => {
    expect(anthropicAdapter.parseResponse({})).toEqual({ content: "", toolCalls: [], finishReason: null });
  });
});

describe("extractErrorDetail（research §6）", () => {
  it("错误 envelope：type + message", () => {
    expect(anthropicAdapter.extractErrorDetail(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "max_tokens 必填" } })))
      .toBe("invalid_request_error: max_tokens 必填");
  });

  it("缺 type / 缺 message / 非 JSON → 宽容回落", () => {
    expect(anthropicAdapter.extractErrorDetail(JSON.stringify({ error: { message: "只有消息" } }))).toBe("只有消息");
    expect(anthropicAdapter.extractErrorDetail(JSON.stringify({ error: { type: "只有类型" } }))).toBe("只有类型");
    expect(anthropicAdapter.extractErrorDetail("plain text")).toBe("plain text");
  });
});

describe("chatCompletion 经 anthropic 协议端到端（core 骨架零改动）", () => {
  it("流式：onEvent 收 token/done 归一事件，返回 { done: true, finishReason }", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => sseResponse([
      anthropicSseData({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "流" } }),
      anthropicSseData({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
      anthropicSseData({ type: "message_stop" })
    ]));
    const events: StreamChatEvent[] = [];
    const result = await chatCompletion({
      provider: { baseUrl: "https://api.anthropic.com", model: "claude-x", apiKey: "sk-ant", protocol: "anthropic" },
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      onEvent: (e) => events.push(e),
      fetchImpl: fetchMock
    });

    expect(result).toEqual({ done: true, finishReason: "stop" });
    expect(events).toEqual([{ type: "token", data: "流" }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant");
  });

  it("HTTP 错误：detail 带 [anthropic] 前缀（core 统一加）与截断", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => ({
      ok: false,
      status: 400,
      text: vi.fn(async () => JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 99 tokens > 9 maximum" } }))
    }) as unknown as Response);

    await expect(
      chatCompletion({
        provider: { baseUrl: "https://api.anthropic.com", model: "claude-x", protocol: "anthropic" },
        messages: [],
        retries: 0,
        fetchImpl: fetchMock
      })
    ).rejects.toMatchObject({ overflow: true });
  });
});
