import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogModelMeta } from "../../extension/ai/model-catalog.js";
import * as realModelCatalog from "../../extension/ai/model-catalog.js";
import { UPSTREAM_CATALOG_SOURCE } from "../../extension/ai/catalog/models-dev-catalog.generated.js";

type CatalogModule = typeof realModelCatalog;

const catalogGate = vi.hoisted(() => ({
  loaded: null as CatalogModule | null,
  deferred: null as Promise<CatalogModule> | null,
  resolveDeferred: null as ((mod: CatalogModule) => void) | null,
  customLookup: null as ((presetId: unknown, baseUrl: unknown, modelId: unknown) => CatalogModelMeta | null) | null
}));

const fetchMocks = vi.hoisted(() => ({
  fetchProviderModels: vi.fn(async (): Promise<{ ok: boolean; models?: string[]; error?: string }> => ({
    ok: true,
    models: []
  }))
}));

vi.mock("../../extension/ui/lazy-model-catalog.js", () => ({
  loadedModelCatalog: () => catalogGate.loaded,
  loadModelCatalog: async () => {
    if (catalogGate.loaded) {
      return catalogGate.loaded;
    }
    if (catalogGate.deferred) {
      return catalogGate.deferred;
    }
    const mod: CatalogModule = catalogGate.customLookup
      ? { ...realModelCatalog, lookupCatalogMeta: catalogGate.customLookup }
      : realModelCatalog;
    catalogGate.loaded = mod;
    return mod;
  }
}));

vi.mock("../../extension/ai/provider-models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/ai/provider-models.js")>();
  return {
    ...actual,
    fetchProviderModels: fetchMocks.fetchProviderModels
  };
});

import { closeProviderEditor, openProviderEditor } from "../../extension/ui/provider-editor.js";
import { flushMicrotasks, resetProviderEditorState, waitForFast } from "../helpers/reset-provider-editor-state.js";

const MIMO_BASE_URL = "https://api.xiaomimimo.com/v1";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";

const PRESET_SUBSET = [
  { id: "custom", name: "自定义", baseUrl: "" },
  { id: "ollama", name: "Ollama (本地)", baseUrl: "http://localhost:11434/v1" },
  { id: "deepseek", name: "DeepSeek", baseUrl: DEEPSEEK_BASE_URL },
  { id: "qwen", name: "Qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" }
];

function mountEditor(options: { presetId: string; baseUrl: string; models: string[]; apiKey?: string }) {
  document.body.innerHTML = '<div id="biliscript-reading-view"></div>';
  openProviderEditor({
    kind: "ai",
    item: {
      id: "p_meta",
      presetId: options.presetId,
      name: "",
      baseUrl: options.baseUrl,
      models: options.models,
      hasSavedKey: true
    },
    presets: PRESET_SUBSET,
    onSave: async () => ({ ok: true })
  });
  const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
  if (options.apiKey) {
    const keyInput = dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!;
    keyInput.value = options.apiKey;
    keyInput.dispatchEvent(new Event("input", { bubbles: true }));
  }
  return dialog;
}

function deferCatalogLoad() {
  catalogGate.deferred = new Promise<CatalogModule>((resolve) => {
    catalogGate.resolveDeferred = (mod) => {
      catalogGate.loaded = mod;
      catalogGate.deferred = null;
      catalogGate.resolveDeferred = null;
      resolve(mod);
    };
  });
}

function metaSlot(dialog: HTMLElement, index: number): HTMLElement {
  const row = dialog.querySelectorAll<HTMLElement>(".provider-editor-model-row")[index];
  return row.querySelector<HTMLElement>("[data-model-meta]")!;
}

function modelInput(dialog: HTMLElement, index: number): HTMLInputElement {
  return dialog.querySelectorAll<HTMLInputElement>(".provider-editor-model-id")[index];
}

function fireInput(node: HTMLElement): void {
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

function fireClick(node: Element | null): void {
  node!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  resetProviderEditorState();
  catalogGate.loaded = null;
  catalogGate.deferred = null;
  catalogGate.resolveDeferred = null;
  catalogGate.customLookup = null;
  fetchMocks.fetchProviderModels.mockReset().mockResolvedValue({ ok: true, models: [] });
});

afterEach(() => {
  closeProviderEditor(true);
});

