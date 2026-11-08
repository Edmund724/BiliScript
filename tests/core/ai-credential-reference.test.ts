// extension/core/ai-credential-reference.ts 测试（GLOSSARY「凭据引用」「官方端点判定」）：
//   ① 官方端点判定：DeepSeek 与 Gemini Live 正例（含尾斜杠 / 大小写 / 带路径 / 443 端口 / 裸域兜底）
//      与反例（明文 http / 非标端口 / 中转 / 反代 / 子域 / 非法串）；
//   ② 凭据引用记录解析：第一条「启用 + 对应 AI presetId + 官方端点」记录；停用 /
//      非目标预设 / 非官方端点跳过；unofficial / no-record / no-key 分野；
//      记录 baseUrl 为空时按预设协议查 protocolBaseUrls；
//   ③ 内存态 Key 解析（resolveAiCredentialKey）：返回 { key, status }，Key 为空时自动降级为 no-key；
//   ④ 运行时消息 Key 查询（queryAiCredentialKey）：两跳消息读取与异常安全兜底；
//   ⑤ UI 声明式查询与行副行状态文案注入（usesAiCredentialReference / annotateAiCredentialRows）。

import { describe, expect, it } from "vitest";
import {
  AI_CREDENTIAL_REFERENCE_SPECS,
  annotateAiCredentialRows,
  getAiCredentialStatusText,
  isOfficialAiCredentialEndpoint,
  queryAiCredentialKey,
  resolveAiCredentialKey,
  resolveAiCredentialReference,
  usesAiCredentialReference
} from "../../extension/core/ai-credential-reference.js";

const OFFICIAL_DEEPSEEK = {
  id: "p_deepseek",
  presetId: "deepseek",
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com/v1",
  enabled: true,
  hasSavedKey: true
};

const OFFICIAL_GEMINI = {
  id: "p_gemini",
  presetId: "gemini",
  name: "Gemini",
  baseUrl: "https://generativelanguage.googleapis.com",
  enabled: true,
  hasSavedKey: true
};

describe("官方端点判定（host 严格判等 + 仅 https）", () => {
  it("DeepSeek 正例与反例", () => {
    expect(isOfficialAiCredentialEndpoint("deepseek", "https://api.deepseek.com/v1")).toBe(true);
    expect(isOfficialAiCredentialEndpoint("deepseek", "https://api.deepseek.com/anthropic")).toBe(true);
    expect(isOfficialAiCredentialEndpoint("deepseek", "https://api.deepseek.com")).toBe(true);
    expect(isOfficialAiCredentialEndpoint("deepseek", "https://api.deepseek.com/")).toBe(true);
    expect(isOfficialAiCredentialEndpoint("deepseek", "HTTPS://API.DEEPSEEK.COM/V1/")).toBe(true);
    expect(isOfficialAiCredentialEndpoint("deepseek", "https://api.deepseek.com:443/v1")).toBe(true);
    expect(isOfficialAiCredentialEndpoint("deepseek", "api.deepseek.com/v1")).toBe(true);

    expect(isOfficialAiCredentialEndpoint("deepseek", "http://api.deepseek.com/v1")).toBe(false);
    expect(isOfficialAiCredentialEndpoint("deepseek", "https://api.deepseek.com:8443/v1")).toBe(false);
    expect(isOfficialAiCredentialEndpoint("deepseek", "https://deepseek-proxy.example.com/v1")).toBe(false);
    expect(isOfficialAiCredentialEndpoint("deepseek", "https://api.deepseek.com.cn/v1")).toBe(false);
    expect(isOfficialAiCredentialEndpoint("deepseek", "https://foo.api.deepseek.com/v1")).toBe(false);
    expect(isOfficialAiCredentialEndpoint("deepseek", "https://api.deepseek.com.evil.com/v1")).toBe(false);
    expect(isOfficialAiCredentialEndpoint("deepseek", "https://")).toBe(false);
    expect(isOfficialAiCredentialEndpoint("deepseek", "")).toBe(false);
    expect(isOfficialAiCredentialEndpoint("deepseek", null)).toBe(false);
    expect(isOfficialAiCredentialEndpoint("deepseek", undefined)).toBe(false);
  });

  it("Gemini Live 正例与反例", () => {
    expect(
      isOfficialAiCredentialEndpoint("gemini-live", "https://generativelanguage.googleapis.com")
    ).toBe(true);
    expect(
      isOfficialAiCredentialEndpoint("gemini-live", "HTTPS://GENERATIVELANGUAGE.GOOGLEAPIS.COM/")
    ).toBe(true);
    expect(
      isOfficialAiCredentialEndpoint("gemini-live", "http://generativelanguage.googleapis.com")
    ).toBe(false);
    expect(
      isOfficialAiCredentialEndpoint("gemini-live", "https://gemini-proxy.example.com")
    ).toBe(false);
    expect(
      isOfficialAiCredentialEndpoint(
        "gemini-live",
        "https://generativelanguage.googleapis.com.evil.example"
      )
    ).toBe(false);
  });
});

