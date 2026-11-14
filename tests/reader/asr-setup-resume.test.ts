// 票 provider-onboarding-consistency/04 的自动化验收：
// 1. 配置类 ASR 阻塞的设置目标解析（未配置 / 停用 / 缺 Key / 记录在但配置不可用）；
// 2. 三个面共用的设置直达入口 openReaderAsrSetup（新增编辑器 / 编辑精确记录并聚焦
//    Key / 自动转写关闭的启用路径）；
// 3. 一次性续跑意图（重发只续跑一次、换视频失效、在飞去重、消费后不再）；
// 4. 配置完成后经既有字幕抓取链续跑（不建第二条转写管线、不虚构用户消息）。
//
// 手法：真实 settings-panel + 真实意图叶子 + 消息总线桩（对齐
// tests/ui/settings-panel-ai-setup.test.ts）；总结链装载 mock 掉，只验证
// 「重新进入既有抓取链」这一件事，不在单测里跑真实转写。

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { installSettingsPanelBus } from "../helpers/settings-panel-bus.js";

vi.mock("../../extension/ai/provider-test.js", () => ({
  testAiProviderConnection: vi.fn(async () => ({ ok: true }))
}));

vi.mock("../../extension/asr/provider-test.js", () => ({
  testAsrConnection: vi.fn(async () => ({ ok: true }))
}));

vi.mock("../../extension/asr/provider-models.js", () => ({
  listAsrModels: vi.fn(async () => ({ ok: false, error: "not used" }))
}));

// 总结链（subtitle/fetcher 等）整体 mock：续跑只要求「经既有 kick 链请求刷新」，
// 真实抓取链属于其它套件的覆盖范围。
vi.mock("../../extension/subtitle/lazy.js", () => ({
  ensureSummarizeChain: vi.fn(async () => ({ refreshClip: vi.fn() }))
}));

type SentMessage = { type: string } & Record<string, any>;
type MessageResponder = (message: SentMessage) => unknown;

const ASR_PROVIDER = {
  id: "asr-1",
  presetId: "siliconflow-sensevoice",
  name: "硅基流动",
  type: "openai-transcriptions",
  baseUrl: "https://api.siliconflow.cn/v1",
  model: "FunAudioLLM/SenseVoiceSmall",
  supportsTimestamps: true,
  enabled: true,
  hasSavedKey: true
};

const MISSING_KEY_PROVIDER = { ...ASR_PROVIDER, hasSavedKey: false };

function chromeStub(): { runtime: { sendMessage: Mock } } {
  return chrome as unknown as { runtime: { sendMessage: Mock } };
}

interface PanelHarness {
  panel: typeof import("../../extension/ui/settings-panel.js");
  leaf: typeof import("../../extension/reader/asr-setup-resume.js");
  core: typeof import("../../extension/core/state.js");
  host: HTMLElement;
  sent: SentMessage[];
  refresh: Mock;
}

// 挂载真实设置面板 + 一个「字幕刷新请求」探针（reader-bus 的 subtitleRefresh 槽，
// 即 fetcher 正常注册的同一个槽）。探针命中 = 续跑确实重新进入了既有抓取链。
async function mountPanel(overrides: Record<string, MessageResponder> = {}): Promise<PanelHarness> {
  document.body.innerHTML = `
    <div id="biliscript-reading-view">
      <section id="biliscript-reading-settings-panel">
        <div id="biliscript-reading-settings-host"></div>
      </section>
    </div>`;
  const sent = installSettingsPanelBus<SentMessage>({
    "asr-providers-save": () => ({ ok: true, providers: [] }),
    "request-provider-origins": () => ({ ok: true }),
    ...overrides
  }).sent;
  const [panel, leaf, state, readerBus] = await Promise.all([
    import("../../extension/ui/settings-panel.js"),
    import("../../extension/reader/asr-setup-resume.js"),
    import("../../extension/core/state.js"),
    import("../../extension/reader/reader-bus.js")
  ]);
  const refresh = vi.fn(async () => undefined);
  readerBus.subscribeSubtitleRefresh(refresh as unknown as () => Promise<unknown>);
  panel.renderReaderSettingsPanel();
  const host = document.getElementById("biliscript-reading-settings-host") as HTMLElement;
  await vi.waitFor(() => {
    expect(sent.some((message) => message.type === "asr-providers-list")).toBe(true);
  });
  return { panel, leaf, core: state, host, sent, refresh };
}

function fireClick(node: Element | null): void {
  node?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function setFieldValue(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
  setLocationUrl(READER_MODE_URL);
});

