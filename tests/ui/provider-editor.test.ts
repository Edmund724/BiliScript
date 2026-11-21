import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installSettingsPanelBus } from "../helpers/settings-panel-bus.js";
import type { TestAiConnectionResult } from "../../extension/ai/provider-test.js";

type SentMessage = { type: string } & Record<string, any>;
type MessageResponder = (message: SentMessage) => unknown;
type SendMessageStub = ReturnType<typeof vi.fn>;

function chromeStub(): { runtime: { sendMessage: SendMessageStub } } {
  return chrome as unknown as { runtime: { sendMessage: SendMessageStub } };
}

const aiModelsState = vi.hoisted(() => ({
  responder: undefined as undefined | ((message: SentMessage) => unknown)
}));

vi.mock("../../extension/ai/provider-models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/ai/provider-models.js")>();
  return {
    ...actual,
    fetchProviderModels: vi.fn(async (input: SentMessage) =>
      aiModelsState.responder ? aiModelsState.responder(input) : { ok: true }
    )
  };
});

vi.mock("../../extension/ai/provider-test.js", () => ({
  testAiProviderConnection: vi.fn(async () => ({ ok: true }))
}));

vi.mock("../../extension/asr/provider-test.js", () => ({
  testAsrConnection: vi.fn(async () => ({ ok: true }))
}));

vi.mock("../../extension/asr/provider-models.js", () => ({
  listAsrModels: vi.fn(async () => ({ ok: false, error: "not used" }))
}));

function installMessageBus(overrides: Record<string, MessageResponder> = {}) {
  const { "ai-providers-models": modelsResponder, ...busOverrides } = overrides;
  aiModelsState.responder = modelsResponder;
  const host = installSettingsPanelBus<SentMessage>({
    "ai-providers-save": () => ({ ok: true, providers: [] }),
    "asr-providers-save": () => ({ ok: true, providers: [] }),
    "request-provider-origins": () => ({ ok: true }),
    ...busOverrides
  });
  return host.sent;
}

async function mountPanel(busOverrides: Record<string, MessageResponder> = {}) {
  document.body.innerHTML = `
    <div id="biliscript-reading-view">
      <section id="biliscript-reading-settings-panel">
        <div id="biliscript-reading-settings-host"></div>
      </section>
    </div>
  `;
  const sent = installMessageBus(busOverrides);
  const panel = await import("../../extension/ui/settings-panel.js");
  panel.renderReaderSettingsPanel();
  const host = document.getElementById("biliscript-reading-settings-host")!;
  await vi.waitFor(() => {
    expect(chromeStub().runtime.sendMessage.mock.calls.some(([message]) => message.type === "asr-providers-list")).toBe(true);
  });
  return { sent, host };
}

async function openEditor(host: HTMLElement, buttonSelectorOrElement: string | Element) {
  const { isProviderEditorOpen } = await import("../../extension/ui/provider-editor.js");
  fireClick(typeof buttonSelectorOrElement === "string" ? host.querySelector(buttonSelectorOrElement) : buttonSelectorOrElement);
  await vi.waitFor(() => {
    expect(document.querySelector(".provider-editor-dialog")).toBeTruthy();
  });
  return { dialog: document.querySelector<HTMLElement>(".provider-editor-dialog")!, isProviderEditorOpen };
}

function editorGone() {
  return document.querySelector(".provider-editor-host") === null;
}

function fireClick(node: Element | null) {
  node!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function setFieldValue(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flushMicrotasks() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
}

function messageTypes(sent: SentMessage[]) {
  return sent.map((message) => message.type);
}

beforeEach(() => {
  resetModuleState();
  aiModelsState.responder = undefined;
  document.body.innerHTML = "";
});

afterEach(async () => {
  const { closeProviderEditor } = await import("../../extension/ui/provider-editor.js");
  closeProviderEditor(true);
});

describe("provider-editor：新增保存链（拍板 Q2/Q4）", () => {
  it("AI 新增：权限代申请 → 现查列表 → upsert 追加 → 整列表落盘，成功后关 Modal 并重渲列表", async () => {
    const savedList = [{ id: "p_new1", presetId: "custom", name: "自定义", baseUrl: "https://api.example.com/v1", models: ["gpt-4o-mini"], requiresKey: true, enabled: true, hasSavedKey: true }];
    const { sent, host } = await mountPanel({
      "ai-providers-save": () => ({ ok: true, providers: savedList })
    });

    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    expect(dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!.value).toBe("custom");
    expect(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!.value).toBe("");
    expect(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!.placeholder).toBe("API Key");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    fireClick(dialog.querySelector(".provider-editor-model-add"));
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-model-id")!, "gpt-4o-mini");

    fireClick(dialog.querySelector(".provider-editor-save"));

    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "ai-providers-save")).toBe(true);
    });

    const types = messageTypes(sent);
    expect(types).toContain("request-provider-origins");
    expect(types.indexOf("request-provider-origins")).toBeLessThan(types.lastIndexOf("ai-providers-list"));
    expect(types.lastIndexOf("ai-providers-list")).toBeLessThan(types.indexOf("ai-providers-save"));
    expect(sent.find((message) => message.type === "request-provider-origins")!.baseUrls).toEqual(["https://api.example.com/v1"]);

    const saveMessage = sent.find((message) => message.type === "ai-providers-save")!;
    expect(saveMessage.providers).toHaveLength(1);
    expect(saveMessage.providers[0]).toMatchObject({
      presetId: "custom",
      name: "自定义",
      baseUrl: "https://api.example.com/v1",
      models: ["gpt-4o-mini"],
      requiresKey: true,
      enabled: true,
      apiKey: "sk-test"
    });
    expect(saveMessage.providers[0].id).toMatch(/^p_/);

    expect(editorGone()).toBe(true);
    expect(host.querySelectorAll("#aiProvidersList .ai-provider-row")).toHaveLength(1);
    expect(host.querySelector<HTMLElement>("#aiProvidersList .ai-provider-row")!.dataset.hasSavedKey).toBe("1");
  });

  it("ASR 新增：type/presetId 落入报文，保存后重渲", async () => {
    const savedList = [{ id: "asr_new1", presetId: "siliconflow-sensevoice", name: "SiliconFlow 硅基流动", type: "openai-transcriptions", baseUrl: "https://asr.example.com/v1", model: "whisper-1", supportsTimestamps: true, enabled: true, hasSavedKey: true }];
    const { sent, host } = await mountPanel({
      "asr-providers-save": () => ({ ok: true, providers: savedList })
    });

    const { dialog } = await openEditor(host, "#addAsrProviderBtn");
    expect(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!.placeholder).toBe("API Key");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://asr.example.com/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-model")!, "whisper-1");

    fireClick(dialog.querySelector(".provider-editor-save"));

    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "asr-providers-save")).toBe(true);
    });

    const saveMessage = sent.find((message) => message.type === "asr-providers-save")!;
    expect(saveMessage.providers[0]).toMatchObject({
      presetId: "siliconflow-sensevoice",
      type: "openai-transcriptions",
      name: "SiliconFlow 硅基流动",
      baseUrl: "https://asr.example.com/v1",
      model: "whisper-1"
    });
    const newId = saveMessage.providers[0].id;
    expect(newId).toMatch(/^asr_/);
    expect(editorGone()).toBe(true);
    expect(host.querySelectorAll("#asrProvidersList .asr-provider-row")).toHaveLength(1);
    expect(
      host.querySelector<HTMLInputElement>("#asrProvidersList .asr-provider-active-radio")?.checked
    ).toBe(true);
    expect(sent).toContainEqual({
      type: "save-settings",
      settings: { activeAsrProviderId: "asr_new1" }
    });
  });

  it("AI 校验失败（缺 Key）：状态行报错不关 Modal，不落盘", async () => {
    const { sent, host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    fireClick(dialog.querySelector(".provider-editor-model-add"));
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-model-id")!, "gpt-4o-mini");

    fireClick(dialog.querySelector(".provider-editor-save"));

    const status = dialog.querySelector<HTMLElement>(".provider-editor-status")!;
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("平台「自定义」需要填写 API Key");
    expect(status.dataset.error).toBe("true");
    expect(sent.some((message) => message.type === "ai-providers-save")).toBe(false);
    expect(editorGone()).toBe(false);
  });

  it("权限代申请被拒：状态行报错不落盘不关 Modal", async () => {
    const { sent, host } = await mountPanel({
      "request-provider-origins": () => ({ ok: false, error: "未授权 https://api.example.com/*，保存已中止" })
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    fireClick(dialog.querySelector(".provider-editor-model-add"));
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-model-id")!, "gpt-4o-mini");

    fireClick(dialog.querySelector(".provider-editor-save"));

    await vi.waitFor(() => {
      expect(dialog.querySelector<HTMLElement>(".provider-editor-status")!.textContent).toContain("未授权");
    });
    expect(sent.some((message) => message.type === "ai-providers-save")).toBe(false);
    expect(editorGone()).toBe(false);
  });

  it("ai-providers-save 失败：状态行报错、busy 复位、Modal 不关", async () => {
    const { sent, host } = await mountPanel({
      "ai-providers-save": () => ({ ok: false, error: "sync 配额不足" })
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    fireClick(dialog.querySelector(".provider-editor-model-add"));
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-model-id")!, "gpt-4o-mini");

    fireClick(dialog.querySelector(".provider-editor-save"));

    await vi.waitFor(() => {
      expect(dialog.querySelector<HTMLElement>(".provider-editor-status")!.textContent).toBe("sync 配额不足");
    });
    expect(dialog.querySelector<HTMLButtonElement>(".provider-editor-save")!.disabled).toBe(false);
    expect(editorGone()).toBe(false);
  });
});

describe("provider-editor：编辑预填与 upsert 替换（拍板 Q3）", () => {
  const aiItem = { id: "p1", presetId: "custom", name: "我的端点", baseUrl: "https://api.example.com/v1", models: ["gpt-4o-mini", "gpt-4o"], requiresKey: true, enabled: true, hasSavedKey: true };

  it("按 id 现查权威列表项预填（模型目录全量预填行）；Key 占位「已保存」；保存按原 id 替换非追加", async () => {
    const { sent, host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [aiItem] }),
      "ai-providers-save": () => ({ ok: true, providers: [{ ...aiItem, models: ["gpt-4o"] }] })
    });

    const row = host.querySelector<HTMLElement>("#aiProvidersList .ai-provider-row")!;
    const { dialog } = await openEditor(host, row.querySelector(".provider-row-edit")!);

    expect(dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!.value).toBe("custom");
    expect(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!.value).toBe("https://api.example.com/v1");
    expect(
      Array.from(dialog.querySelectorAll<HTMLInputElement>(".provider-editor-model-id")).map((input) => input.value)
    ).toEqual(["gpt-4o-mini", "gpt-4o"]);
    expect(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!.value).toBe("");
    expect(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!.placeholder).toBe("已保存");
    expect(dialog.querySelector<HTMLInputElement>(".provider-editor-name")!.value).toBe("我的端点");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-model-id")!, "gpt-4");
    fireClick(dialog.querySelector(".provider-editor-save"));

    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "ai-providers-save")).toBe(true);
    });

    const saveMessage = sent.find((message) => message.type === "ai-providers-save")!;
    expect(saveMessage.providers).toHaveLength(1);
    expect(saveMessage.providers[0]).toMatchObject({ id: "p1", name: "我的端点", models: ["gpt-4", "gpt-4o"], baseUrl: "https://api.example.com/v1" });
    expect(editorGone()).toBe(true);
  });

  it("AI 名称留空回落预设名；名称自定义（≠预设名）则随保存落盘", async () => {
    const { sent, host } = await mountPanel({
      "ai-providers-save": () => ({ ok: true, providers: [] })
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    fireClick(dialog.querySelector(".provider-editor-model-add"));
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-model-id")!, "gpt-4o-mini");
    fireClick(dialog.querySelector(".provider-editor-save"));
    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "ai-providers-save")).toBe(true);
    });
    expect(sent.find((message) => message.type === "ai-providers-save")!.providers[0].name).toBe("自定义");
  });
});

