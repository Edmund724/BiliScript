// extension/search/deepseek-credential.ts 测试（GLOSSARY「凭据引用」「官方端点判定」）：
//   ① 官方端点判定：正例（含规范化边界——尾斜杠 / 大小写 / 带路径 / 端口）与反例
//      （中转 / 反代 / 子域 / 无 scheme 裸域 / 非法串）；
//   ② 凭据引用记录解析：第一条「启用 + presetId deepseek + 官方端点」记录；停用 /
//      非 deepseek 预设 / 非官方端点跳过；无端点记录时的 unofficial / no-record 分野；
//      记录 baseUrl 为空时按预设协议查 protocolBaseUrls；
//   ③ Key 解析：按合格记录 id 从 aiProviderKeys 取值，无合格记录返回空串；
//   ④ 行状态三态文案单源。
import { describe, expect, it } from "vitest";
import {
  DEEPSEEK_OFFICIAL_HOST,
  DEEPSEEK_ROW_STATUS_TEXT,
  isOfficialDeepseekEndpoint,
  resolveDeepseekCredential,
  resolveDeepseekSearchKey
} from "../../extension/search/deepseek-credential.js";

describe("官方端点判定（host 严格判等）", () => {
  it("正例：官方端点（含路径 / 尾斜杠 / 大写 / 端口）", () => {
    expect(isOfficialDeepseekEndpoint("https://api.deepseek.com/v1")).toBe(true);
    expect(isOfficialDeepseekEndpoint("https://api.deepseek.com/anthropic")).toBe(true);
    expect(isOfficialDeepseekEndpoint("https://api.deepseek.com")).toBe(true);
    expect(isOfficialDeepseekEndpoint("https://api.deepseek.com/")).toBe(true);
    expect(isOfficialDeepseekEndpoint("HTTPS://API.DEEPSEEK.COM/V1/")).toBe(true);
    expect(isOfficialDeepseekEndpoint("https://api.deepseek.com:443/v1")).toBe(true);
  });

  it("正例：无 scheme 裸域按 https 兜底解析；反例：明文 http 不通过", () => {
    // AI 记录的 baseUrl 经编辑器 pattern 校验恒带 scheme；裸域仅作存储脏值兜底
    expect(isOfficialDeepseekEndpoint("api.deepseek.com/v1")).toBe(true);
    expect(isOfficialDeepseekEndpoint("http://api.deepseek.com/v1")).toBe(false);
  });

  it("反例：中转 / 反代 / 子域 / 非法串（禁 includes 子串匹配）", () => {
    expect(isOfficialDeepseekEndpoint("https://deepseek-proxy.example.com/v1")).toBe(false);
    expect(isOfficialDeepseekEndpoint("https://api.deepseek.com.cn/v1")).toBe(false);
    expect(isOfficialDeepseekEndpoint("https://foo.api.deepseek.com/v1")).toBe(false);
    expect(isOfficialDeepseekEndpoint("https://api.deepseek.com.evil.com/v1")).toBe(false);
    expect(isOfficialDeepseekEndpoint("https://")).toBe(false);
    expect(isOfficialDeepseekEndpoint("")).toBe(false);
    expect(isOfficialDeepseekEndpoint(null)).toBe(false);
    expect(isOfficialDeepseekEndpoint(undefined)).toBe(false);
  });
});

const OFFICIAL_AI = {
  id: "p_deepseek",
  presetId: "deepseek",
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com/v1",
  enabled: true,
  hasSavedKey: true
};

describe("凭据引用记录解析", () => {
  it("第一条启用 + deepseek 预设 + 官方端点的记录入选（含 hasSavedKey 透传）", () => {
    const { status, record } = resolveDeepseekCredential([
      { ...OFFICIAL_AI, id: "p_other", presetId: "qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
      OFFICIAL_AI
    ]);
    expect(status).toBe("ok");
    expect(record?.id).toBe("p_deepseek");
  });

  it("停用的 DeepSeek 记录不入选（跳到列表序的下一条合格记录）", () => {
    const { status, record } = resolveDeepseekCredential([
      { ...OFFICIAL_AI, id: "p_off", enabled: false },
      { ...OFFICIAL_AI, id: "p_on" }
    ]);
    expect(status).toBe("ok");
    expect(record?.id).toBe("p_on");
  });

  it("无启用 DeepSeek 记录 → no-record；有记录但端点全不通过 → unofficial", () => {
    expect(resolveDeepseekCredential([]).status).toBe("no-record");
    expect(
      resolveDeepseekCredential([{ ...OFFICIAL_AI, presetId: "qwen" }]).status
    ).toBe("no-record");
    expect(
      resolveDeepseekCredential([{ ...OFFICIAL_AI, baseUrl: "https://proxy.example.com/v1" }]).status
    ).toBe("unofficial");
  });

  it("合格记录无 Key → no-key（链跳过；行文案提示回 AI 平台补全）", () => {
    const { status } = resolveDeepseekCredential([{ ...OFFICIAL_AI, hasSavedKey: false }]);
    expect(status).toBe("no-key");
  });

  it("记录 baseUrl 为空时按预设协议查 protocolBaseUrls（Anthropic 端点同属官方 host）", () => {
    // deepseek 预设默认 anthropic 协议：/anthropic 端点也是 api.deepseek.com
    const { status, record } = resolveDeepseekCredential([
      { ...OFFICIAL_AI, baseUrl: "", protocol: "anthropic" }
    ]);
    expect(status).toBe("ok");
    expect(record?.id).toBe("p_deepseek");
  });
});

describe("Key 解析（链装配消费面）", () => {
  it("按合格记录 id 从 aiProviderKeys 取 Key", () => {
    expect(
      resolveDeepseekSearchKey([OFFICIAL_AI], { p_deepseek: "sk-deepseek" })
    ).toBe("sk-deepseek");
  });

  it("无合格记录 / 非官方端点 / 无 Key → 空串（链据此跳过）", () => {
    expect(resolveDeepseekSearchKey([], {})).toBe("");
    expect(
      resolveDeepseekSearchKey([{ ...OFFICIAL_AI, baseUrl: "https://proxy.example.com" }], { p_deepseek: "sk" })
    ).toBe("");
    expect(
      resolveDeepseekSearchKey([{ ...OFFICIAL_AI, hasSavedKey: false }], { p_deepseek: "sk" })
    ).toBe("");
  });

  it("Key 值 trim", () => {
    expect(
      resolveDeepseekSearchKey([OFFICIAL_AI], { p_deepseek: "  sk-deepseek  " })
    ).toBe("sk-deepseek");
  });
});

describe("行状态三态文案", () => {
  it("官方 host 常量与三态文案（ok / no-record|no-key / unofficial）", () => {
    expect(DEEPSEEK_OFFICIAL_HOST).toBe("api.deepseek.com");
    expect(DEEPSEEK_ROW_STATUS_TEXT.ok).toBe("已复用 AI 平台 Key");
    expect(DEEPSEEK_ROW_STATUS_TEXT["no-record"]).toBe("请先在 AI 平台添加官方 DeepSeek 记录");
    expect(DEEPSEEK_ROW_STATUS_TEXT["no-key"]).toBe("请先在 AI 平台添加官方 DeepSeek 记录");
    expect(DEEPSEEK_ROW_STATUS_TEXT.unofficial).toBe("AI 平台 Key 指向非官方端点");
  });
});
