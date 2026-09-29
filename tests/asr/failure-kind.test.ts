// failure-kind.ts（ASR 失败分类纯模块）测试：票 04 判定表全表 + 判定次序。
// 四档报文形状取自 research/platform-error-shapes.md §0（OpenAI 嵌套 /
// 硅基流动扁平 / FastAPI detail / 纯文本 Not Found），逐条断言。
// 重点覆盖三处「同一状态码不同含义」的陷阱：
//   1. source 维度——音轨从 B 站 CDN 下载，它回的 403/404 与 ASR 平台同形，
//      只看状态码会把 CDN 的 403 报成「API Key 无效」（本次要修的误报镜像）；
//   2. 429 双义——OpenAI 一侧额度与限流共用 429，只能靠 error.type 消歧；
//   3. 404 撞码——speaches「模型没下载」与「路由不存在」同码，但两者同为配置问题。
// 纯模块：无 fetch / 无 chrome / 无 state，全部同步断言。

import { describe, expect, it } from "vitest";
import { classifyAsrFailure } from "../../extension/asr/failure-kind.js";
import type { AsrFailureInput, AsrFailureKind, AsrFailureSource } from "../../extension/asr/failure-kind.js";

// 平台侧（适配器）简写
function platform(status: number | null | undefined, body?: string | null, baseUrl?: unknown): AsrFailureInput {
  return { source: "platform", status, body, provider: baseUrl === undefined ? null : { baseUrl } };
}

// 媒体侧（offscreen 管线抛出点）简写
function media(message?: string | null): AsrFailureInput {
  return { source: "media", status: undefined, body: message };
}

// 四档真实报文形状（research/platform-error-shapes.md §0 逐字）
const SHAPES = {
  // ① OpenAI 嵌套：额度用尽样例（chatbox#401）
  openAiQuota:
    '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","param":null,"code":null}}',
  // ① OpenAI 嵌套：限流（error.type 为结构化枚举）
  openAiRateLimit: '{"error":{"message":"Rate limit reached for requests","type":"rate_limit_exceeded","param":null,"code":null}}',
  // ① OpenAI 嵌套：格式非法（portkey 错误库）
  openAiFormat:
    '{"error":{"message":"Invalid file format. Please use one of the supported formats: flac, m4a, mp3, mp4, mpeg, mpga, oga, ogg, wav, webm.","type":"invalid_request_error","param":null,"code":null}}',
  // ② 硅基流动扁平：模型不存在（官方错误处理页完整报文）
  siliconFlowModel: '{"code":20012,"message":"Model does not exist. Please check it carefully.","data":null}',
  // ③ FastAPI detail：模型没下载（speaches routers/utils.py 源码）
  fastApiModelMissing:
    '{"detail":"Model \'whisper-large-v3\' is not installed locally. You can download the model using `POST /v1/models`"}',
  fastApiRouteMissing: '{"detail":"Not Found"}',
  // ③ FastAPI detail：415 格式不支持
  fastApiFormat: '{"detail":"Failed to decode audio. The provided file type is not supported."}',
  fastApiAuthRequired:
    '{"detail":"API key required. Please provide an API key using the Authorization header with Bearer scheme."}',
  fastApiAuthInvalid: '{"detail":"Invalid API key. The provided API key is incorrect."}',
  // ④ 纯文本（硅基流动 404 未知路由实测）
  plainNotFound: "Not Found"
} as const;

describe("判定次序 0a：适配器哨兵 status === -1", () => {
  it("status=-1 → asr-unknown，即使 body 是「响应体不是合法 JSON」", () => {
    // 适配器 openai-transcriptions.ts:160 的自造哨兵：响应到了但体不是 JSON，
    // 无从判断是平台故障还是配置问题 → unknown（票 04 Q3）。
    expect(classifyAsrFailure(platform(-1, "响应体不是合法 JSON"))).toBe("asr-unknown");
  });

  it("status=-1 且带 media 关键词也不改判（哨兵优先于关键词）", () => {
    expect(classifyAsrFailure(platform(-1, "仅支持 fMP4 音轨"))).toBe("asr-unknown");
  });

  it("status=-1 对 media 来源同样 → asr-unknown", () => {
    expect(classifyAsrFailure({ source: "media", status: -1, body: "响应体不是合法 JSON" })).toBe("asr-unknown");
  });
});

