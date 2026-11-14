// DeepSeek Search 同层凭据闭环（票 provider-onboarding-consistency/08）：
// - 搜索 DeepSeek 编辑器内联凭据行与列表行覆盖四态（无记录 / 缺 Key / 非官方地址 /
//   可用）及对应动作；列表 Key 指示点由结构化凭据状态驱动，不把消费族 hasSavedKey
//   当成应有自有 Key；
// - 非官方地址不静默改写：新建独立官方 DeepSeek 记录；「可用」态展示实际命中的
//   来源，多条官方候选时不会误标成另一条；
// - 动作暂存搜索草稿同层进入 AI 族编辑器，保存成功或取消都恢复原草稿；保存成功
//   后重查引用、提示仍需显式保存搜索记录；
// - AI 新增 / 编辑 / 删除后，实时伴看与搜索两类引用行同事务刷新；
// - 存储边界：Key 只随 ai-providers-save 落 AI 族，搜索保存载荷不含 Key。
//
// 手法：真实 settings-panel + provider-editor，消息走 installSettingsPanelBus 总线
// （同 tests/ui/gemini-credential-link.test.ts）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installSettingsPanelBus, type BusMessage, type BusResponder } from "../helpers/settings-panel-bus.js";

const DEEPSEEK_SEARCH = {
  id: "search_deepseek",
  presetId: "deepseek",
  name: "DeepSeek Search",
  type: "deepseek",
  baseUrl: "https://api.deepseek.com",
  enabled: true,
  hasSavedKey: false
};

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

const DEEPSEEK_AI = {
  id: "p_deepseek",
  presetId: "deepseek",
  name: "DeepSeek 官方",
  type: "deepseek",
  baseUrl: "https://api.deepseek.com/v1",
  models: ["deepseek-chat"],
  enabled: true,
  hasSavedKey: true
};

const GEMINI_AI = {
  id: "p_gemini",
  presetId: "gemini",
  name: "Gemini",
  type: "gemini",
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

async function mountPanel(overrides: Record<string, BusResponder<BusMessage>> = {}) {
  document.body.innerHTML = `
    <div id="biliscript-reading-view">
      <section id="biliscript-reading-settings-panel">
        <div id="biliscript-reading-settings-host"></div>
      </section>
    </div>`;
  const bus = installSettingsPanelBus<BusMessage>({
    "search-providers-list": () => ({ ok: true, providers: [DEEPSEEK_SEARCH] }),
    "request-provider-origins": () => ({ ok: true }),
    ...overrides
  });
  const panel = await import("../../extension/ui/settings-panel.js");
  panel.renderReaderSettingsPanel();
  const host = document.getElementById("biliscript-reading-settings-host")!;
  await vi.waitFor(() => {
    expect(searchRow(host)).toBeTruthy();
  });
  return { host, sent: bus.sent };
}

function searchRow(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>(
    '#searchProvidersList .search-provider-row[data-provider-id="search_deepseek"]'
  );
}

function rowSubtitle(host: HTMLElement): string {
  return searchRow(host)?.querySelector(".provider-row-model")?.textContent || "";
}

function rowDot(host: HTMLElement): HTMLElement {
  return searchRow(host)!.querySelector<HTMLElement>(".provider-row-dot")!;
}

function liveSubtitle(host: HTMLElement): string {
  return host.querySelector("#liveProvidersList .live-provider-row .provider-row-model")?.textContent || "";
}

async function openDeepseekEditor(host: HTMLElement): Promise<HTMLElement> {
  click(searchRow(host)!.querySelector(".provider-row-edit"));
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
  return dialog()!;
}

function linkedRow(): HTMLElement | null {
  return dialog()?.querySelector<HTMLElement>(".provider-editor-linked-credential") ?? null;
}

function linkedText(): string {
  return linkedRow()?.querySelector(".provider-editor-linked-credential-text")?.textContent || "";
}

function linkedButton(): HTMLButtonElement | null {
  return linkedRow()?.querySelector<HTMLButtonElement>(".provider-editor-linked-credential-btn") ?? null;
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
});