describe("provider-editor：协议下拉（multi-protocol-ai 设置 UI 章）", () => {
  it("新增 AI：协议下拉默认 OpenAI、限制点小字隐藏；保存报文写入显式 protocol", async () => {
    const { sent, host } = await mountPanel({
      "ai-providers-save": () => ({ ok: true, providers: [] })
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    const protocolSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-protocol")!;
    expect(protocolSelect, "AI Modal 应渲染协议下拉").not.toBeNull();
    expect(protocolSelect.value).toBe("openai");
    expect(dialog.querySelector<HTMLElement>(".provider-editor-protocol-notes")!.hidden).toBe(true);

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    fireClick(dialog.querySelector(".provider-editor-model-add"));
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-model-id")!, "gpt-4o-mini");
    fireClick(dialog.querySelector(".provider-editor-save"));

    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "ai-providers-save")).toBe(true);
    });
    expect(sent.find((message) => message.type === "ai-providers-save")!.providers[0].protocol).toBe("openai");
  });

  it("存量记录缺 protocol 字段：编辑显示「OpenAI」（无提示），保存回写显式值", async () => {
    const aiItem = { id: "p1", presetId: "custom", name: "我的端点", baseUrl: "https://api.example.com/v1", models: ["gpt-4o-mini"], requiresKey: true, enabled: true, hasSavedKey: true };
    const { sent, host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [aiItem] }),
      "ai-providers-save": () => ({ ok: true, providers: [aiItem] })
    });

    const row = host.querySelector<HTMLElement>("#aiProvidersList .ai-provider-row")!;
    const { dialog } = await openEditor(host, row.querySelector(".provider-row-edit")!);

    expect(dialog.querySelector<HTMLSelectElement>(".provider-editor-protocol")!.value).toBe("openai");

    fireClick(dialog.querySelector(".provider-editor-save"));
    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "ai-providers-save")).toBe(true);
    });
    expect(sent.find((message) => message.type === "ai-providers-save")!.providers[0].protocol).toBe("openai");
  });

  it("编辑 anthropic 记录：预填选中；限制点小字两协议都不露出（文案已删）", async () => {
    const aiItem = { id: "p1", presetId: "custom", name: "claude", baseUrl: "https://api.anthropic.com/v1", models: ["claude-sonnet-4-5"], requiresKey: true, enabled: true, hasSavedKey: true, protocol: "anthropic" };
    const { host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [aiItem] })
    });

    const row = host.querySelector<HTMLElement>("#aiProvidersList .ai-provider-row")!;
    const { dialog } = await openEditor(host, row.querySelector(".provider-row-edit")!);

    const protocolSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-protocol")!;
    const notes = dialog.querySelector<HTMLElement>(".provider-editor-protocol-notes")!;
    expect(protocolSelect.value).toBe("anthropic");
    expect(notes.hidden).toBe(true);
    expect(notes.textContent).toBe("");

    protocolSelect.value = "openai";
    protocolSelect.dispatchEvent(new Event("change"));
    expect(notes.hidden).toBe(true);
  });

  it("预设切换联动默认归属、允许用户改：未改跟随新预设默认，改过的选择不覆盖", async () => {
    const presets = [
      { id: "proxied", name: "代理平台", baseUrl: "https://proxy.example.com/v1", requiresKey: true, protocol: "anthropic" },
      { id: "custom", name: "自定义", baseUrl: "", requiresKey: true }
    ];
    const { host } = await mountPanel({
      "ai-presets-list": () => ({ ok: true, presets })
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    const presetSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!;
    const protocolSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-protocol")!;
    expect(protocolSelect.value).toBe("openai");

    presetSelect.value = "proxied";
    presetSelect.dispatchEvent(new Event("change"));
    expect(protocolSelect.value).toBe("anthropic");

    protocolSelect.value = "openai";
    protocolSelect.dispatchEvent(new Event("change"));
    presetSelect.value = "custom";
    presetSelect.dispatchEvent(new Event("change"));
    expect(protocolSelect.value).toBe("openai");
  });

  it("协议下拉选项名为 OpenAI Chat Completions / Anthropic Messages / Gemini GenerateContent（全称，统一风格）", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    const labels = Array.from(dialog.querySelectorAll(".provider-editor-protocol option")).map((option) => option.textContent);
    expect(labels).toEqual(["OpenAI Chat Completions", "Anthropic Messages", "Gemini GenerateContent"]);
  });

  it("切协议联动 baseUrl：未改过跟随该预设的协议端点（DeepSeek /v1 ↔ /anthropic），改过的值不覆盖", async () => {
    const presets = [
      { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", requiresKey: true, protocolBaseUrls: { anthropic: "https://api.deepseek.com/anthropic" } },
      { id: "custom", name: "自定义", baseUrl: "", requiresKey: true }
    ];
    const { host } = await mountPanel({
      "ai-presets-list": () => ({ ok: true, presets })
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    const presetSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!;
    const protocolSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-protocol")!;
    const baseUrlInput = dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!;
    presetSelect.value = "deepseek";
    presetSelect.dispatchEvent(new Event("change"));
    expect(baseUrlInput.value).toBe("https://api.deepseek.com/v1");

    protocolSelect.value = "anthropic";
    protocolSelect.dispatchEvent(new Event("change"));
    expect(baseUrlInput.value).toBe("https://api.deepseek.com/anthropic");
    protocolSelect.value = "openai";
    protocolSelect.dispatchEvent(new Event("change"));
    expect(baseUrlInput.value).toBe("https://api.deepseek.com/v1");

    setFieldValue(baseUrlInput, "https://my-proxy.example.com/v1");
    protocolSelect.value = "anthropic";
    protocolSelect.dispatchEvent(new Event("change"));
    expect(baseUrlInput.value).toBe("https://my-proxy.example.com/v1");
  });

  it("内置 DeepSeek 预设默认 Anthropic：新增选该预设即填 /anthropic，切回 openai 联动 /v1", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    const presetSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!;
    const protocolSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-protocol")!;
    const baseUrlInput = dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!;

    presetSelect.value = "deepseek";
    presetSelect.dispatchEvent(new Event("change"));
    expect(protocolSelect.value).toBe("anthropic");
    expect(baseUrlInput.value).toBe("https://api.deepseek.com/anthropic");

    protocolSelect.value = "openai";
    protocolSelect.dispatchEvent(new Event("change"));
    expect(baseUrlInput.value).toBe("https://api.deepseek.com/v1");
  });

  it("经自定义下拉切到协议为 Anthropic 的预设：协议 trigger 显示与落盘值一致", async () => {
    const { sent, host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    const presetSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!;
    const protocolSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-protocol")!;
    const presetWrapper = presetSelect.closest<HTMLElement>(".custom-select-wrapper")!;
    const protocolWrapper = protocolSelect.closest<HTMLElement>(".custom-select-wrapper")!;
    const protocolShown = () => protocolWrapper.querySelector(".custom-select-value")!.textContent;
    expect(protocolShown()).toBe("OpenAI Chat Completions");

    fireClick(presetWrapper.querySelector<HTMLElement>(".custom-select-trigger")!);
    fireClick(presetWrapper.querySelector<HTMLElement>('.custom-select-option[data-value="deepseek"]')!);

    expect(presetSelect.value).toBe("deepseek");
    expect(protocolSelect.value, "切预设应联动 draft.protocol").toBe("anthropic");
    expect(protocolShown(), "协议 trigger 显示滞留旧协议").toBe("Anthropic Messages");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    fireClick(dialog.querySelector(".provider-editor-save"));
    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "ai-providers-save")).toBe(true);
    });
    expect(sent.find((message) => message.type === "ai-providers-save")!.providers[0].protocol).toBe("anthropic");
  });

  it("编辑 DeepSeek 记录（protocol=anthropic，baseUrl /anthropic）→ 切回 openai 联动 /v1（该预设协议端点）", async () => {
    const presets = [
      { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", requiresKey: true, protocol: "anthropic", protocolBaseUrls: { anthropic: "https://api.deepseek.com/anthropic" } },
      { id: "custom", name: "自定义", baseUrl: "", requiresKey: true }
    ];
    const aiItem = { id: "p1", presetId: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/anthropic", models: ["deepseek-v4-pro"], requiresKey: true, enabled: true, hasSavedKey: true, protocol: "anthropic" };
    const { host } = await mountPanel({
      "ai-presets-list": () => ({ ok: true, presets }),
      "ai-providers-list": () => ({ ok: true, providers: [aiItem] })
    });

    const row = host.querySelector<HTMLElement>("#aiProvidersList .ai-provider-row")!;
    const { dialog } = await openEditor(host, row.querySelector(".provider-row-edit")!);

    const protocolSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-protocol")!;
    const baseUrlInput = dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!;
    expect(protocolSelect.value).toBe("anthropic");
    expect(baseUrlInput.value).toBe("https://api.deepseek.com/anthropic");

    protocolSelect.value = "openai";
    protocolSelect.dispatchEvent(new Event("change"));
    expect(baseUrlInput.value).toBe("https://api.deepseek.com/v1");
  });

  it("切协议即脏：取消先弹 dirty 确认弹层", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    const protocolSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-protocol")!;
    protocolSelect.value = "anthropic";
    protocolSelect.dispatchEvent(new Event("change"));

    fireClick(dialog.querySelector(".provider-editor-cancel"));
    expect(document.querySelector(".confirm-dialog-confirm"), "切协议应触发 dirty 保护").not.toBeNull();
    fireClick(document.querySelector(".confirm-dialog-cancel"));
    await vi.waitFor(() => expect(document.querySelector(".confirm-dialog-host")).toBeNull());
    expect(editorGone()).toBe(false);
  });
});