describe("元数据短格式（经编辑器模型行展示验证）", () => {
  it("≥10⁶ 用 M，否则十进制取整到 K，非正数/NaN 不显示窗口文本", async () => {
    const cases: [string, number, string][] = [
      ["m-1m", 1_000_000, "1M"],
      ["m-524k", 524_288, "524K"],
      ["m-128k", 128_000, "128K"],
      ["m-384k", 384_000, "384K"],
      ["m-8k", 8_192, "8K"],
      ["m-1.5m", 1_500_000, "1.5M"],
      ["m-0", 0, ""],
      ["m-nan", Number.NaN, ""]
    ];
    const table = new Map<string, CatalogModelMeta>(
      cases.map(([id, contextWindow]) => [
        id,
        { id, name: id, contextWindow, maxTokens: 4096, reasoning: false, input: ["text"] }
      ])
    );
    catalogGate.customLookup = (_presetId, _baseUrl, modelId) => table.get(String(modelId ?? "")) ?? null;

    const dialog = mountEditor({
      presetId: "custom",
      baseUrl: "https://api.example.com/v1",
      models: cases.map(([id]) => id)
    });
    await flushMicrotasks();

    cases.forEach(([, , expected], index) => {
      const slot = metaSlot(dialog, index);
      if (expected) {
        expect(slot.hidden).toBe(false);
        expect(slot.querySelector(".provider-editor-model-window")?.textContent).toBe(expected);
      } else {
        expect(slot.hidden).toBe(true);
        expect(slot.textContent).toBe("");
      }
    });
  });
});

