import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installSettingsPanelBus } from "../helpers/settings-panel-bus.js";
import { initCustomSelect } from "../../extension/ui/custom-select.js";
import { isDirty } from "../../extension/ui/provider-editor-modal.js";
import * as projectionModule from "../../extension/ui/provider-editor-projection.js";
import * as stateModule from "../../extension/ui/provider-editor-state.js";
import type { EditorDraft } from "../../extension/ui/provider-editor-state.js";
import type { ProviderRowPreset } from "../../extension/ui/provider-row.js";
import { renderReaderSettingsPanel } from "../../extension/ui/settings-panel.js";
import { resetSettingsPanelState, waitForFast } from "../helpers/reset-settings-panel-state.js";

const PRESETS: ProviderRowPreset[] = [
  { id: "custom", name: "自定义", baseUrl: "", requiresKey: true },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    requiresKey: true,
    protocol: "anthropic",
    protocolBaseUrls: { anthropic: "https://api.deepseek.com/anthropic" }
  },
  { id: "ollama", name: "Ollama (本地)", baseUrl: "http://localhost:11434/v1", requiresKey: false }
];

function draftOf(overrides: Partial<EditorDraft> = {}): EditorDraft {
  return {
    presetId: "custom",
    name: "",
    baseUrl: "",
    apiKey: "",
    protocol: "openai",
    models: [],
    model: "",
    ...overrides
  };
}

beforeEach(() => {
  resetSettingsPanelState();
});

afterEach(() => {
  stateModule.endEditorSession();
});

async function mountProjectionSession(draft: EditorDraft, kind: "ai" | "asr" = "ai") {
  document.body.innerHTML = `
    <div id="biliscript-reading-view">
      <div class="provider-editor-host">
        <section class="provider-editor-dialog">
          <select class="provider-editor-preset">
            ${PRESETS.map((preset) => `<option value="${preset.id}">${preset.name}</option>`).join("")}
          </select>
          <select class="provider-editor-protocol">
            <option value="openai">OpenAI Chat Completions</option>
            <option value="anthropic">Anthropic Messages</option>
          </select>
          <input class="provider-editor-name" type="text" />
          <input class="provider-editor-baseurl" type="text" />
          <input class="provider-editor-apikey" type="password" />
          <input class="provider-editor-model" type="text" />
          <p class="provider-editor-protocol-notes" hidden></p>
          <p class="provider-editor-catalog-empty" hidden></p>
          <div class="provider-editor-model-list"></div>
        </section>
      </div>
    </div>`;
  const host = document.querySelector<HTMLElement>(".provider-editor-host")!;
  stateModule.beginEditorSession({
    kind,
    host,
    presets: PRESETS,
    hasSavedKey: false,
    draft
  });
  return { state: stateModule, projection: projectionModule, host, dialog: document.querySelector<HTMLElement>(".provider-editor-dialog")! };
}

function context(kind: "ai" | "asr" = "ai") {
  return { kind, presets: PRESETS, hasSavedKey: false };
}

function expectProjectionMatches(
  projection: { projectEditorFields: Function; readProjection: Function },
  draft: EditorDraft,
  ctx: { kind: "ai" | "asr"; presets: ProviderRowPreset[]; hasSavedKey: boolean }
) {
  const expected = projection.projectEditorFields(draft, ctx) as Record<string, Record<string, unknown>>;
  const actual = projection.readProjection(ctx) as Record<string, Record<string, unknown>>;
  for (const [field, state] of Object.entries(expected)) {
    for (const [prop, value] of Object.entries(state)) {
      expect(actual[field]?.[prop], `${field}.${prop} 未投影到 DOM`).toEqual(value);
    }
  }
}

describe("字段投影（owner 1）：模板与联动共用的唯一投影点", () => {
  it("重投影后逐字段 DOM 目标态 == projectEditorFields（投影漏字段即红）", async () => {
    const { projection } = await mountProjectionSession(draftOf());
    const initial = draftOf({
      presetId: "deepseek",
      name: "我的端点",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-typed",
      protocol: "anthropic",
      models: ["deepseek-v4-pro"]
    });

    projection.renderProjection(initial, context());
    expectProjectionMatches(projection, initial, context());

    const next = draftOf({
      presetId: "ollama",
      name: "",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "",
      protocol: "openai",
      models: []
    });
    projection.renderProjection(next, context());
    expectProjectionMatches(projection, next, context());
  });

  it("ASR 形态：单模型输入与 Key 值/必填同源投影", async () => {
    const { projection } = await mountProjectionSession(draftOf({ presetId: "custom", model: "" }), "asr");
    const asr = draftOf({ presetId: "custom", name: "本地", baseUrl: "http://localhost:8000/v1", apiKey: "", model: "whisper-large-v3" });

    projection.renderProjection(asr, context("asr"));
    expectProjectionMatches(projection, asr, context("asr"));
  });

  it("模板片段是同一投影的产物（模板自写死值即红）", async () => {
    const { projection } = await mountProjectionSession(draftOf());
    const draft = draftOf({
      presetId: "deepseek",
      name: "我的端点",
      baseUrl: "https://api.deepseek.com/v1",
      protocol: "anthropic",
      models: ["deepseek-v4-pro"]
    });
    const ctx = context();
    const fields = projection.projectEditorFields(draft, ctx) as Record<string, Record<string, string>>;
    const blocks = projection.projectionBlocks(draft, ctx) as Record<string, string>;

    expect(blocks.name).toContain(`value="${fields.name.value}"`);
    expect(blocks.name).toContain(`placeholder="${fields.name.placeholder}"`);
    expect(blocks.baseUrl).toContain(`value="${fields.baseUrl.value}"`);
    expect(blocks.apiKey).toContain(`placeholder="${fields.apiKey.placeholder}"`);
    expect(blocks.preset).toContain(`value="${fields.preset.value}" selected`);
    expect(fields.protocolNotes.text).toBe("");
    expect(blocks.protocolNotes).toContain("hidden");
    expect(blocks.catalogEmpty).toContain("hidden");
  });

  it("预设切换：所有字段随 draft 重投影（协议 trigger / Key 占位与必填 / 名称占位）", async () => {
    const draft = draftOf();
    const { projection, dialog, state } = await mountProjectionSession(draft);
    const { presetProtocol, presetBaseUrlForProtocol } = projection;

    const next = PRESETS[1];
    state.editDraft((current) => {
      current.presetId = next.id;
      current.protocol = presetProtocol(next);
      current.baseUrl = presetBaseUrlForProtocol(next, current.protocol);
    });
    initCustomSelect(dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!);
    initCustomSelect(dialog.querySelector<HTMLSelectElement>(".provider-editor-protocol")!);
    projection.renderProjection();

    const protocolSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-protocol")!;
    const protocolWrapper = protocolSelect.closest<HTMLElement>(".custom-select-wrapper")!;
    expect(protocolSelect.value).toBe("anthropic");
    expect(protocolWrapper.querySelector(".custom-select-value")!.textContent).toBe("Anthropic Messages");
    expect(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!.value).toBe(
      "https://api.deepseek.com/anthropic"
    );
    expect(dialog.querySelector<HTMLInputElement>(".provider-editor-name")!.placeholder).toBe("DeepSeek");
    expect(dialog.querySelector<HTMLElement>(".provider-editor-protocol-notes")!.hidden).toBe(true);
  });
});

