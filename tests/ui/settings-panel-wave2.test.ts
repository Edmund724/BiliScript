import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installSettingsPanelBus, type BusResponder } from "../helpers/settings-panel-bus.js";

type SentMessage = { type: string } & Record<string, any>;

vi.mock("../../extension/ai/provider-test.js", () => ({
  testAiProviderConnection: vi.fn(async () => ({ ok: true }))
}));

vi.mock("../../extension/asr/provider-test.js", () => ({
  testAsrConnection: vi.fn(async () => ({ ok: true }))
}));

vi.mock("../../extension/asr/provider-models.js", () => ({
  listAsrModels: vi.fn(async () => ({ ok: false, error: "not used" }))
}));

const AI_PROVIDERS = [
  {
    id: "ai-1",
    presetId: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o-mini"],
    requiresKey: true,
    enabled: true,
    hasSavedKey: true
  },
  {
    id: "ai-2",
    presetId: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat"],
    requiresKey: true,
    enabled: true,
    hasSavedKey: true
  }
];

const SEARCH_PROVIDERS = [
  {
    id: "search-1",
    presetId: "tavily",
    name: "Tavily",
    baseUrl: "https://api.tavily.com",
    requiresKey: true,
    enabled: true,
    hasSavedKey: true
  },
  {
    id: "search-2",
    presetId: "serper",
    name: "Serper",
    baseUrl: "https://google.serper.dev",
    requiresKey: true,
    enabled: true,
    hasSavedKey: true
  }
];

const ASR_PROVIDERS = [
  {
    id: "asr-1",
    presetId: "siliconflow-sensevoice",
    name: "硅基流动",
    type: "openai-transcriptions",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "FunAudioLLM/SenseVoiceSmall",
    enabled: true,
    hasSavedKey: true
  },
  {
    id: "asr-2",
    presetId: "openai-whisper",
    name: "OpenAI Whisper",
    type: "openai-transcriptions",
    baseUrl: "https://api.openai.com/v1",
    model: "whisper-1",
    enabled: true,
    hasSavedKey: true
  }
];

function setupReadingShellDom(): HTMLElement {
  document.body.innerHTML = `
    <div id="biliscript-reading-view">
      <section id="biliscript-reading-settings-panel" hidden>
        <div id="biliscript-reading-settings-host"></div>
      </section>
    </div>`;
  return document.getElementById("biliscript-reading-settings-host") as HTMLElement;
}

async function mountPanel(overrides: Record<string, BusResponder<SentMessage>> = {}) {
  const host = setupReadingShellDom();
  const bus = installSettingsPanelBus<SentMessage>({
    "request-provider-origins": () => ({ ok: true }),
    "remove-provider-origins": () => ({ ok: true }),
    ...overrides
  });
  const panel = await import("../../extension/ui/settings-panel.js");
  await panel.renderReaderSettingsPanel();
  return { panel, host, sent: bus.sent };
}

function fireClick(el: Element | null): void {
  el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

async function confirmModalDelete(): Promise<void> {
  await vi.waitFor(() => {
    expect(document.querySelector(".confirm-dialog-confirm")).not.toBeNull();
  });
  fireClick(document.querySelector(".confirm-dialog-confirm"));
}

function statusEl(host: HTMLElement): HTMLElement {
  return host.querySelector<HTMLElement>("#biliscriptSettingsStatus")!;
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
});

afterEach(async () => {
  const { closeProviderEditor } = await import("../../extension/ui/provider-editor.js");
  closeProviderEditor(true);
});