afterEach(async () => {
  const { closeProviderEditor } = await import("../../extension/ui/provider-editor.js");
  closeProviderEditor(true);
});

describe("resolveAsrSetupPlan：配置类 ASR 阻塞的三态解析", () => {
  it("自动转写关闭时优先给启用路径（与运行时 asr-disabled 判定同序）", async () => {
    const { resolveAsrSetupPlan } = await import("../../extension/asr/asr-setup.js");
    expect(
      resolveAsrSetupPlan({
        asrAutoFallback: false,
        activeAsrProviderId: "",
        providers: [ASR_PROVIDER]
      })
    ).toEqual({ kind: "disabled", providerId: "" });
  });

  it("无 ASR 记录 → 新增编辑器（开关开启、列表为空）", async () => {
    const { resolveAsrSetupPlan } = await import("../../extension/asr/asr-setup.js");
    expect(
      resolveAsrSetupPlan({ asrAutoFallback: true, activeAsrProviderId: "", providers: [] })
    ).toEqual({ kind: "no-provider", providerId: "" });
  });

  it("激活记录缺 Key → 编辑该精确记录", async () => {
    const { resolveAsrSetupPlan } = await import("../../extension/asr/asr-setup.js");
    const other = { ...ASR_PROVIDER, id: "asr-2", hasSavedKey: true };
    expect(
      resolveAsrSetupPlan({
        asrAutoFallback: true,
        // activeAsrProviderId 悬空时回退列表首项（与运行时/面板单选同一回退规则）
        activeAsrProviderId: "missing-id",
        providers: [MISSING_KEY_PROVIDER, other]
      })
    ).toEqual({ kind: "missing-key", providerId: "asr-1" });
  });

  it("记录与 Key 都在（域名未授权 / 模型不可用 / Key 失效）→ 编辑激活记录", async () => {
    const { resolveAsrSetupPlan } = await import("../../extension/asr/asr-setup.js");
    expect(
      resolveAsrSetupPlan({
        asrAutoFallback: true,
        activeAsrProviderId: "asr-1",
        providers: [ASR_PROVIDER]
      })
    ).toEqual({ kind: "provider-config", providerId: "asr-1" });
  });
});

describe("resolveAsrSetupState：自动转写关闭时保留完整平台阻塞信息", () => {
  it("开关关闭 + 无 ASR 平台 → kind 仍为 disabled，同时暴露 no-provider 与 blockedByBoth=true", async () => {
    const { resolveAsrSetupState } = await import("../../extension/asr/asr-setup.js");
    expect(
      resolveAsrSetupState({
        asrAutoFallback: false,
        activeAsrProviderId: "",
        providers: []
      })
    ).toEqual({
      kind: "disabled",
      providerId: "",
      asrAutoFallback: false,
      providerStatus: "no-provider",
      targetProviderId: "",
      needsProviderSetup: true,
      blockedByBoth: true
    });
  });

  it("开关关闭 + 激活平台缺 Key → 暴露 missing-key、targetProviderId 与 blockedByBoth=true", async () => {
    const { resolveAsrSetupState } = await import("../../extension/asr/asr-setup.js");
    expect(
      resolveAsrSetupState({
        asrAutoFallback: false,
        activeAsrProviderId: "asr-1",
        providers: [MISSING_KEY_PROVIDER]
      })
    ).toEqual({
      kind: "disabled",
      providerId: "",
      asrAutoFallback: false,
      providerStatus: "missing-key",
      targetProviderId: "asr-1",
      needsProviderSetup: true,
      blockedByBoth: true
    });
  });

  it("开关关闭 + 平台与 Key 均就绪 → needsProviderSetup=false, blockedByBoth=false", async () => {
    const { resolveAsrSetupState } = await import("../../extension/asr/asr-setup.js");
    expect(
      resolveAsrSetupState({
        asrAutoFallback: false,
        activeAsrProviderId: "asr-1",
        providers: [ASR_PROVIDER]
      })
    ).toEqual({
      kind: "disabled",
      providerId: "",
      asrAutoFallback: false,
      providerStatus: "provider-config",
      targetProviderId: "asr-1",
      needsProviderSetup: false,
      blockedByBoth: false
    });
  });
});