describe("provider-editor：头部删除按钮（用户拍板：× 改警示删除，编辑态提供）", () => {
  const aiItem = { id: "p1", presetId: "custom", name: "自定义", baseUrl: "https://api.example.com/v1", models: ["gpt-4o-mini"], requiresKey: true, enabled: true, hasSavedKey: true };

  it("编辑态：头部显示删除按钮；面板内确认后发删除消息 + 权限回收现查 + 重渲 + 关 Modal", async () => {
    const { sent, host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [aiItem] }),
      "ai-providers-save": () => ({ ok: true, providers: [] }),
      "ai-providers-delete": () => ({ ok: true, providers: [] })
    });

    const row = host.querySelector<HTMLElement>("#aiProvidersList .ai-provider-row")!;
    const { dialog } = await openEditor(host, row.querySelector(".provider-row-edit")!);

    const deleteBtn = dialog.querySelector<HTMLButtonElement>(".provider-editor-delete")!;
    expect(deleteBtn).not.toBeNull();
    expect(deleteBtn.textContent).toBe("删除");

    fireClick(deleteBtn);
    const confirmButton = document.querySelector<HTMLButtonElement>(".confirm-dialog-confirm")!;
    expect(confirmButton, "删除二次确认弹层应已打开").not.toBeNull();
    expect(confirmButton.textContent).toBe("删除");
    fireClick(document.querySelector(".confirm-dialog-cancel"));
    await vi.waitFor(() => {
      expect(document.querySelector(".confirm-dialog-host")).toBeNull();
    });
    expect(sent.some((message) => message.type === "ai-providers-delete")).toBe(false);
    expect(editorGone()).toBe(false);

    fireClick(deleteBtn);
    fireClick(document.querySelector(".confirm-dialog-confirm"));

    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "ai-providers-delete")).toBe(true);
    });
    expect(sent.some((message) => message.type === "asr-providers-list")).toBe(true);
    expect(sent.find((message) => message.type === "ai-providers-delete")!.providerId).toBe("p1");
    expect(editorGone()).toBe(true);
  });

  it("删除回收 orphan origin 用已存列表项的 baseUrl：未保存的输入改动不混入回收目标", async () => {
    document.body.innerHTML = `
      <div id="biliscript-reading-view">
        <section id="biliscript-reading-settings-panel"></section>
      </div>
    `;
    const onDelete = vi.fn(async () => ({ ok: true }));
    const editor = await import("../../extension/ui/provider-editor.js");
    editor.openProviderEditor({
      kind: "ai",
      item: aiItem,
      presets: [{ id: "custom", name: "自定义", baseUrl: "", requiresKey: true }],
      onSave: async () => ({ ok: true }),
      onDelete
    });
    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;

    const baseUrlInput = dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!;
    setFieldValue(baseUrlInput, "https://never-configured.example.com/v1");
    baseUrlInput.dispatchEvent(new Event("input", { bubbles: true }));

    fireClick(dialog.querySelector(".provider-editor-delete"));
    fireClick(document.querySelector(".confirm-dialog-confirm"));
    await flushMicrotasks();

    expect(onDelete).toHaveBeenCalledWith("ai", {
      id: "p1",
      baseUrl: "https://api.example.com/v1"
    });
  });

  it("新增态：不渲染删除按钮（无可删对象）", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");
    expect(dialog.querySelector(".provider-editor-delete")).toBeNull();
  });
});

describe("provider-editor：dirty 保护与关闭语义（拍板 Q6）", () => {
  it("有改动：取消先弹面板内确认——拒绝不关，放弃更改才关；弹层打开期间 Esc 只关弹层", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");

    fireClick(dialog.querySelector(".provider-editor-cancel"));
    let confirmBtn = document.querySelector<HTMLButtonElement>(".confirm-dialog-confirm")!;
    expect(confirmBtn, "dirty 确认弹层应已打开").not.toBeNull();
    expect(confirmBtn.textContent).toBe("放弃更改");
    expect(document.querySelector<HTMLElement>(".confirm-dialog-message")!.textContent).toBe("未保存的更改将丢失，确定关闭？");
    fireClick(document.querySelector(".confirm-dialog-cancel"));
    await vi.waitFor(() => expect(document.querySelector(".confirm-dialog-host")).toBeNull());
    expect(editorGone()).toBe(false);

    fireClick(dialog.querySelector(".provider-editor-cancel"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector(".confirm-dialog-host")).toBeNull());
    expect(editorGone()).toBe(false);

    fireClick(dialog.querySelector(".provider-editor-cancel"));
    confirmBtn = document.querySelector<HTMLButtonElement>(".confirm-dialog-confirm")!;
    fireClick(confirmBtn);
    await vi.waitFor(() => expect(editorGone()).toBe(true));
  });

  it("无改动：取消直接关，不弹确认弹层", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    fireClick(dialog.querySelector(".provider-editor-cancel"));
    expect(document.querySelector(".confirm-dialog-host")).toBeNull();
    expect(editorGone()).toBe(true);
  });

  it("Esc 关闭（走 dirty 保护）；点遮罩关闭", async () => {
    const { host } = await mountPanel();
    await openEditor(host, "#addAiProviderBtn");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(editorGone()).toBe(true);

    await openEditor(host, "#addAiProviderBtn");
    fireClick(document.querySelector(".provider-editor-mask"));
    expect(editorGone()).toBe(true);
  });

  it("保存成功后直接关（不因字段快照≠初始而弹确认弹层）", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    fireClick(dialog.querySelector(".provider-editor-model-add"));
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-model-id")!, "gpt-4o-mini");
    fireClick(dialog.querySelector(".provider-editor-save"));

    await vi.waitFor(() => expect(editorGone()).toBe(true));
    expect(document.querySelector(".confirm-dialog-host")).toBeNull();
  });
});