describe("判定次序 0b：408 不看来源一律 asr-network", () => {
  it("platform + 408 → asr-network（票 04 表：408 → asr-network）", () => {
    expect(classifyAsrFailure(platform(408, ""))).toBe("asr-network");
  });

  it("media + 408 → asr-network（0b 优先于 0c 的媒体来源短路）", () => {
    expect(classifyAsrFailure({ source: "media", status: 408 })).toBe("asr-network");
  });

  it("408 带配置类文案仍 → asr-network（状态码优先于关键词）", () => {
    expect(classifyAsrFailure(platform(408, '{"detail":"Model is not installed locally"}'))).toBe("asr-network");
  });
});

describe("判定次序 0c：media 来源的 CDN 状态码绝不落进平台语义（CDN 陷阱）", () => {
  it("source=media + 403 → asr-media，而同状态的 platform → asr-auth", () => {
    // 音轨从 B 站 CDN 下载，403 与 ASR 平台同形。只看状态码会把 CDN 拒绝
    // 报成「API Key 无效」——正是本次要修的误报的镜像。
    expect(classifyAsrFailure({ source: "media", status: 403 })).toBe("asr-media");
    expect(classifyAsrFailure({ source: "platform", status: 403 })).toBe("asr-auth");
  });

  it("source=media + 404 → asr-media，而同状态的 platform → no-asr-config", () => {
    // 同一撞码：CDN 404 是音轨取不到，平台 404 才是 baseUrl / 模型配置错。
    expect(classifyAsrFailure({ source: "media", status: 404 })).toBe("asr-media");
    expect(classifyAsrFailure({ source: "platform", status: 404 })).toBe("no-asr-config");
  });

  it("source=media 的其余状态码一律 asr-media（401/402/429/500 都不按平台语义）", () => {
    for (const status of [400, 401, 402, 429, 500, 503]) {
      expect(classifyAsrFailure({ source: "media", status })).toBe("asr-media");
    }
  });

  it("source=media + status>0 时媒体来源短路优先于 5xx 的 asr-server", () => {
    expect(classifyAsrFailure({ source: "media", status: 500 })).toBe("asr-media");
  });

  it("平台侧状态码与媒体侧完全对照（同一张表两种来源）", () => {
    const expected: Array<[number, AsrFailureKind, AsrFailureKind]> = [
      [401, "asr-auth", "asr-media"],
      [402, "asr-quota", "asr-media"],
      [403, "asr-auth", "asr-media"],
      [404, "no-asr-config", "asr-media"],
      [415, "asr-media", "asr-media"],
      [500, "asr-server", "asr-media"]
    ];
    for (const [status, platformKind, mediaKind] of expected) {
      expect(classifyAsrFailure({ source: "platform", status })).toBe(platformKind);
      expect(classifyAsrFailure({ source: "media", status })).toBe(mediaKind);
    }
  });
});

describe("判定次序 1：平台侧状态码表（401/402/403/404/415/5xx）", () => {
  it("401 → asr-auth（OpenAI 与硅基流动的鉴权失败通码）", () => {
    expect(classifyAsrFailure(platform(401, '{"code":30014,"data":null,"message":"Token is invalid."}'))).toBe(
      "asr-auth"
    );
  });

  it("402 → asr-quota（硅基流动额度用尽，不在官方码表里但两社区样例一致）", () => {
    expect(classifyAsrFailure(platform(402, '{"code":30001,"message":"Sorry, your account balance is insufficient","data":null}'))).toBe(
      "asr-quota"
    );
    expect(classifyAsrFailure(platform(402, '{"error":{"message":"Insufficient Balance","type":"unknown_error","param":null,"code":"invalid_request_error"}}'))).toBe(
      "asr-quota"
    );
  });

  it("403 → asr-auth（硅基流动权限不足与 speaches Key 无效撞码，两家动作相同）", () => {
    expect(classifyAsrFailure(platform(403, SHAPES.fastApiAuthInvalid))).toBe("asr-auth");
    expect(classifyAsrFailure(platform(403, SHAPES.fastApiAuthRequired))).toBe("asr-auth");
    expect(classifyAsrFailure(platform(403, ""))).toBe("asr-auth");
  });

  it("404 → no-asr-config：路由不对与模型没下载同码，两种子情形同类", () => {
    expect(classifyAsrFailure(platform(404, SHAPES.plainNotFound))).toBe("no-asr-config");
    expect(classifyAsrFailure(platform(404, SHAPES.fastApiRouteMissing))).toBe("no-asr-config");
    expect(classifyAsrFailure(platform(404, SHAPES.fastApiModelMissing))).toBe("no-asr-config");
  });

  it("415 → asr-media（speaches 唯一专门表示格式不支持的状态码）", () => {
    expect(classifyAsrFailure(platform(415, SHAPES.fastApiFormat))).toBe("asr-media");
  });

  it("5xx → asr-server（500/502/503/504 一律，不看报文）", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyAsrFailure(platform(status, ""))).toBe("asr-server");
    }
    expect(classifyAsrFailure(platform(500, '{"detail":"The model repository does not contain a valid model card."}'))).toBe(
      "asr-server"
    );
  });

  it("表外状态码（418/405/409/451）→ asr-unknown", () => {
    for (const status of [418, 405, 409, 451]) {
      expect(classifyAsrFailure(platform(status, ""))).toBe("asr-unknown");
    }
  });
});

