import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { chatCompletion } from "../../extension/ai/completion.js";
import {
  INDEX_TRANSLATE_BASE_URL,
  INDEX_TRANSLATE_BUILTIN_PROVIDER,
  INDEX_TRANSLATE_DEFAULT_MODEL,
  INDEX_TRANSLATE_MODEL,
  INDEX_TRANSLATE_MODELS,
  INDEX_TRANSLATE_MODEL_OPTIONS,
  INDEX_TRANSLATE_PROVIDER_ID,
  buildSubtitleTranslateRequest,
  createIndexTranslateRateLimiter,
  createIndexTranslateResolution,
  createThinkBlockStreamFilter,
  isIndexTranslateModelId,
  isIndexTranslateProvider,
  normalizeIndexTranslateModel,
  stripThinkBlocks,
  translateSubtitleItems
} from "../../extension/ai/subtitle-translate.js";
import {
  INDEX_TRANSLATE_USER_AGENT,
  resolveSubtitleTranslateProviderConfig
} from "../../extension/ai/subtitle-translate-config.js";
import {
  computeIndexTranslateBackoffMs,
  runWithIndexTranslateRetry
} from "../../extension/ai/index-translate.js";
import {
  INDEX_TRANSLATE_DOMAIN,
  INDEX_TRANSLATE_ORIGIN_HEADER,
  INDEX_TRANSLATE_SESSION_RULE_ID,
  INDEX_TRANSLATE_USER_AGENT_VALUE,
  ensureIndexTranslateSessionRule
} from "../../extension/core/offscreen-host.js";

function createSseResponse(chunks: readonly string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });
  return new Response(stream, {
    status,
    headers: { "Content-Type": "text/event-stream; charset=utf-8" }
  });
}

describe("Bilibili Index-Translate 内置配置解析", () => {
  it("选择 bilibili-index-translate 时即使无已保存 AI 平台与 Key 也能免 Key 解析", () => {
    const resolution = resolveSubtitleTranslateProviderConfig([], {}, {
      subtitleTranslateProviderId: INDEX_TRANSLATE_PROVIDER_ID
    });

    expect(resolution.isFallback).toBe(false);
    expect(resolution.provider).toEqual(INDEX_TRANSLATE_BUILTIN_PROVIDER);
    expect(resolution.apiKey).toBe("");
    expect(resolution.baseUrl).toBe("https://index-translate.bilibili.com/v1");
    expect(resolution.model).toBe("Index-Translate-35B-A3B");
    expect(resolution.presetId).toBe(INDEX_TRANSLATE_PROVIDER_ID);
    expect(resolution.protocol).toBe("openai");
  });

  it("支持 3 个模型枚举，显式选择、缺省空选或未知模型时均按规范归一化并免 Key 解析", () => {
    expect(INDEX_TRANSLATE_DEFAULT_MODEL).toBe("Index-Translate-35B-A3B");
    expect([...INDEX_TRANSLATE_MODELS]).toEqual([
      "Index-Translate-35B-A3B",
      "Index-Translate-9B",
      "Index-Translate-2B"
    ]);
    expect(INDEX_TRANSLATE_BUILTIN_PROVIDER.models).toEqual([...INDEX_TRANSLATE_MODELS]);
    expect(INDEX_TRANSLATE_MODEL_OPTIONS.map((item) => item.id)).toEqual([...INDEX_TRANSLATE_MODELS]);
    expect(INDEX_TRANSLATE_MODEL_OPTIONS.every((item) => item.available)).toBe(true);

    expect(isIndexTranslateModelId("Index-Translate-35B-A3B")).toBe(true);
    expect(isIndexTranslateModelId("Index-Translate-9B")).toBe(true);
    expect(isIndexTranslateModelId("Index-Translate-2B")).toBe(true);
    expect(isIndexTranslateModelId("unknown")).toBe(false);

    expect(normalizeIndexTranslateModel("")).toBe("Index-Translate-35B-A3B");
    expect(normalizeIndexTranslateModel("index-translate-9b")).toBe("Index-Translate-9B");
    expect(normalizeIndexTranslateModel("index-translate-2b")).toBe("Index-Translate-2B");
    expect(normalizeIndexTranslateModel("unsupported-model")).toBe("Index-Translate-35B-A3B");

    for (const model of INDEX_TRANSLATE_MODELS) {
      const resolved = resolveSubtitleTranslateProviderConfig([], {}, {
        subtitleTranslateProviderId: INDEX_TRANSLATE_PROVIDER_ID,
        subtitleTranslateModel: model
      });
      expect(resolved.model).toBe(model);
      expect(resolved.baseUrl).toBe(INDEX_TRANSLATE_BASE_URL);
      expect(resolved.apiKey).toBe("");
    }

    const defaultResolved = resolveSubtitleTranslateProviderConfig([], {}, { subtitleTranslateProviderId: "" });
    expect(defaultResolved.isFallback).toBe(false);
    expect(defaultResolved.provider.id).toBe(INDEX_TRANSLATE_PROVIDER_ID);
    expect(defaultResolved.model).toBe("Index-Translate-35B-A3B");
    expect(defaultResolved.apiKey).toBe("");
  });

  it("isIndexTranslateProvider 支持按 id / presetId / baseUrl 域名识别", () => {
    expect(isIndexTranslateProvider({ id: INDEX_TRANSLATE_PROVIDER_ID })).toBe(true);
    expect(isIndexTranslateProvider({ presetId: INDEX_TRANSLATE_PROVIDER_ID })).toBe(true);
    expect(isIndexTranslateProvider({ baseUrl: "https://index-translate.bilibili.com/v1" })).toBe(true);
    expect(isIndexTranslateProvider({ baseUrl: "https://api.deepseek.com/v1", presetId: "deepseek" })).toBe(false);
    expect(isIndexTranslateProvider({ baseUrl: "not-a-url" })).toBe(false);
    expect(isIndexTranslateProvider(null)).toBe(false);
  });
});