describe("provider-editor：模型目录草稿语义（拍板 Q10/Q7/Q13）", () => {
  it("「+ 添加模型」加空白行、行内删除即移除，全部只改草稿", async () => {
    const { sent, host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    const empty = dialog.querySelector<HTMLElement>(".provider-editor-catalog-empty")!;
    expect(empty.hidden).toBe(false);

    fireClick(dialog.querySelector(".provider-editor-model-add"));
    expect(dialog.querySelectorAll(".provider-editor-model-row")).toHaveLength(1);
    expect(dialog.querySelector<HTMLElement>(".provider-editor-catalog-empty")!.hidden).toBe(true);

    fireClick(dialog.querySelector(".provider-editor-cancel"));
    expect(document.querySelector<HTMLElement>(".confirm-dialog-message")!.textContent).toBe("未保存的更改将丢失，确定关闭？");
    fireClick(document.querySelector(".confirm-dialog-cancel"));
    await vi.waitFor(() => expect(document.querySelector(".confirm-dialog-host")).toBeNull());
    expect(editorGone()).toBe(false);
    expect(sent.some((message) => message.type === "ai-providers-save")).toBe(false);

    fireClick(dialog.querySelector(".provider-editor-model-remove"));
    expect(dialog.querySelectorAll(".provider-editor-model-row")).toHaveLength(0);
    expect(dialog.querySelector<HTMLElement>(".provider-editor-catalog-empty")!.hidden).toBe(false);

    fireClick(dialog.querySelector(".provider-editor-cancel"));
    expect(editorGone()).toBe(true);
  });

  it("收集时 trim / 去空行 / 去重（Q7）", async () => {
    const { sent, host } = await mountPanel({
      "ai-providers-save": () => ({ ok: true, providers: [] })
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    fireClick(dialog.querySelector(".provider-editor-model-add"));
    fireClick(dialog.querySelector(".provider-editor-model-add"));
    fireClick(dialog.querySelector(".provider-editor-model-add"));
    const inputs = dialog.querySelectorAll<HTMLInputElement>(".provider-editor-model-id");
    setFieldValue(inputs[0], "  gpt-4o-mini ");
    setFieldValue(inputs[1], "gpt-4o-mini");
    setFieldValue(inputs[2], "   ");

    fireClick(dialog.querySelector(".provider-editor-save"));
    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "ai-providers-save")).toBe(true);
    });
    expect(sent.find((message) => message.type === "ai-providers-save")!.providers[0].models).toEqual(["gpt-4o-mini"]);
  });

  it("空目录合法：0 行保存落盘 models: []（Q13）", async () => {
    const { sent, host } = await mountPanel({
      "ai-providers-save": () => ({ ok: true, providers: [] })
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");

    fireClick(dialog.querySelector(".provider-editor-save"));
    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "ai-providers-save")).toBe(true);
    });
    expect(sent.find((message) => message.type === "ai-providers-save")!.providers[0].models).toEqual([]);
    expect(editorGone()).toBe(true);
  });
});