afterEach(async () => {
  // 先收起抽屉：往返恢复路径（onSessionEnd → 恢复消费族草稿）在抽屉隐藏时让位，
  // 避免 afterEach 里又重开编辑器、把文档级监听泄漏到下一个用例
  const panel = document.getElementById("biliscript-reading-settings-panel");
  if (panel) panel.hidden = true;
  const { closeProviderEditor } = await import("../../extension/ui/provider-editor.js");
  closeProviderEditor(true);
});

describe("DeepSeek 搜索编辑器内联凭据四态", () => {
  it("无记录：状态文案 + 「配置官方 DeepSeek Key」动作", async () => {
    const { host } = await mountPanel({ "ai-providers-list": () => ({ ok: true, providers: [] }) });
    await openDeepseekEditor(host);
    expect(linkedText()).toBe("请先在 AI 平台添加官方 DeepSeek 记录");
    expect(linkedButton()!.textContent).toBe("配置官方 DeepSeek Key");
  });

  it("缺 Key：状态文案 + 「填写 AI Key」动作", async () => {
    const missingKey = { ...DEEPSEEK_AI, hasSavedKey: false };
    const { host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [missingKey] })
    });
    await openDeepseekEditor(host);
    expect(linkedText()).toBe("官方 DeepSeek AI Key 缺失或引用已失效");
    expect(linkedButton()!.textContent).toBe("填写 AI Key");
  });

  it("非官方地址：状态文案 + 「新建独立官方记录」动作", async () => {
    const relay = { ...DEEPSEEK_AI, id: "p_deepseek_relay", name: "DeepSeek 中转", baseUrl: "https://relay.example.com" };
    const { host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [relay] })
    });
    await openDeepseekEditor(host);
    expect(linkedText()).toBe("AI 平台配置的并非 DeepSeek 官方接口地址");
    expect(linkedButton()!.textContent).toBe("新建独立官方记录");
  });

  it("可用：展示实际命中的来源，无动作按钮", async () => {
    const { host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [DEEPSEEK_AI] })
    });
    await openDeepseekEditor(host);
    expect(linkedText()).toBe("已复用 AI 平台 Key · DeepSeek 官方");
    expect(linkedButton()).toBeNull();
  });
});

describe("DeepSeek 搜索列表行状态由结构化凭据状态驱动", () => {
  it("无记录 / 缺 Key / 非官方地址：副行四态文案，Key 点 missing 但不再自称「未保存 API Key」", async () => {
    const missingKey = { ...DEEPSEEK_AI, hasSavedKey: false };
    const relay = { ...DEEPSEEK_AI, id: "p_deepseek_relay", name: "DeepSeek 中转", baseUrl: "https://relay.example.com" };
    const cases: Array<{ providers: unknown[]; note: string }> = [
      { providers: [], note: "请先在 AI 平台添加官方 DeepSeek 记录" },
      { providers: [missingKey], note: "官方 DeepSeek AI Key 缺失或引用已失效" },
      { providers: [relay], note: "AI 平台配置的并非 DeepSeek 官方接口地址" }
    ];
    for (const testCase of cases) {
      resetModuleState();
      const { host } = await mountPanel({
        "ai-providers-list": () => ({ ok: true, providers: testCase.providers })
      });
      expect(rowSubtitle(host)).toBe(testCase.note);
      expect(rowDot(host).dataset.state).toBe("missing");
      expect(rowDot(host).title).toBe("AI 平台 Key 不可用");
      document.body.innerHTML = "";
    }
  });

  it("可用：Key 点 saved（复用 AI 平台 Key），副行展示命中来源", async () => {
    const { host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [DEEPSEEK_AI] })
    });
    expect(rowSubtitle(host)).toBe("已复用 AI 平台 Key · DeepSeek 官方");
    expect(rowDot(host).dataset.state).toBe("saved");
    expect(rowDot(host).title).toBe("已复用 AI 平台 Key");
  });

  it("多条官方候选：来源显示实际命中的第一条，不误标另一条", async () => {
    const other = { ...DEEPSEEK_AI, id: "p_deepseek_other", name: "DeepSeek 官方 B" };
    const { host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [DEEPSEEK_AI, other] })
    });
    expect(rowSubtitle(host)).toBe("已复用 AI 平台 Key · DeepSeek 官方");
    await openDeepseekEditor(host);
    expect(linkedText()).toBe("已复用 AI 平台 Key · DeepSeek 官方");
  });
});

