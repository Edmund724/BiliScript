// tests/ui/model-catalog-meta.test.ts
// 平台编辑 Modal 的只读模型元数据（model-catalog/04）：
// - 短格式（1000000→"1M" / 524288→"524K"）与徽标条件（思考 / 图片）；
// - 查不到整栏静默隐藏（无占位符、无 title）；
// - 只跟着 (presetId, baseUrl) + 模型 id 重算（含输入事件接线）；
// - 「获取可用模型」勾选弹窗同一套短格式；
// - 目录模块懒加载：加载前不渲染，加载完成后补齐（不清掉勾选态）。
//
// 手法：不经整套设置面板，直接搭最小 Modal DOM + 状态袋 + 真实 wireDialog，
// 目录模块用真实产物（85KB 解析，vitest 无压力）——格式化与查表都是真链路。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetModuleState } from "../setup.js";

const MIMO_BASE_URL = "https://api.xiaomimimo.com/v1";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";

// 结构子集（ProviderRowPreset）：Modal 只读 id/name/baseUrl/requiresKey
const PRESET_SUBSET = [
  { id: "custom", name: "自定义", baseUrl: "" },
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
  const { state } = await import("../../extension/ui/provider-editor-state.js");
  state.host = document.querySelector<HTMLElement>(".provider-editor-host")!;
  state.open = true;
  state.kind = "ai";
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
  const { state } = await import("../../extension/ui/provider-editor-state.js");
  state.host = null;
  state.open = false;
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
    // 非法值不产出假文案（调用方据此省略这一段）
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
    expect(lazy.loadedModelCatalog()).toBeNull(); // 加载前：没有可渲染的数据
    expect(metaSlot(dialog, 0).hidden).toBe(true);

    await lazy.loadModelCatalog();
    catalog.refreshModelCatalogMeta();

    const slot = metaSlot(dialog, 0);
    expect(slot.hidden).toBe(false);
    expect(slot.textContent).toBe("1M思考图片");
    expect(slot.querySelectorAll(".provider-editor-model-badge")).toHaveLength(2);
    expect(slot.title).toContain("MiMo-V2.5");
    expect(slot.title).toContain("输出上限 131K");
    expect(slot.title).toContain("目录 @earendil-works/pi-ai 0.85.1");
  });

  it("只文本的模型不挂「图片」徽标", async () => {
    const { dialog, catalog } = await mountDialog({
      presetId: "deepseek",
      baseUrl: DEEPSEEK_BASE_URL,
      models: ["deepseek-v4-flash"]
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

  it("无数据平台（qwen）整栏不渲染", async () => {
    const { dialog, catalog } = await mountDialog({
      presetId: "qwen",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      models: ["qwen3.8-max"]
    });
    await (await import("../../extension/ui/lazy-model-catalog.js")).loadModelCatalog();
    catalog.refreshModelCatalogMeta();
    expect(metaSlot(dialog, 0).hidden).toBe(true);
  });

  it("只跟着平台身份与模型 id 走：改 baseUrl / 模型 id / 预设都重算", async () => {
    const { dialog, catalog, state } = await mountDialog({
      presetId: "custom",
      baseUrl: "",
      models: ["mimo-v2.5"]
    });
    const { wireDialog } = await import("../../extension/ui/provider-editor-modal.js");
    wireDialog({ kind: "ai", presets: PRESET_SUBSET, onSave: async () => ({ ok: true }) });
    await (await import("../../extension/ui/lazy-model-catalog.js")).loadModelCatalog();
    catalog.refreshModelCatalogMeta();
    expect(metaSlot(dialog, 0).hidden).toBe(true); // 无身份来源：查不到

    // 改 API 地址（custom 的身份来源）→ 输入事件即重算
    const baseUrl = dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!;
    baseUrl.value = MIMO_BASE_URL;
    fireInput(baseUrl);
    expect(metaSlot(dialog, 0).textContent).toBe("1M思考图片");

    // 改模型 id → 委托在目录列表上的 input 事件重算
    const input = modelInput(dialog, 0);
    input.value = "no-such-model";
    fireInput(input);
    expect(metaSlot(dialog, 0).hidden).toBe(true);

    // 改回已知 id，再切预设（presetId 优先于 host）：qwen 无目录数据 → 整栏隐藏
    input.value = "mimo-v2.5";
    fireInput(input);
    expect(metaSlot(dialog, 0).hidden).toBe(false);
    const presetSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!;
    presetSelect.value = "qwen";
    presetSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(metaSlot(dialog, 0).hidden).toBe(true);

    // 关 Modal 后过期回执不再写 DOM
    state.generation += 1;
    state.open = false;
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
});

describe("「获取可用模型」勾选弹窗（spec §展示：同一套短格式）", () => {
  it("勾选项按同一格式化显示窗口与徽标，查不到的项隐藏", async () => {
    await mountDialog({ presetId: "deepseek", baseUrl: DEEPSEEK_BASE_URL, models: [] });
    await (await import("../../extension/ui/lazy-model-catalog.js")).loadModelCatalog();
    const { renderFetchSkeleton, renderFetchList } = await import(
      "../../extension/ui/provider-editor-fetch-dialog.js"
    );
    renderFetchSkeleton();
    renderFetchList(["deepseek-v4-flash", "no-such-model"]);

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
    renderFetchList(["deepseek-v4-flash"]); // 加载前：留空
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