describe("Wave 2 [P0-1]: 行内删除 IPC 校验、失败回滚与搜索/AI 联动更新", () => {
  it("行内删除失败（ok: false）时保留行、恢复按钮可用态并在状态栏报错", async () => {
    const { host } = await mountPanel({
      "search-providers-list": () => ({ ok: true, providers: SEARCH_PROVIDERS }),
      "search-providers-delete": () => ({ ok: false, error: "删除失败：写入拒绝" })
    });

    const row = host.querySelector<HTMLElement>('.search-provider-row[data-provider-id="search-1"]')!;
    const removeBtn = row.querySelector<HTMLButtonElement>(".provider-row-remove")!;
    const editBtn = row.querySelector<HTMLButtonElement>(".provider-row-edit")!;

    fireClick(removeBtn);
    await confirmModalDelete();

    await vi.waitFor(() => {
      expect(statusEl(host).dataset.error).toBe("true");
    });
    expect(statusEl(host).textContent).toBe("删除失败：写入拒绝");
    expect(row.isConnected).toBe(true);
    expect(removeBtn.disabled).toBe(false);
    expect(editBtn.disabled).toBe(false);
  });

  it("搜索行内删除当前激活平台：无需 DOM :checked 反查，直接清空 activeSearchProviderId 与单选态并重置摘要", async () => {
    let currentSearch = [...SEARCH_PROVIDERS];
    let currentSettings: Record<string, unknown> = { activeSearchProviderId: "search-1" };
    const { host, sent } = await mountPanel({
      "search-providers-list": () => ({ ok: true, providers: currentSearch }),
      "search-providers-delete": (msg) => {
        currentSearch = currentSearch.filter((item) => item.id !== msg.providerId);
        return { ok: true, providers: currentSearch };
      },
      "get-settings": () => ({ ok: true, settings: currentSettings }),
      "save-settings": (msg) => {
        currentSettings = { ...currentSettings, ...(msg.settings as Record<string, unknown>) };
        return { ok: true };
      }
    });

    await vi.waitFor(() => {
      expect(host.querySelector("#searchChainActiveSummary")?.textContent).toContain("仅使用 Tavily");
    });

    const row = host.querySelector<HTMLElement>('.search-provider-row[data-provider-id="search-1"]')!;
    fireClick(row.querySelector(".provider-row-remove"));
    await confirmModalDelete();

    await vi.waitFor(() => {
      expect(sent.some((m) => m.type === "save-settings" && m.settings?.activeSearchProviderId === "")).toBe(
        true
      );
    });
    expect(host.querySelector('.search-provider-row[data-provider-id="search-1"]')).toBeNull();
    expect(host.querySelector("#searchChainActiveSummary")?.textContent).toBe("智能搜索 · 失败自动回退");
    expect(host.querySelector<HTMLElement>("#searchProvidersDanglingHint")?.hidden).toBe(true);
    expect(host.querySelector<HTMLElement>(".search-chain-footer-bar")?.hidden).toBe(false);
  });

  it("AI 行内删除：同步刷新默认摘要、默认徽标与字幕翻译下拉选项", async () => {
    let currentAi = [...AI_PROVIDERS];
    let resolveCalled = 0;
    const { host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: currentAi }),
      "ai-providers-delete": (msg) => {
        currentAi = currentAi.filter((item) => item.id !== msg.providerId);
        return { ok: true, providers: currentAi };
      },
      "get-settings": () => ({ ok: true, settings: { defaultModel: "ai-1" } }),
      "resolve-ai-provider": () => {
        resolveCalled += 1;
        if (currentAi.some((p) => p.id === "ai-1")) {
          return { ok: true, provider: currentAi[0], apiKey: "sk" };
        }
        return { ok: true, isFallback: true, provider: currentAi[0], apiKey: "sk" };
      },
      "resolve-subtitle-translate-provider": () => ({
        ok: true,
        provider: currentAi[0],
        model: currentAi[0]?.models?.[0] || "",
        isFallback: false
      })
    });

    await vi.waitFor(() => {
      expect(host.querySelector("#aiActiveDefaultSummary")?.textContent).toContain("OpenAI · gpt-4o-mini");
    });
    expect(host.querySelectorAll("#subtitleTranslateModel optgroup").length).toBe(2);

    const callsBeforeDelete = resolveCalled;
    const row = host.querySelector<HTMLElement>('.ai-provider-row[data-provider-id="ai-1"]')!;
    fireClick(row.querySelector(".provider-row-remove"));
    await confirmModalDelete();

    await vi.waitFor(() => {
      expect(resolveCalled).toBeGreaterThan(callsBeforeDelete);
      expect(host.querySelector("#aiActiveDefaultSummary")?.textContent).toContain("DeepSeek · deepseek-chat");
    });
    expect(host.querySelectorAll("#subtitleTranslateModel optgroup").length).toBe(1);
    expect(
      host.querySelector('.ai-provider-row[data-provider-id="ai-2"] .provider-row-badge')?.textContent
    ).toBe("默认");
  });
});