describe("非官方地址同层新建官方记录", () => {
  it("新建独立官方 DeepSeek 记录：预置官方端点，不打开也不改写中转记录", async () => {
    const relay = { ...DEEPSEEK_AI, id: "p_deepseek_relay", name: "DeepSeek 中转", baseUrl: "https://relay.example.com" };
    const { host, sent } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [relay] })
    });
    const editor = await openDeepseekEditor(host);
    click(editor.querySelector(".provider-editor-linked-credential-btn"));

    await vi.waitFor(() => {
      expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("添加AI 平台");
    });
    const aiDialog = dialog()!;
    expect(aiDialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!.value).toBe("deepseek");
    expect(aiDialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")!.value)
      .toBe("https://api.deepseek.com/anthropic");
    expect(aiDialog.querySelector<HTMLButtonElement>(".provider-editor-save")!.textContent)
      .toBe("保存并返回搜索平台");
    expect(aiDialog.querySelector<HTMLButtonElement>(".provider-editor-cancel")!.textContent)
      .toBe("返回搜索平台");
    // 全程不触碰中转记录：未发生任何 AI 落盘
    expect(sent.some((message) => message.type === "ai-providers-save")).toBe(false);
  });
});

describe("往返：恢复搜索草稿与保存后重查引用", () => {
  it("取消后恢复原搜索草稿（未保存改动与 dirty 基线都在）", async () => {
    const { host } = await mountPanel({ "ai-providers-list": () => ({ ok: true, providers: [] }) });
    const editor = await openDeepseekEditor(host);
    input(editor.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://search.example.com");
    click(editor.querySelector(".provider-editor-linked-credential-btn"));

    await vi.waitFor(() => {
      expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("添加AI 平台");
    });
    click(dialog()!.querySelector<HTMLButtonElement>(".provider-editor-cancel"));

    await vi.waitFor(() => {
      expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("编辑搜索平台");
    });
    expect(dialog()!.querySelector<HTMLInputElement>(".provider-editor-baseurl")!.value)
      .toBe("https://search.example.com");
    // dirty 仍在：Esc 触发逐层退出的确认框（既有 confirmDialog 规则）
    pressEsc();
    await vi.waitFor(() => expect(document.querySelector(".confirm-dialog")).not.toBeNull());
    click(document.querySelector<HTMLButtonElement>(".confirm-dialog-cancel"));
  });

  it("保存成功后恢复草稿、重查引用并提示仍需显式保存搜索记录；Key 只落 AI 族", async () => {
    let aiProviders: Record<string, unknown>[] = [];
    const { host, sent } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: aiProviders }),
      "ai-providers-save": () => {
        aiProviders = [DEEPSEEK_AI];
        return { ok: true, providers: aiProviders };
      },
      "search-providers-save": (message) => ({ ok: true, providers: message.providers })
    });
    expect(rowSubtitle(host)).toBe("请先在 AI 平台添加官方 DeepSeek 记录");

    const editor = await openDeepseekEditor(host);
    // DeepSeek 搜索没有自有 Key 输入框（Key 经凭据引用取 AI 族）
    expect(
      editor.querySelector<HTMLElement>(".provider-editor-field .provider-editor-apikey")!
        .closest<HTMLElement>(".provider-editor-field")!.hidden
    ).toBe(true);
    input(editor.querySelector<HTMLInputElement>(".provider-editor-name")!, "DeepSeek 搜索草稿");
    click(editor.querySelector(".provider-editor-linked-credential-btn"));

    await vi.waitFor(() => {
      expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("添加AI 平台");
    });
    input(dialog()!.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-deepseek");
    click(dialog()!.querySelector<HTMLButtonElement>(".provider-editor-save"));

    // 保存成功后：搜索草稿恢复 + 提示 + 行状态按新引用刷新
    await vi.waitFor(() => {
      expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("编辑搜索平台");
    });
    expect(dialog()!.querySelector<HTMLInputElement>(".provider-editor-name")!.value)
      .toBe("DeepSeek 搜索草稿");
    await vi.waitFor(() => {
      expect(dialog()!.querySelector(".provider-editor-status")!.textContent)
        .toContain("请继续保存搜索平台记录");
    });
    await vi.waitFor(() => {
      expect(rowSubtitle(host)).toBe("已复用 AI 平台 Key · DeepSeek 官方");
    });
    // 引用可用后，恢复的编辑器内联行不再给动作
    expect(linkedButton()).toBeNull();

    // 存储边界：Key 只随 AI 族落盘；搜索编辑器保存载荷不含 Key
    const aiSave = sent.find((message) => message.type === "ai-providers-save") as {
      providers?: Array<{ apiKey?: string; presetId?: string }>;
    };
    expect(aiSave?.providers?.[0]?.apiKey).toBe("sk-deepseek");
    expect(aiSave?.providers?.[0]?.presetId).toBe("deepseek");
    expect(sent.some((message) => message.type === "search-providers-save")).toBe(false);

    click(dialog()!.querySelector<HTMLButtonElement>(".provider-editor-save"));
    await vi.waitFor(() => expect(sent.some((message) => message.type === "search-providers-save")).toBe(true));
    const searchSave = sent.find((message) => message.type === "search-providers-save") as {
      providers?: Array<{ apiKey?: string; hasSavedKey?: boolean; presetId?: string }>;
    };
    expect(searchSave?.providers?.[0]?.presetId).toBe("deepseek");
    expect(searchSave?.providers?.[0]?.apiKey ?? "").toBe("");
    expect(searchSave?.providers?.[0]?.hasSavedKey).toBe(false);
  });

  it("抽屉收起的强制关闭不恢复搜索编辑器", async () => {
    const { host } = await mountPanel({ "ai-providers-list": () => ({ ok: true, providers: [] }) });
    const editor = await openDeepseekEditor(host);
    input(editor.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://search.example.com");
    click(editor.querySelector(".provider-editor-linked-credential-btn"));
    await vi.waitFor(() => {
      expect(dialog()?.querySelector(".provider-editor-title")?.textContent).toBe("添加AI 平台");
    });

    document.getElementById("biliscript-reading-settings-panel")!.hidden = true;
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(host.querySelector("#biliscriptSettingsStatus")!.textContent)
      .not.toContain("请继续保存搜索平台记录");
  });
});

