import { describe, expect, it } from "vitest";
import {
  ASR_SOURCE_KEY_PREFIX,
  TRANSLATED_SOURCE_KEY_PREFIX,
  buildSubtitleSourceKey,
  isAsrVariantSourceKey,
  isTranslatedVariantSourceKey,
  subtitleSourceKey,
  trackIdentity,
  translatedTrackId
} from "../../extension/subtitle/source-key.js";

const QUERY_URL = "https://i0.hdslb.com/bfs/ai_subtitle/p/zh.json?auth_key=123";

describe("字幕轨身份 → source key：四态真值表（字节 = 既有缓存兼容面）", () => {
  it("track：轨 id 前后空格 trim 进 id_ 分支", () => {
    expect(subtitleSourceKey({ kind: "track", trackId: "  abc  " })).toBe("id_abc");
    expect(buildSubtitleSourceKey("  abc  ", QUERY_URL, "zh-CN")).toBe("id_abc");
  });

  it("url：带 query 的绝对地址削成 hostname + path（query 不进键）", () => {
    expect(subtitleSourceKey({ kind: "url", url: QUERY_URL })).toBe("url_i0.hdslb.com/bfs/ai_subtitle/p/zh.json");
    expect(buildSubtitleSourceKey("", QUERY_URL, "zh-CN")).toBe("url_i0.hdslb.com/bfs/ai_subtitle/p/zh.json");
  });

  it("url：相对协议地址（//host/...）走非 URL 解析的净化分支", () => {
    expect(subtitleSourceKey({ kind: "url", url: "//i0.hdslb.com/bfs/ai_subtitle/p/zh.json?auth_key=123" })).toBe(
      "url_//i0.hdslb.com/bfs/ai_subtitle/p/zh.json_auth_key_123"
    );
  });

  it("lang：空 / 纯空格 → unknown 兜底；大小写与周围空格归一到小写", () => {
    expect(subtitleSourceKey({ kind: "lang", lang: "" })).toBe("lang_unknown");
    expect(subtitleSourceKey({ kind: "lang", lang: "   " })).toBe("lang_unknown");
    expect(subtitleSourceKey({ kind: "lang", lang: " ZH-CN " })).toBe("lang_zh-cn");
    expect(buildSubtitleSourceKey("", "", " ZH-CN ")).toBe("lang_zh-cn");
  });

  it("asr：provider / model / lang 用 : 原样拼接，空 model 段不剔，可选 audioTrackId 追加 :track~ 后缀且缺省字节不变", () => {
    expect(subtitleSourceKey({ kind: "asr", providerId: "p1", model: "whisper-large-v3", lang: "auto" })).toBe(
      "id_asr:p1:whisper-large-v3:auto"
    );
    expect(subtitleSourceKey({ kind: "asr", providerId: "p1", model: "whisper-large-v3", lang: "auto", audioTrackId: "" })).toBe(
      "id_asr:p1:whisper-large-v3:auto"
    );
    expect(subtitleSourceKey({ kind: "asr", providerId: "p1", model: "whisper-large-v3", lang: "auto", audioTrackId: "en.4" })).toBe(
      "id_asr:p1:whisper-large-v3:auto:track~en.4"
    );
    expect(subtitleSourceKey({ kind: "asr", providerId: "p1", model: "", lang: "auto" })).toBe("id_asr:p1::auto");
    expect(subtitleSourceKey({ kind: "asr", providerId: "", model: "", lang: "" })).toBe("id_asr:::");
  });

  it("translated：产出字节不变的 id_translate-<lang>", () => {
    expect(subtitleSourceKey({ kind: "translated", targetLang: "en" })).toBe("id_translate-en");
    expect(subtitleSourceKey({ kind: "translated", targetLang: "  ja  " })).toBe("id_translate-ja");
    expect(subtitleSourceKey({ kind: "translated", targetLang: "" })).toBe("id_translate-");
    expect(translatedTrackId("  en  ")).toBe("translate-en");
  });
});

