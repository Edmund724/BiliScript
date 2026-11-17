// pipeline.js + openai-transcriptions 适配器测试。
// 关键点：转写调度已迁入 offscreen（engine + ASR_ADAPTERS，见 entry/offscreen-asr.js
// 与 engine.test.js），页面侧 pipeline 只做编排——取音轨 → 任务宿主（生产为
// offscreen 桥，测试传合成宿主）收文本结果 → 合并/诊断。宿主契约：
//   async ({ audioUrl, backupUrls, onProgress? }) =>
//     { results, totalChunks, skippedSegments, failedChunks }
// 网络层用 fake fetch（vi.stubGlobal("fetch")）断言 FormData 与请求体。
// 管线不带 runId/isStale 守卫：转写与视频切换解耦（切走视频任务照跑，
// 中止只剩真断连），见 fallback 的 UI 门控与 offscreen-bridge.page。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import type { AsrChunkResult } from "../../extension/asr/offscreen-bridge.page.js";
import type { AsrProvider } from "../../extension/asr/asr-provider-store.js";

// ===== 模块级 mock：pipeline 的外部依赖 =====

// 切片宿主走 offscreen 直连（jsdom 无 chrome.runtime.connect），mock 掉
// audio-source 返回的 URL 即可（pipeline 不直接接触 offscreen 通道）。
vi.mock("../../extension/asr/audio-source.js", () => ({
  getSourceAudioUrl: vi.fn(async () => ({
    url: "https://example.com/audio.m4s",
    backupUrls: []
  }))
}));
// retryAsync 已移入 shared/error-helpers.js（转写重试现由 offscreen 侧
// engine.js 调用，见 engine.test.js）。这里不用 vi.mock 工厂：
// resetModuleState 的 vi.resetModules 不会重跑 mock 工厂，工厂里
// importOriginal 捕获的真实导出会闭包到过期的 state 实例（ensureRunActive 因此
// 看不到用例内 setFetchRunId 的变更）。保持直 import 真实模块，逐用例新鲜。
vi.mock("../../extension/reader/reader-bus.js", () => ({
  subscribeSubtitleRefresh: vi.fn(),
  notifyReaderPresenter: vi.fn()
}));
vi.mock("../../extension/ui/ui-renderer.js", () => ({
  renderMeta: vi.fn(),
  renderSubtitleSelect: vi.fn(),
  setStatus: vi.fn(),
  setMessage: vi.fn()
}));
vi.mock("../../extension/subtitle/ui.js", () => ({
  applyNoSubtitleState: vi.fn(),
  readVideoDescription: vi.fn(() => "")
}));
vi.mock("../../extension/subtitle/core.js", () => ({
  readVideoTitle: vi.fn(() => "标题"),
  readVideoAuthor: vi.fn(() => "作者"),
  readUploadDate: vi.fn(() => "2026-01-01"),
  refreshHotComments: vi.fn(async () => {}),
  invalidateDerived: vi.fn(),
  refreshDerivedContent: vi.fn(async () => {})
}));
// 取体链收口 subtitle/body.js 后本文件不再整体替换 subtitle/cache.js：pipeline
// 只经 asr 域内部接口，缓存落盘口由真实模块 + tests/setup.js 的 chrome.storage
// stub 承担（本文件不作缓存断言）。
vi.mock("../../extension/bilibili/gateway.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, contentFetchJson: vi.fn() };
});

// 合成任务宿主：模拟 offscreen 桥返回的文本结果（{results, totalChunks,
// skippedSegments, failedChunks}），results 为按片 index 对齐的单片记录
// [{ index, startSec, durationSec, result }]。durationSec 对齐 offscreen
// streamWavChunks 的实际解码片长语义（测试按时长切好传入）。
function makeSynthTaskHost(chunks: Array<{ startSec: number; durationSec: number; result: AsrChunkResult }>) {
  return vi.fn(async () => ({
    results: chunks.map((chunk, index) => ({
      index,
      startSec: chunk.startSec,
      durationSec: chunk.durationSec,
      result: chunk.result
    })),
    totalChunks: chunks.length,
    skippedSegments: 0,
    failedChunks: 0
  }));
}

// 默认 provider（openai-transcriptions，带时间戳）。
// presetId/enabled 为 AsrProvider 签名必填字段（normalizeAsrProvider 的产出形状），
// 运行时适配器只读 baseUrl/model/apiKey/language，此处按签名补齐。
const OPENAI_PROVIDER: AsrProvider = {
  id: "siliconflow-sensevoice",
  presetId: "custom",
  name: "SiliconFlow 硅基流动",
  type: "openai-transcriptions",
  baseUrl: "https://api.siliconflow.cn/v1",
  model: "FunAudioLLM/SenseVoiceSmall",
  supportsTimestamps: true,
  enabled: true,
  apiKey: "sk-test"
};

let pipeline: typeof import("../../extension/asr/pipeline.js");

beforeEach(async () => {
  resetModuleState();
  pipeline = await import("../../extension/asr/pipeline.js");
  // fetch mock：默认直接 200 返回空 text（transcribe 各用例自己覆盖）
  vi.stubGlobal("fetch", vi.fn(async () => {
    return { ok: true, status: 200, json: async () => ({ text: "" }) };
  }));
});

