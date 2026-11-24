import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

import { closeProviderEditor } from "../../extension/ui/provider-editor.js";
import { renderReaderSettingsPanel } from "../../extension/ui/settings-panel.js";
import { resetSettingsPanelState, waitForFast } from "../helpers/reset-settings-panel-state.js";

function chromeStub(): { runtime: { sendMessage: ReturnType<typeof vi.fn> } } {
  return chrome as unknown as { runtime: { sendMessage: ReturnType<typeof vi.fn> } };
}

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
  await renderReaderSettingsPanel();
  const host = document.getElementById("biliscript-reading-settings-host")!;
  expect(chromeStub().runtime.sendMessage.mock.calls.some(([message]) => message.type === "asr-providers-list")).toBe(true);
  return { sent, host };
}

async function openEditor(host: HTMLElement, buttonSelector: string) {
  host.querySelector(buttonSelector)!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await waitForFast(() => {
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
  resetSettingsPanelState();
});

afterEach(() => {
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
        setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
        setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-model")!, "whisper-1");
      },
      expected: {
        presetId: "siliconflow-sensevoice",
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
        presetId: "tavily",
        type: "tavily",
        baseUrl: "https://api.tavily.com"
      },
      absent: ["models", "protocol"]
    }
  ];

  it.each(cases)("$label：保存报文带本族特有字段、不带他族字段", async (testCase) => {
    const { sent, host } = await mountPanel();
    const dialog = await openEditor(host, testCase.button);

    testCase.fill(dialog);
    fireClick(dialog.querySelector(".provider-editor-save"));

    await waitForFast(() => {
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
