import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { TRASH_ICON_PATHS } from "../../extension/ui/provider-row.js";

const { sendRuntimeMessageMock } = vi.hoisted(() => ({
  sendRuntimeMessageMock: vi.fn()
}));

vi.mock("../../extension/shared/messaging.js", () => ({
  sendRuntimeMessage: sendRuntimeMessageMock
}));

const AI_PRESETS = [
  { id: "openai_compat", name: "OpenAI 兼容", baseUrl: "https://api.openai.com/v1", requiresKey: true },
  { id: "ollama", name: "Ollama (本地)", baseUrl: "http://localhost:11434/v1", requiresKey: false },
  { id: "custom", name: "自定义", baseUrl: "", requiresKey: true }
];

const ASR_PRESETS = [
  {
    id: "siliconflow",
    name: "SiliconFlow 硅基流动（免费）",
    type: "openai-transcriptions",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "XingChenAGI/XingChenASR-V3.2-Ultra",
    supportsTimestamps: true
  },
  {
    id: "local-whisper",
    name: "本地 Whisper 服务",
    type: "openai-transcriptions",
    baseUrl: "http://localhost:8000/v1",
    model: "whisper-large-v3",
    supportsTimestamps: true
  },
  { id: "custom", name: "自定义", type: "openai-transcriptions", baseUrl: "", model: "", supportsTimestamps: true }
];

const TRASH_PATHS = [
  "M4 7h16",
  "M9 3h6",
  "M10 11v6",
  "M14 11v6",
  "M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"
];

function makeContainer() {
  document.body.innerHTML = '<div id="biliscript-reading-view"><section id="biliscript-reading-settings-panel"></section></div>';
  const listNode = document.createElement("div");
  const emptyNode = document.createElement("p");
  document.getElementById("biliscript-reading-view")!.append(listNode, emptyNode);
  return { listNode, emptyNode };
}

function fireClick(el: Element) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function readTrashPaths(row: Element) {
  return Array.from(row.querySelectorAll(".provider-row-remove svg path")).map((p) => p.getAttribute("d"));
}

async function flushMicrotasks() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

function confirmDelete() {
  const button = document.querySelector(".confirm-dialog-confirm");
  expect(button, "删除确认弹层应已打开").not.toBeNull();
  fireClick(button!);
}

function cancelDelete() {
  fireClick(document.querySelector(".confirm-dialog-cancel")!);
}

beforeEach(() => {
  vi.resetModules();
  resetModuleState();
  document.body.innerHTML = "";
  sendRuntimeMessageMock.mockReset();
  sendRuntimeMessageMock.mockImplementation(async () => ({ ok: true }));
});

async function createRows(onEdit: (providerId: string) => void = () => {}) {
  const { createProviderFamilyRows } = await import("../../extension/ui/provider-family.js");
  return createProviderFamilyRows({ onRowEdit: (_kind, providerId) => onEdit(providerId) });
}

