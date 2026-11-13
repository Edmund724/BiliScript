// 伴看 Gemini Live 凭据同层往返（票 provider-onboarding-consistency/07）：
// - 伴看 Gemini 编辑器内联凭据行区分四态（无记录 / 缺 Key / 非官方地址 / 可用）
//   并给对应动作；可用态只读无按钮；
// - 动作同层切到 AI 族编辑器（复用同一宿主，不增加可见 Modal 层）：缺 Key 编辑
//   实际引用记录并聚焦 Key，无记录 / 非官方地址新建独立官方记录（不改写中转）；
// - 保存成功或取消都会话结束后恢复原伴看草稿（未保存改动与 dirty 基线都在），
//   保存成功提示仍需显式保存伴看记录；Esc / 外点的 dirty 拦截走既有 confirmDialog；
// - 抽屉收起的强制关闭路径不恢复（草稿随既有规则丢弃）；
// - 存储边界：Key 只随 ai-providers-save 落 AI 族，伴看保存载荷不含 Key。
//
// 手法：真实 settings-panel + provider-editor，消息走 installSettingsPanelBus 总线
// （同 tests/ui/settings-panel-gemini-live.test.ts）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installSettingsPanelBus, type BusMessage, type BusResponder } from "../helpers/settings-panel-bus.js";

const GEMINI_LIVE = {
  id: "live_gemini",
  presetId: "gemini-live",
  name: "Gemini Live",
  type: "gemini-live",
  baseUrl: "https://generativelanguage.googleapis.com",
  model: "gemini-3.8-live",
  enabled: true,
  hasSavedKey: false
};

const OFFICIAL_AI = {
  id: "p_gemini",
  presetId: "gemini",
  name: "Gemini",
  type: "gemini",
  protocol: "gemini",
  baseUrl: "https://generativelanguage.googleapis.com",
  models: ["gemini-3.8-live"],
  enabled: true,
  hasSavedKey: true
};

function click(node: Element | null): void {
  node!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function input(node: HTMLInputElement, value: string): void {
  node.value = value;
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

function pressEsc(): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".provider-editor-dialog");
}

function linkedRow(): HTMLElement | null {
  return dialog()?.querySelector<HTMLElement>(".provider-editor-linked-credential") ?? null;
}

async function mountPanel(overrides: Record<string, BusResponder<BusMessage>> = {}) {
  document.body.innerHTML = `
    <div id="biliscript-reading-view">
      <section id="biliscript-reading-settings-panel">
        <div id="biliscript-reading-settings-host"></div>
      </section>
    </div>`;
  const bus = installSettingsPanelBus<BusMessage>({
    "live-providers-list": () => ({ ok: true, providers: [GEMINI_LIVE] }),
    "request-provider-origins": () => ({ ok: true }),
    ...overrides
  });
  const panel = await import("../../extension/ui/settings-panel.js");
  panel.renderReaderSettingsPanel();
  const host = document.getElementById("biliscript-reading-settings-host")!;
  await vi.waitFor(() => {
    expect(host.querySelector("#liveProvidersList .live-provider-row")).toBeTruthy();
  });
  return { host, sent: bus.sent };
}

// 打开伴看 Gemini 行编辑器（内联凭据行的宿主）
async function openLiveGeminiEditor(host: HTMLElement): Promise<HTMLElement> {
  click(host.querySelector("#liveProvidersList .provider-row-edit"));
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
  return dialog()!;
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
});

afterEach(async () => {
  // 强制关闭前先收起抽屉：往返恢复路径（onSessionEnd → 恢复伴看草稿）在抽屉
  // 隐藏时让位，避免 afterEach 里又重开编辑器、把文档级监听泄漏到下一个用例
  const panel = document.getElementById("biliscript-reading-settings-panel");
  if (panel) panel.hidden = true;
  const { closeProviderEditor } = await import("../../extension/ui/provider-editor.js");
  closeProviderEditor(true);
});

