import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

const IMAGE = { mime: "image/webp", data: "QUJD" };
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";

let mod: typeof import("../../extension/chat/image-support.js");
let chatSessionState: typeof import("../../extension/chat/chat-state.js").chatSessionState;
let chatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").chatSessionStateForTests;
let buildModelOptionValue: typeof import("../../extension/shared/selected-provider.js").buildModelOptionValue;

function seedProvider(provider: { id: string; presetId?: string; baseUrl?: string }): void {
  chatSessionStateForTests.providers = [
    { id: provider.id, presetId: provider.presetId, baseUrl: provider.baseUrl, models: ["m1"] }
  ];
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface GateHarness {
  gate: import("../../extension/chat/image-support.js").ImageSupportGate;
  notify: ReturnType<typeof vi.fn>;
  lookupMeta: ReturnType<typeof vi.fn>;
}

const NULL_LOOKUP = async (): Promise<{ input: readonly string[] } | null> => null;

function makeGate(options: {
  value?: string;
  lookup?: (presetId?: string, baseUrl?: string, modelId?: string) => Promise<{ input: readonly string[] } | null>;
} = {}): GateHarness {
  const notify = vi.fn();
  const lookupMeta = vi.fn(options.lookup || NULL_LOOKUP);
  const gate = mod.createImageSupportGate({
    getSelectedModelValue: () => options.value ?? "",
    notify,
    lookupMeta
  });
  return { gate, notify, lookupMeta };
}

function makeRealGate(value: string): { gate: import("../../extension/chat/image-support.js").ImageSupportGate; notify: ReturnType<typeof vi.fn> } {
  const notify = vi.fn();
  return {
    gate: mod.createImageSupportGate({ getSelectedModelValue: () => value, notify }),
    notify
  };
}

beforeEach(async () => {
  resetModuleState();
  mod = await import("../../extension/chat/image-support.js");
  chatSessionState = (await import("../../extension/chat/chat-state.js")).chatSessionState;
  chatSessionStateForTests = (await import("../../extension/chat/chat-state.js")).chatSessionStateForTests;
  buildModelOptionValue = (await import("../../extension/shared/selected-provider.js")).buildModelOptionValue;
});

describe("门控：乐观放行（目录明确登记不收图才提示）", () => {
  it("目录含 image：不提示", async () => {
    seedProvider({ id: "p1", presetId: "custom" });
    const { gate, notify, lookupMeta } = makeGate({
      value: buildModelOptionValue("p1", "gpt-4o"),
      lookup: async () => ({ input: ["text", "image"] })
    });

    gate.check([IMAGE]);
    await flush();

    expect(lookupMeta).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("目录明确只文本：提示（不阻断——只走提示出口）", async () => {
    seedProvider({ id: "p1", presetId: "deepseek", baseUrl: DEEPSEEK_BASE_URL });
    const { gate, notify } = makeGate({
      value: buildModelOptionValue("p1", "deepseek-v4-flash"),
      lookup: async () => ({ input: ["text"] })
    });

    gate.check([IMAGE, IMAGE]);
    await flush();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(mod.IMAGE_UNSUPPORTED_NOTICE);
  });

  it("目录查不到（该平台 / 该模型没有数据）：静默放行", async () => {
    seedProvider({ id: "p1", presetId: "qwen" });
    const { gate, notify, lookupMeta } = makeGate({
      value: buildModelOptionValue("p1", "qwen3.8-max"),
      lookup: async () => null
    });

    gate.check([IMAGE]);
    await flush();

    expect(lookupMeta).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("识别入参：选中平台的 (presetId, baseUrl) + 选中模型 id", async () => {
    seedProvider({ id: "p1", presetId: "deepseek", baseUrl: DEEPSEEK_BASE_URL });
    const { gate, lookupMeta } = makeGate({
      value: buildModelOptionValue("p1", "deepseek-v4-flash"),
      lookup: async () => null
    });

    gate.check([IMAGE]);
    await flush();

    expect(lookupMeta).toHaveBeenCalledWith("deepseek", DEEPSEEK_BASE_URL, "deepseek-v4-flash");
  });

  it("无图：连目录都不查", async () => {
    seedProvider({ id: "p1", presetId: "deepseek", baseUrl: DEEPSEEK_BASE_URL });
    const { gate, notify, lookupMeta } = makeGate({
      value: buildModelOptionValue("p1", "deepseek-v4-flash")
    });

    gate.check([]);
    await flush();

    expect(lookupMeta).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("无身份（未选模型 / 平台不在列表）：静默且不查目录", async () => {
    const unselected = makeGate({ value: "" });
    unselected.gate.check([IMAGE]);
    await flush();
    expect(unselected.lookupMeta).not.toHaveBeenCalled();
    expect(unselected.notify).not.toHaveBeenCalled();

    seedProvider({ id: "other" });
    const gone = makeGate({ value: buildModelOptionValue("p1", "deepseek-v4-flash") });
    gone.gate.check([IMAGE]);
    await flush();
    expect(gone.lookupMeta).not.toHaveBeenCalled();
    expect(gone.notify).not.toHaveBeenCalled();
  });

  it("目录查询失败：静默放行，不抛也不提示", async () => {
    seedProvider({ id: "p1", presetId: "deepseek", baseUrl: DEEPSEEK_BASE_URL });
    const { gate, notify } = makeGate({
      value: buildModelOptionValue("p1", "deepseek-v4-flash"),
      lookup: async () => {
        throw new Error("chunk 404");
      }
    });

    gate.check([IMAGE]);
    await flush();

    expect(notify).not.toHaveBeenCalled();
  });
});

describe("supportsImages：截帧工具能力查询", () => {
  it("仅目录明确不含 image 时关闭；有图、未知与查询失败均放行", async () => {
    seedProvider({ id: "p1", presetId: "custom" });
    const value = buildModelOptionValue("p1", "m1");

    const vision = makeGate({ value, lookup: async () => ({ input: ["text", "image"] }) });
    await expect(vision.gate.supportsImages()).resolves.toBe(true);

    const unknown = makeGate({ value, lookup: async () => null });
    await expect(unknown.gate.supportsImages()).resolves.toBe(true);

    const failed = makeGate({ value, lookup: async () => { throw new Error("catalog unavailable"); } });
    await expect(failed.gate.supportsImages()).resolves.toBe(true);

    const textOnly = makeGate({ value, lookup: async () => ({ input: ["text"] }) });
    await expect(textOnly.gate.supportsImages()).resolves.toBe(false);
  });

  it("没有可识别的选中模型时不提供截帧工具", async () => {
    const { gate, lookupMeta } = makeGate({ value: "" });
    await expect(gate.supportsImages()).resolves.toBe(false);
    expect(lookupMeta).not.toHaveBeenCalled();
  });
});

describe("真实目录链路（默认懒加载接缝，不注入替身）", () => {
  it("deepseek-v4-pro（目录仅文本）→ 提示；gpt-4o（目录含图）→ 无提示；未知模型 → 无提示", async () => {
    const lazy = await import("../../extension/ui/lazy-model-catalog.js");
    expect(lazy.loadedModelCatalog()).toBeNull();

    seedProvider({ id: "p1", presetId: "deepseek", baseUrl: DEEPSEEK_BASE_URL });
    const textOnly = makeRealGate(buildModelOptionValue("p1", "deepseek-v4-pro"));
    textOnly.gate.check([IMAGE]);
    await vi.waitFor(() => expect(textOnly.notify).toHaveBeenCalledWith(mod.IMAGE_UNSUPPORTED_NOTICE));
    expect(lazy.loadedModelCatalog()).not.toBeNull();

    seedProvider({ id: "p1", presetId: "openrouter" });
    const vision = makeRealGate(buildModelOptionValue("p1", "openai/gpt-4o"));
    vision.gate.check([IMAGE]);

    const unknown = makeRealGate(buildModelOptionValue("p1", "no-such-model"));
    unknown.gate.check([IMAGE]);

    await flush();
    expect(vision.notify).not.toHaveBeenCalled();
    expect(unknown.notify).not.toHaveBeenCalled();
  });
});

describe("400 兜底：错误文案里给出可操作线索", () => {
  it("带图 + HTTP 400 + 平台文案无线索 → 补固定提示", () => {
    expect(mod.imageUnsupportedErrorHint("HTTP 400: [openai] invalid_request_error", [IMAGE])).toBe(
      mod.IMAGE_UNSUPPORTED_ERROR_HINT
    );
    expect(mod.imageUnsupportedErrorHint("HTTP 400", [IMAGE])).toBe(mod.IMAGE_UNSUPPORTED_ERROR_HINT);
  });

  it("平台文案自带图片线索（detail 透传）→ 不补，避免盖过更具体的平台理由", () => {
    expect(mod.imageUnsupportedErrorHint("HTTP 400: [openai] this model does not support image input", [IMAGE])).toBe("");
    expect(mod.imageUnsupportedErrorHint("HTTP 400: [anthropic] 该模型不支持图片输入", [IMAGE])).toBe("");
  });

  it("无图 / 非 400 → 不补", () => {
    expect(mod.imageUnsupportedErrorHint("HTTP 400: [openai] invalid_request_error", [])).toBe("");
    expect(mod.imageUnsupportedErrorHint("HTTP 500: [openai] boom", [IMAGE])).toBe("");
    expect(mod.imageUnsupportedErrorHint("网络错误：Failed to fetch", [IMAGE])).toBe("");
    expect(mod.imageUnsupportedErrorHint(undefined, [IMAGE])).toBe("");
  });
});