describe("Bilibili Index-Translate 请求构造（temperature: 0 & enable_thinking: false）", () => {
  it("请求体显式传 temperature: 0 与 chat_template_kwargs.enable_thinking: false，且免 Key 不强制 Authorization", async () => {
    const capturedRequests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedRequests.push({
        url: String(input),
        headers: (init?.headers || {}) as Record<string, string>,
        body: JSON.parse(String(init?.body || "{}")) as Record<string, unknown>
      });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify([{ id: "0", translation: "你好，世界" }])
              },
              finish_reason: "stop"
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const req = buildSubtitleTranslateRequest({
      provider: {
        id: INDEX_TRANSLATE_PROVIDER_ID,
        presetId: INDEX_TRANSLATE_PROVIDER_ID,
        baseUrl: INDEX_TRANSLATE_BASE_URL,
        apiKey: "",
        model: INDEX_TRANSLATE_MODEL
      },
      messages: [
        { role: "system", content: "Translate" },
        { role: "user", content: '[{"id":"0","text":"Hello world"}]' }
      ],
      stream: false,
      thinkingLevel: "high",
      fetchImpl: fakeFetch
    });

    expect(req.temperature).toBe(0);
    expect(req.extraBody).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(req.thinkingLevel).toBe("off");

    const output = await chatCompletion(req);
    expect(output).toBe('[{"id":"0","translation":"你好，世界"}]');

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].url).toBe("https://index-translate.bilibili.com/v1/chat/completions");
    expect(capturedRequests[0].headers.Authorization).toBeUndefined();
    expect(capturedRequests[0].body).toMatchObject({
      model: "Index-Translate-35B-A3B",
      stream: false,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false }
    });
  });

  it.each(INDEX_TRANSLATE_MODELS)(
    "模型 %s 共用端点与免 Key 请求构造，并显式传 temperature: 0 与 enable_thinking: false",
    async (modelId) => {
      const capturedBodies: Array<Record<string, unknown>> = [];
      const capturedUrls: string[] = [];
      const capturedHeaders: Array<Record<string, string>> = [];
      const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrls.push(String(input));
        capturedHeaders.push((init?.headers || {}) as Record<string, string>);
        capturedBodies.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '[{"id":"0","translation":"你好"}]' }, finish_reason: "stop" }]
          }),
          { status: 200 }
        );
      });

      const req = buildSubtitleTranslateRequest({
        provider: {
          id: INDEX_TRANSLATE_PROVIDER_ID,
          presetId: INDEX_TRANSLATE_PROVIDER_ID,
          baseUrl: INDEX_TRANSLATE_BASE_URL,
          apiKey: "",
          model: modelId
        },
        messages: [
          { role: "system", content: "Translate" },
          { role: "user", content: '[{"id":"0","text":"Hello"}]' }
        ],
        stream: false,
        thinkingLevel: "high",
        fetchImpl: fakeFetch
      });

      await chatCompletion(req);

      expect(capturedUrls).toEqual(["https://index-translate.bilibili.com/v1/chat/completions"]);
      expect(capturedHeaders[0].Authorization).toBeUndefined();
      expect(capturedBodies[0]).toMatchObject({
        model: modelId,
        stream: false,
        temperature: 0,
        chat_template_kwargs: { enable_thinking: false }
      });
    }
  );

  it("支持传入占位 Key（如 index）时携带 Bearer 请求头，且不影响普通平台请求体", async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];
    const capturedHeaders: Array<Record<string, string>> = [];
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders.push((init?.headers || {}) as Record<string, string>);
      capturedBodies.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
        { status: 200 }
      );
    });

    const indexReq = buildSubtitleTranslateRequest({
      provider: {
        presetId: INDEX_TRANSLATE_PROVIDER_ID,
        baseUrl: INDEX_TRANSLATE_BASE_URL,
        apiKey: "index",
        model: INDEX_TRANSLATE_MODEL
      },
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      fetchImpl: fakeFetch
    });
    await chatCompletion(indexReq);

    expect(capturedHeaders[0].Authorization).toBe("Bearer index");
    expect(capturedBodies[0].temperature).toBe(0);
    expect(capturedBodies[0].chat_template_kwargs).toEqual({ enable_thinking: false });

    const normalReq = buildSubtitleTranslateRequest({
      provider: {
        presetId: "deepseek",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "sk-real",
        model: "deepseek-chat"
      },
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      fetchImpl: fakeFetch
    });
    await chatCompletion(normalReq);

    expect(capturedBodies[1]).not.toHaveProperty("temperature");
    expect(capturedBodies[1]).not.toHaveProperty("chat_template_kwargs");
  });
});