describe("判定次序 1：400 的三分（格式 → media / 模型不存在 → config / 其余 unknown）", () => {
  it("400 + OpenAI 格式报文（英文 format 关键词）→ asr-media", () => {
    expect(classifyAsrFailure(platform(400, SHAPES.openAiFormat))).toBe("asr-media");
  });

  it("400 + 无格式关键词的报文（speaches 空文件 detail）→ asr-unknown（不猜）", () => {
    // 该 detail 不含「格式 / format / unsupported media / 仅支持」任一关键词，
    // 票 04 的 400 三分里没有它的位置 → unknown（不自行补规则）。
    expect(classifyAsrFailure(platform(400, '{"detail":"Failed to decode audio. The provided file is likely empty."}'))).toBe(
      "asr-unknown"
    );
  });

  it("400 + 硅基流动 20012 报文 → no-asr-config（模型不存在）", () => {
    expect(classifyAsrFailure(platform(400, SHAPES.siliconFlowModel))).toBe("no-asr-config");
  });

  it("400 + 裸 20012 错误码 → no-asr-config", () => {
    expect(classifyAsrFailure(platform(400, '{"code":20012}'))).toBe("no-asr-config");
  });

  it("400 + 中文「模型不存在」→ no-asr-config", () => {
    expect(classifyAsrFailure(platform(400, '{"message":"模型不存在"}'))).toBe("no-asr-config");
  });

  it("400 无特征报文 → asr-unknown（不猜）", () => {
    expect(classifyAsrFailure(platform(400, ""))).toBe("asr-unknown");
    expect(classifyAsrFailure(platform(400, '{"detail":"参数不正确"}'))).toBe("asr-unknown");
  });

  it("400 格式关键词优先于模型关键词（含两者的报文按 media 判）", () => {
    expect(classifyAsrFailure(platform(400, '{"message":"Invalid file format for model does not exist"}'))).toBe(
      "asr-media"
    );
  });
});

describe("判定次序 1：429 双义（额度 vs 限流）", () => {
  it("429 + insufficient_quota → asr-quota", () => {
    expect(classifyAsrFailure(platform(429, SHAPES.openAiQuota))).toBe("asr-quota");
  });

  it("429 + rate_limit_exceeded → asr-ratelimit", () => {
    expect(classifyAsrFailure(platform(429, SHAPES.openAiRateLimit))).toBe("asr-ratelimit");
  });

  it("429 + 中文「余额」→ asr-quota；429 + 中文「限流」→ asr-ratelimit", () => {
    expect(classifyAsrFailure(platform(429, '{"code":30001,"message":"账户余额不足"}'))).toBe("asr-quota");
    expect(classifyAsrFailure(platform(429, '{"message":"请求被限流，请稍后重试"}'))).toBe("asr-ratelimit");
  });

  it("429 裸报文：硅基流动 baseUrl → asr-ratelimit（429 是它的限流默认语义）", () => {
    expect(classifyAsrFailure(platform(429, "", "https://api.siliconflow.cn/v1"))).toBe("asr-ratelimit");
  });

  it("429 裸报文：OpenAI 兼容 baseUrl → asr-quota（歧义时保守落额度）", () => {
    expect(classifyAsrFailure(platform(429, "", "https://api.openai.com/v1"))).toBe("asr-quota");
  });

  it("429 裸报文：本地 baseUrl（localhost / 127.0.0.1 / [::1] / 0.0.0.0）→ asr-ratelimit", () => {
    for (const baseUrl of [
      "http://localhost:8000/v1",
      "http://127.0.0.1:8000/v1",
      "http://[::1]:8000/v1",
      "http://0.0.0.0:8000/v1"
    ]) {
      expect(classifyAsrFailure(platform(429, "", baseUrl))).toBe("asr-ratelimit");
    }
  });

  it("429 裸报文：无 provider / baseUrl 缺失 / 非法 baseUrl → asr-quota（走歧义兜底）", () => {
    expect(classifyAsrFailure({ source: "platform", status: 429 })).toBe("asr-quota");
    expect(classifyAsrFailure(platform(429, "", null))).toBe("asr-quota");
    expect(classifyAsrFailure(platform(429, "", ""))).toBe("asr-quota");
    expect(classifyAsrFailure(platform(429, "", "not a url"))).toBe("asr-quota");
  });

  it("429 报文的额度关键词优先于 siliconflow host 默认（报文永远比 host 更具体）", () => {
    expect(classifyAsrFailure(platform(429, '{"message":"余额不足"}', "https://api.siliconflow.cn/v1"))).toBe(
      "asr-quota"
    );
  });

  it("429 报文的限流关键词优先于 OpenAI host 默认", () => {
    expect(classifyAsrFailure(platform(429, '{"message":"too many requests"}', "https://api.openai.com/v1"))).toBe(
      "asr-ratelimit"
    );
  });
});

