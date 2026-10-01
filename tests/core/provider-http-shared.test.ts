// tests/core/provider-http-shared.test.ts
// core/provider-http-shared.ts（平台请求代发两通道的公共件叶）单测：抽叶前两侧
// 逐字相同、抽叶后必须逐件同义的 9 组公共件，按件钉死现状语义——
// URL 提取 / Headers 归一 / 已中止短路判据 / errorText / Response status 归一 /
// makeAbortError / 接收端 URL 预检判据 / 接收端 fetch init 构造 / 出向载荷核心。
//
// 不在本文件内的（各侧自留，见 CONTEXT.md「平台请求代发」词条）：承载（消息 vs
// 端口）、超时（SW 15s vs offscreen 无）、中止机制（raceWithAbort vs onAbort +
// 端口释放）、回吐形态——两侧差异正是「不抽」的部分。
//
// 另有一条结构用例钉叶子纪律（零运行时依赖 + 零 chrome.* 触达）：本叶被 SW 图、
// content 懒区与 offscreen 文档三处消费，任何一条运行时 import 都会把别的语境
// 拖进来。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProviderFetchInit,
  buildProviderRequestPayload,
  errorText,
  extractRequestUrl,
  isRequestAborted,
  makeAbortError,
  normalizeRequestHeaders,
  normalizeResponseStatus,
  resolveRequestTarget
} from "../../extension/core/provider-http-shared.js";
import { extractOriginFromBaseUrl } from "../../extension/core/host-permissions.js";

describe("URL 提取（extractRequestUrl）", () => {
  it("三形态：字符串原样 / URL 实例取 href / Request 形取 url", () => {
    expect(extractRequestUrl("https://api.example.com/v1/chat")).toBe("https://api.example.com/v1/chat");
    expect(extractRequestUrl(new URL("https://api.example.com/v1/models?x=1"))).toBe(
      "https://api.example.com/v1/models?x=1"
    );
    expect(extractRequestUrl({ url: "https://api.example.com/v1/messages" } as unknown as Request)).toBe(
      "https://api.example.com/v1/messages"
    );
  });

  it("Request 形缺 url → 空串（后续预检据空串判非法）", () => {
    expect(extractRequestUrl({} as unknown as Request)).toBe("");
    expect(extractRequestUrl({ url: undefined } as unknown as Request)).toBe("");
  });
});

describe("Headers 归一（normalizeRequestHeaders）", () => {
  it("键统一小写（浏览器 fetch 语义同款），值不动", () => {
    expect(
      normalizeRequestHeaders({ Accept: "application/json", Authorization: "Bearer sk-1" })
    ).toEqual({ accept: "application/json", authorization: "Bearer sk-1" });
  });

  it("键大小写混写一并归一；数组形态与 Headers 实例同走标准归一", () => {
    expect(normalizeRequestHeaders({ "X-API-Key": "sk-1", "anthropic-version": "2023-06-01" })).toEqual({
      "x-api-key": "sk-1",
      "anthropic-version": "2023-06-01"
    });
    expect(normalizeRequestHeaders([["X-Api-Key", "sk-2"]])).toEqual({ "x-api-key": "sk-2" });
    expect(normalizeRequestHeaders(new Headers({ "X-Api-Key": "sk-3" }))).toEqual({ "x-api-key": "sk-3" });
  });

  it("缺省 → 空对象（出向载荷固定四键，不因缺头变形状）", () => {
    expect(normalizeRequestHeaders()).toEqual({});
    expect(normalizeRequestHeaders(undefined)).toEqual({});
  });
});

describe("已中止短路判据（isRequestAborted）", () => {
  it("已中止 → true；未中止 / 无 signal → false", () => {
    const controller = new AbortController();
    expect(isRequestAborted(undefined)).toBe(false);
    expect(isRequestAborted(null)).toBe(false);
    expect(isRequestAborted(controller.signal)).toBe(false);

    controller.abort();
    expect(isRequestAborted(controller.signal)).toBe(true);
  });
});

describe("错误文案归一（errorText）", () => {
  it("Error 取 message；非 Error 走 String", () => {
    expect(errorText(new Error("Failed to fetch"))).toBe("Failed to fetch");
    expect(errorText("raw failure")).toBe("raw failure");
    expect(errorText(undefined)).toBe("undefined");
  });

  it("message 为空串的 Error 回落到 String(error)（现状语义，不引入新分支）", () => {
    expect(errorText(new Error(""))).toBe("Error");
  });
});

describe("Response status 归一（normalizeResponseStatus）", () => {
  it("数值 / 数字串原样；缺省 / 0 / 非数 → 200", () => {
    expect(normalizeResponseStatus(401)).toBe(401);
    expect(normalizeResponseStatus("500")).toBe(500);
    expect(normalizeResponseStatus(undefined)).toBe(200);
    expect(normalizeResponseStatus(0)).toBe(200);
    expect(normalizeResponseStatus(Number.NaN)).toBe(200);
  });
});

