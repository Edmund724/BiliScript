import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UPSTREAM_CATALOG_SOURCE } from "../../extension/ai/catalog/models-dev-catalog.generated.js";
import { resetModuleState } from "../setup.js";

const MIMO_BASE_URL = "https://api.xiaomimimo.com/v1";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";

const PRESET_SUBSET = [
  { id: "custom", name: "自定义", baseUrl: "" },
  { id: "ollama", name: "Ollama (本地)", baseUrl: "http://localhost:11434/v1" },
  { id: "deepseek", name: "DeepSeek", baseUrl: DEEPSEEK_BASE_URL },
  { id: "qwen", name: "Qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" }
];

async function mountDialog(options: { presetId: string; baseUrl: string; models: string[] }) {
  document.body.innerHTML = `
    <div id="biliscript-reading-view">
      <div class="provider-editor-host">
        <section class="provider-editor-dialog">
          <select class="provider-editor-preset">
            ${PRESET_SUBSET.map(
              (preset) =>
                `<option value="${preset.id}" ${preset.id === options.presetId ? "selected" : ""}>${preset.name}</option>`
            ).join("")}
          </select>
          <input class="provider-editor-baseurl" type="text" value="${options.baseUrl}" />
          <div class="provider-editor-model-list"></div>
        </section>
      </div>
    </div>`;
  const { beginEditorSession } = await import("../../extension/ui/provider-editor-state.js");
  beginEditorSession({
    kind: "ai",
    host: document.querySelector<HTMLElement>(".provider-editor-host")!,
    presets: PRESET_SUBSET,
    draft: {
      presetId: options.presetId,
      name: "",
      baseUrl: options.baseUrl,
      apiKey: "",
      protocol: "openai",
      models: [],
      model: ""
    }
  });
  const state = await import("../../extension/ui/provider-editor-state.js");
  const catalog = await import("../../extension/ui/provider-editor-catalog.js");
  for (const model of options.models) {
    catalog.addModelRow(model);
  }
  const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
  return { state, catalog, dialog };
}

function hostElement(): HTMLElement {
  return document.querySelector<HTMLElement>(".provider-editor-host")!;
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

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
});

afterEach(async () => {
  const { endEditorSession } = await import("../../extension/ui/provider-editor-state.js");
  endEditorSession();
});

describe("元数据短格式（spec §展示）", () => {
  it("≥10⁶ 用 M，否则十进制取整到 K", async () => {
    const { formatContextWindow } = await import("../../extension/ui/provider-editor-catalog.js");
    expect(formatContextWindow(1_000_000)).toBe("1M");
    expect(formatContextWindow(524_288)).toBe("524K");
    expect(formatContextWindow(128_000)).toBe("128K");
    expect(formatContextWindow(384_000)).toBe("384K");
    expect(formatContextWindow(8_192)).toBe("8K");
    expect(formatContextWindow(1_500_000)).toBe("1.5M");
    expect(formatContextWindow(0)).toBe("");
    expect(formatContextWindow(Number.NaN)).toBe("");
  });
});