describe("provider-editor：行级测试连接（拍板 Q4/Q12，只验证连通性不落盘）", () => {
  function addModelRowWithValue(dialog: HTMLElement, value: string) {
    fireClick(dialog.querySelector(".provider-editor-model-add"));
    const row = dialog.querySelector<HTMLElement>(".provider-editor-model-row:last-child")!;
    setFieldValue(row.querySelector<HTMLInputElement>(".provider-editor-model-id")!, value);
    return row;
  }

  it("AI 不渲染平台级测试按钮；行级测试成功：spinner→✓、权限代申请先于探针、不落盘", async () => {
    const { testAiProviderConnection } = await import("../../extension/ai/provider-test.js");
    const order: string[] = [];
    vi.mocked(testAiProviderConnection).mockImplementationOnce(async () => {
      order.push("probe");
      return { ok: true };
    });
    const { sent, host } = await mountPanel({
      "request-provider-origins": () => {
        order.push("permission");
        return { ok: true };
      }
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    expect(dialog.querySelector(".provider-editor-test")).toBeNull();

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    const row = addModelRowWithValue(dialog, "gpt-4o-mini");

    fireClick(row.querySelector(".provider-editor-model-test"));
    expect(order, "权限代申请必须在点击同步链上（零先行 await）").toEqual(["permission"]);
    expect(row.querySelector<HTMLElement>(".provider-editor-model-result")!.dataset.state).toBe("loading");
    expect(row.querySelector<HTMLButtonElement>(".provider-editor-model-test")!.disabled).toBe(true);

    await vi.waitFor(() => {
      expect(testAiProviderConnection).toHaveBeenCalledWith({
        providerId: "",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-test",
        model: "gpt-4o-mini",
        protocol: "openai",
        presetId: "custom"
      });
    });
    await vi.waitFor(() => {
      expect(row.querySelector<HTMLElement>(".provider-editor-model-result")!.dataset.state).toBe("ok");
    });
    expect(order).toEqual(["permission", "probe"]);
    expect(sent.find((message) => message.type === "request-provider-origins")!.baseUrls).toEqual(["https://api.example.com/v1"]);
    expect(sent.some((message) => message.type === "ai-providers-save")).toBe(false);
    expect(editorGone()).toBe(false);
    expect(row.querySelector<HTMLButtonElement>(".provider-editor-model-test")!.disabled).toBe(false);
  });

  it("行级测试：权限被拒 → 行内可操作文案、不发探针、按钮可再点", async () => {
    const { testAiProviderConnection } = await import("../../extension/ai/provider-test.js");
    const order: string[] = [];
    vi.mocked(testAiProviderConnection).mockImplementationOnce(async () => {
      order.push("probe");
      return { ok: true };
    });
    const { sent, host } = await mountPanel({
      "request-provider-origins": () => {
        order.push("permission");
        return { ok: false, error: "未授权 https://api.example.com/*，操作已中止：请在权限弹窗中选择允许后重试" };
      }
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    const row = addModelRowWithValue(dialog, "gpt-4o-mini");

    fireClick(row.querySelector(".provider-editor-model-test"));

    await vi.waitFor(() => {
      expect(row.querySelector<HTMLElement>(".provider-editor-model-result")!.dataset.state).toBe("error");
    });
    expect(order).toEqual(["permission"]);
    expect(testAiProviderConnection).not.toHaveBeenCalled();
    const result = row.querySelector<HTMLElement>(".provider-editor-model-result")!;
    expect(result.title).toContain("操作已中止");
    expect(result.dataset.unsaved).toBeUndefined();
    expect(row.querySelector<HTMLButtonElement>(".provider-editor-model-test")!.disabled).toBe(false);
    expect(sent.find((message) => message.type === "request-provider-origins")!.baseUrls).toEqual(["https://api.example.com/v1"]);
  });

  it("行级测试「未保存」短标：草稿有未保存改动 → ✓ 旁显式短标 + title 说明", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    const row = addModelRowWithValue(dialog, "gpt-4o-mini");

    fireClick(row.querySelector(".provider-editor-model-test"));

    const result = row.querySelector<HTMLElement>(".provider-editor-model-result")!;
    await vi.waitFor(() => {
      expect(result.dataset.state).toBe("ok");
    });
    expect(result.dataset.unsaved).toBe("true");
    expect(result.title).toBe("连接成功（当前表单未保存）");
  });

  it("行级测试「未保存」短标：编辑已存平台但未改动 → 只有「连接成功」", async () => {
    const aiItem = { id: "p1", presetId: "custom", name: "我的端点", baseUrl: "https://api.example.com/v1", models: ["gpt-4o-mini"], requiresKey: true, enabled: true, hasSavedKey: true };
    const { host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [aiItem] })
    });
    const providerRow = host.querySelector<HTMLElement>("#aiProvidersList .ai-provider-row")!;
    const { dialog } = await openEditor(host, providerRow.querySelector(".provider-row-edit")!);

    const row = dialog.querySelector<HTMLElement>(".provider-editor-model-row")!;
    fireClick(row.querySelector(".provider-editor-model-test"));

    const result = row.querySelector<HTMLElement>(".provider-editor-model-result")!;
    await vi.waitFor(() => {
      expect(result.dataset.state).toBe("ok");
    });
    expect(result.dataset.unsaved).toBeUndefined();
    expect(result.title).toBe("连接成功");
  });

  it("行级测试「未保存」短标随状态重置：上次成功的短标不残留到本次失败", async () => {
    const { testAiProviderConnection } = await import("../../extension/ai/provider-test.js");
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    const row = addModelRowWithValue(dialog, "gpt-4o-mini");
    const result = row.querySelector<HTMLElement>(".provider-editor-model-result")!;

    fireClick(row.querySelector(".provider-editor-model-test"));
    await vi.waitFor(() => {
      expect(result.dataset.unsaved).toBe("true");
    });

    vi.mocked(testAiProviderConnection).mockImplementationOnce(async () => ({ ok: false, error: "quota exceeded" }));
    fireClick(row.querySelector(".provider-editor-model-test"));
    await vi.waitFor(() => {
      expect(result.dataset.state).toBe("error");
    });
    expect(result.dataset.unsaved).toBeUndefined();
    expect(result.title).toBe("失败：quota exceeded");
  });

  it("行级测试失败：行内 ✕ + title 原因，不落盘", async () => {
    const { testAiProviderConnection } = await import("../../extension/ai/provider-test.js");
    vi.mocked(testAiProviderConnection).mockImplementationOnce(async () => ({ ok: false, error: "quota exceeded" }));
    const { sent, host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    const row = addModelRowWithValue(dialog, "gpt-4o-mini");

    fireClick(row.querySelector(".provider-editor-model-test"));

    await vi.waitFor(() => {
      expect(row.querySelector<HTMLElement>(".provider-editor-model-result")!.dataset.state).toBe("error");
    });
    expect(row.querySelector<HTMLElement>(".provider-editor-model-result")!.title).toBe("失败：quota exceeded");
    expect(sent.some((message) => message.type === "ai-providers-save")).toBe(false);
    expect(row.querySelector<HTMLButtonElement>(".provider-editor-model-test")!.disabled).toBe(false);
  });

  it("缺模型 ID / 缺 API 地址：行内提示且不调探针", async () => {
    const { testAiProviderConnection } = await import("../../extension/ai/provider-test.js");
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    const row = addModelRowWithValue(dialog, "");
    fireClick(row.querySelector(".provider-editor-model-test"));
    expect(row.querySelector<HTMLElement>(".provider-editor-model-result")!.dataset.state).toBe("error");
    expect(row.querySelector<HTMLElement>(".provider-editor-model-result")!.title).toBe("请先填写模型 ID");

    setFieldValue(row.querySelector<HTMLInputElement>(".provider-editor-model-id")!, "gpt-4o-mini");
    fireClick(row.querySelector(".provider-editor-model-test"));
    expect(row.querySelector<HTMLElement>(".provider-editor-model-result")!.title).toBe("请先填写 API 地址");
    expect(testAiProviderConnection).not.toHaveBeenCalled();
  });

  it("行级测试随表单协议下拉走：切到 Anthropic 探针带 protocol:anthropic（multi-protocol-ai）", async () => {
    const { testAiProviderConnection } = await import("../../extension/ai/provider-test.js");
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    const protocolSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-protocol")!;
    protocolSelect.value = "anthropic";
    protocolSelect.dispatchEvent(new Event("change"));
    const row = addModelRowWithValue(dialog, "claude-sonnet-4-5");

    fireClick(row.querySelector(".provider-editor-model-test"));

    await vi.waitFor(() => {
      expect(testAiProviderConnection).toHaveBeenCalledWith(
        expect.objectContaining({ protocol: "anthropic" })
      );
    });
  });

  it("行级测试随表单平台下拉走：选 Opencode Go 探针带 presetId:opencodego（新增未保存，平台身份不来自己存记录）", async () => {
    const { testAiProviderConnection } = await import("../../extension/ai/provider-test.js");
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    const presetSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!;
    presetSelect.value = "opencodego";
    presetSelect.dispatchEvent(new Event("change"));
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://opencode.ai/zen/go/v1");
    const row = addModelRowWithValue(dialog, "glm-5.1");

    fireClick(row.querySelector(".provider-editor-model-test"));

    await vi.waitFor(() => {
      expect(testAiProviderConnection).toHaveBeenCalledWith(
        expect.objectContaining({ presetId: "opencodego" })
      );
    });
  });

  it("多行并发测试互不阻塞，各行用自己的模型 ID", async () => {
    const { testAiProviderConnection } = await import("../../extension/ai/provider-test.js");
    let resolveFirst: ((result: TestAiConnectionResult) => void) | undefined;
    vi.mocked(testAiProviderConnection)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(async () => ({ ok: true }));
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    const rowA = addModelRowWithValue(dialog, "gpt-4o-mini");
    const rowB = addModelRowWithValue(dialog, "gpt-4o");

    fireClick(rowA.querySelector(".provider-editor-model-test"));
    fireClick(rowB.querySelector(".provider-editor-model-test"));

    await vi.waitFor(() => {
      expect(rowB.querySelector<HTMLElement>(".provider-editor-model-result")!.dataset.state).toBe("ok");
    });
    expect(rowA.querySelector<HTMLElement>(".provider-editor-model-result")!.dataset.state).toBe("loading");
    expect(testAiProviderConnection).toHaveBeenCalledTimes(2);

    resolveFirst!({ ok: true });
    await vi.waitFor(() => {
      expect(rowA.querySelector<HTMLElement>(".provider-editor-model-result")!.dataset.state).toBe("ok");
    });
  });

  it("同一行重复点击：忽略前一个（后点者的结果落定）", async () => {
    const { testAiProviderConnection } = await import("../../extension/ai/provider-test.js");
    let resolveFirst: ((result: TestAiConnectionResult) => void) | undefined;
    vi.mocked(testAiProviderConnection)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(async () => ({ ok: false, error: "model not found" }));
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    const row = addModelRowWithValue(dialog, "gpt-4o-mini");

    fireClick(row.querySelector(".provider-editor-model-test"));
    setFieldValue(row.querySelector<HTMLInputElement>(".provider-editor-model-id")!, "gpt-4o");
    fireClick(row.querySelector(".provider-editor-model-test"));
    await vi.waitFor(() => {
      expect(testAiProviderConnection).toHaveBeenCalledTimes(2);
    });

    resolveFirst!({ ok: true });
    await vi.waitFor(() => {
      expect(row.querySelector<HTMLElement>(".provider-editor-model-result")!.dataset.state).toBe("error");
    });
    expect(row.querySelector<HTMLElement>(".provider-editor-model-result")!.title).toBe("失败：model not found");
  });

  it("ASR 保留平台级测试按钮：权限代申请先于探针，成功回「连接成功」", async () => {
    const { testAsrConnection } = await import("../../extension/asr/provider-test.js");
    const order: string[] = [];
    vi.mocked(testAsrConnection).mockImplementationOnce(async () => {
      order.push("probe");
      return { ok: true };
    });
    const { sent, host } = await mountPanel({
      "request-provider-origins": () => {
        order.push("permission");
        return { ok: true };
      }
    });
    const { dialog } = await openEditor(host, "#addAsrProviderBtn");

    expect(dialog.querySelector(".provider-editor-test")).not.toBeNull();

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://asr.example.com/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-model")!, "whisper-1");

    fireClick(dialog.querySelector(".provider-editor-test"));

    expect(order, "权限代申请必须在点击同步链上（零先行 await）").toEqual(["permission"]);
    await vi.waitFor(() => {
      expect(dialog.querySelector<HTMLElement>(".provider-editor-status")!.textContent).toBe("连接成功");
    });
    expect(order).toEqual(["permission", "probe"]);
    const granted = sent.find((message) => message.type === "request-provider-origins");
    expect(granted?.baseUrls).toEqual(["https://asr.example.com/v1"]);
  });

  it("ASR 平台级测试：权限被拒 → 状态行报可操作提示，不发探针、不卡 busy", async () => {
    const { testAsrConnection } = await import("../../extension/asr/provider-test.js");
    const { host } = await mountPanel({
      "request-provider-origins": () => ({
        ok: false,
        error: "未授权 https://asr.example.com/*，操作已中止：请在权限弹窗中选择允许后重试"
      })
    });
    const { dialog } = await openEditor(host, "#addAsrProviderBtn");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://asr.example.com/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-model")!, "whisper-1");

    fireClick(dialog.querySelector(".provider-editor-test"));

    await vi.waitFor(() => {
      expect(dialog.querySelector<HTMLElement>(".provider-editor-status")!.dataset.error).toBe("true");
    });
    const status = dialog.querySelector<HTMLElement>(".provider-editor-status")!;
    expect(status.textContent).toContain("操作已中止");
    expect(testAsrConnection).not.toHaveBeenCalled();
    expect(dialog.querySelector<HTMLButtonElement>(".provider-editor-test")!.disabled).toBe(false);
  });
});

describe("provider-editor：与设置抽屉的层级联动", () => {
  it("面板外点击：capture 拦截，只关 Modal，bubble 委托（抽屉外点关闭）收不到该点击", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    const bubbleSpy = vi.fn();
    document.addEventListener("click", bubbleSpy);
    try {
      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(bubbleSpy).not.toHaveBeenCalled();
      expect(editorGone()).toBe(true);
    } finally {
      document.removeEventListener("click", bubbleSpy);
    }
  });

  it("Modal 内点击不外传：document bubble 委托（抽屉外点关闭）收不到，Modal 不关", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    const bubbleSpy = vi.fn();
    document.addEventListener("click", bubbleSpy);
    try {
      dialog.querySelector(".provider-editor-body")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(bubbleSpy).not.toHaveBeenCalled();
      expect(editorGone()).toBe(false);
    } finally {
      document.removeEventListener("click", bubbleSpy);
    }
  });

  it("Modal 内点下拉组件外收起模型下拉（ASR；settings-panel 文档级委托收不到不外传的点击，语义在 Modal 内自持）", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAsrProviderBtn");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://asr.example.com/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    const dropdown = dialog.querySelector<HTMLElement>(".ai-provider-model-dropdown")!;
    dropdown.hidden = false;
    await flushMicrotasks();

    dialog.querySelector(".provider-editor-name")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(dropdown.hidden).toBe(true);
  });

  it("设置抽屉收起（hidden）时 Modal 强制关闭：dirty 也不弹确认弹层", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");

    document.getElementById("biliscript-reading-settings-panel")!.hidden = true;
    await vi.waitFor(() => {
      expect(editorGone()).toBe(true);
    });
    expect(document.querySelector(".confirm-dialog-host")).toBeNull();
  });
});