describe("makeAbortError（中止形状）", () => {
  it('name="AbortError" + message="请求已中止"（completion 据 name 转中止；读流按 message 抛）', () => {
    const error = makeAbortError();

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AbortError");
    expect(error.message).toBe("请求已中止");
  });

  it("每次调用新实例（不得共享单例，避免调用方改写污染）", () => {
    expect(makeAbortError()).not.toBe(makeAbortError());
  });
});

describe("接收端 URL 预检判据（resolveRequestTarget）", () => {
  it("合法 http(s) → 回裁剪后的目标（首尾空白去除）", () => {
    expect(resolveRequestTarget("  https://api.example.com/v1/chat  ", extractOriginFromBaseUrl)).toBe(
      "https://api.example.com/v1/chat"
    );
  });

  it("空 / 非 http(s) → null（与 host-permissions 的 origin 提取同判据）", () => {
    expect(resolveRequestTarget(undefined, extractOriginFromBaseUrl)).toBeNull();
    expect(resolveRequestTarget("", extractOriginFromBaseUrl)).toBeNull();
    expect(resolveRequestTarget("   ", extractOriginFromBaseUrl)).toBeNull();
    expect(resolveRequestTarget("chrome-extension://x/y", extractOriginFromBaseUrl)).toBeNull();
    expect(resolveRequestTarget("not a url", extractOriginFromBaseUrl)).toBeNull();
  });

  it("合法性校验器由调用方注入（本叶零运行时依赖，不 import host-permissions）", () => {
    const onlyHttps = (target: string): boolean => target.startsWith("https://");

    expect(resolveRequestTarget("https://api.example.com/v1", onlyHttps)).toBe("https://api.example.com/v1");
    expect(resolveRequestTarget("http://api.example.com/v1", onlyHttps)).toBeNull();
  });
});

describe("接收端 fetch init 构造（buildProviderFetchInit）", () => {
  it("四键形状：method 缺省 GET、headers 原样、body 空值转 undefined、signal 由参数传入", () => {
    const controller = new AbortController();
    const headers = { accept: "application/json" };

    expect(buildProviderFetchInit({ headers }, controller.signal)).toEqual({
      method: "GET",
      headers,
      body: undefined,
      signal: controller.signal
    });
    // signal 是同一个引用（到点 abort / 端口断连 abort 走的就是它）
    expect(buildProviderFetchInit({ headers }, controller.signal).signal).toBe(controller.signal);
  });

  it("给定 method / body 原样透传；body 为 null 也算空", () => {
    const controller = new AbortController();

    expect(
      buildProviderFetchInit({ method: "POST", body: '{"model":"m"}', headers: {} }, controller.signal)
    ).toEqual({ method: "POST", headers: {}, body: '{"model":"m"}', signal: controller.signal });
    expect(buildProviderFetchInit({ method: "POST", body: null }, controller.signal).body).toBeUndefined();
  });
});

describe("出向载荷核心（buildProviderRequestPayload）", () => {
  it("四字段：url / method（缺省 GET）/ headers（键小写）/ body（字符串才带）", () => {
    expect(
      buildProviderRequestPayload("https://api.example.com/v1/chat/completions", {
        method: "POST",
        headers: { Accept: "application/json", Authorization: "Bearer sk-1" },
        body: '{"model":"gpt"}'
      })
    ).toEqual({
      url: "https://api.example.com/v1/chat/completions",
      method: "POST",
      headers: { accept: "application/json", authorization: "Bearer sk-1" },
      body: '{"model":"gpt"}'
    });
  });

  it("init 缺省 → GET + 空头 + 无 body；非字符串 body（FormData 等）不带上通道", () => {
    expect(buildProviderRequestPayload("https://api.example.com/v1/models")).toEqual({
      url: "https://api.example.com/v1/models",
      method: "GET",
      headers: {},
      body: undefined
    });
    expect(
      buildProviderRequestPayload("https://api.example.com/v1/models", {
        body: new URLSearchParams({ a: "1" }) as unknown as BodyInit
      }).body
    ).toBeUndefined();
  });

  it("信封键不在本叶：载荷只有四字段（type / action 各侧自包）", () => {
    expect(Object.keys(buildProviderRequestPayload("https://api.example.com/v1/models")).sort()).toEqual([
      "body",
      "headers",
      "method",
      "url"
    ]);
  });
});

describe("叶子纪律（结构用例）", () => {
  const leafSource = (): string =>
    // 与 tests/search/search-order.test.ts 同款：jsdom 环境里 new URL(相对, import.meta.url)
    // 会按文档地址解析，直接取仓库根下的源文件。
    readFileSync(join(process.cwd(), "extension/core/provider-http-shared.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");

  it("零运行时依赖：无值 import、无动态 import（被三处语境消费，不得拖入任何语境）", () => {
    const source = leafSource();
    expect(source).not.toMatch(/^\s*import\s+(?!type\b)/m);
    expect(source).not.toMatch(/\bimport\s*\(/);
  });

  it("零 chrome.* 触达（offscreen 文档半边经本叶走接收端 fetch init 构造）", () => {
    expect(leafSource()).not.toMatch(/\bchrome\./);
  });
});