describe("host 解析边界（429 分流靠 provider.baseUrl）", () => {
  it("带端口 / http 与 https 的本地 host 都识别为本地", () => {
    expect(classifyAsrFailure(platform(429, "", "http://localhost"))).toBe("asr-ratelimit");
    expect(classifyAsrFailure(platform(429, "", "https://127.0.0.1:443/v1/audio"))).toBe("asr-ratelimit");
    expect(classifyAsrFailure(platform(429, "", "http://localhost:8000"))).toBe("asr-ratelimit");
  });

  it("host 含 siliconflow 子串（含自建代理域名）→ asr-ratelimit", () => {
    expect(classifyAsrFailure(platform(429, "", "https://api.siliconflow.cn/v1"))).toBe("asr-ratelimit");
    expect(classifyAsrFailure(platform(429, "", "http://siliconflow.internal:8000/v1"))).toBe("asr-ratelimit");
  });

  it("localhost 出现在 path 里不算本地 host", () => {
    expect(classifyAsrFailure(platform(429, "", "https://api.openai.com/localhost/v1"))).toBe("asr-quota");
  });

  it("provider.baseUrl 非字符串（数字 / 对象 / 缺省）不被 host 规则误命中", () => {
    expect(classifyAsrFailure(platform(429, "", 42))).toBe("asr-quota");
    expect(classifyAsrFailure(platform(429, "", { href: "http://localhost" }))).toBe("asr-quota");
    expect(classifyAsrFailure({ source: "platform", status: 429, provider: {} })).toBe("asr-quota");
  });
});