describe("draft 真源与 dirty（F3/F5）", () => {
  it("EditorDraft 全键穷举：任一字段变化都判脏（draftsEqual 漏比即红）", async () => {
    const { cloneDraft, draftsEqual } = stateModule;
    const base = draftOf({ presetId: "custom", name: "n", baseUrl: "https://a.example.com", apiKey: "k", protocol: "openai", models: ["m"], model: "x" });
    expect(draftsEqual(base, cloneDraft(base))).toBe(true);

    for (const key of Object.keys(base)) {
      const mutated = cloneDraft(base) as unknown as Record<string, unknown>;
      const current = mutated[key];
      mutated[key] = Array.isArray(current) ? [...current, "m2"] : key === "protocol" ? "anthropic" : `${String(current)}!`;
      expect(draftsEqual(base, mutated as never), `${key} 变化必须判脏`).toBe(false);
    }
  });

  it("models 顺序不同同样判脏（不只看长度）", async () => {
    const { draftsEqual } = stateModule;
    expect(draftsEqual(draftOf({ models: ["a", "b"] }), draftOf({ models: ["b", "a"] }))).toBe(false);
  });
});

type MessageResponder = (message: { type: string } & Record<string, any>) => unknown;

function installMessageBus(overrides: Record<string, MessageResponder> = {}) {
  const host = installSettingsPanelBus<{ type: string } & Record<string, any>>({
    "ai-providers-save": () => ({ ok: true, providers: [] }),
    "asr-providers-save": () => ({ ok: true, providers: [] }),
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
  const sendMessage = (chrome as unknown as { runtime: { sendMessage: { mock: { calls: [{ type: string }][] } } } }).runtime.sendMessage;
  expect(sendMessage.mock.calls.some(([message]) => message.type === "asr-providers-list")).toBe(true);
  return { sent, host };
}

async function openEditor(host: HTMLElement, buttonSelector: string) {
  host.querySelector(buttonSelector)!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await waitForFast(() => {
    expect(document.querySelector(".provider-editor-dialog")).toBeTruthy();
  });
  return document.querySelector<HTMLElement>(".provider-editor-dialog")!;
}

function setFieldValue(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("输入回写与联动（F4/F5，真实设置面板路径）", () => {
  it.each([
    ["name", "#addAiProviderBtn", ".provider-editor-name", "我的端点"],
    ["baseUrl", "#addAiProviderBtn", ".provider-editor-baseurl", "https://api.example.com/v1"],
    ["apiKey", "#addAiProviderBtn", ".provider-editor-apikey", "sk-test"],
    ["model", "#addAsrProviderBtn", ".provider-editor-model", "whisper-1"]
  ])("%s 经 input 事件写入即判脏（回写漏字段即红）", async (_key, button, selector, value) => {
    const { host } = await mountPanel();
    const dialog = await openEditor(host, button);

    expect(isDirty()).toBe(false);
    setFieldValue(dialog.querySelector<HTMLInputElement>(selector)!, value);
    expect(isDirty()).toBe(true);
  });

  it("预设切换走自定义下拉：联动结果写入 draft 并随保存落盘（只改 DOM 会落旧值）", async () => {
    const { sent, host } = await mountPanel();
    const dialog = await openEditor(host, "#addAiProviderBtn");

    const presetSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!;
    const wrapper = presetSelect.closest<HTMLElement>(".custom-select-wrapper")!;
    wrapper
      .querySelector<HTMLElement>('.custom-select-option[data-value="deepseek"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(presetSelect.value).toBe("deepseek");
    expect(dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!.value).toBe(
      "https://api.deepseek.com/anthropic"
    );

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    dialog.querySelector(".provider-editor-save")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitForFast(() => {
      expect(sent.some((message) => message.type === "ai-providers-save")).toBe(true);
    });
    const saveMessage = sent.find((message) => message.type === "ai-providers-save")!;
    expect(saveMessage.providers[0]).toMatchObject({
      presetId: "deepseek",
      baseUrl: "https://api.deepseek.com/anthropic",
      protocol: "anthropic"
    });
  });
});