describe("provider-editor：预设切换（Modal 内不代申请权限）", () => {
  it("AI：baseUrl 未改过才跟随新预设；名称空则占位符跟随；切预设不发权限消息", async () => {
    const { sent, host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    const select = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!;
    const baseUrlInput = dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!;

    select.value = "ollama";
    select.dispatchEvent(new Event("change"));
    expect(baseUrlInput.value).toBe("http://localhost:11434/v1");
    expect(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!.placeholder).toBe("API Key（可选）");

    setFieldValue(baseUrlInput, "https://my-proxy.example.com/v1");
    select.value = "deepseek";
    select.dispatchEvent(new Event("change"));
    expect(baseUrlInput.value).toBe("https://my-proxy.example.com/v1");

    await flushMicrotasks();
    expect(sent.some((message) => message.type === "request-provider-origins")).toBe(false);
  });

  it("ASR：模型名/名称无条件跟随，Key 清空", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAsrProviderBtn");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-old");
    const select = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!;

    select.value = "local-whisper";
    select.dispatchEvent(new Event("change"));

    expect(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!.value).toBe("http://localhost:8000/v1");
    expect(dialog.querySelector<HTMLInputElement>(".provider-editor-model")!.value).toBe("whisper-large-v3");
    expect(dialog.querySelector<HTMLInputElement>(".provider-editor-name")!.value).toBe("本地 Whisper 服务");
    expect(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!.value).toBe("");
  });
});