describe("Wave 2 [P0-2]: 动态跨族凭据引用与双击互斥锁", () => {
  it("新增搜索平台切换预设到 deepseek / 切离时实时显示和隐藏跨族凭据状态卡", async () => {
    const { host } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: [] }),
      "search-providers-list": () => ({ ok: true, providers: [] })
    });

    fireClick(host.querySelector("#addSearchProviderBtn"));
    await vi.waitFor(() => {
      expect(document.querySelector(".provider-editor-dialog")).not.toBeNull();
    });

    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    const presetSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!;
    const linkedRow = dialog.querySelector<HTMLElement>(".provider-editor-linked-credential")!;
    expect(linkedRow.hidden).toBe(true);

    presetSelect.value = "deepseek";
    presetSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(linkedRow.hidden).toBe(false);
    expect(dialog.querySelector(".provider-editor-linked-credential-btn")?.textContent).toBe(
      "配置官方 DeepSeek Key"
    );

    presetSelect.value = "tavily";
    presetSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(linkedRow.hidden).toBe(true);
  });

  it("快速连点两次跨族凭据按钮：同步禁用按钮且只触发一次跳转，不覆写消费草稿", async () => {
    let aiListResolves: Array<(v: unknown) => void> = [];
    let aiListAfterEditorOpen = 0;
    let editorOpened = false;
    const { host } = await mountPanel({
      "ai-providers-list": () => {
        if (!editorOpened) return { ok: true, providers: [] };
        aiListAfterEditorOpen += 1;
        return new Promise((resolve) => {
          aiListResolves.push(resolve);
        });
      },
      "live-providers-list": () => ({ ok: true, providers: [] })
    });

    fireClick(host.querySelector("#addLiveProviderBtn"));
    await vi.waitFor(() => {
      expect(document.querySelector(".provider-editor-dialog")).not.toBeNull();
    });
    editorOpened = true;

    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    const presetSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")!;
    presetSelect.value = "gemini-live";
    presetSelect.dispatchEvent(new Event("change", { bubbles: true }));

    const btn = dialog.querySelector<HTMLButtonElement>(".provider-editor-linked-credential-btn")!;
    expect(btn.hidden).toBe(false);

    fireClick(btn);
    expect(btn.disabled).toBe(true);
    fireClick(btn);
    await vi.waitFor(() => {
      expect(aiListAfterEditorOpen).toBe(1);
    });
    expect(aiListAfterEditorOpen).toBe(1);

    aiListResolves[0]?.({ ok: true, providers: [] });
    await vi.waitFor(() => {
      expect(document.querySelector(".provider-editor-title")?.textContent).toBe("添加AI 平台");
    });
  });
});