describe("openReaderAsrSetup：未配置 → 直接打开 ASR 编辑器", () => {
  it("无记录时打开新增编辑器，并记录一次性续跑意图", async () => {
    const { panel, leaf } = await mountPanel({
      "asr-providers-list": () => ({ ok: true, providers: [] })
    });
    await panel.openReaderAsrSetup();
    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector(".provider-editor-title")?.textContent).toBe("添加语音转写平台");
    // 新增流程不聚焦 Key（聚焦在对话框本体）
    expect(document.activeElement).not.toBe(
      dialog?.querySelector<HTMLInputElement>(".provider-editor-apikey")
    );
    expect(leaf.peekAsrSetupResumeIntent()).toMatchObject({ kind: "no-provider" });
  });
});

describe("openReaderAsrSetup：缺 Key → 编辑精确记录并聚焦 Key", () => {
  it("编辑激活记录、聚焦 Key；保存成功后消费意图并重新进入抓取链", async () => {
    const { panel, leaf, core, refresh } = await mountPanel({
      "asr-providers-list": () => ({ ok: true, providers: [MISSING_KEY_PROVIDER] }),
      "get-settings": () => ({ ok: true, settings: { asrAutoFallback: true, activeAsrProviderId: "asr-1" } })
    });
    await panel.openReaderAsrSetup();
    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector(".provider-editor-title")?.textContent).toBe("编辑语音转写平台");
    const keyInput = dialog!.querySelector<HTMLInputElement>(".provider-editor-apikey");
    expect(document.activeElement).toBe(keyInput);
    expect(core.state.reader.readingSettingsExpanded).toBe(true);
    expect(refresh).not.toHaveBeenCalled();

    // 保存 = 配置完成：续跑一次并退出设置回到原任务
    setFieldValue(keyInput!, "sk-test");
    fireClick(dialog!.querySelector(".provider-editor-save"));
    await vi.waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
    expect(leaf.peekAsrSetupResumeIntent()).toBeNull();
    expect(core.state.reader.readingSettingsExpanded).toBe(false);
  });

  it("取消编辑（会话结束）作废未消费的意图，不续跑", async () => {
    const { panel, leaf, core, refresh } = await mountPanel({
      "asr-providers-list": () => ({ ok: true, providers: [MISSING_KEY_PROVIDER] }),
      "get-settings": () => ({ ok: true, settings: { asrAutoFallback: true, activeAsrProviderId: "asr-1" } })
    });
    await panel.openReaderAsrSetup();
    expect(leaf.peekAsrSetupResumeIntent()).not.toBeNull();
    // 取消 = 关闭编辑器会话
    fireClick(document.querySelector(".provider-editor-mask"));
    await vi.waitFor(() => {
      expect(document.querySelector(".provider-editor-dialog")).toBeNull();
    });
    expect(leaf.peekAsrSetupResumeIntent()).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    expect(core.state.reader.readingSettingsExpanded).toBe(true);
  });
});

