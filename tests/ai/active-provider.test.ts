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
  ok?: boolean;
  error?: string;
};

function stubMessages({ provider, apiKey = "sk-test", ok = true, error }: StubMessagesOptions = {}) {
  sendMessageMock.mockImplementation((message, callback) => {
    if (message?.type === "resolve-ai-provider") {
      if (!ok) {
        callback({ ok: false, error });
      } else {
        callback({ ok: true, provider, apiKey });
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

// 模型同步（工单「概览和解释要用和对话 tab 同步的模型」）：对话 tab 的模型选择器把
// 「平台 id\u0001模型 id」复合值写进 chrome.storage.local（chat/providers.ts 的
// setSelectedProvider）；概览 / 选区解释没有模型选择器，只能读这个选中项。
// 不同步的后果：平台记录首个模型无效/不可用时，对话正常而概览与解释失败。
describe("resolveActiveProvider 模型同步（对话 tab 选中项）", () => {
  const SELECTED_KEY = "biliscript_ai_selected_provider";

  function stubSelected(value: unknown): void {
    (chrome.storage.local.get as Mock).mockImplementation(async () => ({ [SELECTED_KEY]: value }));
  }

  it("选中项指向同一平台 → 用选中的模型，而非记录首个", async () => {
    stubMessages({
      provider: { id: "p1", baseUrl: "https://opencode.ai/zen/go/v1", models: ["glm-4.5", "glm-5.1"], enabled: true }
    });
    stubSelected(`p1${String.fromCharCode(1)}glm-5.1`);

    const provider = await activeProvider.resolveActiveProvider();

    expect(provider.model).toBe("glm-5.1");
  });

  it("选中项属于别的平台 → 不串用，回落记录首个模型", async () => {
    stubMessages({
      provider: { id: "p1", baseUrl: "https://api.example.com/v1", models: ["glm-4.5"], enabled: true }
    });
    stubSelected(`p2${String.fromCharCode(1)}别的模型`);

    const provider = await activeProvider.resolveActiveProvider();

    expect(provider.model).toBe("glm-4.5");
  });

  it("无选中项 / 旧裸平台 id（无模型段）→ 回落记录首个模型", async () => {
    stubMessages({
      provider: { id: "p1", baseUrl: "https://api.example.com/v1", models: ["glm-4.5", "glm-5.1"], enabled: true }
    });

    stubSelected(undefined);
    expect((await activeProvider.resolveActiveProvider()).model).toBe("glm-4.5");

    // 旧记录：复合值只有平台 id（multi-model-catalog 之前写入的裸 id），模型段为空
    stubSelected("p1");
    expect((await activeProvider.resolveActiveProvider()).model).toBe("glm-4.5");
  });

  it("选中项读取失败 → 静默回落记录首个模型（概览 / 解释不因偏好读取失败而中断）", async () => {
    stubMessages({
      provider: { id: "p1", baseUrl: "https://api.example.com/v1", models: ["glm-4.5"], enabled: true }
    });
    (chrome.storage.local.get as Mock).mockRejectedValue(new Error("storage 不可用"));

    const provider = await activeProvider.resolveActiveProvider();

    expect(provider.model).toBe("glm-4.5");
  });
});