describe("Wave 2 [P1-1]: AI 行内「设为默认」与失败回滚", () => {
  it("点击 AI 行「设为默认」持久化 defaultModel 并刷新按钮状态与生效投影；失败则回滚", async () => {
    let currentSettings: Record<string, unknown> = { defaultModel: "ai-1" };
    let failSave = false;
    const { host, sent } = await mountPanel({
      "ai-providers-list": () => ({ ok: true, providers: AI_PROVIDERS }),
      "get-settings": () => ({ ok: true, settings: currentSettings }),
      "save-settings": (msg) => {
        if (failSave) return { ok: false, error: "保存默认失败" };
        currentSettings = { ...currentSettings, ...(msg.settings as Record<string, unknown>) };
        return { ok: true };
      },
      "resolve-ai-provider": () => {
        const active =
          AI_PROVIDERS.find((p) => p.id === currentSettings.defaultModel) || AI_PROVIDERS[0];
        return { ok: true, provider: active, apiKey: "sk" };
      },
      "resolve-subtitle-translate-provider": () => {
        const active =
          AI_PROVIDERS.find((p) => p.id === currentSettings.defaultModel) || AI_PROVIDERS[0];
        return { ok: true, provider: active, model: active.models[0], isFallback: false };
      }
    });

    await vi.waitFor(() => {
      expect(host.querySelector("#aiActiveDefaultSummary")?.textContent).toContain("OpenAI · gpt-4o-mini");
    });

    const btn1 = host.querySelector<HTMLButtonElement>(
      '.ai-provider-row[data-provider-id="ai-1"] .ai-provider-default-btn'
    )!;
    const btn2 = host.querySelector<HTMLButtonElement>(
      '.ai-provider-row[data-provider-id="ai-2"] .ai-provider-default-btn'
    )!;
    expect(btn1.disabled).toBe(true);
    expect(btn1.textContent).toBe("默认");
    expect(btn2.disabled).toBe(false);
    expect(btn2.textContent).toBe("设为默认");

    fireClick(btn2);
    await vi.waitFor(() => {
      expect(btn2.disabled).toBe(true);
      expect(btn2.textContent).toBe("默认");
      expect(host.querySelector("#aiActiveDefaultSummary")?.textContent).toContain("DeepSeek · deepseek-chat");
    });
    expect(btn1.disabled).toBe(false);
    expect(btn1.textContent).toBe("设为默认");
    expect(sent.some((m) => m.type === "save-settings" && m.settings?.defaultModel === "ai-2")).toBe(true);

    failSave = true;
    fireClick(btn1);
    await vi.waitFor(() => {
      expect(statusEl(host).dataset.error).toBe("true");
    });
    expect(statusEl(host).textContent).toBe("保存默认失败");
    expect(btn2.disabled).toBe(true);
    expect(btn2.textContent).toBe("默认");
    expect(btn1.disabled).toBe(false);
    expect(btn1.textContent).toBe("设为默认");
  });
});

describe("Wave 2 [P1-3]: 行内单选切换与重置顺序失败回滚", () => {
  it("ASR 行内单选 save-settings 失败时回滚 checked 状态并在状态栏报错", async () => {
    let failSave = false;
    const { host } = await mountPanel({
      "asr-providers-list": () => ({ ok: true, providers: ASR_PROVIDERS }),
      "get-settings": () => ({ ok: true, settings: { activeAsrProviderId: "asr-1" } }),
      "save-settings": () => (failSave ? { ok: false, error: "切换失败" } : { ok: true })
    });

    const r1 = host.querySelector<HTMLInputElement>(
      '.asr-provider-row[data-provider-id="asr-1"] .asr-provider-active-radio'
    )!;
    const r2 = host.querySelector<HTMLInputElement>(
      '.asr-provider-row[data-provider-id="asr-2"] .asr-provider-active-radio'
    )!;
    expect(r1.checked).toBe(true);
    expect(r2.checked).toBe(false);

    failSave = true;
    r2.checked = true;
    r2.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      expect(statusEl(host).dataset.error).toBe("true");
    });
    expect(statusEl(host).textContent).toBe("切换失败");
    expect(r1.checked).toBe(true);
    expect(r2.checked).toBe(false);
  });

  it("恢复默认搜索顺序 storage.sync.remove 失败时不清空按钮状态并在状态栏报错", async () => {
    await chrome.storage.sync.set({ searchProviderOrder: ["search-2", "search-1"] });
    const { host } = await mountPanel({
      "search-providers-list": () => ({ ok: true, providers: SEARCH_PROVIDERS })
    });

    const resetBtn = host.querySelector<HTMLButtonElement>("#resetSearchProviderOrderBtn")!;
    expect(resetBtn.disabled).toBe(false);

    vi.spyOn(chrome.storage.sync, "remove").mockRejectedValueOnce(new Error("sync remove failed"));
    fireClick(resetBtn);

    await vi.waitFor(() => {
      expect(statusEl(host).dataset.error).toBe("true");
    });
    expect(statusEl(host).textContent).toBe("sync remove failed");
    expect(resetBtn.disabled).toBe(false);
  });
});