describe("<think>...</think> 兜底清洗", () => {
  it("stripThinkBlocks 剔除单个/多个/跨行/大小写与未闭合 <think> 块", () => {
    expect(stripThinkBlocks('<think>内部推理\n第二行</think>\n[{"id":"0","translation":"你好"}]')).toBe(
      '[{"id":"0","translation":"你好"}]'
    );
    expect(
      stripThinkBlocks('<THINK>a</THINK>hello<think>b</think> world')
    ).toBe("hello world");
    expect(stripThinkBlocks('[{"id":"0","translation":"你好"}]<think>截断的思考')).toBe(
      '[{"id":"0","translation":"你好"}]'
    );
  });

  it("createThinkBlockStreamFilter 在跨分片边界正确过滤 <think> 且保留普通 < 文本", () => {
    const emitted: string[] = [];
    const filter = createThinkBlockStreamFilter((chunk) => emitted.push(chunk));

    const chunks = [
      "<th",
      "ink>先想一下",
      "如何翻译 {",
      '"ignored": true}</th',
      'ink>\n{"groups":[{"ids":["0"],"text":"a < b","translation":"a < b"}]}'
    ];
    for (const chunk of chunks) {
      filter.push(chunk);
    }
    filter.flush();

    expect(emitted.join("")).toBe('\n{"groups":[{"ids":["0"],"text":"a < b","translation":"a < b"}]}');

    const partialEmitted: string[] = [];
    const partialFilter = createThinkBlockStreamFilter((chunk) => partialEmitted.push(chunk));
    partialFilter.push("x <");
    partialFilter.push(" y");
    partialFilter.flush();
    expect(partialEmitted.join("")).toBe("x < y");
  });

  it("translateSubtitleItems 流式与非流式路径遇到意外 <think> 块时均可正确剔除并完成翻译", async () => {
    const resolved = createIndexTranslateResolution();
    const items = [
      { from: 0, to: 2, content: "Hello world" },
      { from: 2, to: 4, content: "Good night" }
    ];

    // 1. 流式 SSE 分片含跨 chunk 的 <think>...</think>
    const sseFetch = vi.fn(async () =>
      createSseResponse([
        'data: {"choices":[{"delta":{"content":"<th"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"ink>thinking {bad json}</th"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"ink>[{\\"id\\":\\"0\\",\\"translation\\":\\"你好，世界\\"},"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"{\\"id\\":\\"1\\",\\"translation\\":\\"晚安\\"}]"}}]}\n\n',
        "data: [DONE]\n\n"
      ])
    );

    const onCueReady = vi.fn();
    const streamResult = await translateSubtitleItems({
      items,
      targetLang: "zh",
      providerResolution: resolved,
      stream: true,
      onCueReady,
      fetchImpl: sseFetch,
      indexTranslateOptions: { baseDelayMs: 0 }
    });

    expect(onCueReady).toHaveBeenCalledTimes(2);
    expect(streamResult).toEqual([
      { from: 0, to: 2, content: "你好，世界" },
      { from: 2, to: 4, content: "晚安" }
    ]);

    // 2. 非流式响应含 <think>...</think>
    const nonStreamFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '<think>reasoning...</think>[{"id":"0","translation":"你好"},{"id":"1","translation":"晚安"}]'
              },
              finish_reason: "stop"
            }
          ]
        }),
        { status: 200 }
      )
    );

    const nonStreamResult = await translateSubtitleItems({
      items,
      targetLang: "zh",
      providerResolution: resolved,
      stream: false,
      fetchImpl: nonStreamFetch,
      indexTranslateOptions: { baseDelayMs: 0 }
    });

    expect(nonStreamResult).toEqual([
      { from: 0, to: 2, content: "你好" },
      { from: 2, to: 4, content: "晚安" }
    ]);
  });
});