describe("伴看 Gemini 编辑器内联凭据四态", () => {
  it("无记录：状态文案 + 「配置官方 Gemini Key」动作", async () => {
    const { host } = await mountPanel({ "ai-providers-list": () => ({ ok: true, providers: [] }) });
    const editor = await openLiveGeminiEditor(host);
    const row = editor.querySelector<HTMLElement>(".provider-editor-linked-credential")!;
    expect(row.querySelector(".provider-editor-linked-credential-text")!.textContent)
      .toBe("尚未配置官方 Gemini AI Key");
    expect(row.querySelector<HTMLButtonElement>(".provider-editor-linked-credential-btn")!.textContent)
      .toBe("配置官方 Gemini Key");
  });

  it("缺 Key：状态文案 + 「填写 AI Key」动作", async () => {
    const missingKey = { ...OFFICIAL_AI, hasSavedKey: false };
    const { host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [missingKey] }),
      "get-ai-provider-key": () => ({ ok: true, apiKey: "" })
    });
    const editor = await openLiveGeminiEditor(host);
    const row = editor.querySelector<HTMLElement>(".provider-editor-linked-credential")!;
    expect(row.querySelector(".provider-editor-linked-credential-text")!.textContent)
      .toBe("官方 Gemini AI Key 缺失或引用已失效");
    expect(row.querySelector<HTMLButtonElement>(".provider-editor-linked-credential-btn")!.textContent)
      .toBe("填写 AI Key");
  });

  it("非官方地址：状态文案 + 「新建独立官方记录」动作", async () => {
    const relay = { ...OFFICIAL_AI, id: "p_gemini_relay", name: "Gemini 中转", baseUrl: "https://relay.example.com" };
    const { host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [relay] }),
      "get-ai-provider-key": () => ({ ok: true, apiKey: "" })
    });
    const editor = await openLiveGeminiEditor(host);
    const row = editor.querySelector<HTMLElement>(".provider-editor-linked-credential")!;
    expect(row.querySelector(".provider-editor-linked-credential-text")!.textContent)
      .toBe("AI 平台配置的并非 Gemini 官方接口地址");
    expect(row.querySelector<HTMLButtonElement>(".provider-editor-linked-credential-btn")!.textContent)
      .toBe("新建独立官方记录");
  });

  it("可用：只读状态文案，无动作按钮", async () => {
    const { host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [OFFICIAL_AI] }),
      "get-ai-provider-key": () => ({ ok: true, apiKey: "AIza-live" })
    });
    const editor = await openLiveGeminiEditor(host);
    const row = editor.querySelector<HTMLElement>(".provider-editor-linked-credential")!;
    expect(row.querySelector(".provider-editor-linked-credential-text")!.textContent)
      .toBe("已复用 AI 平台 Key");
    expect(row.querySelector(".provider-editor-linked-credential-btn")).toBeNull();
  });
});

describe("凭据动作同层进入 AI 族编辑器", () => {
  it("无记录：打开预置官方 Gemini 的 AI 编辑器，保存/取消钮明示返回伴看", async () => {
    const { host } = await mountPanel({ "ai-providers-list": () => ({ ok: true, providers: [] }) });
    const editor = await openLiveGeminiEditor(host);
    click(editor.querySelector(".provider-editor-linked-credential-btn"));

    await vi.waitFor(() => {
      expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("添加AI 平台");
    });
    const aiDialog = dialog()!;
    expect(aiDialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!.value).toBe("gemini");
    expect(aiDialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!.value)
      .toBe("https://generativelanguage.googleapis.com");
    expect(aiDialog.querySelector<HTMLButtonElement>(".provider-editor-save")!.textContent)
      .toBe("保存并返回伴看平台");
    expect(aiDialog.querySelector<HTMLButtonElement>(".provider-editor-cancel")!.textContent)
      .toBe("返回伴看平台");
  });

  it("缺 Key：编辑实际引用的 AI 记录并聚焦 Key", async () => {
    const missingKey = { ...OFFICIAL_AI, hasSavedKey: false };
    const { host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [missingKey] }),
      "get-ai-provider-key": () => ({ ok: true, apiKey: "" })
    });
    const editor = await openLiveGeminiEditor(host);
    click(editor.querySelector(".provider-editor-linked-credential-btn"));

    await vi.waitFor(() => {
      expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("编辑AI 平台");
    });
    const aiDialog = dialog()!;
    // AI 名称 = 预设名时留空 + 占位（拍板 Q7 语义）：编辑目标指向实际引用记录
    // （标题「编辑」+ 地址预填引用值）
    expect(aiDialog.querySelector<HTMLInputElement>(".provider-editor-name")!.placeholder).toBe("Gemini");
    expect(aiDialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!.value)
      .toBe("https://generativelanguage.googleapis.com");
    expect(document.activeElement).toBe(aiDialog.querySelector(".provider-editor-apikey"));
  });

  it("非官方地址：新建独立官方记录，不打开中转记录也不改写它", async () => {
    const relay = { ...OFFICIAL_AI, id: "p_gemini_relay", name: "Gemini 中转", baseUrl: "https://relay.example.com" };
    const { host, sent } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [relay] }),
      "get-ai-provider-key": () => ({ ok: true, apiKey: "" })
    });
    const editor = await openLiveGeminiEditor(host);
    click(editor.querySelector(".provider-editor-linked-credential-btn"));

    await vi.waitFor(() => {
      expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("添加AI 平台");
    });
    const aiDialog = dialog()!;
    expect(aiDialog.querySelector<HTMLInputElement>(".provider-editor-name")!.placeholder).toBe("Gemini");
    expect(aiDialog.querySelector<HTMLInputElement>(".provider-editor-name")!.value).toBe("");
    expect(aiDialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!.value)
      .toBe("https://generativelanguage.googleapis.com");
    // 往返全程不触碰中转记录（无编辑落盘）
    expect(sent.some((message) => message.type === "ai-providers-save")).toBe(false);
  });
});