describe("三字段原始输入 → 身份：优先级 id > url > lang 的唯一裁定处", () => {
  it("有 id 取 track（压过 url / lang），id 空 → url，url 归一后为空 → lang", () => {
    expect(trackIdentity("88", QUERY_URL, "zh-CN")).toEqual({ kind: "track", trackId: "88" });
    expect(trackIdentity("", QUERY_URL, "zh-CN")).toEqual({ kind: "url", url: QUERY_URL });
    expect(trackIdentity("", "", "zh-CN")).toEqual({ kind: "lang", lang: "zh-CN" });
  });

  it("空白 id / 归一后为空串的 url 都不算身份，回落 lang 分支", () => {
    expect(trackIdentity("   ", "   ", "zh-CN")).toEqual({ kind: "lang", lang: "zh-CN" });
    expect(trackIdentity(null, null, "zh-CN")).toEqual({ kind: "lang", lang: "zh-CN" });
    expect(subtitleSourceKey(trackIdentity("", "   ", "zh-CN"))).toBe("lang_zh-cn");
  });
});

describe("ASR 变体判据与编码同根", () => {
  const ASR_IDENTITIES = [
    { kind: "asr", providerId: "p1", model: "whisper-large-v3", lang: "auto" },
    { kind: "asr", providerId: "p1", model: "", lang: "auto" },
    { kind: "asr", providerId: "", model: "", lang: "" }
  ] as const;

  it("ASR 身份组出的键必被变体判据认出（含空 model 段）", () => {
    expect(ASR_IDENTITIES.map((identity) => subtitleSourceKey(identity))).toEqual([
      "id_asr:p1:whisper-large-v3:auto",
      "id_asr:p1::auto",
      "id_asr:::"
    ]);
    for (const identity of ASR_IDENTITIES) {
      const sourceKey = subtitleSourceKey(identity);
      expect(isAsrVariantSourceKey(sourceKey)).toBe(true);
      expect(sourceKey.startsWith(ASR_SOURCE_KEY_PREFIX)).toBe(true);
    }
  });

  it("平台轨三态（track / url / lang）一律不被认出", () => {
    const platformKeys = [
      subtitleSourceKey({ kind: "track", trackId: "2120476497172283392" }),
      subtitleSourceKey({ kind: "url", url: QUERY_URL }),
      subtitleSourceKey({ kind: "lang", lang: "zh-CN" })
    ];
    expect(platformKeys).toEqual([
      "id_2120476497172283392",
      "url_i0.hdslb.com/bfs/ai_subtitle/p/zh.json",
      "lang_zh-cn"
    ]);
    for (const key of platformKeys) {
      expect(isAsrVariantSourceKey(key)).toBe(false);
    }
  });

  it("判据 = 前缀匹配，前缀由叶内唯一根常量派生（字面钉住缓存字节）", () => {
    expect(ASR_SOURCE_KEY_PREFIX).toBe("id_asr:");
    expect(isAsrVariantSourceKey(`${ASR_SOURCE_KEY_PREFIX}p:m:auto`)).toBe(true);
    expect(isAsrVariantSourceKey("id_88")).toBe(false);
    expect(isAsrVariantSourceKey("url_a.b/c.json")).toBe(false);
    expect(isAsrVariantSourceKey("")).toBe(false);
  });
});

describe("译文副轨变体判据与编码同根", () => {
  it("translated 身份组出的键必被译文判据认出，平台/ASR 键不被误判", () => {
    expect(TRANSLATED_SOURCE_KEY_PREFIX).toBe("id_translate-");
    const translatedKey = subtitleSourceKey({ kind: "translated", targetLang: "en" });
    expect(isTranslatedVariantSourceKey(translatedKey)).toBe(true);
    expect(isAsrVariantSourceKey(translatedKey)).toBe(false);

    expect(isTranslatedVariantSourceKey(subtitleSourceKey({ kind: "track", trackId: "88" }))).toBe(false);
    expect(isTranslatedVariantSourceKey(subtitleSourceKey({ kind: "asr", providerId: "p", model: "m", lang: "auto" }))).toBe(false);
    expect(isTranslatedVariantSourceKey("")).toBe(false);
  });
});