describe("凭据引用记录解析（resolveAiCredentialReference）", () => {
  it("DeepSeek：第一条启用 + deepseek 预设 + 官方端点的记录入选", () => {
    const { status, record } = resolveAiCredentialReference("deepseek", [
      { ...OFFICIAL_DEEPSEEK, id: "p_off", enabled: false },
      { ...OFFICIAL_DEEPSEEK, id: "p_other", presetId: "qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
      OFFICIAL_DEEPSEEK
    ]);
    expect(status).toBe("ok");
    expect(record?.id).toBe("p_deepseek");
  });

  it("DeepSeek：记录 baseUrl 为空时按预设协议查 protocolBaseUrls（Anthropic 端点同属官方 host）", () => {
    const { status, record } = resolveAiCredentialReference("deepseek", [
      { ...OFFICIAL_DEEPSEEK, baseUrl: "", protocol: "anthropic" }
    ]);
    expect(status).toBe("ok");
    expect(record?.id).toBe("p_deepseek");
  });

  it("Gemini Live：四态（ok / no-record / unofficial / no-key）完整区分", () => {
    const okResult = resolveAiCredentialReference("gemini-live", [
      { ...OFFICIAL_GEMINI, id: "disabled", enabled: false },
      { ...OFFICIAL_GEMINI, id: "other", presetId: "qwen" },
      OFFICIAL_GEMINI
    ]);
    expect(okResult.status).toBe("ok");
    expect(okResult.record?.id).toBe("p_gemini");

    expect(resolveAiCredentialReference("gemini-live", []).status).toBe("no-record");
    expect(
      resolveAiCredentialReference("gemini-live", [{ ...OFFICIAL_GEMINI, enabled: false }]).status
    ).toBe("no-record");
    expect(
      resolveAiCredentialReference("gemini-live", [
        { ...OFFICIAL_GEMINI, baseUrl: "https://proxy.example.com" }
      ]).status
    ).toBe("unofficial");
    expect(
      resolveAiCredentialReference("gemini-live", [{ ...OFFICIAL_GEMINI, hasSavedKey: false }])
        .status
    ).toBe("no-key");
  });
});

describe("内存态 Key 解析（resolveAiCredentialKey）", () => {
  it("按合格记录 id 从 aiProviderKeys 取值并 trim，Key 缺失时降级为 no-key", () => {
    expect(
      resolveAiCredentialKey("deepseek", [OFFICIAL_DEEPSEEK], { p_deepseek: "  sk-deepseek  " })
    ).toEqual({ key: "sk-deepseek", status: "ok" });

    expect(
      resolveAiCredentialKey("gemini-live", [OFFICIAL_GEMINI], { p_gemini: "  gm-key  " })
    ).toEqual({ key: "gm-key", status: "ok" });

    expect(resolveAiCredentialKey("deepseek", [OFFICIAL_DEEPSEEK], {})).toEqual({
      key: "",
      status: "no-key"
    });
    expect(resolveAiCredentialKey("deepseek", [], { p_deepseek: "sk" })).toEqual({
      key: "",
      status: "no-record"
    });
    expect(
      resolveAiCredentialKey(
        "gemini-live",
        [{ ...OFFICIAL_GEMINI, baseUrl: "https://proxy.example.com" }],
        { p_gemini: "gm" }
      )
    ).toEqual({ key: "", status: "unofficial" });
  });
});

describe("运行时消息 Key 查询（queryAiCredentialKey）", () => {
  it("DeepSeek 与 Gemini Live 按合格记录 id 读取 AI 平台 Key", async () => {
    const messages: unknown[] = [];
    const result = await queryAiCredentialKey("gemini-live", async (message) => {
      messages.push(message);
      if (message.type === "ai-providers-list") return { ok: true, providers: [OFFICIAL_GEMINI] };
      if (message.type === "get-ai-provider-key") return { ok: true, apiKey: "  shared-gemini-key  " };
      return { ok: false };
    });
    expect(result).toEqual({ key: "shared-gemini-key", status: "ok" });
    expect(messages).toEqual([
      { type: "ai-providers-list" },
      { type: "get-ai-provider-key", providerId: "p_gemini" }
    ]);
  });

  it("无合格记录、非官方端点、无 Key 或消息异常时返回空 Key 与对应状态", async () => {
    expect(
      await queryAiCredentialKey("deepseek", async () => ({ ok: true, providers: [] }))
    ).toEqual({ key: "", status: "no-record" });

    expect(
      await queryAiCredentialKey("deepseek", async () => ({
        ok: true,
        providers: [{ ...OFFICIAL_DEEPSEEK, baseUrl: "https://proxy.example.com/v1" }]
      }))
    ).toEqual({ key: "", status: "unofficial" });

    expect(
      await queryAiCredentialKey("deepseek", async () => ({
        ok: true,
        providers: [{ ...OFFICIAL_DEEPSEEK, hasSavedKey: false }]
      }))
    ).toEqual({ key: "", status: "no-key" });

    expect(
      await queryAiCredentialKey("deepseek", async () => {
        throw new Error("transport error");
      })
    ).toEqual({ key: "", status: "no-record" });
  });
});

describe("声明式规格、UI 字段显隐与行状态文案注入", () => {
  it("usesAiCredentialReference 仅匹配声明式 (consumerKind, consumerPresetId) 二元组", () => {
    expect(usesAiCredentialReference("search", "deepseek")).toBe(true);
    expect(usesAiCredentialReference("live", "gemini-live")).toBe(true);
    expect(usesAiCredentialReference("ai", "deepseek")).toBe(false);
    expect(usesAiCredentialReference("ai", "gemini")).toBe(false);
    expect(usesAiCredentialReference("search", "tavily")).toBe(false);
    expect(usesAiCredentialReference("live", "moss-live")).toBe(false);
  });

  it("三态文案表与 annotateAiCredentialRows 行注解一致", () => {
    expect(AI_CREDENTIAL_REFERENCE_SPECS.deepseek.officialHost).toBe("api.deepseek.com");
    expect(AI_CREDENTIAL_REFERENCE_SPECS["gemini-live"].officialHost).toBe(
      "generativelanguage.googleapis.com"
    );
    expect(getAiCredentialStatusText("deepseek", "ok")).toBe("已复用 AI 平台 Key");
    expect(getAiCredentialStatusText("deepseek", "no-record")).toBe(
      "请先在 AI 平台添加官方 DeepSeek 记录"
    );
    expect(getAiCredentialStatusText("gemini-live", "unofficial")).toBe(
      "AI 平台配置的并非 Gemini 官方接口地址"
    );

    const searchRows = annotateAiCredentialRows(
      "search",
      [{ id: "s1", presetId: "tavily" }, { id: "s2", presetId: "deepseek" }],
      [OFFICIAL_DEEPSEEK]
    );
    expect(searchRows).toEqual([
      { id: "s1", presetId: "tavily" },
      { id: "s2", presetId: "deepseek", statusNote: "已复用 AI 平台 Key" }
    ]);

    const liveRows = annotateAiCredentialRows(
      "live",
      [{ id: "l1", presetId: "gemini-live" }],
      []
    );
    expect(liveRows).toEqual([
      {
        id: "l1",
        presetId: "gemini-live",
        statusNote: "请先在 AI 平台添加官方 Gemini 记录"
      }
    ]);
  });
});
