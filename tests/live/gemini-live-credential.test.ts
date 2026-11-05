import { describe, expect, it } from "vitest";
import {
  GEMINI_LIVE_ROW_STATUS_TEXT,
  isOfficialGeminiEndpoint,
  queryGeminiCredentialKey,
  resolveGeminiCredential
} from "../../extension/live/gemini-live-credential.js";

const OFFICIAL_GEMINI = {
  id: "p_gemini",
  presetId: "gemini",
  baseUrl: "https://generativelanguage.googleapis.com",
  enabled: true,
  hasSavedKey: true
};

describe("Gemini 官方端点判定", () => {
  it("仅放行官方 HTTPS 主机，忽略大小写与尾部斜杠", () => {
    expect(isOfficialGeminiEndpoint("https://generativelanguage.googleapis.com")).toBe(true);
    expect(isOfficialGeminiEndpoint("HTTPS://GENERATIVELANGUAGE.GOOGLEAPIS.COM/")).toBe(true);
    expect(isOfficialGeminiEndpoint("http://generativelanguage.googleapis.com")).toBe(false);
    expect(isOfficialGeminiEndpoint("https://gemini-proxy.example.com")).toBe(false);
    expect(isOfficialGeminiEndpoint("https://generativelanguage.googleapis.com.evil.example")).toBe(false);
  });
});

describe("Gemini Live 凭据引用四态", () => {
  it("第一条已启用且端点合格的 Gemini 记录可复用", () => {
    const result = resolveGeminiCredential([
      { ...OFFICIAL_GEMINI, id: "disabled", enabled: false },
      { ...OFFICIAL_GEMINI, id: "other", presetId: "qwen" },
      OFFICIAL_GEMINI
    ]);
    expect(result.status).toBe("ok");
    expect(result.record?.id).toBe("p_gemini");
  });

  it("无启用 Gemini 记录为 no-record", () => {
    expect(resolveGeminiCredential([]).status).toBe("no-record");
    expect(resolveGeminiCredential([{ ...OFFICIAL_GEMINI, enabled: false }]).status).toBe("no-record");
  });

  it("有启用 Gemini 记录但均非官方端点为 unofficial", () => {
    expect(
      resolveGeminiCredential([{ ...OFFICIAL_GEMINI, baseUrl: "https://proxy.example.com" }]).status
    ).toBe("unofficial");
  });

  it("合格记录没有已存 Key 为 no-key", () => {
    expect(resolveGeminiCredential([{ ...OFFICIAL_GEMINI, hasSavedKey: false }]).status).toBe("no-key");
  });

  it("三态行文案与状态一一对应", () => {
    expect(GEMINI_LIVE_ROW_STATUS_TEXT.ok).toBe("已复用 AI 平台 Key");
    expect(GEMINI_LIVE_ROW_STATUS_TEXT["no-record"]).toBe("请先在 AI 平台添加官方 Gemini 记录");
    expect(GEMINI_LIVE_ROW_STATUS_TEXT["no-key"]).toBe("请先在 AI 平台添加官方 Gemini 记录");
    expect(GEMINI_LIVE_ROW_STATUS_TEXT.unofficial).toBe("AI 平台配置的并非 Gemini 官方接口地址");
  });
});

describe("Gemini Live 运行时凭据查询", () => {
  it("按合格记录 id 读取 AI 平台 Key", async () => {
    const messages: unknown[] = [];
    const result = await queryGeminiCredentialKey(async (message) => {
      messages.push(message);
      if (message.type === "ai-providers-list") return { ok: true, providers: [OFFICIAL_GEMINI] };
      if (message.type === "get-ai-provider-key") return { ok: true, apiKey: "shared-gemini-key" };
      return { ok: false };
    });
    expect(result).toEqual({ key: "shared-gemini-key", status: "ok" });
    expect(messages).toEqual([
      { type: "ai-providers-list" },
      { type: "get-ai-provider-key", providerId: "p_gemini" }
    ]);
  });
});