describe("openai-transcriptions 适配器", () => {
  it("verbose_json 有 segments：正常映射片内相对秒", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        text: "你好世界",
        segments: [
          { start: 0.5, end: 1.2, text: "你好" },
          { start: 1.5, end: 2.4, text: "世界" }
        ]
      })
    }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = await import("../../extension/asr/adapters/openai-transcriptions.js");
    const wavBlob = new Blob([new Uint8Array(16000 * 2 * 2)]);
    const result = await adapter.transcribe({ wavBlob, startSec: 0, durationSec: 60, provider: OPENAI_PROVIDER });

    expect(result.text).toBe("你好世界");
    expect(result.segments).toEqual([
      { start: 0.5, end: 1.2, text: "你好" },
      { start: 1.5, end: 2.4, text: "世界" }
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("2xx 仅返回 { text }（无 segments，如 SiliconFlow SenseVoiceSmall）→ 直接复用 text，只 fetch 1 次不重复上传", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ text: "单行第一句。单行第二句！" }) });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = await import("../../extension/asr/adapters/openai-transcriptions.js");
    const result = await adapter.transcribe({
      wavBlob: new Blob([new Uint8Array(8)]),
      startSec: 0,
      durationSec: 60,
      provider: OPENAI_PROVIDER
    });

    expect(result).toEqual({ text: "单行第一句。单行第二句！" });
    expect(result.segments).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const items = pipeline.synthesizeChunk({ startSec: 0, durationSec: 60, result });
    expect(items).toHaveLength(2);
    expect(items[0].content).toBe("单行第一句。");
    expect(items[1].content).toBe("单行第二句！");
    expect(items[0].from).toBeLessThan(items[0].to);
    expect(items[1].from).toBe(items[0].to);
    expect(items[1].from).toBeLessThan(items[1].to);
  });

  it("verbose_json 返回 HTTP 400 / 422（不支持 verbose_json）→ 降级重发 response_format=json（共 2 次 fetch）", async () => {
    for (const status of [400, 422]) {
      const formats: string[] = [];
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(async (_url: string, init: RequestInit) => {
          formats.push(String((init.body as FormData).get("response_format")));
          return {
            ok: false,
            status,
            text: async () => '{"error":{"message":"response_format verbose_json is not supported"}}'
          };
        })
        .mockImplementationOnce(async (_url: string, init: RequestInit) => {
          formats.push(String((init.body as FormData).get("response_format")));
          return {
            ok: true,
            status: 200,
            json: async () => ({ text: `降级成功-${status}` })
          };
        });
      vi.stubGlobal("fetch", fetchMock);
      const adapter = await import("../../extension/asr/adapters/openai-transcriptions.js");
      const result = await adapter.transcribe({
        wavBlob: new Blob([new Uint8Array(8)]),
        startSec: 0,
        durationSec: 60,
        provider: OPENAI_PROVIDER
      });

      expect(result).toEqual({ text: `降级成功-${status}` });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(formats).toEqual(["verbose_json", "json"]);
    }
  });

  it("verbose_json 同时返回 words 数组：归一化保留 { word, start, end }，缺省时不附带 words 键", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          text: "Hello world",
          segments: [{ start: 0, end: 1.5, text: "Hello world" }],
          words: [
            { word: " Hello", start: "0.1", end: 0.6 },
            { word: "   ", start: 0.6, end: 0.7 },
            { word: "invalid", start: Number.NaN, end: 0.8 },
            { word: "world", start: 0.7, end: 1.4 }
          ]
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          text: "星辰结果",
          segments: [{ start: 0, end: 1, text: "星辰结果" }]
        })
      });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = await import("../../extension/asr/adapters/openai-transcriptions.js");

    const withWords = await adapter.transcribe({
      wavBlob: new Blob([new Uint8Array(8)]),
      provider: OPENAI_PROVIDER
    });
    expect(withWords).toEqual({
      text: "Hello world",
      segments: [{ start: 0, end: 1.5, text: "Hello world" }],
      words: [
        { word: "Hello", start: 0.1, end: 0.6 },
        { word: "world", start: 0.7, end: 1.4 }
      ]
    });

    const withoutWords = await adapter.transcribe({
      wavBlob: new Blob([new Uint8Array(8)]),
      provider: OPENAI_PROVIDER
    });
    expect(withoutWords).toEqual({
      text: "星辰结果",
      segments: [{ start: 0, end: 1, text: "星辰结果" }]
    });
    expect("words" in withoutWords).toBe(false);
  });

  it("2xx 但响应体不是合法 JSON（status=-1）：仍走 json 降级（平台兼容问题，共 2 次 fetch）", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        // 响应到了但 json() 解析失败 → postTranscription 返回 status=-1
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        }
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ text: "降级文本" }) });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = await import("../../extension/asr/adapters/openai-transcriptions.js");
    const result = await adapter.transcribe({
      wavBlob: new Blob([new Uint8Array(8)]),
      startSec: 0,
      durationSec: 60,
      provider: OPENAI_PROVIDER
    });

    expect(result).toEqual({ text: "降级文本" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("verbose_json 500：直接抛 HTTP 错误且只 fetch 1 次（非 2xx 不再降级第二次 POST）", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "internal error"
    }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = await import("../../extension/asr/adapters/openai-transcriptions.js");
    // 单片 wav 38MB 级：非 2xx 后断言绝不发生第二次全量重传
    const wavBlob = new Blob([new Uint8Array(16000 * 2 * 2)]);

    await expect(
      adapter.transcribe({ wavBlob, startSec: 0, durationSec: 60, provider: OPENAI_PROVIDER })
    ).rejects.toMatchObject({ message: "HTTP 500: internal error", status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("verbose_json 401：确定性鉴权失败直接抛且只 fetch 1 次（不再降级）", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => "invalid api key"
    }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = await import("../../extension/asr/adapters/openai-transcriptions.js");

    await expect(
      adapter.transcribe({
        wavBlob: new Blob([new Uint8Array(8)]),
        startSec: 0,
        durationSec: 60,
        provider: OPENAI_PROVIDER
      })
    ).rejects.toMatchObject({ message: "HTTP 401: invalid api key", status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetch 网络拒绝：错误原样上抛并挂 kind=asr-network，消息形态可被 isRetryableNetworkError 命中", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = await import("../../extension/asr/adapters/openai-transcriptions.js");
    const { isRetryableNetworkError } = await import("../../extension/shared/error-helpers.js");

    let caught: (Error & { kind?: string }) | null = null;
    try {
      await adapter.transcribe({
        wavBlob: new Blob([new Uint8Array(8)]),
        startSec: 0,
        durationSec: 60,
        provider: OPENAI_PROVIDER
      });
    } catch (error) {
      caught = error as Error & { kind?: string };
    }

    // 网络层错误不被适配器包装：原样上抛，交 retryAsync 消息启发式判定可重试
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught?.message).toBe("Failed to fetch");
    expect(isRetryableNetworkError(caught)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ===== 失败信号的 kind 标注（票 03：判定在完整报文还在手上的层做）=====
  // 适配器是唯一拿到**未截断**响应体的地方，故状态码 → kind 的判定在此落定；
  // 跨 port 只传 kind 这个小字符串，报文全量只进 offscreen 的 logWarn。
  // 判定表与次序的唯一实现在 asr/failure-kind.js（本组用例锁的是「接线」：
  // 适配器把 status + 完整 raw + provider 喂进分类模块，并把结果挂上 error）。
  describe("抛出物携带 kind / detail（分类在完整报文还在手上时完成）", () => {
    function stubHttpResponse({ status, body }: { status: number; body: string }) {
      const fetchMock = vi.fn(async () => ({
        ok: false,
        status,
        text: async () => body
      }));
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    async function catchTranscribeError(): Promise<Record<string, unknown>> {
      const adapter = await import("../../extension/asr/adapters/openai-transcriptions.js");
      try {
        await adapter.transcribe({
          wavBlob: new Blob([new Uint8Array(8)]),
          startSec: 0,
          durationSec: 60,
          provider: OPENAI_PROVIDER
        });
      } catch (error) {
        return error as Record<string, unknown>;
      }
      throw new Error("transcribe 应当抛出");
    }

    it.each([
      [401, "invalid api key", "asr-auth"],
      [402, '{"code":30014,"message":"余额不足"}', "asr-quota"],
      [403, '{"detail":"Invalid API key."}', "asr-auth"],
      [404, "Not Found", "no-asr-config"],
      [415, '{"detail":"Failed to decode audio. The provided file type is not supported."}', "asr-media"],
      [500, "internal error", "asr-server"],
      // 429 双义：只能靠报文 error.type 消歧（纯状态码表在这条上不成立）
      [429, '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}', "asr-quota"],
      [429, '{"error":{"message":"Rate limit reached","type":"rate_limit_exceeded"}}', "asr-ratelimit"]
    ])("HTTP %s → kind=%s（message 与 status 形状不变）", async (status, body, kind) => {
      const fetchMock = stubHttpResponse({ status: status as number, body: body as string });

      const error = await catchTranscribeError();

      expect(error).toMatchObject({ status, kind, detail: String(body).slice(0, 200) });
      expect(error.message).toBe(`HTTP ${status}: ${String(body).slice(0, 200)}`);
      // 非 2xx 不再降级：绝不发生第二次全量重传（单片 wav 38MB 级）
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("detail 为截断到 200 字符的展示片段，kind 判定仍基于完整报文", async () => {
      // 关键词藏在第 200 字符之后：截断片段已不含它，分类必须以完整报文为准
      const body = `{"error":"${"x".repeat(300)}","type":"insufficient_quota"}`;
      stubHttpResponse({ status: 429, body });

      const error = await catchTranscribeError();

      expect(error.kind).toBe("asr-quota");
      expect((error.detail as string).length).toBe(200);
      expect(error.detail).not.toContain("insufficient_quota");
    });

    it("响应体非 JSON（status=-1 哨兵）：走 json 降级，降级也失败则 kind=asr-unknown", async () => {
      // 首次 verbose_json 与降级 json 两次都是 2xx 但体不可解析 → 第二次以 -1 抛出
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        }
      }));
      vi.stubGlobal("fetch", fetchMock);

      const error = await catchTranscribeError();

      expect(error).toMatchObject({ status: -1, kind: "asr-unknown", detail: "响应体不是合法 JSON" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("平台 baseUrl 未配置：无网络交互，kind=no-asr-config", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const adapter = await import("../../extension/asr/adapters/openai-transcriptions.js");

      let caught: Record<string, unknown> | null = null;
      try {
        await adapter.transcribe({
          wavBlob: new Blob([new Uint8Array(8)]),
          startSec: 0,
          durationSec: 60,
          provider: { ...OPENAI_PROVIDER, baseUrl: "" }
        });
      } catch (error) {
        caught = error as Record<string, unknown>;
      }

      expect(caught).toMatchObject({ message: "平台 baseUrl 未配置", kind: "no-asr-config" });
      // 票 02/04：这条**无状态码**（同步抛出、无网络交互），不许凭空造一个
      expect((caught as { status?: unknown }).status).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("FormData 字段断言：body 为 FormData、model 正确、绝无 Content-Type 头、apiKey 带 Bearer", async () => {
    let captured: { body: FormData; headers: Record<string, string> } | null = null;
    let capturedUrl: string | null = null;
    const fetchMock = vi.fn(async (url, init) => {
      captured = init;
      capturedUrl = url;
      return { ok: true, status: 200, json: async () => ({ text: "ok", segments: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = await import("../../extension/asr/adapters/openai-transcriptions.js");
    await adapter.transcribe({
      wavBlob: new Blob([new Uint8Array(8)], { type: "audio/wav" }),
      startSec: 0,
      durationSec: 60,
      provider: OPENAI_PROVIDER
    });

    // 2xx 含 text 时不再发第二次 json 降级请求
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(captured!.body).toBeInstanceOf(FormData);
    expect(captured!.body.get("model")).toBe("FunAudioLLM/SenseVoiceSmall");
    expect(captured!.body.get("response_format")).toBe("verbose_json");
    // 语言不放在 multipart 字段里（SiliconFlow 只认查询参数）
    expect(captured!.body.get("language")).toBeNull();
    expect(captured!.body.get("file")).toBeInstanceOf(Blob);
    // 绝不手动设 Content-Type
    expect(captured!.headers["Content-Type"]).toBeUndefined();
    expect(captured!.headers.Authorization).toBe("Bearer sk-test");
    // provider 未设语言档位 → URL 不带 language 参数
    expect(capturedUrl).toBe("https://api.siliconflow.cn/v1/audio/transcriptions");
  });

  it("language=en 时 URL 附加 ?language=english（英文转写链路）", async () => {
    let capturedUrls: string[] = [];
    const fetchMock = vi.fn(async (url, init) => {
      capturedUrls.push(url);
      return { ok: true, status: 200, json: async () => ({ text: "hello" }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = await import("../../extension/asr/adapters/openai-transcriptions.js");
    await adapter.transcribe({
      wavBlob: new Blob([new Uint8Array(8)]),
      startSec: 0,
      durationSec: 60,
      provider: { ...OPENAI_PROVIDER, language: "en" }
    });

    expect(capturedUrls).toEqual([
      "https://api.siliconflow.cn/v1/audio/transcriptions?language=english"
    ]);
  });

  it("language=zh 时 URL 附加 ?language=zh", async () => {
    let capturedUrls: string[] = [];
    const fetchMock = vi.fn(async (url) => {
      capturedUrls.push(url);
      return { ok: true, status: 200, json: async () => ({ text: "你好" }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = await import("../../extension/asr/adapters/openai-transcriptions.js");
    await adapter.transcribe({
      wavBlob: new Blob([new Uint8Array(8)]),
      startSec: 0,
      durationSec: 60,
      provider: { ...OPENAI_PROVIDER, language: "zh" }
    });
    expect(capturedUrls[0]).toBe("https://api.siliconflow.cn/v1/audio/transcriptions?language=zh");
  });

  it("apiKey 为空时不带 Authorization 头", async () => {
    let captured: { headers: Record<string, string> } | null = null;
    const fetchMock = vi.fn(async (url, init) => {
      captured = init;
      return { ok: true, status: 200, json: async () => ({ text: "ok" }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = await import("../../extension/asr/adapters/openai-transcriptions.js");
    await adapter.transcribe({
      wavBlob: new Blob([new Uint8Array(8)]),
      startSec: 0,
      durationSec: 60,
      provider: { ...OPENAI_PROVIDER, apiKey: "" }
    });
    expect(captured!.headers.Authorization).toBeUndefined();
    expect(captured!.headers["Content-Type"]).toBeUndefined();
  });
});

describe("pipeline 时间戳合成与偏移合并", () => {
  it("25 分钟视频分 2 片（自建 1200s/片，不依赖生产片长）→ 全局偏移正确且递增", async () => {
    const body = await pipeline.runAsrPipeline({
      bvid: "BV1test",
      cid: "101",
      onProgress: vi.fn(),
      chunkHost: makeSynthTaskHost([
        {
          startSec: 0,
          durationSec: 1200,
          result: {
            text: "片一",
            segments: [
              { start: 0, end: 1, text: "第一句" },
              { start: 2, end: 3, text: "第二句" }
            ]
          }
        },
        {
          startSec: 1200,
          durationSec: 300,
          result: {
            text: "片二",
            segments: [
              { start: 0, end: 1, text: "第三句" },
              { start: 1.5, end: 2.5, text: "第四句" }
            ]
          }
        }
      ])
    });

    expect(body).toEqual([
      { from: 0, to: 1, content: "第一句" },
      { from: 2, to: 3, content: "第二句" },
      { from: 1200, to: 1201, content: "第三句" },
      { from: 1201.5, to: 1202.5, content: "第四句" }
    ]);
    // from 严格递增
    for (let i = 1; i < body.length; i += 1) {
      expect(body[i].from).toBeGreaterThan(body[i - 1].from);
    }
  });

  it("任务参数：host 收到音轨地址与 onProgress 透传，进度文本原样中继，不再携带 isStale", async () => {
    const onProgress = vi.fn();
    const host = vi.fn(async ({ onProgress: relay }) => {
      relay?.("语音识别中 1 片…");
      return {
        results: [{ index: 0, startSec: 0, durationSec: 60, result: { text: "片文本" } }],
        totalChunks: 1,
        skippedSegments: 0,
        failedChunks: 0
      };
    });

    await pipeline.runAsrPipeline({
      bvid: "BV1test",
      cid: "101",
      onProgress,
      chunkHost: host
    });

    expect(host).toHaveBeenCalledTimes(1);
    const hostArgs = host.mock.calls[0][0];
    expect(hostArgs.audioUrl).toBe("https://example.com/audio.m4s");
    expect(hostArgs.backupUrls).toEqual([]);
    // 守卫链已整体移除：宿主参数不再有 isStale（跨 context 中止只剩真断连）
    expect(hostArgs.isStale).toBeUndefined();
    // 页面自身的阶段文案 + offscreen 引擎进度文本原样中继
    expect(onProgress).toHaveBeenCalledWith("无字幕轨，正在获取音频流…");
    expect(onProgress).toHaveBeenCalledWith("音频下载与解码中…");
    expect(onProgress).toHaveBeenCalledWith("语音识别中 1 片…");
  });

  it("无 segments（降级路径）：单句无标点整片一条粗粒度字幕 {from,to,content}", async () => {
    const body = await pipeline.runAsrPipeline({
      bvid: "BV1test",
      cid: "101",
      onProgress: vi.fn(),
      chunkHost: makeSynthTaskHost([
        { startSec: 0, durationSec: 600, result: { text: "整片文本" } }
      ])
    });

    expect(body).toEqual([{ from: 0, to: 600, content: "整片文本" }]);
  });

  it("无 segments 多句纯文本：按标点与换行切分并按字符权重线性插值，连续不重叠", async () => {
    // 片长 60s，startSec=100
    // 两句长度各 4 字符（"这是第一句。" 和 "这是第二句！"）
    const body = await pipeline.runAsrPipeline({
      bvid: "BV1test",
      cid: "101",
      onProgress: vi.fn(),
      chunkHost: makeSynthTaskHost([
        { startSec: 100, durationSec: 60, result: { text: "这是第一句。这是第二句！" } }
      ])
    });

    expect(body).toHaveLength(2);
    expect(body[0]).toEqual({ from: 100, to: 130, content: "这是第一句。" });
    expect(body[1]).toEqual({ from: 130, to: 160, content: "这是第二句！" });
  });

  it("to 不超过片末边界（segments 越界被截断）", async () => {
    const body = await pipeline.runAsrPipeline({
      bvid: "BV1test",
      cid: "101",
      chunkHost: makeSynthTaskHost([
        {
          startSec: 0,
          durationSec: 120,
          result: { text: "x", segments: [{ start: 0, end: 99999, text: "越界句" }] }
        }
      ])
    });
    expect(body[0]).toEqual({ from: 0, to: 120, content: "越界句" });
  });

  it("转写与视频切换解耦：runId 过期（fetchRunId 前进）不再中止管线", async () => {
    const { clipState } = await import("../../extension/core/state.js");
    // 模拟转写进行中视频被切换/并发刷新：fetchRunId 前进，任务照跑不中止
    clipState.setFetchRunId(99);

    const body = await pipeline.runAsrPipeline({
      bvid: "BV1test",
      cid: "101",
      onProgress: vi.fn(),
      chunkHost: makeSynthTaskHost([
        { startSec: 0, durationSec: 600, result: { text: "片文本" } }
      ])
    });
    expect(body).toEqual([{ from: 0, to: 600, content: "片文本" }]);
  });
});

describe("pipeline 空结果与诊断", () => {
  it("全部 text 为空白 → 返回 []", async () => {
    const body = await pipeline.runAsrPipeline({
      bvid: "BV1test",
      cid: "101",
      chunkHost: makeSynthTaskHost([
        { startSec: 0, durationSec: 60, result: { text: "   " } }
      ])
    });
    expect(body).toEqual([]);
  });

  it("空结果诊断：分片数/各片文本长度/事件诊断拼进文案", async () => {
    const onEmptyDiagnostic = vi.fn();
    await pipeline.runAsrPipeline({
      bvid: "BV1test",
      cid: "101",
      chunkHost: makeSynthTaskHost([
        { startSec: 0, durationSec: 60, result: { text: "", _asrDiag: { noSpeech: true } } }
      ]),
      onEmptyDiagnostic
    });

    expect(onEmptyDiagnostic).toHaveBeenCalledTimes(1);
    const diagText = onEmptyDiagnostic.mock.calls[0][0];
    expect(diagText).toContain("分片 1 片");
    expect(diagText).toContain("各片文本长度[0]");
    expect(diagText).toContain("事件诊断");
    expect(diagText).not.toContain("转写失败");
  });

  it("空结果诊断追加失败计数：N 片转写失败、M 段解码失败已跳过", async () => {
    const onEmptyDiagnostic = vi.fn();
    // 转写失败片/解码失败段不产生 result 记录，只有 done 计数上来
    const host = vi.fn(async () => ({
      results: [],
      totalChunks: 3,
      skippedSegments: 2,
      failedChunks: 1
    }));

    const body = await pipeline.runAsrPipeline({
      bvid: "BV1test",
      cid: "101",
      chunkHost: host,
      onEmptyDiagnostic
    });

    expect(body).toEqual([]);
    const diagText = onEmptyDiagnostic.mock.calls[0][0];
    expect(diagText).toContain("分片 3 片");
    expect(diagText).toContain("1 片转写失败");
    expect(diagText).toContain("2 段解码失败已跳过");
  });

  it("非空结果不追加失败计数（不改变成功路径文案）", async () => {
    const onEmptyDiagnostic = vi.fn();
    const host = vi.fn(async () => ({
      results: [{ index: 0, startSec: 0, durationSec: 60, result: { text: "有内容" } }],
      totalChunks: 2,
      skippedSegments: 1,
      failedChunks: 1
    }));

    const body = await pipeline.runAsrPipeline({
      bvid: "BV1test",
      cid: "101",
      chunkHost: host,
      onEmptyDiagnostic
    });

    expect(body).toEqual([{ from: 0, to: 60, content: "有内容" }]);
    // 有文本产出 → 诊断回调不触发
    expect(onEmptyDiagnostic).not.toHaveBeenCalled();
  });
});

describe("pipeline onAttemptOutcome（整轮重试判定用失败面）", () => {
  it("空结果：回调携带 totalChunks/failedChunks/elapsedMs", async () => {
    const onAttemptOutcome = vi.fn();
    const host = vi.fn(async () => ({
      results: [],
      totalChunks: 3,
      skippedSegments: 1,
      failedChunks: 2
    }));

    await pipeline.runAsrPipeline({
      bvid: "BV1test",
      cid: "101",
      chunkHost: host,
      onAttemptOutcome
    });

    expect(onAttemptOutcome).toHaveBeenCalledTimes(1);
    const outcome = onAttemptOutcome.mock.calls[0][0];
    expect(outcome.totalChunks).toBe(3);
    expect(outcome.failedChunks).toBe(2);
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("非空结果：同样上报（failedChunks 反映部分片失败）", async () => {
    const onAttemptOutcome = vi.fn();
    const host = vi.fn(async () => ({
      results: [{ index: 0, startSec: 0, durationSec: 60, result: { text: "有内容" } }],
      totalChunks: 2,
      skippedSegments: 0,
      failedChunks: 1
    }));

    const body = await pipeline.runAsrPipeline({
      bvid: "BV1test",
      cid: "101",
      chunkHost: host,
      onAttemptOutcome
    });

    expect(body).toEqual([{ from: 0, to: 60, content: "有内容" }]);
    expect(onAttemptOutcome).toHaveBeenCalledTimes(1);
    expect(onAttemptOutcome.mock.calls[0][0].failedChunks).toBe(1);
  });

  it("失败信号透传：宿主结果的 failedKind/failedStatus/failedDetail 进 outcome", async () => {
    const onAttemptOutcome = vi.fn();
    const host = vi.fn(async () => ({
      results: [],
      totalChunks: 2,
      skippedSegments: 0,
      failedChunks: 2,
      failedKind: "asr-quota",
      failedStatus: 402,
      failedDetail: '{"code":30014,"message":"余额不足"}'
    }));

    await pipeline.runAsrPipeline({ bvid: "BV1test", cid: "101", chunkHost: host, onAttemptOutcome });

    expect(onAttemptOutcome.mock.calls[0][0]).toMatchObject({
      failedKind: "asr-quota",
      failedStatus: 402,
      failedDetail: '{"code":30014,"message":"余额不足"}'
    });
  });

  it("宿主未带失败信号（成功路径）→ outcome 不多出失败字段", async () => {
    const onAttemptOutcome = vi.fn();
    const host = vi.fn(async () => ({
      results: [{ index: 0, startSec: 0, durationSec: 60, result: { text: "有内容" } }],
      totalChunks: 1,
      skippedSegments: 0,
      failedChunks: 0
    }));

    await pipeline.runAsrPipeline({ bvid: "BV1test", cid: "101", chunkHost: host, onAttemptOutcome });

    const outcome = onAttemptOutcome.mock.calls[0][0];
    expect("failedKind" in outcome).toBe(false);
    expect("failedStatus" in outcome).toBe(false);
    expect("failedDetail" in outcome).toBe(false);
  });
});

describe("工单 01：ASR 60 秒分片计划与待处理分片上限 100", () => {
  it("OpenAI 兼容语音转写分片计划片长为 60 秒", async () => {
    const { buildChunkPlan } = await import("../../extension/asr/chunker.js");
    expect(buildChunkPlan("openai-transcriptions")).toEqual({ chunkSeconds: 60 });
  });

  it("待处理分片上限 ASR_MAX_PENDING_CHUNKS 为 100", async () => {
    const { ASR_MAX_PENDING_CHUNKS } = await import("../../extension/asr/protocol.js");
    expect(ASR_MAX_PENDING_CHUNKS).toBe(100);
  });
});

describe("工单 01：纯文本分句与过短碎句合并 (splitTextIntoSentences)", () => {
  it("按中文句末标点（。！？）正常切分", async () => {
    const { splitTextIntoSentences } = await import("../../extension/asr/pipeline.js");
    const res = splitTextIntoSentences("这是第一句话。这是第二句吗？这是第三句！");
    expect(res).toEqual(["这是第一句话。", "这是第二句吗？", "这是第三句！"]);
  });

  it("按英文句末标点（. ! ?）切分并保留小数（如 3.14）不切断", async () => {
    const { splitTextIntoSentences } = await import("../../extension/asr/pipeline.js");
    const res = splitTextIntoSentences("The value is 3.14. Is that right? Yes!");
    expect(res).toEqual(["The value is 3.14.", "Is that right?", "Yes!"]);
  });

  it("按换行符（\\n / \\r\\n）切分，自动剔除空行", async () => {
    const { splitTextIntoSentences } = await import("../../extension/asr/pipeline.js");
    const res = splitTextIntoSentences("第一行内容\r\n\n第二行内容\n第三行内容");
    expect(res).toEqual(["第一行内容", "第二行内容", "第三行内容"]);
  });

  it("包含句末引号、括号等包裹符号时保持在原句尾部", async () => {
    const { splitTextIntoSentences } = await import("../../extension/asr/pipeline.js");
    const res = splitTextIntoSentences("他说：“太精彩了！”\n真的吗？");
    expect(res).toEqual(["他说：“太精彩了！”", "真的吗？"]);
  });

  it("合并过短碎句（句首短句合入下一句、句尾/句中短句合入前一句）", async () => {
    const { splitTextIntoSentences } = await import("../../extension/asr/pipeline.js");
    // 句首 "好。"（2字符）与后续完整句合并
    expect(splitTextIntoSentences("好。今天我们开始讲第一章。")).toEqual(["好。今天我们开始讲第一章。"]);
    // 句尾 "好。" 与前句合并
    expect(splitTextIntoSentences("今天我们开始讲第一章。好。")).toEqual(["今天我们开始讲第一章。好。"]);
    // 句中 "对。" 与前句合并
    expect(splitTextIntoSentences("今天讲第一章。对。明天讲第二章。")).toEqual([
      "今天讲第一章。对。",
      "明天讲第二章。"
    ]);
  });

  it("全句仅有一句超短单句时保留不丢弃", async () => {
    const { splitTextIntoSentences } = await import("../../extension/asr/pipeline.js");
    expect(splitTextIntoSentences("好。")).toEqual(["好。"]);
    expect(splitTextIntoSentences("OK")).toEqual(["OK"]);
  });

  it("空文本或纯空白字符串返回空数组", async () => {
    const { splitTextIntoSentences } = await import("../../extension/asr/pipeline.js");
    expect(splitTextIntoSentences("")).toEqual([]);
    expect(splitTextIntoSentences("   \n\t  ")).toEqual([]);
  });

  it("单行无换行混合中英文标点、省略号、域名（Node.js）与闭合引号/方括号切分正确，英文短句合并保留空格", async () => {
    const { splitTextIntoSentences } = await import("../../extension/asr/pipeline.js");
    expect(splitTextIntoSentences('He said "Hi." Node.js works... Really?! Yes……')).toEqual([
      'He said "Hi."',
      "Node.js works...",
      "Really?!",
      "Yes……"
    ]);
    expect(splitTextIntoSentences("First sentence. OK. Second sentence.")).toEqual([
      "First sentence. OK.",
      "Second sentence."
    ]);
    expect(splitTextIntoSentences("他说：“太精彩了！”[注]真的吗？")).toEqual([
      "他说：“太精彩了！”",
      "[注]真的吗？"
    ]);
  });
});

describe("工单 01：纯文本线性插值 (interpolateSentenceTimestamps)", () => {
  it("单句占满整个 [startSec, startSec + durationSec] 区间", async () => {
    const { interpolateSentenceTimestamps } = await import("../../extension/asr/pipeline.js");
    const res = interpolateSentenceTimestamps({
      sentences: ["单句完整内容。"],
      startSec: 10,
      durationSec: 60
    });
    expect(res).toEqual([{ from: 10, to: 70, content: "单句完整内容。" }]);
  });

  it("多句按字符长度严格按比例线性分配，首尾对齐且连续不重叠", async () => {
    const { interpolateSentenceTimestamps } = await import("../../extension/asr/pipeline.js");
    // 句1长度 10，句2长度 20，总长 30；总时长 60s
    // 句1 应分得 20s (10/30 * 60)，句2 应分得 40s (20/30 * 60)
    const sentences = ["一二三四五六七八九十", "一二三四五六七八九十一二三四五六七八九十"];
    const res = interpolateSentenceTimestamps({
      sentences,
      startSec: 100,
      durationSec: 60
    });
    expect(res).toHaveLength(2);
    expect(res[0]).toEqual({ from: 100, to: 120, content: sentences[0] });
    expect(res[1]).toEqual({ from: 120, to: 160, content: sentences[1] });
    expect(res[0].to).toBe(res[1].from);
  });

  it("durationSec <= 0 边界处理返回起点相同的时间戳，不抛出异常", async () => {
    const { interpolateSentenceTimestamps } = await import("../../extension/asr/pipeline.js");
    const res = interpolateSentenceTimestamps({
      sentences: ["第一句", "第二句"],
      startSec: 50,
      durationSec: 0
    });
    expect(res).toEqual([
      { from: 50, to: 50, content: "第一句" },
      { from: 50, to: 50, content: "第二句" }
    ]);
  });

  it("空句子列表返回空数组", async () => {
    const { interpolateSentenceTimestamps } = await import("../../extension/asr/pipeline.js");
    expect(interpolateSentenceTimestamps({ sentences: [], startSec: 0, durationSec: 60 })).toEqual([]);
  });
});

describe("工单 01：synthesizeChunk 与多分片合并排序", () => {
  it("有效 segments 保留原有的句级相对秒偏移与片末截断行为", async () => {
    const { synthesizeChunk } = await import("../../extension/asr/pipeline.js");
    const res = synthesizeChunk({
      startSec: 60,
      durationSec: 60,
      result: {
        text: "片文本",
        segments: [
          { start: 1, end: 5, text: "句一" },
          { start: 50, end: 999, text: "越界句" }
        ]
      }
    });
    expect(res).toEqual([
      { from: 61, to: 65, content: "句一" },
      { from: 110, to: 120, content: "越界句" }
    ]);
  });

  it("segments 包含空白文本时自动跳过", async () => {
    const { synthesizeChunk } = await import("../../extension/asr/pipeline.js");
    const res = synthesizeChunk({
      startSec: 0,
      durationSec: 60,
      result: {
        text: "片文本",
        segments: [
          { start: 0, end: 1, text: "  " },
          { start: 2, end: 3, text: "有效句" }
        ]
      }
    });
    expect(res).toEqual([{ from: 2, to: 3, content: "有效句" }]);
  });

  it("多分片合并严格按 from 升序排列，乱序输入的片段正确归并", async () => {
    const { mergeChunkResults } = await import("../../extension/asr/pipeline.js");
    const records = [
      {
        index: 2,
        startSec: 120,
        durationSec: 60,
        result: { text: "第三片内容。" }
      },
      {
        index: 0,
        startSec: 0,
        durationSec: 60,
        result: { text: "第一片第一句。第一片第二句。" }
      },
      {
        index: 1,
        startSec: 60,
        durationSec: 60,
        result: {
          text: "第二片",
          segments: [{ start: 5, end: 10, text: "第二片独立句" }]
        }
      }
    ];

    const merged = mergeChunkResults(records);
    expect(merged.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < merged.length; i++) {
      expect(merged[i].from).toBeGreaterThanOrEqual(merged[i - 1].from);
    }
    expect(merged[0].content).toBe("第一片第一句。");
    expect(merged[merged.length - 1].content).toBe("第三片内容。");
  });

  it("空白片段不产生空字幕条目", async () => {
    const { mergeChunkResults } = await import("../../extension/asr/pipeline.js");
    const records = [
      {
        index: 0,
        startSec: 0,
        durationSec: 60,
        result: { text: "   \n\t " }
      },
      {
        index: 1,
        startSec: 60,
        durationSec: 60,
        result: { text: "有效单句。" }
      },
      {
        index: 2,
        startSec: 120,
        durationSec: 60,
        result: null
      }
    ];

    const merged = mergeChunkResults(records);
    expect(merged).toEqual([{ from: 60, to: 120, content: "有效单句。" }]);
  });
});

describe("重叠区去重与跨分片未闭合尾句缝合", () => {
  it("全程满幅正弦波触发 1.5s 微重叠时，pipeline 正确去重并平滑取中间时间点衔接", async () => {
    const { streamWavChunks } = await import("../../extension/asr/stream-chunker.js");
    const { mergeChunkResults } = await import("../../extension/asr/pipeline.js");

    const rate = 16000;
    const totalSec = 80;
    const sine = new Float32Array(totalSec * rate);
    for (let i = 0; i < sine.length; i += 1) {
      sine[i] = Math.sin((2 * Math.PI * 440 * i) / rate);
    }

    const emitted: Array<{ index: number; startSec: number; durationSec: number; overlapLeadSec: number }> = [];
    await streamWavChunks([sine], {
      chunkSeconds: 60,
      sampleRate: rate,
      decodeSegment: async (seg) => seg as Float32Array,
      onChunk: (chunk) => {
        emitted.push({
          index: chunk.index,
          startSec: chunk.startSec,
          durationSec: chunk.durationSec,
          overlapLeadSec: chunk.overlapLeadSec
        });
      }
    });

    expect(emitted).toHaveLength(2);
    expect(emitted[1].startSec).toBeCloseTo(58.5, 6);
    expect(emitted[1].overlapLeadSec).toBeCloseTo(1.5, 6);

    // 场景 A：重叠区完全重复的句段 + 跨重叠边界后续句段，且携带 words 时同步裁剪
    const mergedExact = mergeChunkResults([
      {
        ...emitted[0],
        result: {
          text: "前面正常内容。今天我们要讲解",
          segments: [
            { start: 10, end: 15, text: "前面正常内容。" },
            { start: 58.6, end: 60, text: "今天我们要讲解。" }
          ],
          words: [
            { word: "今天", start: 58.6, end: 59.1 },
            { word: "我们要", start: 59.1, end: 59.6 },
            { word: "讲解。", start: 59.6, end: 60.0 }
          ]
        }
      },
      {
        ...emitted[1],
        result: {
          text: "今天我们要讲解核心原理。",
          segments: [
            // 相对 emitted[1].startSec=58.5：0.1~1.5s 对应全局 58.6~60.0s
            { start: 0.1, end: 3.5, text: "今天我们要讲解核心原理。" }
          ],
          words: [
            { word: "今天", start: 0.1, end: 0.6 },
            { word: "我们要", start: 0.6, end: 1.1 },
            { word: "讲解", start: 1.1, end: 1.5 },
            { word: "核心", start: 1.6, end: 2.4 },
            { word: "原理。", start: 2.4, end: 3.5 }
          ]
        }
      }
    ]);

    expect(mergedExact).toHaveLength(3);
    expect(mergedExact[1].content).toBe("今天我们要讲解。");
    expect(mergedExact[2].content).toBe("核心原理。");
    expect(mergedExact[1].to).toBeCloseTo(59.3, 6);
    expect(mergedExact[2].from).toBeCloseTo(59.3, 6);
    expect(mergedExact[2].to).toBeCloseTo(62.0, 6);
    expect((mergedExact[2] as { words?: Array<{ word: string }> }).words?.map((w) => w.word)).toEqual([
      "核心",
      "原理。"
    ]);

    // 场景 B：硬切边界导致尾字微残损（近边界 LCS 容错），去重后与未闭合尾句协同修复断词并缝合
    const mergedFuzzy = mergeChunkResults([
      {
        index: 0,
        startSec: 0,
        durationSec: 60,
        overlapLeadSec: 0,
        result: {
          text: "welcome to the sh",
          segments: [{ start: 58.6, end: 59.95, text: "welcome to the sh" }]
        }
      },
      {
        index: 1,
        startSec: 58.5,
        durationSec: 21.5,
        overlapLeadSec: 1.5,
        result: {
          text: "welcome to the show today.",
          segments: [{ start: 0.1, end: 3.0, text: "welcome to the show today." }]
        }
      }
    ]);

    expect(mergedFuzzy).toEqual([
      { from: 58.6, to: 61.5, content: "welcome to the show today." }
    ]);

    // 场景 C：闭合句子后的尾缀残损被 LCS 裁剪后保留句末标点，各自独立并在中点平滑衔接
    const mergedClosedFuzzy = mergeChunkResults([
      {
        index: 0,
        startSec: 0,
        durationSec: 60,
        overlapLeadSec: 0,
        result: {
          text: "nice show. wh",
          segments: [{ start: 58.6, end: 59.95, text: "nice show. wh" }]
        }
      },
      {
        index: 1,
        startSec: 58.5,
        durationSec: 21.5,
        overlapLeadSec: 1.5,
        result: {
          text: "nice show. what is next?",
          segments: [{ start: 0.1, end: 3.0, text: "nice show. what is next?" }]
        }
      }
    ]);

    expect(mergedClosedFuzzy).toHaveLength(2);
    expect(mergedClosedFuzzy[0].content).toBe("nice show.");
    expect(mergedClosedFuzzy[1].content).toBe("what is next?");
    expect(mergedClosedFuzzy[0].to).toBeCloseTo(mergedClosedFuzzy[1].from, 6);
    expect(mergedClosedFuzzy[0].to).toBeCloseTo((58.6 + 59.95) / 2, 6);
  });

  it("乱序到达（分片 1 先于分片 0，或 0/2 先到、1 后到）：暂态可先展示，两片齐备后准确缝合并保持时间单调不重叠", async () => {
    const { createProgressiveChunkMerger } = await import("../../extension/asr/pipeline.js");
    const merger = createProgressiveChunkMerger();

    // 1) 分片 1 先到（无重叠，左边界 0.1s 距 60s < 0.45s）
    const snap1 = merger.push({
      index: 1,
      startSec: 60,
      durationSec: 60,
      overlapLeadSec: 0,
      result: {
        text: "第二片内容",
        segments: [
          { start: 0.05, end: 0.15, text: "[掌声]" },
          { start: 0.2, end: 3.0, text: "构建高可用架构。" },
          { start: 4.0, end: 7.0, text: "这是下一句。" }
        ]
      }
    });
    expect(snap1.mergedItems).toHaveLength(3);

    // 2) 分片 0 后到：末尾非音效句未闭合（距 60s < 0.45s），跳过末尾瞬间 [音乐] 与分片 1 首条缝合
    const snap2 = merger.push({
      index: 0,
      startSec: 0,
      durationSec: 60,
      overlapLeadSec: 0,
      result: {
        text: "第一片内容",
        segments: [
          { start: 1.0, end: 4.0, text: "大家好。" },
          { start: 57.5, end: 59.75, text: "今天我们一起来学习如何" },
          { start: 59.8, end: 59.95, text: "[音乐]" }
        ]
      }
    });
    expect(snap2.updatedChunkIndices).toEqual([0, 1]);
    expect(snap2.mergedItems).toEqual([
      { from: 1.0, to: 4.0, content: "大家好。" },
      { from: 57.5, to: 63.0, content: "今天我们一起来学习如何构建高可用架构。" },
      { from: 64.0, to: 67.0, content: "这是下一句。" }
    ]);
    for (let i = 1; i < snap2.mergedItems.length; i += 1) {
      expect(snap2.mergedItems[i].from).toBeGreaterThanOrEqual(snap2.mergedItems[i - 1].to);
    }

    // 3) 分片 0 先到时先正常展示未闭合尾句，分片 1 后到再无感更新（英文自动补空格）
    const progressive = createProgressiveChunkMerger();
    const firstView = progressive.push({
      index: 0,
      startSec: 0,
      durationSec: 60,
      overlapLeadSec: 0,
      result: {
        text: "We are going to",
        segments: [{ start: 57.0, end: 59.8, text: "We are going to" }],
        words: [
          { word: "We", start: 57.0, end: 57.5 },
          { word: "are", start: 57.5, end: 58.2 },
          { word: "going", start: 58.2, end: 59.0 },
          { word: "to", start: 59.0, end: 59.8 }
        ]
      }
    });
    expect(firstView.mergedItems).toHaveLength(1);
    expect(firstView.mergedItems[0].content).toBe("We are going to");

    const updatedView = progressive.push({
      index: 1,
      startSec: 60,
      durationSec: 60,
      overlapLeadSec: 0,
      result: {
        text: "build this system.",
        segments: [{ start: 0.1, end: 2.5, text: "build this system." }],
        words: [
          { word: "build", start: 0.1, end: 0.8 },
          { word: "this", start: 0.8, end: 1.5 },
          { word: "system.", start: 1.5, end: 2.5 }
        ]
      }
    });
    expect(updatedView.updatedChunkIndices).toEqual([0, 1]);
    expect(updatedView.mergedItems).toHaveLength(1);
    expect(updatedView.mergedItems[0].from).toBe(57.0);
    expect(updatedView.mergedItems[0].to).toBe(62.5);
    expect(updatedView.mergedItems[0].content).toBe("We are going to build this system.");
    expect((updatedView.mergedItems[0] as { words?: Array<{ word: string }> }).words).toHaveLength(7);
  });

  it("跨片缝合守卫：句末含标点、距边界 >= 0.45s 或合并后 > 10s 时不误缝合", async () => {
    const { mergeChunkResults } = await import("../../extension/asr/pipeline.js");

    // 1) 末尾已有句末标点（含闭合引号）不缝合
    const closed = mergeChunkResults([
      {
        index: 0,
        startSec: 0,
        durationSec: 60,
        overlapLeadSec: 0,
        result: { text: "他说：“结束了。”", segments: [{ start: 57, end: 59.8, text: "他说：“结束了。”" }] }
      },
      {
        index: 1,
        startSec: 60,
        durationSec: 60,
        overlapLeadSec: 0,
        result: { text: "下一句。", segments: [{ start: 0.1, end: 2.0, text: "下一句。" }] }
      }
    ]);
    expect(closed).toHaveLength(2);

    // 2) 距右边界 >= 0.45s 不缝合
    const farFromEdge = mergeChunkResults([
      {
        index: 0,
        startSec: 0,
        durationSec: 60,
        overlapLeadSec: 0,
        result: { text: "未闭合但离边界太远", segments: [{ start: 56, end: 59.4, text: "未闭合但离边界太远" }] }
      },
      {
        index: 1,
        startSec: 60,
        durationSec: 60,
        overlapLeadSec: 0,
        result: { text: "接不上", segments: [{ start: 0.1, end: 2.0, text: "接不上。" }] }
      }
    ]);
    expect(farFromEdge).toHaveLength(2);

    // 3) 合并后总时长 > 10s 不缝合
    const tooLong = mergeChunkResults([
      {
        index: 0,
        startSec: 0,
        durationSec: 60,
        overlapLeadSec: 0,
        result: { text: "很长的半句", segments: [{ start: 52, end: 59.9, text: "很长的半句" }] }
      },
      {
        index: 1,
        startSec: 60,
        durationSec: 60,
        overlapLeadSec: 0,
        result: { text: "也很长的后半句。", segments: [{ start: 0.1, end: 4.0, text: "也很长的后半句。" }] }
      }
    ]);
    expect(tooLong).toHaveLength(2);
  });

  it("runAsrPipeline 乱序分片回传：onChunkResult 携带增量重算 snapshot 且最终产出时间单调不重叠", async () => {
    const snapshots: Array<{ index: number; updated: number[]; mergedLen: number }> = [];
    const body = await pipeline.runAsrPipeline({
      bvid: "BV1test",
      cid: "101",
      chunkHost: async ({ onChunkResult }) => {
        const rec1 = {
          index: 1,
          startSec: 58.5,
          durationSec: 21.5,
          overlapLeadSec: 1.5,
          result: {
            text: "后半段内容继续说下去。",
            segments: [
              { start: 0.2, end: 1.5, text: "先讲前半句" },
              { start: 1.5, end: 4.0, text: "再讲后半句。" }
            ]
          }
        };
        const rec0 = {
          index: 0,
          startSec: 0,
          durationSec: 60,
          overlapLeadSec: 0,
          result: {
            text: "开头。先讲前半句",
            segments: [
              { start: 1.0, end: 3.0, text: "开头。" },
              { start: 58.7, end: 59.9, text: "先讲前半句" }
            ]
          }
        };
        onChunkResult?.(rec1);
        onChunkResult?.(rec0);
        return { results: [rec1, rec0], totalChunks: 2, skippedSegments: 0, failedChunks: 0 };
      },
      onChunkResult: (record, _items, snapshot) => {
        snapshots.push({
          index: record.index,
          updated: snapshot?.updatedChunkIndices ?? [],
          mergedLen: snapshot?.mergedItems.length ?? 0
        });
      }
    });

    expect(snapshots).toEqual([
      { index: 1, updated: [1], mergedLen: 2 },
      { index: 0, updated: [0, 1], mergedLen: 2 }
    ]);
    expect(body).toEqual([
      { from: 1.0, to: 3.0, content: "开头。" },
      { from: 58.7, to: 62.5, content: "先讲前半句再讲后半句。" }
    ]);
  });
});