describe("AI 族变更联动两类引用行", () => {
  it("AI 新增官方 DeepSeek 记录后，搜索行同事务刷新为可用", async () => {
    let aiProviders: Record<string, unknown>[] = [];
    const { host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: aiProviders }),
      "ai-providers-save": () => {
        aiProviders = [DEEPSEEK_AI];
        return { ok: true, providers: aiProviders };
      }
    });
    expect(rowSubtitle(host)).toBe("请先在 AI 平台添加官方 DeepSeek 记录");

    click(host.querySelector("#addAiProviderBtn"));
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    const aiDialog = dialog()!;
    const preset = aiDialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!;
    preset.value = "deepseek";
    preset.dispatchEvent(new Event("change"));
    input(aiDialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-deepseek");
    click(aiDialog.querySelector(".provider-editor-model-add"));
    input(aiDialog.querySelector<HTMLInputElement>(".provider-editor-model-id")!, "deepseek-chat");
    click(aiDialog.querySelector(".provider-editor-save"));

    await vi.waitFor(() => {
      expect(rowSubtitle(host)).toBe("已复用 AI 平台 Key · DeepSeek 官方");
    });
  });

  it("AI 编辑记录名后，搜索行来源同步更新", async () => {
    let aiProviders: Record<string, unknown>[] = [DEEPSEEK_AI];
    const { host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: aiProviders }),
      "ai-providers-save": () => {
        aiProviders = [{ ...DEEPSEEK_AI, name: "DeepSeek 官方（改名）" }];
        return { ok: true, providers: aiProviders };
      }
    });
    expect(rowSubtitle(host)).toBe("已复用 AI 平台 Key · DeepSeek 官方");

    click(host.querySelector('#aiProvidersList .ai-provider-row[data-provider-id="p_deepseek"] .provider-row-edit'));
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    input(dialog()!.querySelector<HTMLInputElement>(".provider-editor-name")!, "DeepSeek 官方（改名）");
    click(dialog()!.querySelector(".provider-editor-save"));

    await vi.waitFor(() => {
      expect(rowSubtitle(host)).toBe("已复用 AI 平台 Key · DeepSeek 官方（改名）");
    });
  });

  it("AI 删除记录后，实时伴看与搜索两类引用行同事务刷新", async () => {
    const other = { ...DEEPSEEK_AI, id: "p_deepseek_other", name: "DeepSeek 官方 B" };
    let aiProviders: Array<Record<string, unknown>> = [GEMINI_AI, DEEPSEEK_AI, other];
    const { host } = await mountPanel({
      "live-providers-list": () => ({ ok: true, providers: [GEMINI_LIVE] }),
      "search-providers-list": () => ({ ok: true, providers: [DEEPSEEK_SEARCH] }),
      "ai-providers-list": () => ({ ok: true, providers: aiProviders }),
      "ai-providers-delete": (message) => {
        aiProviders = aiProviders.filter((provider) => provider.id !== message.providerId);
        return { ok: true, providers: aiProviders };
      }
    });
    await vi.waitFor(() => {
      expect(host.querySelector("#liveProvidersList .live-provider-row")).toBeTruthy();
    });
    expect(liveSubtitle(host)).toBe("gemini-3.8-live · 已复用 AI 平台 Key");
    expect(rowSubtitle(host)).toBe("已复用 AI 平台 Key · DeepSeek 官方");

    // 删除命中的 DeepSeek 官方 A：搜索行改指下一条官方记录，伴看行同批重渲
    click(host.querySelector('#aiProvidersList .ai-provider-row[data-provider-id="p_deepseek"] .provider-row-remove'));
    click(document.querySelector(".confirm-dialog-confirm"));
    await vi.waitFor(() => {
      expect(rowSubtitle(host)).toBe("已复用 AI 平台 Key · DeepSeek 官方 B");
    });
    expect(liveSubtitle(host)).toBe("gemini-3.8-live · 已复用 AI 平台 Key");

    // 删除 Gemini AI 记录：搜索行保持可用，伴看行降级为缺记录
    click(host.querySelector('#aiProvidersList .ai-provider-row[data-provider-id="p_gemini"] .provider-row-remove'));
    click(document.querySelector(".confirm-dialog-confirm"));
    await vi.waitFor(() => {
      expect(liveSubtitle(host)).toBe("gemini-3.8-live · 尚未配置官方 Gemini AI Key");
    });
    expect(rowSubtitle(host)).toBe("已复用 AI 平台 Key · DeepSeek 官方 B");
  });
});