describe("并发节流、429 与网络抖动退避重试", () => {
  it("限流器严格限制并发度 <= 2 且每 1000ms 窗口不超过 3 次请求", async () => {
    let fakeNow = 0;
    const sleepLog: number[] = [];
    const startTimes: number[] = [];

    const limiter = createIndexTranslateRateLimiter({
      maxConcurrency: 2,
      maxRequestsPerWindow: 3,
      windowMs: 1000,
      now: () => fakeNow,
      sleep: async (ms) => {
        sleepLog.push(ms);
        await Promise.resolve();
        fakeNow += ms;
      }
    });

    let active = 0;
    let peakActive = 0;
    const tasks = Array.from({ length: 6 }, (_, idx) =>
      limiter.run(async () => {
        startTimes.push(fakeNow);
        active += 1;
        peakActive = Math.max(peakActive, active);
        await Promise.resolve();
        fakeNow += 50;
        active -= 1;
        return idx;
      })
    );

    const results = await Promise.all(tasks);
    expect(results).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peakActive).toBeLessThanOrEqual(2);
    expect(sleepLog.some((ms) => ms > 0)).toBe(true);

    // 验证任意 1000ms 滑动窗口内发起的请求数不超过 3
    for (let i = 0; i < startTimes.length; i += 1) {
      const countInWindow = startTimes.filter(
        (t) => t >= startTimes[i] && t < startTimes[i] + 1000
      ).length;
      expect(countInWindow).toBeLessThanOrEqual(3);
    }
  });

  it("队列等待期间触发 AbortSignal 立即中止且不占用并发槽", async () => {
    const controller = new AbortController();
    const limiter = createIndexTranslateRateLimiter({
      maxConcurrency: 1,
      maxRequestsPerWindow: 3,
      windowMs: 1000
    });

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = limiter.run(() => firstGate);
    const secondTask = vi.fn(async () => "ok");
    const second = limiter.run(secondTask, controller.signal);

    controller.abort();
    await expect(second).rejects.toThrow(/aborted/i);
    expect(secondTask).not.toHaveBeenCalled();

    releaseFirst();
    await first;
    expect(limiter.getSnapshot().active).toBe(0);
  });

  it("遇到 HTTP 429 时执行指数退避重试并写入共享冷却窗口，成功后返回结果", async () => {
    const backoffDelays: number[] = [];
    let currentTime = 100;
    const limiter = createIndexTranslateRateLimiter({
      maxConcurrency: 2,
      maxRequestsPerWindow: 3,
      windowMs: 1000,
      now: () => currentTime,
      sleep: async (ms) => {
        currentTime += ms;
      }
    });

    let callCount = 0;
    const fakeFetch = vi.fn(async () => {
      callCount += 1;
      if (callCount <= 2) {
        return new Response(JSON.stringify({ error: { message: "Too Many Requests" } }), { status: 429 });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '[{"id":"0","translation":"限流后成功"}]' }, finish_reason: "stop" }]
        }),
        { status: 200 }
      );
    });

    const result = await translateSubtitleItems({
      items: [{ from: 0, to: 2, content: "Retry after 429" }],
      targetLang: "zh",
      providerResolution: createIndexTranslateResolution(),
      stream: false,
      fetchImpl: fakeFetch,
      indexTranslateOptions: {
        limiter,
        maxRetries: 3,
        baseDelayMs: 500,
        maxDelayMs: 5000,
        jitterRatio: 0,
        sleep: async (ms) => {
          backoffDelays.push(ms);
          currentTime += ms;
        }
      }
    });

    expect(callCount).toBe(3);
    expect(backoffDelays).toEqual([500, 1000]);
    expect(limiter.getSnapshot().cooldownUntil).toBeGreaterThanOrEqual(1000);
    expect(result).toEqual([{ from: 0, to: 2, content: "限流后成功" }]);
  });

  it("遇到网络抖动时退避重试并恢复；429 重试耗尽时抛出清晰中文错误", async () => {
    // 1. 网络抖动恢复
    let netAttempts = 0;
    const jitterSleep: number[] = [];
    const recovered = await runWithIndexTranslateRetry(
      async () => {
        netAttempts += 1;
        if (netAttempts === 1) {
          throw new Error("网络错误：Failed to fetch");
        }
        return "recovered";
      },
      {
        maxRetries: 2,
        baseDelayMs: 200,
        jitterRatio: 0,
        sleep: async (ms) => {
          jitterSleep.push(ms);
        },
        limiter: createIndexTranslateRateLimiter({ sleep: async () => {} })
      }
    );
    expect(recovered).toBe("recovered");
    expect(netAttempts).toBe(2);
    expect(jitterSleep).toEqual([200]);

    // 2. 429 耗尽重试 -> 清晰错误提示且保留 status=429
    const always429Fetch = vi.fn(async () => new Response("rate limit", { status: 429 }));
    let caughtError: (Error & { status?: number }) | null = null;
    try {
      await translateSubtitleItems({
        items: [{ from: 0, to: 2, content: "Always 429" }],
        targetLang: "zh",
        providerResolution: createIndexTranslateResolution(),
        stream: true,
        fetchImpl: always429Fetch,
        indexTranslateOptions: {
          limiter: createIndexTranslateRateLimiter(),
          maxRetries: 2,
          baseDelayMs: 100,
          jitterRatio: 0,
          sleep: async () => {}
        }
      });
    } catch (error) {
      caughtError = error as Error & { status?: number };
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError?.status).toBe(429);
    expect(caughtError?.message).toContain("429");
    expect(caughtError?.message).toContain("限流");
    expect(always429Fetch).toHaveBeenCalledTimes(3); // 首次 + 2 次退避重试，不再额外重复撞流降级
  });

  it("遇到 HTTP 412 风控拦截时不重试且直接给出清晰提示", async () => {
    const wafFetch = vi.fn(async () => new Response("<html>412</html>", { status: 412 }));

    await expect(
      translateSubtitleItems({
        items: [{ from: 0, to: 2, content: "WAF 412" }],
        targetLang: "zh",
        providerResolution: createIndexTranslateResolution(),
        stream: true,
        fetchImpl: wafFetch,
        indexTranslateOptions: {
          limiter: createIndexTranslateRateLimiter(),
          maxRetries: 3,
          sleep: async () => {}
        }
      })
    ).rejects.toThrow(/412/);

    expect(wafFetch).toHaveBeenCalledTimes(1);
  });

  it("computeIndexTranslateBackoffMs 按指数增长并受 maxDelayMs 封顶", () => {
    expect(computeIndexTranslateBackoffMs(0, { baseDelayMs: 1000, maxDelayMs: 5000, jitterRatio: 0 })).toBe(1000);
    expect(computeIndexTranslateBackoffMs(1, { baseDelayMs: 1000, maxDelayMs: 5000, jitterRatio: 0 })).toBe(2000);
    expect(computeIndexTranslateBackoffMs(2, { baseDelayMs: 1000, maxDelayMs: 5000, jitterRatio: 0 })).toBe(4000);
    expect(computeIndexTranslateBackoffMs(3, { baseDelayMs: 1000, maxDelayMs: 5000, jitterRatio: 0 })).toBe(5000);
  });
});