describe("Wave 2 [P1-5 & P1-6]: 搜索链自动展开与 Modal 保存/删除状态反馈", () => {
  it("搜索平台为空时自动展开 #searchChainContainer 并同步 aria-expanded", async () => {
    const { host } = await mountPanel({
      "search-providers-list": () => ({ ok: true, providers: [] })
    });

    const container = host.querySelector<HTMLElement>("#searchChainContainer")!;
    const toggleBtn = host.querySelector<HTMLButtonElement>("#toggleSearchChainBtn")!;
    expect(container.hidden).toBe(false);
    expect(toggleBtn.getAttribute("aria-expanded")).toBe("true");
  });

  it("搜索链原本折叠时通过 Modal 新增保存搜索平台 → 自动展开并显示「平台已保存」", async () => {
    let currentSearch = [...SEARCH_PROVIDERS];
    const { host } = await mountPanel({
      "search-providers-list": () => ({ ok: true, providers: currentSearch }),
      "search-providers-save": (msg) => {
        currentSearch = Array.isArray(msg.providers) ? msg.providers : currentSearch;
        return { ok: true, providers: currentSearch };
      }
    });

    const container = host.querySelector<HTMLElement>("#searchChainContainer")!;
    const toggleBtn = host.querySelector<HTMLButtonElement>("#toggleSearchChainBtn")!;
    expect(container.hidden).toBe(true);
    expect(toggleBtn.getAttribute("aria-expanded")).toBe("false");

    fireClick(host.querySelector("#addSearchProviderBtn"));
    await vi.waitFor(() => {
      expect(document.querySelector(".provider-editor-dialog")).not.toBeNull();
    });

    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    const keyInput = dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!;
    keyInput.value = "sk-search-1";
    keyInput.dispatchEvent(new Event("input", { bubbles: true }));
    fireClick(dialog.querySelector(".provider-editor-save"));

    await vi.waitFor(() => {
      expect(document.querySelector(".provider-editor-dialog")).toBeNull();
    });
    expect(container.hidden).toBe(false);
    expect(toggleBtn.getAttribute("aria-expanded")).toBe("true");
    expect(statusEl(host).textContent).toBe("平台已保存");
  });

  it("Modal 删除平台成功后状态栏显示「平台已删除」；权限回收失败时不覆盖错误提示", async () => {
    let currentAi = [...AI_PROVIDERS];
    let revokeShouldFail = false;
    const origPermissions = (chrome as unknown as { permissions?: unknown }).permissions;
    (chrome as unknown as { permissions: unknown }).permissions = {
      contains: vi.fn(async () => true),
      remove: vi.fn(async () => !revokeShouldFail)
    };
    try {
      const { host } = await mountPanel({
        "ai-providers-list": () => ({ ok: true, providers: currentAi }),
        "ai-providers-delete": (msg) => {
          currentAi = currentAi.filter((item) => item.id !== msg.providerId);
          return { ok: true, providers: currentAi };
        }
      });

      fireClick(host.querySelector('.ai-provider-row[data-provider-id="ai-1"] .provider-row-edit'));
      await vi.waitFor(() => {
        expect(document.querySelector(".provider-editor-dialog")).not.toBeNull();
      });
      fireClick(document.querySelector(".provider-editor-delete"));
      await confirmModalDelete();

      await vi.waitFor(() => {
        expect(document.querySelector(".provider-editor-dialog")).toBeNull();
      });
      expect(statusEl(host).textContent).toBe("平台已删除");
      expect(statusEl(host).dataset.error).toBe("false");

      revokeShouldFail = true;
      fireClick(host.querySelector('.ai-provider-row[data-provider-id="ai-2"] .provider-row-edit'));
      await vi.waitFor(() => {
        expect(document.querySelector(".provider-editor-dialog")).not.toBeNull();
      });
      fireClick(document.querySelector(".provider-editor-delete"));
      await confirmModalDelete();

      await vi.waitFor(() => {
        expect(document.querySelector(".provider-editor-dialog")).toBeNull();
      });
      expect(statusEl(host).dataset.error).toBe("true");
      expect(statusEl(host).textContent).not.toBe("平台已删除");
    } finally {
      (chrome as unknown as { permissions?: unknown }).permissions = origPermissions;
    }
  });
});

