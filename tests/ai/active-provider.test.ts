// ai/active-provider.ts content 侧解析测试（工单 02：presetId 穿线；arch-slim-3/09
// 单趟化随改）。解析走 resolve-ai-provider 合成消息单趟往返（策略与密钥校验
// 单源在 core/provider-handlers.ts 处理器），sendMessage 桩按新消息形状注入，
// 并断言「单趟」契约：全程恰一次 sendMessage。
// 断言解析结果的 provider 对象带回记录的 presetId（preset 词表键，非记录 id）：
// 这是概览 / 选区解释两条 content 链的平台识别主路径来源——baseUrl host 推断
// 退为兜底（custom 用户改过反代域名时识别不失效）。
// 末组覆盖模型同步：概览 / 选区解释没有模型选择器，必须跟随对话 tab 的选中模型
//（chrome.storage.local 的复合值），而不是平台记录的首个模型。

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { resetModuleState } from "../setup.js";

let activeProvider: typeof import("../../extension/ai/active-provider.js");
let sendMessageMock: Mock;

type StubMessagesOptions = {
  provider?: Record<string, unknown>;
  apiKey?: string;
  model?: string;
  ok?: boolean;
  error?: string;
};

function stubMessages({ provider, apiKey = "sk-test", model, ok = true, error }: StubMessagesOptions = {}) {
  sendMessageMock.mockImplementation((message, callback) => {
    if (message?.type === "resolve-ai-provider") {
      if (!ok) {
        callback({ ok: false, error });
      } else {
        callback({ ok: true, provider, apiKey, ...(model !== undefined ? { model } : {}) });
      }
    } else {
      callback({ ok: true });
    }
    return undefined;
  });
}

beforeEach(async () => {
  resetModuleState();
  // runtime.sendMessage 的命名空间声明是重载函数，mock 只能经 cast 换装
  //（同 tests/ui/provider-editor.test.ts 手法）。
  sendMessageMock = vi.fn();
  (chrome as unknown as { runtime: { sendMessage: Mock } }).runtime.sendMessage = sendMessageMock;
  activeProvider = await import("../../extension/ai/active-provider.js");
});

describe("resolveActiveProvider presetId 穿线（resolve-ai-provider 单趟）", () => {
  it("解析结果带回记录的 presetId（反代场景下是概览/解释链唯一的平台识别线索）", async () => {
    stubMessages({
      provider: {
        id: "p1",
        presetId: "qwen",
        name: "反代百炼",
        baseUrl: "https://thinking-proxy.example.com/v1",
        model: "qwen3-max",
        enabled: true,
        hasSavedKey: true
      }
    });

    const provider = await activeProvider.resolveActiveProvider();

    expect(provider).toEqual({
      baseUrl: "https://thinking-proxy.example.com/v1",
      apiKey: "sk-test",
      model: "qwen3-max",
      presetId: "qwen"
    });
  });

  it("旧记录无 presetId 字段 → 回传空串（resolver 端回落 host/模型名，不臆造平台）", async () => {
    stubMessages({
      provider: {
        id: "p1",
        name: "旧记录",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.1",
        enabled: true,
        hasSavedKey: true
      }
    });

    const provider = await activeProvider.resolveActiveProvider();

    expect(provider.presetId).toBe("");
  });

  it("单趟契约：解析全程恰一次 sendMessage（原三趟消息链收口防回焊）", async () => {
    stubMessages({
      provider: { id: "p1", name: "平台", baseUrl: "https://api.example.com/v1", model: "m1", enabled: true }
    });

    await activeProvider.resolveActiveProvider();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0][0]).toEqual({
      type: "resolve-ai-provider"
    });
  });

  it("处理器回 ok:false → 错误文案原样上翻为异常", async () => {
    stubMessages({ ok: false, error: "还没有配置 AI 平台，请先在插件设置中添加并启用。" });

    await expect(activeProvider.resolveActiveProvider()).rejects.toThrow(
      "还没有配置 AI 平台，请先在插件设置中添加并启用。"
    );
  });
});

// 模型选择独立性：概览 / 选区解释由 resolve-ai-provider 回传的默认模型决定，
// 不再受对话 tab chrome.storage.local 选中项影响。
describe("resolveActiveProvider 模型解析（独立于对话 tab）", () => {
  const SELECTED_KEY = "biliscript_ai_selected_provider";

  it("优先采用 resolve-ai-provider 返回的 model，忽略对话 tab 本地选中", async () => {
    (chrome.storage.local.get as Mock).mockImplementation(async () => ({
      [SELECTED_KEY]: `p1${String.fromCharCode(1)}glm-4.5`
    }));
    stubMessages({
      provider: { id: "p1", baseUrl: "https://opencode.ai/zen/go/v1", models: ["glm-4.5", "glm-5.1"], enabled: true },
      model: "glm-5.1"
    });

    const provider = await activeProvider.resolveActiveProvider();

    expect(provider.model).toBe("glm-5.1");
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
  });

  it("回包未携带 model 时回落目录首项或旧 model 字段", async () => {
    stubMessages({
      provider: { id: "p1", baseUrl: "https://api.example.com/v1", models: ["glm-4.5", "glm-5.1"], enabled: true }
    });
    expect((await activeProvider.resolveActiveProvider()).model).toBe("glm-4.5");

    stubMessages({
      provider: { id: "p1", baseUrl: "https://api.example.com/v1", model: "legacy-m", enabled: true }
    });
    expect((await activeProvider.resolveActiveProvider()).model).toBe("legacy-m");
  });

  it("平台已启用但 models 为空且无 model 字段 → 拒绝放行并抛 NO_ACTIVE_MODEL_MESSAGE", async () => {
    const { NO_ACTIVE_MODEL_MESSAGE } = await import("../../extension/core/overview-setup-error.js");
    stubMessages({
      provider: { id: "p1", baseUrl: "https://api.example.com/v1", models: [], model: "", enabled: true }
    });

    await expect(activeProvider.resolveActiveProvider()).rejects.toThrow(NO_ACTIVE_MODEL_MESSAGE);
  });
});