describe("openReaderAsrSetup：自动转写关闭 → 启用路径", () => {
  it("不弹编辑器，定位到自动转写开关；打开并落盘成功后回到原任务续跑", async () => {
    const { panel, leaf, core, host, refresh } = await mountPanel({
      "asr-providers-list": () => ({ ok: true, providers: [ASR_PROVIDER] }),
      "get-settings": () => ({ ok: true, settings: { asrAutoFallback: false, activeAsrProviderId: "asr-1" } })
    });
    await panel.openReaderAsrSetup();
    expect(document.querySelector(".provider-editor-dialog")).toBeNull();
    const toggle = host.querySelector<HTMLInputElement>("#asrAutoFallback");
    expect(toggle).not.toBeNull();
    expect(document.activeElement).toBe(toggle);
    expect(leaf.peekAsrSetupResumeIntent()).toMatchObject({ kind: "disabled" });

    // 用户显式打开开关（不代用户改设置），落盘成功后续跑
    toggle!.checked = true;
    toggle!.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
    expect(leaf.peekAsrSetupResumeIntent()).toBeNull();
    expect(core.state.reader.readingSettingsExpanded).toBe(false);
  });

  it("开关落盘失败不续跑、保留意图与设置抽屉", async () => {
    const { panel, leaf, core, host, refresh } = await mountPanel({
      "asr-providers-list": () => ({ ok: true, providers: [ASR_PROVIDER] }),
      "get-settings": () => ({ ok: true, settings: { asrAutoFallback: false, activeAsrProviderId: "asr-1" } }),
      "save-settings": () => ({ ok: false, error: "写入失败" })
    });
    await panel.openReaderAsrSetup();
    const toggle = host.querySelector<HTMLInputElement>("#asrAutoFallback")!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => {
      expect(core.state.reader.readingSettingsExpanded).toBe(true);
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(leaf.peekAsrSetupResumeIntent()).not.toBeNull();
  });

  it("开关关闭 + 无 ASR 平台：开启开关后不退出设置，直接顺滑进入新增 ASR 编辑器（一次闭环）", async () => {
    let settings = { asrAutoFallback: false, activeAsrProviderId: "" };
    let providers: Array<Record<string, unknown>> = [];
    const { panel, leaf, core, host, refresh } = await mountPanel({
      "asr-providers-list": () => ({ ok: true, providers }),
      "asr-providers-save": (msg) => {
        providers = Array.isArray(msg.providers) ? msg.providers : [];
        return { ok: true, providers };
      },
      "get-settings": () => ({ ok: true, settings }),
      "save-settings": (msg) => {
        settings = { ...settings, ...(msg.settings as Record<string, unknown>) } as typeof settings;
        return { ok: true };
      }
    });

    await panel.openReaderAsrSetup();
    expect(document.querySelector(".provider-editor-dialog")).toBeNull();
    const toggle = host.querySelector<HTMLInputElement>("#asrAutoFallback")!;
    expect(document.activeElement).toBe(toggle);
    expect(host.querySelector("#biliscriptSettingsStatus")?.textContent).toContain("随后补充语音转写平台配置");

    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      expect(document.querySelector(".provider-editor-dialog")).not.toBeNull();
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(core.state.reader.readingSettingsExpanded).toBe(true);
    expect(leaf.peekAsrSetupResumeIntent()).toMatchObject({ kind: "no-provider" });
    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    expect(dialog.querySelector(".provider-editor-title")?.textContent).toBe("添加语音转写平台");
    expect(dialog.querySelector(".provider-editor-save")?.textContent).toBe("保存并继续");
    expect(dialog.querySelector<HTMLElement>(".provider-editor-context-banner")?.textContent).toBe(
      "保存可用语音转写平台后将自动返回继续"
    );

    setFieldValue(dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-asr-new");
    fireClick(dialog.querySelector(".provider-editor-save"));
    await vi.waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
    expect(leaf.peekAsrSetupResumeIntent()).toBeNull();
    expect(core.state.reader.readingSettingsExpanded).toBe(false);
  });

  it("开关关闭 + 激活平台缺 Key：开启开关后顺滑进入编辑 ASR 并聚焦 Key，保存即完成续跑", async () => {
    let settings = { asrAutoFallback: false, activeAsrProviderId: "asr-1" };
    const { panel, leaf, core, host, refresh } = await mountPanel({
      "asr-providers-list": () => ({ ok: true, providers: [MISSING_KEY_PROVIDER] }),
      "get-settings": () => ({ ok: true, settings }),
      "save-settings": (msg) => {
        settings = { ...settings, ...(msg.settings as Record<string, unknown>) } as typeof settings;
        return { ok: true };
      }
    });

    await panel.openReaderAsrSetup();
    const toggle = host.querySelector<HTMLInputElement>("#asrAutoFallback")!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      expect(document.querySelector(".provider-editor-dialog")).not.toBeNull();
    });
    expect(leaf.peekAsrSetupResumeIntent()).toMatchObject({ kind: "missing-key" });
    const dialog = document.querySelector<HTMLElement>(".provider-editor-dialog")!;
    expect(dialog.querySelector(".provider-editor-title")?.textContent).toBe("编辑语音转写平台");
    const keyInput = dialog.querySelector<HTMLInputElement>(".provider-editor-apikey")!;
    expect(document.activeElement).toBe(keyInput);
    expect(dialog.querySelector<HTMLElement>(".provider-editor-context-banner")?.textContent).toBe(
      "请补充语音转写 API Key 后保存继续"
    );

    setFieldValue(keyInput, "sk-asr-fixed");
    fireClick(dialog.querySelector(".provider-editor-save"));
    await vi.waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
    expect(core.state.reader.readingSettingsExpanded).toBe(false);
  });
});