describe("Wave 2 [P1-冷启动闭环]: openReaderAiSetup 冷启动导航、no-model 与异常终止", () => {
  it("冷启动未预先渲染面板时调用 openReaderAiSetup → 等待渲染完成并定位到 llm 导航项", async () => {
    const host = setupReadingShellDom();
    installSettingsPanelBus<SentMessage>({
      "ai-providers-list": () => ({ ok: true, providers: [] }),
      "request-provider-origins": () => ({ ok: true })
    });
    const panel = await import("../../extension/ui/settings-panel.js");
    const onAfterSave = vi.fn();
    const onSessionEnd = vi.fn();

    await panel.openReaderAiSetup("no-provider", { onAfterSave, onSessionEnd });

    const llmNav = host.querySelector<HTMLElement>('.biliscript-settings-nav-item[data-section="llm"]');
    expect(llmNav?.classList.contains("is-active")).toBe(true);
    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    expect(dialog.querySelector<HTMLElement>(".provider-editor-context-banner")?.textContent).toBe(
      "保存可用 AI 平台后将自动返回继续"
    );
  });

  it("openReaderAiSetup('no-model') 打开目标平台编辑器、展示引导横幅并聚焦模型配置控件", async () => {
    await mountPanel({
      "ai-providers-list": () => ({
        ok: true,
        providers: [
          {
            id: "ai-no-model",
            presetId: "custom",
            name: "空模型平台",
            baseUrl: "https://api.test/v1",
            models: [],
            requiresKey: true,
            enabled: true,
            hasSavedKey: true
          }
        ]
      })
    });
    const panel = await import("../../extension/ui/settings-panel.js");

    await panel.openReaderAiSetup(
      "no-model",
      { onAfterSave: vi.fn(), onSessionEnd: vi.fn() },
      { providerId: "ai-no-model" }
    );

    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector(".provider-editor-title")?.textContent).toBe("编辑AI 平台");
    expect(dialog.querySelector<HTMLElement>(".provider-editor-context-banner")?.textContent).toBe(
      "请至少添加一个可用模型后保存继续"
    );
    const addModelBtn = dialog.querySelector<HTMLElement>('[data-provider-editor-action="add-model"]');
    expect(document.activeElement).toBe(addModelBtn);
  });

  it("openReaderAiSetup('missing-key') 目标缺失/禁用/无需 Key 时终止会话并给出明确提示", async () => {
    const { panel, host } = await mountPanel({
      "ai-providers-list": () => ({
        ok: true,
        providers: [
          {
            id: "ai-keyless",
            presetId: "ollama",
            name: "Ollama",
            baseUrl: "http://127.0.0.1:11434/v1",
            models: ["llama3"],
            requiresKey: false,
            enabled: true,
            hasSavedKey: false
          }
        ]
      })
    });
    const onSessionEnd = vi.fn();

    await panel.openReaderAiSetup(
      "missing-key",
      { onAfterSave: vi.fn(), onSessionEnd },
      { providerId: "ai-keyless" }
    );

    expect(onSessionEnd).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".provider-editor-dialog")).toBeNull();
    expect(statusEl(host).dataset.error).toBe("true");
    expect(statusEl(host).textContent).toContain("未找到需要补充 API Key");
  });
});