describe("往返：恢复伴看草稿与保存提示", () => {
  it("取消后恢复原伴看草稿（未保存改动与 dirty 基线都在）", async () => {
    const { host } = await mountPanel({ "ai-providers-list": () => ({ ok: true, providers: [] }) });
    const editor = await openLiveGeminiEditor(host);
    // 伴看草稿留一个未保存改动（dirty）
    input(editor.querySelector<HTMLInputElement>(".provider-editor-model")!, "gemini-3.9-live");
    click(editor.querySelector(".provider-editor-linked-credential-btn"));

    await vi.waitFor(() => expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("添加AI 平台"));
    click(dialog()!.querySelector<HTMLButtonElement>(".provider-editor-cancel"));

    // 取消后伴看编辑器按原草稿恢复：未保存改动还在，dirty 基线保留
    await vi.waitFor(() => {
      expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("编辑实时伴看平台");
    });
    const restored = dialog()!;
    expect(restored.querySelector<HTMLInputElement>(".provider-editor-model")!.value).toBe("gemini-3.9-live");
    // dirty 仍在：Esc 触发逐层退出的确认框（既有 confirmDialog 规则）
    pressEsc();
    await vi.waitFor(() => expect(document.querySelector(".confirm-dialog")).not.toBeNull());
    expect(host.querySelector("#biliscriptSettingsStatus")!.textContent).not.toContain("请继续保存伴看平台记录");
  });

  it("保存成功后恢复草稿、刷新行状态并提示仍需显式保存伴看记录；Key 只落 AI 族", async () => {
    let aiProviders: Record<string, unknown>[] = [];
    const savedAi = { ...OFFICIAL_AI, id: "p_gemini_new" };
    const { host, sent } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: aiProviders }),
      "ai-providers-save": (_message) => {
        aiProviders = [savedAi];
        return { ok: true, providers: aiProviders };
      },
      "get-ai-provider-key": () => ({ ok: true, apiKey: "AIza-roundtrip" })
    });
    expect(host.querySelector("#liveProvidersList .provider-row-model")!.textContent)
      .toContain("尚未配置官方 Gemini AI Key");

    const editor = await openLiveGeminiEditor(host);
    input(editor.querySelector<HTMLInputElement>(".provider-editor-model")!, "gemini-3.9-live");
    click(editor.querySelector(".provider-editor-linked-credential-btn"));

    await vi.waitFor(() => expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("添加AI 平台"));
    input(dialog()!.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "AIza-roundtrip");
    click(dialog()!.querySelector<HTMLButtonElement>(".provider-editor-save"));

    // 保存成功后：伴看草稿恢复 + 状态行提示仍需显式保存伴看记录 + 行状态刷新
    await vi.waitFor(() => {
      expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("编辑实时伴看平台");
    });
    const restored = dialog()!;
    expect(restored.querySelector<HTMLInputElement>(".provider-editor-model")!.value).toBe("gemini-3.9-live");
    await vi.waitFor(() => {
      expect(host.querySelector("#biliscriptSettingsStatus")!.textContent).toContain("请继续保存伴看平台记录");
    });
    await vi.waitFor(() => {
      expect(host.querySelector("#liveProvidersList .provider-row-model")!.textContent)
        .toContain("已复用 AI 平台 Key");
    });

    // 存储边界：Key 只随 AI 族落盘；伴看编辑器自身保存的载荷不含 Key
    const aiSave = sent.find((message) => message.type === "ai-providers-save") as {
      providers?: Array<{ apiKey?: string; presetId?: string }>;
    };
    expect(aiSave?.providers?.[0]?.apiKey).toBe("AIza-roundtrip");
    expect(aiSave?.providers?.[0]?.presetId).toBe("gemini");

    click(restored.querySelector<HTMLButtonElement>(".provider-editor-save"));
    await vi.waitFor(() => expect(sent.some((message) => message.type === "live-providers-save")).toBe(true));
    const liveSave = sent.find((message) => message.type === "live-providers-save") as {
      providers?: Array<{ apiKey?: string; hasSavedKey?: boolean; model?: string }>;
    };
    expect(liveSave?.providers?.[0]?.apiKey ?? "").toBe("");
    expect(liveSave?.providers?.[0]?.hasSavedKey).toBe(false);
    expect(liveSave?.providers?.[0]?.model).toBe("gemini-3.9-live");
  });

  it("AI 编辑器的未保存修改被 Esc 拦截：确认放弃后关闭并恢复伴看草稿", async () => {
    const { host } = await mountPanel({ "ai-providers-list": () => ({ ok: true, providers: [] }) });
    const editor = await openLiveGeminiEditor(host);
    input(editor.querySelector<HTMLInputElement>(".provider-editor-model")!, "gemini-3.9-live");
    click(editor.querySelector(".provider-editor-linked-credential-btn"));
    await vi.waitFor(() => expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("添加AI 平台"));

    // AI 编辑器里改了 Key 再 Esc：dirty 拦截弹既有确认框，不直关
    input(dialog()!.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "AIza-typed");
    pressEsc();
    await vi.waitFor(() => expect(document.querySelector(".confirm-dialog")).not.toBeNull());
    expect(dialog()).not.toBeNull();
    click(document.querySelector<HTMLButtonElement>(".confirm-dialog-cancel"));
    expect(document.querySelector(".confirm-dialog")).toBeNull();

    // 再点「返回伴看平台」：dirty 仍拦，确认放弃后才关并恢复伴看草稿
    click(dialog()!.querySelector<HTMLButtonElement>(".provider-editor-cancel"));
    await vi.waitFor(() => expect(document.querySelector(".confirm-dialog")).not.toBeNull());
    click(document.querySelector<HTMLButtonElement>(".confirm-dialog-confirm"));
    await vi.waitFor(() => {
      expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("编辑实时伴看平台");
    });
    expect(dialog()!.querySelector<HTMLInputElement>(".provider-editor-model")!.value).toBe("gemini-3.9-live");
  });

  it("抽屉收起的强制关闭不恢复伴看编辑器", async () => {
    const { host } = await mountPanel({ "ai-providers-list": () => ({ ok: true, providers: [] }) });
    const editor = await openLiveGeminiEditor(host);
    input(editor.querySelector<HTMLInputElement>(".provider-editor-model")!, "gemini-3.9-live");
    click(editor.querySelector(".provider-editor-linked-credential-btn"));
    await vi.waitFor(() => expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("添加AI 平台"));

    // 外层命令收起抽屉：AI 编辑器被强制关闭（既有联动），恢复路径让位
    document.getElementById("biliscript-reading-settings-panel")!.hidden = true;
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(dialog()).toBeNull();
    expect(host.querySelector("#biliscriptSettingsStatus")!.textContent).not.toContain("请继续保存伴看平台记录");
  });
});