describe("provider-editor：「获取可用模型」弹窗（拍板 Q5/Q11）", () => {
  it("地址/Key 未填：目录区行内红字提示，不申请权限、不发模型请求", async () => {
    const { sent, host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    fireClick(dialog.querySelector(".provider-editor-fetch"));

    const error = dialog.querySelector<HTMLElement>(".provider-editor-catalog-error")!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("请先填写 API 地址和 Key");
    expect(document.querySelector(".provider-editor-fetch-dialog")).toBeNull();
    expect(sent.some((message) => message.type === "request-provider-origins")).toBe(false);
    const { fetchProviderModels } = await import("../../extension/ai/provider-models.js");
    expect(vi.mocked(fetchProviderModels)).not.toHaveBeenCalled();
  });

  it("权限代申请落在点击同步链上：点「获取可用模型」当拍即出站（零先行 await）", async () => {
    const { sent, host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://token.sensenova.cn/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");

    fireClick(dialog.querySelector(".provider-editor-fetch"));

    expect(messageTypes(sent).filter((type) => type === "request-provider-origins")).toHaveLength(1);
  });

  it("拉取成功：权限先于模型请求；搜索过滤；全选；勾选追加为目录行（草稿，不落盘）", async () => {
    const { sent, host } = await mountPanel({
      "ai-providers-models": () => {
        expect(chromeStub().runtime.sendMessage.mock.calls.some(([message]) => message.type === "request-provider-origins")).toBe(true);
        return { ok: true, models: ["gpt-4o-mini", "gpt-4o", "o1-mini"] };
      }
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://token.sensenova.cn/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");

    fireClick(dialog.querySelector(".provider-editor-fetch"));

    await vi.waitFor(() => {
      expect(document.querySelectorAll(".provider-editor-fetch-item")).toHaveLength(3);
    });
    expect(sent.find((message) => message.type === "request-provider-origins")!.baseUrls).toEqual(["https://token.sensenova.cn/v1"]);

    const search = document.querySelector<HTMLInputElement>(".provider-editor-fetch-search")!;
    search.value = "gpt";
    search.dispatchEvent(new Event("input"));
    expect(document.querySelectorAll(".provider-editor-fetch-item")).toHaveLength(2);
    search.value = "";
    search.dispatchEvent(new Event("input"));
    expect(document.querySelectorAll(".provider-editor-fetch-item")).toHaveLength(3);

    fireClick(document.querySelector(".provider-editor-fetch-all"));
    const confirmBtn = document.querySelector<HTMLButtonElement>(".provider-editor-fetch-confirm")!;
    expect(confirmBtn.textContent).toBe("添加所选 (3)");
    fireClick(confirmBtn);

    expect(document.querySelector(".provider-editor-fetch-dialog")).toBeNull();
    expect(
      Array.from(dialog.querySelectorAll<HTMLInputElement>(".provider-editor-model-id")).map((input) => input.value)
    ).toEqual(["gpt-4o-mini", "gpt-4o", "o1-mini"]);
    expect(sent.some((message) => message.type === "ai-providers-save")).toBe(false);
  });

  it("Anthropic 协议预设（DeepSeek）：探测地址跟随预设的 OpenAI 端点（/anthropic 无 /v1/models）", async () => {
    const { sent, host } = await mountPanel({
      "ai-providers-models": () => ({ ok: true, models: ["deepseek-chat", "deepseek-reasoner"] })
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");
    const presetSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!;
    presetSelect.value = "deepseek";
    presetSelect.dispatchEvent(new Event("change"));
    expect(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!.value).toBe("https://api.deepseek.com/anthropic");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");

    fireClick(dialog.querySelector(".provider-editor-fetch"));

    await vi.waitFor(() => {
      expect(document.querySelectorAll(".provider-editor-fetch-item")).toHaveLength(2);
    });
    const { fetchProviderModels } = await import("../../extension/ai/provider-models.js");
    expect(vi.mocked(fetchProviderModels).mock.calls[0][0].baseUrl).toBe("https://api.deepseek.com/v1");
    expect(sent.find((message) => message.type === "request-provider-origins")!.baseUrls).toEqual([
      "https://api.deepseek.com/anthropic",
      "https://api.deepseek.com/v1"
    ]);
  });

  it("已在目录中的模型置灰标注「已添加」，不可勾选", async () => {
    const aiItem = { id: "p1", presetId: "custom", name: "自定义", baseUrl: "https://token.sensenova.cn/v1", models: ["gpt-4o-mini"], requiresKey: true, enabled: true, hasSavedKey: true };
    const { host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [aiItem] }),
      "ai-providers-models": () => ({ ok: true, models: ["gpt-4o-mini", "gpt-4o"] })
    });
    const row = host.querySelector<HTMLElement>("#aiProvidersList .ai-provider-row")!;
    const { dialog } = await openEditor(host, row.querySelector(".provider-row-edit")!);

    fireClick(dialog.querySelector(".provider-editor-fetch"));

    await vi.waitFor(() => {
      expect(document.querySelectorAll(".provider-editor-fetch-item")).toHaveLength(2);
    });
    const addedCheck = document.querySelector<HTMLInputElement>('.provider-editor-fetch-check[value="gpt-4o-mini"]')!;
    expect(addedCheck.disabled).toBe(true);
    expect(addedCheck.closest(".provider-editor-fetch-item")!.textContent).toContain("已添加");

    fireClick(document.querySelector(".provider-editor-fetch-all"));
    expect(document.querySelectorAll(".provider-editor-fetch-check:checked")).toHaveLength(1);
    fireClick(document.querySelector(".provider-editor-fetch-confirm"));
    expect(
      Array.from(dialog.querySelectorAll<HTMLInputElement>(".provider-editor-model-id")).map((input) => input.value)
    ).toEqual(["gpt-4o-mini", "gpt-4o"]);
  });

  it("拉取失败：弹窗原位报错可重试；重试成功渲染列表", async () => {
    let modelsResponder: (message: SentMessage) => unknown = () => ({ ok: false, error: "HTTP 401: unauthorized" });
    const { host } = await mountPanel({
      "ai-providers-models": (message) => modelsResponder(message)
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://token.sensenova.cn/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    fireClick(dialog.querySelector(".provider-editor-fetch"));

    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>(".provider-editor-fetch-error")!.hidden).toBe(false);
    });
    expect(document.querySelector<HTMLElement>(".provider-editor-fetch-error")!.textContent).toContain("HTTP 401");

    modelsResponder = () => ({ ok: true, models: ["gpt-4o-mini"] });
    fireClick(document.querySelector(".provider-editor-fetch-retry"));

    await vi.waitFor(() => {
      expect(document.querySelectorAll(".provider-editor-fetch-item")).toHaveLength(1);
    });
    expect(document.querySelector<HTMLElement>(".provider-editor-fetch-error")!.hidden).toBe(true);
  });

  it("权限被拒：弹窗原位报错且不发注定 CORS 失败的模型请求", async () => {
    const { sent, host } = await mountPanel({
      "request-provider-origins": () => ({ ok: false, error: "未授权 https://token.sensenova.cn/*，操作已中止：请在权限弹窗中选择允许后重试" })
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://token.sensenova.cn/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    fireClick(dialog.querySelector(".provider-editor-fetch"));

    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>(".provider-editor-fetch-error")!.textContent).toContain("未授权");
    });
    const { fetchProviderModels } = await import("../../extension/ai/provider-models.js");
    expect(vi.mocked(fetchProviderModels)).not.toHaveBeenCalled();
    fireClick(document.querySelector(".provider-editor-fetch-cancel"));
    expect(document.querySelector(".provider-editor-fetch-dialog")).toBeNull();
    expect(editorGone()).toBe(false);
  });

  it("Esc 逐层退出：先关弹窗不关 Modal，再 Esc 弹 dirty 确认，放弃更改后关 Modal", async () => {
    const { host } = await mountPanel({
      "ai-providers-models": () => ({ ok: true, models: ["gpt-4o-mini"] })
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://token.sensenova.cn/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    fireClick(dialog.querySelector(".provider-editor-fetch"));
    await vi.waitFor(() => {
      expect(document.querySelectorAll(".provider-editor-fetch-item")).toHaveLength(1);
    });

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".provider-editor-fetch-dialog")).toBeNull();
    expect(editorGone()).toBe(false);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(editorGone()).toBe(false);
    expect(document.querySelector<HTMLElement>(".confirm-dialog-message")!.textContent).toBe("未保存的更改将丢失，确定关闭？");

    fireClick(document.querySelector(".confirm-dialog-confirm"));
    await vi.waitFor(() => expect(editorGone()).toBe(true));
  });
});

describe("provider-editor：「获取可用模型」内联子视图与选择保留（票 09）", () => {
  async function openFetchSubview(host: HTMLElement) {
    const { dialog } = await openEditor(host, "#addAiProviderBtn");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://token.sensenova.cn/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    fireClick(dialog.querySelector(".provider-editor-fetch"));
    await vi.waitFor(() => {
      expect(document.querySelectorAll(".provider-editor-fetch-item").length).toBeGreaterThan(0);
    });
    return { dialog, subview: document.querySelector<HTMLElement>(".provider-editor-fetch-dialog")! };
  }

  function checkOf(model: string): HTMLInputElement {
    return document.querySelector<HTMLInputElement>(`.provider-editor-fetch-check[value="${model}"]`)!;
  }

  function setSearch(value: string) {
    const search = document.querySelector<HTMLInputElement>(".provider-editor-fetch-search")!;
    search.value = value;
    search.dispatchEvent(new Event("input"));
  }

  it("内联子视图：渲染在编辑器 Dialog 内且无第二张遮罩", async () => {
    const { host } = await mountPanel({
      "ai-providers-models": () => ({ ok: true, models: ["gpt-4o-mini"] })
    });
    const { dialog, subview } = await openFetchSubview(host);

    expect(subview).toBeTruthy();
    expect(subview.closest(".provider-editor-dialog")).toBe(dialog);
    expect(document.querySelector(".provider-editor-fetch-mask")).toBeNull();
    expect(subview.querySelector(".provider-editor-fetch-back")!.textContent).toContain("返回");
    expect(subview.querySelector(".provider-editor-fetch-cancel")).toBeTruthy();
    expect(subview.querySelector(".provider-editor-fetch-confirm")).toBeTruthy();
  });

  it("打开子视图即移焦到子视图，Esc 只退回编辑器并把焦点还给「获取可用模型」", async () => {
    const { host } = await mountPanel({
      "ai-providers-models": () => ({ ok: true, models: ["gpt-4o-mini"] })
    });
    const { dialog } = await openFetchSubview(host);

    expect(document.activeElement).toBe(document.querySelector(".provider-editor-fetch-back"));
    expect(document.querySelector(".provider-editor-fetch-dialog")!.closest(".provider-editor-dialog")).toBe(dialog);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".provider-editor-fetch-dialog")).toBeNull();
    expect(editorGone()).toBe(false);
    expect(document.activeElement).toBe(dialog.querySelector(".provider-editor-fetch"));
  });

  it("先选 A、过滤选 B：选择集跨搜索过滤保留，确认加入全量已选", async () => {
    const { host } = await mountPanel({
      "ai-providers-models": () => ({ ok: true, models: ["model-a", "model-b", "model-c"] })
    });
    const { dialog } = await openFetchSubview(host);

    fireClick(checkOf("model-a"));
    expect(document.querySelector<HTMLButtonElement>(".provider-editor-fetch-confirm")!.textContent).toBe("添加所选 (1)");
    setSearch("model-b");
    expect(document.querySelectorAll(".provider-editor-fetch-item")).toHaveLength(1);
    fireClick(checkOf("model-b"));
    expect(document.querySelector<HTMLButtonElement>(".provider-editor-fetch-confirm")!.textContent).toBe("添加所选 (2)");
    setSearch("");
    expect(checkOf("model-a").checked).toBe(true);
    expect(checkOf("model-b").checked).toBe(true);
    expect(checkOf("model-c").checked).toBe(false);

    fireClick(document.querySelector(".provider-editor-fetch-confirm"));
    expect(
      Array.from(dialog.querySelectorAll<HTMLInputElement>(".provider-editor-model-id")).map((input) => input.value)
    ).toEqual(["model-a", "model-b"]);
  });

  it("全选三态：部分勾选为 indeterminate；全选只作用于当前可见且未添加项", async () => {
    const { host } = await mountPanel({
      "ai-providers-models": () => ({ ok: true, models: ["gpt-4o-mini", "gpt-4o", "o1-mini"] })
    });
    await openFetchSubview(host);
    const all = document.querySelector<HTMLInputElement>(".provider-editor-fetch-all")!;

    setSearch("gpt");
    fireClick(checkOf("gpt-4o"));
    expect(all.indeterminate).toBe(true);
    expect(all.checked).toBe(false);

    fireClick(all);
    expect(all.checked).toBe(true);
    expect(all.indeterminate).toBe(false);
    expect(document.querySelectorAll(".provider-editor-fetch-check:checked")).toHaveLength(2);

    fireClick(all);
    expect(all.checked).toBe(false);
    expect(document.querySelectorAll(".provider-editor-fetch-check:checked")).toHaveLength(0);
    expect(document.querySelector<HTMLButtonElement>(".provider-editor-fetch-confirm")!.disabled).toBe(true);
  });

  it("确认计数包含隐藏已选项，并说明不可见选择数量", async () => {
    const { host } = await mountPanel({
      "ai-providers-models": () => ({ ok: true, models: ["model-a", "model-b", "model-c"] })
    });
    await openFetchSubview(host);

    fireClick(checkOf("model-a"));
    setSearch("model-b");
    fireClick(checkOf("model-b"));

    const note = document.querySelector<HTMLElement>(".provider-editor-fetch-note")!;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe("另有 1 项已选不在当前筛选结果中");
    expect(document.querySelector<HTMLButtonElement>(".provider-editor-fetch-confirm")!.textContent).toBe("添加所选 (2)");

    setSearch("model-");
    expect(document.querySelector<HTMLElement>(".provider-editor-fetch-note")!.hidden).toBe(true);
  });

  it("已添加模型保持禁用标识，重复确认不会制造重复目录项", async () => {
    const { host } = await mountPanel({
      "ai-providers-models": () => ({ ok: true, models: ["gpt-4o-mini", "gpt-4o"] })
    });
    const { dialog } = await openFetchSubview(host);

    fireClick(document.querySelector(".provider-editor-fetch-all"));
    fireClick(document.querySelector(".provider-editor-fetch-confirm"));
    expect(dialog.querySelectorAll(".provider-editor-model-row")).toHaveLength(2);

    fireClick(dialog.querySelector(".provider-editor-fetch"));
    await vi.waitFor(() => {
      expect(document.querySelectorAll(".provider-editor-fetch-item")).toHaveLength(2);
    });
    const addedCheck = checkOf("gpt-4o-mini");
    expect(addedCheck.disabled).toBe(true);
    expect(addedCheck.closest(".provider-editor-fetch-item")!.textContent).toContain("已添加");
    expect(document.querySelector<HTMLButtonElement>(".provider-editor-fetch-confirm")!.disabled).toBe(true);

    fireClick(checkOf("gpt-4o"));
    fireClick(document.querySelector(".provider-editor-fetch-confirm"));
    expect(
      Array.from(dialog.querySelectorAll<HTMLInputElement>(".provider-editor-model-id")).map((input) => input.value)
    ).toEqual(["gpt-4o-mini", "gpt-4o"]);
  });

  it("返回与取消只退回平台编辑器：草稿保留、dirty 保护不触发", async () => {
    const { host } = await mountPanel({
      "ai-providers-models": () => ({ ok: true, models: ["gpt-4o-mini"] })
    });
    const { dialog } = await openFetchSubview(host);

    fireClick(document.querySelector(".provider-editor-fetch-back"));
    expect(document.querySelector(".provider-editor-fetch-dialog")).toBeNull();
    expect(editorGone()).toBe(false);
    expect(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!.value).toBe("https://token.sensenova.cn/v1");
    expect(document.querySelector(".confirm-dialog-host")).toBeNull();

    fireClick(dialog.querySelector(".provider-editor-fetch"));
    await vi.waitFor(() => {
      expect(document.querySelectorAll(".provider-editor-fetch-item")).toHaveLength(1);
    });
    fireClick(document.querySelector(".provider-editor-fetch-cancel"));
    expect(document.querySelector(".provider-editor-fetch-dialog")).toBeNull();
    expect(editorGone()).toBe(false);
  });
});

