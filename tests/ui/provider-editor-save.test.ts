// tests/ui/provider-editor-save.test.ts
// Modal 保存/测试动作「每族知识走族声明」的行为契约（owner 3 的 Modal 侧边界）。
//
// 替换的两条源码文本断言（原 provider-family-module.test.ts 的 functionBody 切片）：
//   1.「collectUpsert 不再按 kind 分支：字段直收、序列化委派族声明」——等价行为
//     判据 = 三族各走一次真实保存链，报文里出现本族特有字段（AI 的
//     models/requiresKey/protocol、ASR 的 type/model、搜索的 type），说明序列化
//     由族声明产出而不是在 Modal 里按 kind 拼；
//   2.「kind 门收敛为能力位（supportsPlatformTest）」——等价行为判据 = 三族
//     Modal 的平台级测试按钮在场性由能力位决定（AI 无、ASR/搜索有）。
//
// 失败方式：某族序列化漏写本族字段、或平台级测试按钮按 kind 名硬写分支而漂移，
// 本文件即红。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installSettingsPanelBus } from "../helpers/settings-panel-bus.js";

type SentMessage = { type: string } & Record<string, any>;
type MessageResponder = (message: SentMessage) => unknown;

vi.mock("../../extension/ai/provider-test.js", () => ({
  testAiProviderConnection: vi.fn(async () => ({ ok: true }))
}));

vi.mock("../../extension/asr/provider-test.js", () => ({
  testAsrConnection: vi.fn(async () => ({ ok: true }))
}));

vi.mock("../../extension/asr/provider-models.js", () => ({
  listAsrModels: vi.fn(async () => ({ ok: false, error: "not used" }))
}));

function chromeStub(): { runtime: { sendMessage: ReturnType<typeof vi.fn> } } {
  return chrome as unknown as { runtime: { sendMessage: ReturnType<typeof vi.fn> } };
}

// 消息总线桩由 tests/helpers/settings-panel-bus.ts 单源装配（缺省表 + 本族专属回包 + overrides）。
function installMessageBus(overrides: Record<string, MessageResponder> = {}): SentMessage[] {
  const host = installSettingsPanelBus<SentMessage>({
    "ai-providers-save": () => ({ ok: true, providers: [] }),
    "asr-providers-save": () => ({ ok: true, providers: [] }),
    "search-providers-save": () => ({ ok: true, providers: [] }),
    "request-provider-origins": () => ({ ok: true }),
    ...overrides
  });
  return host.sent;
}

async function mountPanel(busOverrides: Record<string, MessageResponder> = {}) {
  document.body.innerHTML = `
    <div id="biliscript-reading-view">
      <section id="biliscript-reading-settings-panel">
        <div id="biliscript-reading-settings-host"></div>
      </section>
    </div>`;
  const sent = installMessageBus(busOverrides);
  const panel = await import("../../extension/ui/settings-panel.js");
  panel.renderReaderSettingsPanel();
  const host = document.getElementById("biliscript-reading-settings-host")!;
  await vi.waitFor(() => {
    expect(chromeStub().runtime.sendMessage.mock.calls.some(([message]) => message.type === "asr-providers-list")).toBe(true);
  });
  return { sent, host };
}

async function openEditor(host: HTMLElement, buttonSelector: string) {
  host.querySelector(buttonSelector)!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => {
    expect(document.querySelector(".provider-editor-dialog")).toBeTruthy();
  });
  return document.querySelector<HTMLElement>(".provider-editor-dialog")!;
}

function fireClick(node: Element | null) {
  node!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function setFieldValue(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
});

afterEach(async () => {
  const { closeProviderEditor } = await import("../../extension/ui/provider-editor.js");
  closeProviderEditor(true);
});

describe("Modal 保存：三族序列化走族声明（替源码切片断言）", () => {
  const cases: {
    label: string;
    button: string;
    saveType: string;
    fill: (dialog: HTMLElement) => void;
    expected: Record<string, unknown>;
    absent: string[];
  }[] = [
    {
      label: "AI",
      button: "#addAiProviderBtn",
      saveType: "ai-providers-save",
      fill: (dialog) => {
        setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
        setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
        fireClick(dialog.querySelector(".provider-editor-model-add"));
        setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-model-id")!, "gpt-4o-mini");
      },
      expected: {
        presetId: "custom",
        baseUrl: "https://api.example.com/v1",
        models: ["gpt-4o-mini"],
        requiresKey: true,
        protocol: "openai"
      },
      absent: ["type"]
    },
    {
      label: "ASR",
      button: "#addAsrProviderBtn",
      saveType: "asr-providers-save",
      fill: (dialog) => {
        setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://asr.example.com/v1");
        setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-model")!, "whisper-1");
      },
      expected: {
        presetId: "custom",
        type: "openai-transcriptions",
        baseUrl: "https://asr.example.com/v1",
        model: "whisper-1"
      },
      absent: ["models", "protocol"]
    },
    {
      label: "搜索",
      button: "#addSearchProviderBtn",
      saveType: "search-providers-save",
      fill: () => {},
      expected: {
        presetId: "firecrawl",
        type: "firecrawl",
        baseUrl: "https://api.firecrawl.dev"
      },
      absent: ["models", "protocol"]
    }
  ];

  it.each(cases)("$label：保存报文带本族特有字段、不带他族字段", async (testCase) => {
    const { sent, host } = await mountPanel();
    const dialog = await openEditor(host, testCase.button);

    testCase.fill(dialog);
    fireClick(dialog.querySelector(".provider-editor-save"));

    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === testCase.saveType)).toBe(true);
    });
    const payload = sent.find((message) => message.type === testCase.saveType)!.providers[0];
    expect(payload).toMatchObject(testCase.expected);
    for (const key of testCase.absent) {
      expect(payload[key], `${testCase.label} 报文不应出现他族字段 ${key}`).toBeUndefined();
    }
  });
});

describe("Modal 平台级测试按钮：能力位驱动在场性（替源码切片断言）", () => {
  it.each([
    ["AI", "#addAiProviderBtn", false],
    ["ASR", "#addAsrProviderBtn", true],
    ["搜索", "#addSearchProviderBtn", true]
  ])("%s：平台级测试按钮在场性 = %s", async (_label, button, expected) => {
    const { host } = await mountPanel();
    const dialog = await openEditor(host, button);
    expect(dialog.querySelector(".provider-editor-test") === null).toBe(!expected);
  });
});