describe("字幕空态：配置类 ASR 补救投影为实际设置动作", () => {
  // 字幕空态要真实壳模板（列表宿主 + 设置宿主 + 副本/导出绑定都在壳里），
  // 故这里用 ui-renderer 的完整模板而不是 mountPanel 的最小骨架。
  async function renderEmptySubtitleList(
    reason: "asr-disabled" | "asr-empty"
  ): Promise<PanelHarness> {
    document.body.innerHTML = "";
    const sent = installSettingsPanelBus<SentMessage>({
      "asr-providers-save": () => ({ ok: true, providers: [] }),
      "request-provider-origins": () => ({ ok: true }),
      "asr-providers-list": () => ({ ok: true, providers: [] })
    }).sent;
    const uiRenderer = await import("../../extension/ui/ui-renderer.js");
    uiRenderer.ensureUiReady({ forceRecreate: true });
    const [panel, leaf, core, readerBus, reader] = await Promise.all([
      import("../../extension/ui/settings-panel.js"),
      import("../../extension/reader/asr-setup-resume.js"),
      import("../../extension/core/state.js"),
      import("../../extension/reader/reader-bus.js"),
      import("../../extension/reader/index.js")
    ]);
    const refresh = vi.fn(async () => undefined);
    readerBus.subscribeSubtitleRefresh(refresh as unknown as () => Promise<unknown>);
    core.clipState.setBvid("BV1test000000");
    core.clipState.setSubtitleFetchState("empty");
    core.clipState.setNoSubtitleReason(reason);
    reader.renderReadingView();
    return {
      panel,
      leaf,
      core,
      host: document.getElementById("biliscript-reading-settings-host") as HTMLElement,
      sent,
      refresh
    };
  }

  it("配置类 empty → 渲染「前往设置」，点击直达 ASR 设置入口", async () => {
    await renderEmptySubtitleList("asr-disabled");
    const button = document.querySelector<HTMLElement>('[data-subtitle-action="asr-setup"]');
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe("前往设置");
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(document.querySelector(".provider-editor-dialog")).not.toBeNull();
    });
    // 默认设置（开关开、无 ASR 记录）→ 新增编辑器
    expect(document.querySelector(".provider-editor-title")?.textContent).toBe("添加语音转写平台");
  });

  it("非配置类 empty（无人声）→ 不挂设置动作，空态文案照旧", async () => {
    await renderEmptySubtitleList("asr-empty");
    expect(document.querySelector('[data-subtitle-action="asr-setup"]')).toBeNull();
    expect(document.querySelector(".biliscript-reading-empty")?.textContent).toContain("未识别到语音内容");
  });
});

describe("对话拦截「前往设置」：带 ASR 目标经壳命令直达设置", () => {
  it("open-settings + target=asr → 直接进 ASR 编辑器（无记录 → 新增）", async () => {
    document.body.innerHTML = "";
    installSettingsPanelBus<SentMessage>({
      "asr-providers-save": () => ({ ok: true, providers: [] }),
      "request-provider-origins": () => ({ ok: true }),
      "asr-providers-list": () => ({ ok: true, providers: [] })
    });
    const uiRenderer = await import("../../extension/ui/ui-renderer.js");
    uiRenderer.ensureUiReady({ forceRecreate: true });
    const readerBus = await import("../../extension/reader/reader-bus.js");
    readerBus.requestUiCommand("open-settings", { target: "asr" });
    await vi.waitFor(() => {
      expect(document.querySelector(".provider-editor-dialog")).not.toBeNull();
    });
    expect(document.querySelector(".provider-editor-title")?.textContent).toBe("添加语音转写平台");
  });
});

describe("resumeAsrSubtitleFetchAfterSetup：一次性、换视频失效、在飞去重", () => {
  it("重复续跑只起一轮抓取（意图一次性消费）", async () => {
    const { panel, leaf, refresh } = await mountPanel();
    leaf.setAsrSetupResumeIntent({ videoKey: leaf.currentPageVideoKey(), kind: "missing-key" });
    expect(panel.resumeAsrSubtitleFetchAfterSetup()).toBe(true);
    expect(panel.resumeAsrSubtitleFetchAfterSetup()).toBe(false);
    await vi.waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });

  it("视频身份快照不一致（换视频 / 换分 P）时不续跑", async () => {
    const { panel, leaf, refresh } = await mountPanel();
    leaf.setAsrSetupResumeIntent({ videoKey: "BV1other00000|1", kind: "missing-key" });
    expect(panel.resumeAsrSubtitleFetchAfterSetup()).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    expect(leaf.peekAsrSetupResumeIntent()).toBeNull();
  });

  it("同一视频已有抓取在飞时不另起一轮（在飞去重）", async () => {
    const { panel, leaf, core, refresh } = await mountPanel();
    core.clipState.setBvid("BV1test000000");
    core.clipState.setPageIndex(1);
    core.clipState.setSubtitleFetchState("loading");
    leaf.setAsrSetupResumeIntent({ videoKey: leaf.currentPageVideoKey(), kind: "missing-key" });
    expect(panel.resumeAsrSubtitleFetchAfterSetup()).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });
});