describe("provider-editor：ASR 模型下拉箭头先申请域名权限（model-picker，ASR 侧保留）", () => {
  it("ASR：点箭头 → 先申请权限再调 listAsrModels", async () => {
    const { listAsrModels } = await import("../../extension/asr/provider-models.js");
    vi.mocked(listAsrModels).mockResolvedValueOnce({ ok: true, models: ["whisper-1"] });
    const { sent, host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAsrProviderBtn");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://asr.example.com/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    fireClick(dialog.querySelector(".ai-provider-model-toggle"));

    await vi.waitFor(() => {
      expect(dialog.querySelector('.ai-provider-model-option[data-model="whisper-1"]')).toBeTruthy();
    });
    expect(sent.some((message) => message.type === "request-provider-origins")).toBe(true);
    expect(listAsrModels).toHaveBeenCalled();
  });
});

describe("provider-editor：原生约束校验属性（:user-invalid CSS 校验态的属性面）", () => {
  it("新增 AI（custom 预设）：baseUrl required+pattern、Key required；模型目录行无原生必填（空目录合法 Q13）", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    const baseUrl = dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!;
    expect(baseUrl.required).toBe(true);
    expect(baseUrl.getAttribute("pattern")).toBe("https?://.+");
    expect(dialog.querySelector(".provider-editor-model")).toBeNull();
    expect(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!.required).toBe(true);
  });

  it("切换到免 Key 预设（ollama）：Key required 摘除，切回必填预设恢复", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");
    const select = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!;
    const apikey = dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!;

    select.value = "ollama";
    select.dispatchEvent(new Event("change"));
    expect(apikey.required).toBe(false);

    select.value = "deepseek";
    select.dispatchEvent(new Event("change"));
    expect(apikey.required).toBe(true);
  });

  it("编辑已存 Key 的平台：Key 不 required（空值沿用已存 Key）", async () => {
    const aiItem = { id: "p1", presetId: "custom", name: "自定义", baseUrl: "https://api.example.com/v1", models: ["gpt-4o-mini"], requiresKey: true, enabled: true, hasSavedKey: true };
    const { host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [aiItem] })
    });
    const row = host.querySelector<HTMLElement>("#aiProvidersList .ai-provider-row")!;
    const { dialog } = await openEditor(host, row.querySelector(".provider-row-edit")!);

    expect(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!.required).toBe(false);
  });

  it("ASR Modal：baseUrl required+pattern、模型名 required 同样就位", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAsrProviderBtn");

    expect(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!.required).toBe(true);
    expect(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!.getAttribute("pattern")).toBe("https?://.+");
    expect(dialog.querySelector<HTMLInputElement>(".provider-editor-model")!.required).toBe(true);
    expect(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!.required).toBe(true);
  });

  it("未提交校验时输入 / blur 不挂 aria-invalid（字段错误态由提交后的校验维护）", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");
    const baseUrl = dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!;

    baseUrl.value = "https://api.example.com/v1";
    baseUrl.dispatchEvent(new Event("input", { bubbles: true }));
    baseUrl.dispatchEvent(new FocusEvent("blur"));
    expect(baseUrl.getAttribute("aria-invalid")).toBeNull();

    expect(() => dialog.dispatchEvent(new FocusEvent("blur"))).not.toThrow();
    expect(() => dialog.querySelector(".provider-editor-save")!.dispatchEvent(new Event("input", { bubbles: true }))).not.toThrow();
    expect(dialog.querySelector(".provider-editor-save")!.getAttribute("aria-invalid")).toBeNull();
  });
});

describe("provider-editor：平台预设走 custom-select（AI/ASR 两侧）", () => {
  it.each([
    ["AI", "#addAiProviderBtn", "ollama", "http://localhost:11434/v1"],
    ["ASR", "#addAsrProviderBtn", "local-whisper", "http://localhost:8000/v1"]
  ])("%s：原生 select 被组件接管，选项点击写回值并派生 change", async (_label, button, optionValue, expectedBaseUrl) => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, button);

    const select = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!;
    const wrapper = select.closest<HTMLElement>(".custom-select-wrapper")!;
    expect(wrapper).toBeTruthy();
    expect(select.dataset.customSelectInitialized).toBe("1");
    expect(select.style.display).toBe("none");
    expect(select.getAttribute("tabindex")).toBeNull();
    expect(select.getAttribute("aria-hidden")).toBeNull();
    expect(select.closest(".provider-editor-host")).toBeTruthy();

    const trigger = wrapper.querySelector<HTMLElement>(".custom-select-trigger")!;
    const option = wrapper.querySelector<HTMLElement>(`.custom-select-option[data-value="${optionValue}"]`)!;
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    expect(option).toBeTruthy();

    fireClick(option);
    expect(select.value).toBe(optionValue);
    expect(trigger.querySelector(".custom-select-value")!.textContent).toBe(option.textContent);
    expect(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!.value).toBe(expectedBaseUrl);
  });
});

describe("provider-editor：draft 投影语义（候选 4 片 3）", () => {
  it("裸写 DOM 不进保存：落盘的是经 input 事件写入 draft 的值", async () => {
    const { sent, host } = await mountPanel({
      "ai-providers-save": () => ({ ok: true, providers: [] })
    });
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    fireClick(dialog.querySelector(".provider-editor-model-add"));
    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-model-id")!, "gpt-4o-mini");
    dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!.value = "https://tampered.example.com/v1";

    fireClick(dialog.querySelector(".provider-editor-save"));
    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "ai-providers-save")).toBe(true);
    });
    const saveMessage = sent.find((message) => message.type === "ai-providers-save")!;
    expect(saveMessage.providers[0].baseUrl).toBe("https://api.example.com/v1");
  });

  it("裸写 DOM 不产生 dirty：取消直关，不弹确认弹层", async () => {
    const { host } = await mountPanel();
    const { dialog } = await openEditor(host, "#addAiProviderBtn");

    dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!.value = "https://tampered.example.com/v1";

    fireClick(dialog.querySelector(".provider-editor-cancel"));
    expect(document.querySelector(".confirm-dialog-host")).toBeNull();
    expect(editorGone()).toBe(true);
  });
});

describe("ASR 平台选用状态自动维护", () => {
  const asr1 = {
    id: "asr_1",
    presetId: "siliconflow-sensevoice",
    type: "openai-transcriptions",
    name: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "FunAudioLLM/SenseVoiceSmall",
    supportsTimestamps: false,
    enabled: true,
    hasSavedKey: true
  };
  const asr2 = {
    id: "asr_2",
    presetId: "groq",
    type: "openai-transcriptions",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "whisper-large-v3-turbo",
    supportsTimestamps: true,
    enabled: true,
    hasSavedKey: true
  };

  it("面板装载时若列表非空但 activeAsrProviderId 为空，自动选中首项并写回设置", async () => {
    const { sent, host } = await mountPanel({
      "asr-providers-list": () => ({ ok: true, providers: [asr1, asr2] })
    });

    const radios = host.querySelectorAll<HTMLInputElement>("#asrProvidersList .asr-provider-active-radio");
    expect(radios).toHaveLength(2);
    expect(radios[0].checked).toBe(true);
    expect(radios[1].checked).toBe(false);
    expect(sent).toContainEqual({
      type: "save-settings",
      settings: { activeAsrProviderId: "asr_1" }
    });
  });

  it("删除当前激活的 ASR 平台后若仍有剩余平台，自动回退选中首个剩余平台", async () => {
    const { sent, host } = await mountPanel({
      "get-settings": () => ({ ok: true, settings: { activeAsrProviderId: "asr_1" } }),
      "asr-providers-list": () => ({ ok: true, providers: [asr1, asr2] }),
      "asr-providers-delete": () => ({ ok: true, providers: [asr2] })
    });

    const firstRow = host.querySelector<HTMLElement>("#asrProvidersList .asr-provider-row")!;
    fireClick(firstRow.querySelector(".provider-row-remove"));
    const confirmBtn = document.querySelector<HTMLButtonElement>(".confirm-dialog-confirm")!;
    fireClick(confirmBtn);

    await vi.waitFor(() => {
      expect(sent.some((m) => m.type === "asr-providers-delete")).toBe(true);
    });

    const remainingRadio = host.querySelector<HTMLInputElement>("#asrProvidersList .asr-provider-active-radio")!;
    expect(remainingRadio.checked).toBe(true);
    expect(sent).toContainEqual({
      type: "save-settings",
      settings: { activeAsrProviderId: "asr_2" }
    });
  });
});