describe("模型行元数据", () => {
  it("命中：窗口 + 能力徽标；title 带输出上限与数据版本", async () => {
    const { dialog, catalog } = await mountDialog({
      presetId: "custom",
      baseUrl: MIMO_BASE_URL,
      models: ["mimo-v2.5"]
    });
    const lazy = await import("../../extension/ui/lazy-model-catalog.js");
    expect(lazy.loadedModelCatalog()).toBeNull();
    expect(metaSlot(dialog, 0).hidden).toBe(true);

    await lazy.loadModelCatalog();
    catalog.refreshModelCatalogMeta();

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
    const { dialog, catalog } = await mountDialog({
      presetId: "deepseek",
      baseUrl: DEEPSEEK_BASE_URL,
      models: ["deepseek-v4-pro"]
    });
    await (await import("../../extension/ui/lazy-model-catalog.js")).loadModelCatalog();
    catalog.refreshModelCatalogMeta();
    const slot = metaSlot(dialog, 0);
    expect(slot.textContent).toBe("1M思考");
    expect(slot.title).toContain("仅文本输入");
  });

  it("查不到整栏静默隐藏：不占位、无 title、无徽标", async () => {
    const { dialog, catalog } = await mountDialog({
      presetId: "deepseek",
      baseUrl: DEEPSEEK_BASE_URL,
      models: ["no-such-model"]
    });
    await (await import("../../extension/ui/lazy-model-catalog.js")).loadModelCatalog();
    catalog.refreshModelCatalogMeta();
    const slot = metaSlot(dialog, 0);
    expect(slot.hidden).toBe(true);
    expect(slot.textContent).toBe("");
    expect(slot.hasAttribute("title")).toBe(false);
  });

  it("无数据平台（ollama）整栏不渲染", async () => {
    const { dialog, catalog } = await mountDialog({
      presetId: "ollama",
      baseUrl: "http://localhost:11434/v1",
      models: ["qwen3.8-max"]
    });
    await (await import("../../extension/ui/lazy-model-catalog.js")).loadModelCatalog();
    catalog.refreshModelCatalogMeta();
    expect(metaSlot(dialog, 0).hidden).toBe(true);
  });

  it("原无数据平台（qwen）改源后命中：窗口 + 思考 + 图片徽标（10 号票白名单收缩）", async () => {
    const { dialog, catalog } = await mountDialog({
      presetId: "qwen",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      models: ["qwen3.8-max"]
    });
    await (await import("../../extension/ui/lazy-model-catalog.js")).loadModelCatalog();
    catalog.refreshModelCatalogMeta();
    const slot = metaSlot(dialog, 0);
    expect(slot.hidden).toBe(false);
    expect(slot.textContent).toBe("1M思考图片");
  });

  it("只跟着平台身份与模型 id 走：改 baseUrl / 模型 id / 预设都重算", async () => {
    const { dialog, catalog, state } = await mountDialog({
      presetId: "custom",
      baseUrl: "",
      models: ["mimo-v2.5"]
    });
    const { wireDialog } = await import("../../extension/ui/provider-editor-modal.js");
    wireDialog();
    await (await import("../../extension/ui/lazy-model-catalog.js")).loadModelCatalog();
    catalog.refreshModelCatalogMeta();
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

    state.endEditorSession();
    catalog.refreshModelCatalogMeta();
    expect(metaSlot(dialog, 0).hidden).toBe(true);
  });

  it("新加的行也带上元数据（草稿行增删路径）", async () => {
    const { dialog, catalog } = await mountDialog({
      presetId: "deepseek",
      baseUrl: DEEPSEEK_BASE_URL,
      models: []
    });
    await (await import("../../extension/ui/lazy-model-catalog.js")).loadModelCatalog();
    catalog.addModelRow("deepseek-v4-pro");
    expect(metaSlot(dialog, 0).textContent).toBe("1M思考");
  });

  it("仅以 session draft 为真源：跳过未同步到 draft 的裸 DOM 修改，且默认以 draft 克隆建立基线", async () => {
    const { dialog, catalog, state } = await mountDialog({
      presetId: "custom",
      baseUrl: "",
      models: ["mimo-v2.5"]
    });
    expect(state.state.baselineDraft).toEqual({
      presetId: "custom",
      name: "",
      baseUrl: "",
      apiKey: "",
      protocol: "openai",
      models: [],
      model: ""
    });

    await (await import("../../extension/ui/lazy-model-catalog.js")).loadModelCatalog();
    dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!.value = "deepseek";
    dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!.value = MIMO_BASE_URL;
    catalog.refreshModelCatalogMeta();
    expect(metaSlot(dialog, 0).hidden).toBe(true);

    state.editDraft((draft) => {
      draft.baseUrl = MIMO_BASE_URL;
    });
    catalog.refreshModelCatalogMeta();
    expect(metaSlot(dialog, 0).hidden).toBe(false);
    expect(metaSlot(dialog, 0).textContent).toBe("1M思考图片");
  });
});

describe("「获取可用模型」勾选弹窗（spec §展示：同一套短格式）", () => {
  it("勾选项按同一格式化显示窗口与徽标，查不到的项隐藏", async () => {
    await mountDialog({ presetId: "deepseek", baseUrl: DEEPSEEK_BASE_URL, models: [] });
    await (await import("../../extension/ui/lazy-model-catalog.js")).loadModelCatalog();
    const { renderFetchSkeleton, renderFetchList } = await import(
      "../../extension/ui/provider-editor-fetch-dialog.js"
    );
    renderFetchSkeleton();
    renderFetchList(["deepseek-v4-pro", "no-such-model"]);

    const items = hostElement().querySelectorAll<HTMLElement>(".provider-editor-fetch-item");
    expect(items).toHaveLength(2);
    expect(items[0].querySelector<HTMLElement>("[data-model-meta]")!.textContent).toBe("1M思考");
    expect(items[1].querySelector<HTMLElement>("[data-model-meta]")!.hidden).toBe(true);
  });

  it("目录模块后加载：弹窗列表不重渲也能补齐元数据（勾选态不丢）", async () => {
    await mountDialog({ presetId: "deepseek", baseUrl: DEEPSEEK_BASE_URL, models: [] });
    const { renderFetchSkeleton, renderFetchList } = await import(
      "../../extension/ui/provider-editor-fetch-dialog.js"
    );
    renderFetchSkeleton();
    renderFetchList(["deepseek-v4-pro"]);
    const item = hostElement().querySelector<HTMLElement>(".provider-editor-fetch-item")!;
    expect(item.querySelector<HTMLElement>("[data-model-meta]")!.hidden).toBe(true);

    const check = item.querySelector<HTMLInputElement>(".provider-editor-fetch-check")!;
    check.checked = true;
    const { primeModelCatalogMeta } = await import("../../extension/ui/provider-editor-catalog.js");
    await primeModelCatalogMeta();
    expect(item.querySelector<HTMLElement>("[data-model-meta]")!.textContent).toBe("1M思考");
    expect(item.querySelector<HTMLInputElement>(".provider-editor-fetch-check")!.checked).toBe(true);
  });
});