describe("判定次序 0d：无有效状态码时的关键词表", () => {
  it("网络关键词（Failed to fetch / fetch failed / net:: / timeout / ECONNREFUSED）→ asr-network", () => {
    const bodies = [
      "Failed to fetch",
      "TypeError: Failed to fetch",
      "fetch failed",
      "NetworkError when attempting to fetch resource.",
      "net::ERR_CONNECTION_REFUSED",
      "request timeout",
      "connect timed out",
      "connect ECONNREFUSED 127.0.0.1:8000",
      "getaddrinfo ENOTFOUND api.example.com",
      "无法连接到平台",
      "连接被拒绝",
      "网络错误"
    ];
    for (const body of bodies) {
      expect(classifyAsrFailure(platform(undefined, body))).toBe("asr-network");
    }
  });

  it("配置关键词（HOST_PERMISSION_HINT / baseUrl 未配置 / 未配置 / 模型类）→ no-asr-config", () => {
    const bodies = [
      "该平台域名未授权，请在保存时允许权限", // extension/core/host-permissions.ts:28 逐字
      "平台 baseUrl 未配置", // extension/asr/adapters/openai-transcriptions.ts:115 逐字
      "未配置语音识别平台",
      "Model does not exist. Please check it carefully.",
      "model not found",
      "Model 'whisper-large-v3' is not installed locally.",
      "no such model",
      "模型不存在",
      "模型没下载"
    ];
    for (const body of bodies) {
      expect(classifyAsrFailure(platform(undefined, body))).toBe("no-asr-config");
    }
  });

  it("额度关键词（insufficient_quota / billing / 余额 / 额度）→ asr-quota", () => {
    for (const body of [
      "insufficient_quota",
      "You have insufficient quota",
      "quota exceeded",
      "please check your plan and billing details",
      "账户余额不足",
      "免费额度已用完"
    ]) {
      expect(classifyAsrFailure(platform(undefined, body))).toBe("asr-quota");
    }
  });

  it("限流关键词（rate_limit_exceeded / rate limit / too many requests / 限流 / 频率）→ asr-ratelimit", () => {
    for (const body of [
      "rate_limit_exceeded",
      "Rate limit reached for requests",
      "Too Many Requests",
      "请求被限流",
      "请求频率过高"
    ]) {
      expect(classifyAsrFailure(platform(undefined, body))).toBe("asr-ratelimit");
    }
  });

  it("媒体关键词（格式 / format / unsupported media / 仅支持）→ asr-media", () => {
    for (const body of [
      "音频格式不支持",
      "Invalid file format.",
      "unsupported media type",
      "仅支持 fMP4 音轨"
    ]) {
      expect(classifyAsrFailure(platform(undefined, body))).toBe("asr-media");
    }
  });

  it("关键词大小写不敏感且忽略首尾空白", () => {
    expect(classifyAsrFailure(platform(undefined, "  FAILED TO FETCH  "))).toBe("asr-network");
    expect(classifyAsrFailure(platform(undefined, "MODEL DOES NOT EXIST"))).toBe("no-asr-config");
    expect(classifyAsrFailure(platform(undefined, "Insufficient_Quota"))).toBe("asr-quota");
    expect(classifyAsrFailure(platform(undefined, "Rate Limit Reached"))).toBe("asr-ratelimit");
  });

  it("关键词优先级：网络 > 配置 > 额度 > 限流 > 媒体", () => {
    expect(classifyAsrFailure(platform(undefined, "Failed to fetch: 模型不存在"))).toBe("asr-network");
    expect(classifyAsrFailure(platform(undefined, "模型不存在，额度不足"))).toBe("no-asr-config");
    expect(classifyAsrFailure(platform(undefined, "余额不足，请降低请求频率"))).toBe("asr-quota");
    expect(classifyAsrFailure(platform(undefined, "限流，格式不支持"))).toBe("asr-ratelimit");
  });
});

describe("判定次序 0d：来源与关键词的先后（媒体来源的兜底）", () => {
  it("source=media + 音频下载失败（无状态码）→ asr-media", () => {
    expect(classifyAsrFailure(media("音频下载失败"))).toBe("asr-media");
  });

  it("source=media + 音频解码失败：仅支持 fMP4 音轨 → asr-media（关键词命中）", () => {
    expect(classifyAsrFailure(media("音频解码失败：仅支持 fMP4 音轨"))).toBe("asr-media");
  });

  it("source=media + 无任何关键词 → asr-media（媒体来源默认落媒体类）", () => {
    expect(classifyAsrFailure(media("音频切片为空，无法转写"))).toBe("asr-media");
    expect(classifyAsrFailure(media("视频过长"))).toBe("asr-media");
  });

  it("媒体来源的网络关键词优先于来源默认（CDN 连不上要说网络，不是音轨格式）", () => {
    expect(classifyAsrFailure(media("Failed to fetch"))).toBe("asr-network");
    expect(classifyAsrFailure(media("音频下载失败：网络错误"))).toBe("asr-network");
  });

  it("媒体来源的配置类文案落 no-asr-config（域名未授权在管线侧抛出）", () => {
    expect(classifyAsrFailure(media("该平台域名未授权，请在保存时允许权限"))).toBe("no-asr-config");
  });
});

describe("判定次序 2：无状态码无关键词的兜底", () => {
  it("平台侧无状态码无关键词 → asr-unknown", () => {
    expect(classifyAsrFailure(platform(undefined, "转写请求失败"))).toBe("asr-unknown");
    expect(classifyAsrFailure(platform(null, ""))).toBe("asr-unknown");
  });

  it("平台侧完全空输入 → asr-unknown", () => {
    expect(classifyAsrFailure({ source: "platform" })).toBe("asr-unknown");
  });

  it("「暂不支持的平台类型：x」不加特判，落 asr-unknown（票 04 未给规则）", () => {
    expect(classifyAsrFailure(platform(undefined, "暂不支持的平台类型：mystery"))).toBe("asr-unknown");
  });
});