describe("createProviderRow：AI 平台行（provider-family.js 的 AI 族声明，紧凑形态）", () => {
  const aiItem = { id: "p1", presetId: "openai_compat", name: "我的端点", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" };

  it("渲染紧凑行结构与空态：主行 + 模型名副行，行内零输入字段", async () => {
    const bindings = await createRows();
    const { listNode, emptyNode } = makeContainer();
    bindings.ai.render(listNode, emptyNode, [
      aiItem,
      { id: "p2", presetId: "ollama", baseUrl: "http://localhost:11434/v1", model: "llama3", hasSavedKey: true }
    ], { presets: AI_PRESETS });

    const allRows = listNode.querySelectorAll<HTMLElement>(".ai-provider-row");
    expect(allRows).toHaveLength(2);
    expect(emptyNode.hidden).toBe(true);

    const row = allRows[0];
    expect(row.dataset.providerId).toBe("p1");
    expect(row.dataset.hasSavedKey).toBe("0");
    expect(row.dataset.currentPresetId).toBe("openai_compat");
    expect(row.dataset.baseUrl).toBe("https://api.openai.com/v1");

    const line = row.querySelector(".provider-row-line")!;
    expect(line).not.toBeNull();
    expect(line.querySelector<HTMLElement>(".provider-row-dot")!.dataset.state).toBe("missing");
    expect(line.querySelector(".provider-row-name")!.textContent).toBe("我的端点");
    expect(line.querySelector("button.provider-row-edit")!.textContent).toBe("编辑");
    expect(line.querySelector("button.provider-row-remove")).not.toBeNull();

    expect(row.querySelector(".provider-row-model")).toBeNull();

    expect(row.querySelectorAll("input")).toHaveLength(0);
    expect(row.querySelectorAll("select")).toHaveLength(0);
    expect(row.querySelector(".asr-provider-active-radio")).toBeNull();
    expect(TRASH_ICON_PATHS).toContain('d="M4 7h16"');
    expect(readTrashPaths(row)).toEqual(TRASH_PATHS);

    expect(allRows[1].querySelector<HTMLElement>(".provider-row-dot")!.dataset.state).toBe("saved");
  });

  it("名称回落：无自定义名回落预设名；模型名空则不渲染副行", async () => {
    const bindings = await createRows();
    const { listNode, emptyNode } = makeContainer();
    bindings.ai.render(listNode, emptyNode, [
      { id: "p1", presetId: "openai_compat", baseUrl: "https://api.openai.com/v1" },
      { id: "p2", presetId: "ollama", baseUrl: "http://localhost:11434/v1", model: "" }
    ], { presets: AI_PRESETS });

    const allRows = listNode.querySelectorAll<HTMLElement>(".ai-provider-row");
    expect(allRows[0].querySelector(".provider-row-name")!.textContent).toBe("OpenAI 兼容");
    expect(allRows[0].querySelector(".provider-row-model")).toBeNull();

    expect(allRows[1].querySelector(".provider-row-model")).toBeNull();
  });

  it("模型名副行：models 目录多个时「首项 等 N 个」，单模型只显示模型名（拍板 Q15）", async () => {
    const bindings = await createRows();
    const { listNode, emptyNode } = makeContainer();
    bindings.ai.render(listNode, emptyNode, [
      { id: "p1", presetId: "openai_compat", name: "我的端点", baseUrl: "https://api.example.com/v1", models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-reasoner"] },
      { id: "p2", presetId: "ollama", baseUrl: "http://localhost:11434/v1", models: ["llama3"] },
      { id: "p3", presetId: "custom", name: "旧数据", baseUrl: "", model: "gpt-4o-mini" }
    ], { presets: AI_PRESETS });

    const allRows = listNode.querySelectorAll<HTMLElement>(".ai-provider-row");
    expect(allRows[0].querySelector(".provider-row-model")).toBeNull();
    expect(allRows[1].querySelector(".provider-row-model")).toBeNull();
    expect(allRows[2].querySelector(".provider-row-model")).toBeNull();
  });

  it("渲染空列表时显示空态", async () => {
    const bindings = await createRows();
    const { listNode, emptyNode } = makeContainer();
    bindings.ai.render(listNode, emptyNode, [], { presets: AI_PRESETS });
    expect(listNode.children).toHaveLength(0);
    expect(emptyNode.hidden).toBe(false);
  });

  it("「编辑」按钮：onRowEdit（工厂 deps 注入）转发行 providerId", async () => {
    const onEdit = vi.fn();
    const bindings = await createRows(onEdit);
    const { listNode } = makeContainer();
    bindings.ai.render(listNode, document.createElement("p"), [aiItem], { presets: AI_PRESETS });

    const row = listNode.querySelector(".ai-provider-row")!;
    fireClick(row.querySelector(".provider-row-edit")!);
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith("p1");
  });

  it("删除：确认后先同步触发 onBeforeDelete（带行 dataset 的 baseUrl）再走后台删除；取消确认不触发", async () => {
    const bindings = await createRows();
    const { listNode, emptyNode } = makeContainer();
    const onBeforeDelete = vi.fn(async () => {});
    bindings.ai.controller.setBeforeDeleteHandler(onBeforeDelete);
    bindings.ai.render(listNode, emptyNode, [aiItem], { presets: AI_PRESETS });
    const row = listNode.querySelector(".ai-provider-row")!;

    fireClick(row.querySelector(".provider-row-remove")!);
    cancelDelete();
    await flushMicrotasks();
    expect(onBeforeDelete).not.toHaveBeenCalled();
    expect(sendRuntimeMessageMock).not.toHaveBeenCalled();

    fireClick(row.querySelector(".provider-row-remove")!);
    confirmDelete();
    await flushMicrotasks();
    expect(onBeforeDelete).toHaveBeenCalledTimes(1);
    expect(onBeforeDelete).toHaveBeenCalledWith("p1", "https://api.openai.com/v1");
    expect(sendRuntimeMessageMock).toHaveBeenCalledWith({ type: "ai-providers-delete", providerId: "p1" });
    expect(listNode.querySelectorAll(".ai-provider-row")).toHaveLength(0);
    expect(emptyNode.hidden).toBe(false);
  });

  it("删除：onBeforeDelete 抛错不阻断删除，并通过 logWarn 留痕", async () => {
    const { registerDebugGate } = await import("../../extension/shared/logging.js");
    registerDebugGate(() => true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const bindings = await createRows();
      const { listNode, emptyNode } = makeContainer();
      const hookError = new Error("permissions API unavailable");
      bindings.ai.controller.setBeforeDeleteHandler(vi.fn(async () => {
        throw hookError;
      }));
      bindings.ai.render(listNode, emptyNode, [aiItem], { presets: AI_PRESETS });
      const row = listNode.querySelector(".ai-provider-row")!;

      fireClick(row.querySelector(".provider-row-remove")!);
      confirmDelete();
      await flushMicrotasks();
      expect(warnSpy).toHaveBeenCalledWith("[BILISCRIPT] onBeforeDelete hook failed", hookError);
      expect(sendRuntimeMessageMock).toHaveBeenCalledWith({ type: "ai-providers-delete", providerId: "p1" });
      expect(listNode.querySelectorAll(".ai-provider-row")).toHaveLength(0);
      expect(emptyNode.hidden).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("createProviderRow：ASR 平台行（provider-family.js 的 ASR 族声明，紧凑形态）", () => {
  const asrItem = {
    id: "asr1",
    presetId: "siliconflow",
    name: "我的 ASR",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "XingChenAGI/XingChenASR-V3.2-Ultra"
  };

  it("渲染紧凑行：名称 + 模型名副行（缺省回落预设 model）+ 选用 radio", async () => {
    const bindings = await createRows();
    const { listNode, emptyNode } = makeContainer();
    bindings.asr.render(listNode, emptyNode, [asrItem, { id: "asr2", presetId: "local-whisper", hasSavedKey: true }], { presets: ASR_PRESETS, activeId: "asr2" });

    const allRows = listNode.querySelectorAll<HTMLElement>(".asr-provider-row");
    expect(allRows).toHaveLength(2);
    expect(emptyNode.hidden).toBe(true);

    const row = allRows[0];
    expect(row.dataset.currentPresetId).toBe("siliconflow");
    expect(row.dataset.baseUrl).toBe("https://api.siliconflow.cn/v1");
    expect(row.querySelector(".provider-row-name")!.textContent).toBe("我的 ASR");
    expect(row.querySelector(".provider-row-model")!.textContent).toBe("XingChenAGI/XingChenASR-V3.2-Ultra");
    expect(allRows[1].querySelector(".provider-row-name")!.textContent).toBe("本地 Whisper 服务");
    expect(allRows[1].querySelector(".provider-row-model")!.textContent).toBe("whisper-large-v3");
    const radios = listNode.querySelectorAll<HTMLInputElement>(".asr-provider-active-radio");
    expect(radios[0].checked).toBe(false);
    expect(radios[1].checked).toBe(true);
    expect(radios[0].closest("label")!.title).toBe("选用该平台自动生成字幕");
    expect(allRows[0].querySelector<HTMLElement>(".provider-row-dot")!.dataset.state).toBe("missing");
    expect(allRows[1].querySelector<HTMLElement>(".provider-row-dot")!.dataset.state).toBe("saved");
    expect(row.querySelector("button.provider-row-remove")).not.toBeNull();
    expect(row.querySelector(".ai-provider-remove")).toBeNull();
    expect(readTrashPaths(row)).toEqual(TRASH_PATHS);
  });

  it("选用 radio：change 时持久化 activeAsrProviderId 并同步选中态", async () => {
    const bindings = await createRows();
    const { listNode, emptyNode } = makeContainer();
    bindings.asr.render(listNode, emptyNode, [asrItem, { id: "asr2", presetId: "local-whisper" }], { presets: ASR_PRESETS });

    const radios = listNode.querySelectorAll<HTMLInputElement>(".asr-provider-active-radio");
    radios[1].checked = true;
    radios[1].dispatchEvent(new Event("change"));
    await flushMicrotasks();

    expect(sendRuntimeMessageMock).toHaveBeenCalledWith({ type: "save-settings", settings: { activeAsrProviderId: "asr2" } });
    expect(radios[0].checked).toBe(false);
    expect(radios[1].checked).toBe(true);
    expect(bindings.asr.getActiveId!(listNode)).toBe("asr2");
  });

  it("删除：后台消息后触发注入的 onDelete（删选用平台时清 activeAsrProviderId 的钩子），并恢复空态", async () => {
    const bindings = await createRows();
    const { listNode, emptyNode } = makeContainer();
    const onDelete = vi.fn(async () => {});
    bindings.asr.controller.setDeleteHandler(onDelete);
    const onBeforeDelete = vi.fn(async () => {});
    bindings.asr.controller.setBeforeDeleteHandler(onBeforeDelete);
    bindings.asr.render(listNode, emptyNode, [asrItem], { presets: ASR_PRESETS });
    const row = listNode.querySelector(".asr-provider-row")!;

    fireClick(row.querySelector(".provider-row-remove")!);
    confirmDelete();
    await flushMicrotasks();
    expect(onBeforeDelete).toHaveBeenCalledWith("asr1", "https://api.siliconflow.cn/v1");
    expect(sendRuntimeMessageMock).toHaveBeenCalledWith({ type: "asr-providers-delete", providerId: "asr1" });
    expect(onDelete).toHaveBeenCalledWith("asr1");
    expect(listNode.querySelectorAll(".asr-provider-row")).toHaveLength(0);
    expect(emptyNode.hidden).toBe(false);
  });

  it("「编辑」按钮：onRowEdit（工厂 deps 注入）转发行 providerId", async () => {
    const onEdit = vi.fn();
    const bindings = await createRows(onEdit);
    const { listNode } = makeContainer();
    bindings.asr.render(listNode, document.createElement("p"), [asrItem], { presets: ASR_PRESETS });

    fireClick(listNode.querySelector(".asr-provider-row .provider-row-edit")!);
    expect(onEdit).toHaveBeenCalledWith("asr1");
  });
});

describe("拖拽把手只搜索族渲染（spec §6.10 / §10 第 81 行）", () => {
  it("AI / ASR 行内 .provider-row-drag-handle 零命中，行尾仍是删除按钮", async () => {
    const bindings = await createRows();
    const ai = makeContainer();
    const asr = makeContainer();
    bindings.ai.render(ai.listNode, ai.emptyNode, [{ id: "p1", presetId: "openai_compat", name: "我的端点", baseUrl: "https://api.openai.com/v1" }], {
      presets: AI_PRESETS
    });
    bindings.asr.render(asr.listNode, asr.emptyNode, [{ id: "asr1", presetId: "siliconflow", name: "我的 ASR" }], {
      presets: ASR_PRESETS
    });

    [ai.listNode, asr.listNode].forEach((listNode) => {
      expect(listNode.querySelectorAll(".provider-row-drag-handle")).toHaveLength(0);
    });
    [
      [ai.listNode, ".ai-provider-row"],
      [asr.listNode, ".asr-provider-row"]
    ].forEach(([listNode, selector]) => {
      const line = (listNode as HTMLElement).querySelector<HTMLElement>(`${selector} .provider-row-line`)!;
      expect(line.lastElementChild!.classList.contains("provider-row-remove")).toBe(true);
    });
  });
});