describe("Manifest 权限与 DNR 会话规则适配", () => {
  it("extension/manifest.json host_permissions 已声明 https://index-translate.bilibili.com/*", () => {
    const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8")) as {
      permissions?: string[];
      host_permissions?: string[];
    };
    expect(manifest.permissions).toContain("declarativeNetRequest");
    expect(manifest.host_permissions).toContain("https://index-translate.bilibili.com/*");
  });

  it("ensureIndexTranslateSessionRule 安装 DNR 会话规则注入合规 User-Agent 与 Origin", async () => {
    const updateSessionRules = vi.fn(async () => {});
    vi.stubGlobal("chrome", {
      ...globalThis.chrome,
      declarativeNetRequest: {
        updateSessionRules,
        getSessionRules: vi.fn(async () => [])
      }
    });

    await ensureIndexTranslateSessionRule();

    expect(updateSessionRules).toHaveBeenCalledTimes(1);
    expect(updateSessionRules).toHaveBeenCalledWith({
      removeRuleIds: [INDEX_TRANSLATE_SESSION_RULE_ID],
      addRules: [
        {
          id: INDEX_TRANSLATE_SESSION_RULE_ID,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "User-Agent", operation: "set", value: INDEX_TRANSLATE_USER_AGENT_VALUE },
              { header: "Origin", operation: "set", value: INDEX_TRANSLATE_ORIGIN_HEADER }
            ]
          },
          condition: {
            requestDomains: [INDEX_TRANSLATE_DOMAIN],
            resourceTypes: ["xmlhttprequest"]
          }
        }
      ]
    });
    expect(INDEX_TRANSLATE_USER_AGENT_VALUE).toBe(INDEX_TRANSLATE_USER_AGENT);
  });
});