describe("模型行元数据", () => {
  it("命中：延迟加载前隐藏，加载后展示窗口 + 能力徽标；title 带输出上限与数据版本", async () => {
    deferCatalogLoad();
    const dialog = mountEditor({
      presetId: "custom",
      baseUrl: MIMO_BASE_URL,
      models: ["mimo-v2.5"]
    });
    expect(metaSlot(dialog, 0).hidden).toBe(true);

    catalogGate.resolveDeferred!(realModelCatalog);
    await flushMicrotasks();

    const slot = metaSlot(dialog, 0);
    expect(slot.hidden).toBe(false);
    expect(slot.textContent).toBe("1M思考图片");
    expect(slot.querySelectorAll(".provider-editor-model-badge")).toHaveLength(2);
    expect(slot.title).toContain("MiMo-V2.5");
    expect(slot.title).toContain("输出上限 131K");
    expect(slot.title).toContain(
      `目录 ${UPSTREAM_CATALOG_SOURCE.source} ${UPSTREAM_CATALOG_SOURCE.contentHash}`
    );
    expect(slot.title).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it("只文本的模型不挂「图片」徽标", async () => {
    const dialog = mountEditor({
      presetId: "deepseek",
      baseUrl: DEEPSEEK_BASE_URL,
      models: ["deepseek-v4-pro"]
    });
    await flushMicrotasks();

    const slot = metaSlot(dialog, 0);
    expect(slot.textContent).toBe("1M思考");
    expect(slot.title).toContain("仅文本输入");
  });

  it("查不到整栏静默隐藏：不占位、无 title、无徽标", async () => {
    const dialog = mountEditor({
      presetId: "deepseek",
      baseUrl: DEEPSEEK_BASE_URL,
      models: ["no-such-model"]
    });
    await flushMicrotasks();

    const slot = metaSlot(dialog, 0);
    expect(slot.hidden).toBe(true);
    expect(slot.textContent).toBe("");
    expect(slot.hasAttribute("title")).toBe(false);
  });

  it("无数据平台（ollama）整栏不渲染", async () => {
    const dialog = mountEditor({
      presetId: "ollama",
      baseUrl: "http://localhost:11434/v1",
      models: ["qwen3.8-max"]
    });
    await flushMicrotasks();

    expect(metaSlot(dialog, 0).hidden).toBe(true);
  });

  it("原无数据平台（qwen）改源后命中：窗口 + 思考 + 图片徽标（10 号票白名单收缩）", async () => {
    const dialog = mountEditor({
      presetId: "qwen",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      models: ["qwen3.8-max"]
    });
    await flushMicrotasks();

    const slot = metaSlot(dialog, 0);
    expect(slot.hidden).toBe(false);
    expect(slot.textContent).toBe("1M思考图片");
  });

  it("只跟着平台身份与模型 id 走：改 baseUrl / 模型 id / 预设都重算", async () => {
    const dialog = mountEditor({
      presetId: "custom",
      baseUrl: "",
      models: ["mimo-v2.5"]
    });
    await flushMicrotasks();
    expect(metaSlot(dialog, 0).hidden).toBe(true);

    const baseUrl = dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!;
    baseUrl.value = MIMO_BASE_URL;
    fireInput(baseUrl);
    expect(metaSlot(dialog, 0).textContent).toBe("1M思考图片");

    const input = modelInput(dialog, 0);
    input.value = "no-such-model";
    fireInput(input);
    expect(metaSlot(dialog, 0).hidden).toBe(true);

    input.value = "mimo-v2.5";
    fireInput(input);
    expect(metaSlot(dialog, 0).hidden).toBe(false);

    const presetSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!;
    presetSelect.value = "ollama";
    presetSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(metaSlot(dialog, 0).hidden).toBe(true);
  });

  it("新加的行也带上元数据（草稿行增删路径）", async () => {
    const dialog = mountEditor({
      presetId: "deepseek",
      baseUrl: DEEPSEEK_BASE_URL,
      models: []
    });
    await flushMicrotasks();

    fireClick(dialog.querySelector(".provider-editor-model-add"));
    const input = modelInput(dialog, 0);
    input.value = "deepseek-v4-pro";
    fireInput(input);
    expect(metaSlot(dialog, 0).textContent).toBe("1M思考");
  });

  it("仅以 session draft 为真源：裸改 DOM 不生效，经 input 写入 draft 后重算元数据", async () => {
    const dialog = mountEditor({
      presetId: "custom",
      baseUrl: "",
      models: ["mimo-v2.5"]
    });
    await flushMicrotasks();

    dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!.value = "deepseek";
    const baseUrlInput = dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!;
    baseUrlInput.value = MIMO_BASE_URL;
    fireClick(dialog.querySelector(".provider-editor-model-add"));
    expect(metaSlot(dialog, 0).hidden).toBe(true);

    baseUrlInput.value = MIMO_BASE_URL;
    fireInput(baseUrlInput);
    expect(metaSlot(dialog, 0).hidden).toBe(false);
    expect(metaSlot(dialog, 0).textContent).toBe("1M思考图片");
  });
});

describe("「获取可用模型」勾选弹窗（同一套短格式）", () => {
  it("勾选项按同一格式化显示窗口与徽标，查不到的项隐藏", async () => {
    fetchMocks.fetchProviderModels.mockResolvedValueOnce({
      ok: true,
      models: ["deepseek-v4-pro", "no-such-model"]
    });
    const dialog = mountEditor({
      presetId: "deepseek",
      baseUrl: DEEPSEEK_BASE_URL,
      models: []
    });
    await flushMicrotasks();

    fireClick(dialog.querySelector(".provider-editor-fetch"));
    await waitForFast(() => {
      expect(document.querySelectorAll(".provider-editor-fetch-item")).toHaveLength(2);
    });

    const items = document.querySelectorAll<HTMLElement>(".provider-editor-fetch-item");
    expect(items[0].querySelector<HTMLElement>("[data-model-meta]")!.textContent).toBe("1M思考");
    expect(items[1].querySelector<HTMLElement>("[data-model-meta]")!.hidden).toBe(true);
  });

  it("目录模块后加载：弹窗列表不重渲也能补齐元数据（勾选态不丢）", async () => {
    deferCatalogLoad();
    fetchMocks.fetchProviderModels.mockResolvedValueOnce({
      ok: true,
      models: ["deepseek-v4-pro"]
    });
    const dialog = mountEditor({
      presetId: "deepseek",
      baseUrl: DEEPSEEK_BASE_URL,
      models: []
    });

    fireClick(dialog.querySelector(".provider-editor-fetch"));
    await waitForFast(() => {
      expect(document.querySelectorAll(".provider-editor-fetch-item")).toHaveLength(1);
    });

    const item = document.querySelector<HTMLElement>(".provider-editor-fetch-item")!;
    expect(item.querySelector<HTMLElement>("[data-model-meta]")!.hidden).toBe(true);

    const check = item.querySelector<HTMLInputElement>(".provider-editor-fetch-check")!;
    fireClick(check);
    expect(check.checked).toBe(true);

    catalogGate.resolveDeferred!(realModelCatalog);
    await flushMicrotasks();

    expect(item.querySelector<HTMLElement>("[data-model-meta]")!.textContent).toBe("1M思考");
    expect(item.querySelector<HTMLInputElement>(".provider-editor-fetch-check")!.checked).toBe(true);
  });
});