describe("输入容错：非法 status", () => {
  it("status 为 NaN / Infinity / -Infinity 视为无有效状态码", () => {
    expect(classifyAsrFailure(platform(Number.NaN, "Failed to fetch"))).toBe("asr-network");
    expect(classifyAsrFailure(platform(Number.POSITIVE_INFINITY, ""))).toBe("asr-unknown");
    expect(classifyAsrFailure(platform(Number.NEGATIVE_INFINITY, "模型不存在"))).toBe("no-asr-config");
  });

  it("status <= 0（0 与 -5）不算有效状态码，走关键词", () => {
    expect(classifyAsrFailure(platform(0, "模型不存在"))).toBe("no-asr-config");
    expect(classifyAsrFailure(platform(-5, "Failed to fetch"))).toBe("asr-network");
  });

  it("status 传字符串（\"401\" / \"403\" / \"404\"）与数字等价", () => {
    // 跨 port 传输后类型可能丢失（票 03 契约保证 kind 到 content，但输入侧防御）
    expect(classifyAsrFailure(platform("401" as unknown as number))).toBe("asr-auth");
    expect(classifyAsrFailure(platform("403" as unknown as number))).toBe("asr-auth");
    expect(classifyAsrFailure(platform("404" as unknown as number))).toBe("no-asr-config");
  });

  it("status 传非数字字符串视为无有效状态码", () => {
    expect(classifyAsrFailure(platform("abc" as unknown as number, "Failed to fetch"))).toBe("asr-network");
  });

  it("body 为 null / undefined / 数字不抛错", () => {
    expect(classifyAsrFailure(platform(401, null))).toBe("asr-auth");
    expect(classifyAsrFailure(platform(undefined, null))).toBe("asr-unknown");
    expect(classifyAsrFailure({ source: "platform", status: undefined, body: 123 as unknown as string })).toBe(
      "asr-unknown"
    );
  });

  it("provider 为 null / undefined 不抛错", () => {
    expect(classifyAsrFailure({ source: "platform", status: 429, provider: null })).toBe("asr-quota");
    expect(classifyAsrFailure({ source: "platform", status: 429, provider: undefined })).toBe("asr-quota");
  });
});

describe("判定表全表回归（票 04 判定表逐行）", () => {
  it("每行「输入 → kind」一次跑完", () => {
    const table: Array<[string, AsrFailureInput, AsrFailureKind]> = [
      ["适配器哨兵", platform(-1, "响应体不是合法 JSON"), "asr-unknown"],
      ["请求超时", platform(408, ""), "asr-network"],
      ["音轨 CDN 403", { source: "media", status: 403 }, "asr-media"],
      ["音轨 CDN 404", { source: "media", status: 404 }, "asr-media"],
      ["鉴权失败", platform(401, ""), "asr-auth"],
      ["余额用尽", platform(402, ""), "asr-quota"],
      ["权限不足", platform(403, ""), "asr-auth"],
      ["路由 / 模型缺失", platform(404, SHAPES.plainNotFound), "no-asr-config"],
      ["格式不支持", platform(415, SHAPES.fastApiFormat), "asr-media"],
      ["平台故障", platform(503, ""), "asr-server"],
      ["模型不存在", platform(400, SHAPES.siliconFlowModel), "no-asr-config"],
      ["格式非法", platform(400, SHAPES.openAiFormat), "asr-media"],
      ["OpenAI 额度", platform(429, SHAPES.openAiQuota), "asr-quota"],
      ["OpenAI 限流", platform(429, SHAPES.openAiRateLimit), "asr-ratelimit"],
      ["连接被拒", platform(undefined, "Failed to fetch"), "asr-network"],
      ["域名未授权", platform(undefined, "该平台域名未授权，请在保存时允许权限"), "no-asr-config"],
      ["baseUrl 未配置", platform(undefined, "平台 baseUrl 未配置"), "no-asr-config"],
      ["音轨下载失败", media("音频下载失败"), "asr-media"],
      ["无从判断", platform(undefined, "转写请求失败"), "asr-unknown"]
    ];
    for (const [name, inputCase, expected] of table) {
      expect(classifyAsrFailure(inputCase), name).toBe(expected);
    }
  });
});
