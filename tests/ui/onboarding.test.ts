import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

const ONBOARDING_HTML = readFileSync(join(process.cwd(), "extension", "onboarding.html"), "utf8");

function installOnboardingRuntimeMock(initial: {
  settings?: Record<string, unknown>;
  aiProviders?: Array<Record<string, unknown>>;
  asrProviders?: Array<Record<string, unknown>>;
  aiKeys?: Record<string, string>;
  asrKeys?: Record<string, string>;
  fetchedModels?: string[];
} = {}) {
  let settings: Record<string, unknown> = {
    readerTheme: "light",
    readerThemeUserSet: false,
    readerPalette: "flyme",
    asrAutoFallback: true,
    webSearchEnabled: false,
    searchOptInNoticeAcknowledged: false,
    defaultModel: "",
    defaultAiModel: "",
    activeAsrProviderId: "",
    ...(initial.settings || {})
  };
  let aiProviders = [...(initial.aiProviders || [])];
  let asrProviders = [...(initial.asrProviders || [])];
  const aiKeys = { ...(initial.aiKeys || {}) };
  const asrKeys = { ...(initial.asrKeys || {}) };
  const sentMessages: Array<Record<string, unknown>> = [];

  const runtime = globalThis.chrome.runtime as unknown as {
    sendMessage: (msg: Record<string, unknown>, cb?: (resp: unknown) => void) => Promise<unknown> | void;
  };
  runtime.sendMessage = vi.fn((msg: Record<string, unknown>, cb?: (resp: unknown) => void) => {
    sentMessages.push(msg);
    let reply: unknown = { ok: false, error: "unknown" };
    if (msg.type === "get-settings") {
      reply = { ok: true, settings: { ...settings } };
    } else if (msg.type === "save-settings") {
      settings = { ...settings, ...((msg.settings as Record<string, unknown>) || {}) };
      reply = { ok: true };
    } else if (msg.type === "ai-providers-list") {
      reply = {
        ok: true,
        providers: aiProviders.map(({ apiKey: _k, ...p }) => ({
          ...p,
          hasSavedKey: Boolean(aiKeys[String(p.id)])
        }))
      };
    } else if (msg.type === "ai-providers-save") {
      const incoming = Array.isArray(msg.providers) ? (msg.providers as Array<Record<string, unknown>>) : [];
      aiProviders = incoming.map((p) => {
        const key = String(p.apiKey || "").trim();
        if (key) aiKeys[String(p.id)] = key;
        const { apiKey: _k, ...rest } = p;
        return { ...rest, hasSavedKey: Boolean(aiKeys[String(p.id)]) };
      });
      reply = { ok: true, providers: aiProviders };
    } else if (msg.type === "asr-providers-list") {
      reply = {
        ok: true,
        providers: asrProviders.map(({ apiKey: _k, ...p }) => ({
          ...p,
          hasSavedKey: Boolean(asrKeys[String(p.id)])
        }))
      };
    } else if (msg.type === "asr-providers-save") {
      const incoming = Array.isArray(msg.providers) ? (msg.providers as Array<Record<string, unknown>>) : [];
      asrProviders = incoming.map((p) => {
        const key = String(p.apiKey || "").trim();
        if (key) asrKeys[String(p.id)] = key;
        const { apiKey: _k, ...rest } = p;
        return { ...rest, hasSavedKey: Boolean(asrKeys[String(p.id)]) };
      });
      reply = { ok: true, providers: asrProviders };
    } else if (msg.type === "resolve-search-provider") {
      reply = { ok: true, chain: [{ provider: { id: "tavily", access: "keyless" } }] };
    } else if (msg.type === "provider-http") {
      const models = initial.fetchedModels ?? [];
      reply = {
        ok: true,
        status: 200,
        body: JSON.stringify({ data: models.map((id) => ({ id })) })
      };
    }

    if (typeof cb === "function") {
      cb(reply);
      return;
    }
    return Promise.resolve(reply);
  });

  (globalThis.chrome as unknown as { permissions: unknown }).permissions = {
    request: vi.fn(async () => true),
    contains: vi.fn(async () => true)
  };

  return {
    getSettings: () => settings,
    getAiProviders: () => aiProviders,
    getAiKeys: () => aiKeys,
    getAsrProviders: () => asrProviders,
    getAsrKeys: () => asrKeys,
    sentMessages
  };
}

function loadOnboardingDom(): void {
  const bodyMatch = ONBOARDING_HTML.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  document.body.innerHTML = bodyMatch ? bodyMatch[1] : "";
}

beforeEach(() => {
  resetModuleState();
  loadOnboardingDom();
});

describe("onboarding.html 与引导页配置读写同步", () => {
  it("包含三部分引导结构、GitHub Pages 外链与默认 ModelScope / XingChenASR-V3.2 预设", async () => {
    installOnboardingRuntimeMock();
    const { mountOnboardingPage } = await import("../../extension/entry/onboarding.js");
    const ctrl = await mountOnboardingPage(document);

    expect(document.getElementById("aiPresetSelect") instanceof HTMLSelectElement).toBe(true);
    expect((document.getElementById("aiPresetSelect") as HTMLSelectElement).value).toBe("modelscope");
    expect((document.getElementById("aiBaseUrlInput") as HTMLInputElement).value).toBe(
      "https://api-inference.modelscope.cn/v1"
    );
    expect((document.getElementById("asrPresetSelect") as HTMLSelectElement).value).toBe(
      "siliconflow-sensevoice"
    );
    expect((document.getElementById("asrModelInput") as HTMLInputElement).value).toBe(
      "XingChenAGI/XingChenASR-V3.2"
    );

    const footerLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>(".onboarding-footer a"));
    expect(footerLinks.map((a) => a.getAttribute("href"))).toEqual([
      "https://edmund724.github.io/BiliScript/docs/guide.html",
      "https://edmund724.github.io/BiliScript/docs/agent-bridge.html",
      "https://edmund724.github.io/BiliScript/privacy.html"
    ]);
    for (const link of footerLinks) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }

    ctrl.dispose();
  });

  it("在引导页保存 ModelScope 与硅基流动配置后同步落盘并展示就绪状态", async () => {
    const store = installOnboardingRuntimeMock();
    const { mountOnboardingPage } = await import("../../extension/entry/onboarding.js");
    const ctrl = await mountOnboardingPage(document);

    const aiKey = document.getElementById("aiApiKeyInput") as HTMLInputElement;
    const aiModel = document.getElementById("aiModelInput") as HTMLInputElement;
    const aiForm = document.getElementById("onboardingAiForm") as HTMLFormElement;

    aiKey.value = "ms-test-token-123";
    aiModel.value = "Qwen/Qwen3-235B-A22B-Instruct-2507";
    aiForm.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

    await vi.waitFor(() => {
      expect(store.getAiProviders()).toHaveLength(1);
    });
    expect(store.getAiProviders()[0].presetId).toBe("modelscope");
    expect(store.getAiKeys()[String(store.getAiProviders()[0].id)]).toBe("ms-test-token-123");
    expect(store.getSettings().defaultModel).toBe(store.getAiProviders()[0].id);
    expect(store.getSettings().defaultAiModel).toBe("Qwen/Qwen3-235B-A22B-Instruct-2507");
    expect(document.getElementById("aiReadyBadge")?.getAttribute("data-ready")).toBe("true");

    const asrKey = document.getElementById("asrApiKeyInput") as HTMLInputElement;
    const asrForm = document.getElementById("onboardingAsrForm") as HTMLFormElement;
    asrKey.value = "sf-test-key-456";
    asrForm.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

    await vi.waitFor(() => {
      expect(store.getAsrProviders()).toHaveLength(1);
    });
    expect(store.getAsrProviders()[0].model).toBe("XingChenAGI/XingChenASR-V3.2");
    expect(store.getAsrKeys()[String(store.getAsrProviders()[0].id)]).toBe("sf-test-key-456");
    expect(store.getSettings().activeAsrProviderId).toBe(store.getAsrProviders()[0].id);
    expect(document.getElementById("asrReadyBadge")?.getAttribute("data-ready")).toBe("true");

    ctrl.dispose();
  });

  it("开启免 Key 联网搜索时必须走现有 opt-in 授权确认弹窗闭环", async () => {
    const store = installOnboardingRuntimeMock();
    const { mountOnboardingPage } = await import("../../extension/entry/onboarding.js");
    const ctrl = await mountOnboardingPage(document);

    const toggle = document.getElementById("webSearchToggle") as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));

    // 弹出标准 opt-in 确认对话框（不绕过）
    await vi.waitFor(() => {
      expect(document.querySelector(".confirm-dialog")).not.toBeNull();
    });
    expect(store.getSettings().searchOptInNoticeAcknowledged).toBe(false);

    // 1) 点「关闭联网搜索」→ 关闭开关并保持未确认
    (document.querySelector(".confirm-dialog-cancel") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(toggle.checked).toBe(false);
    });
    expect(store.getSettings().webSearchEnabled).toBe(false);
    expect(store.getSettings().searchOptInNoticeAcknowledged).toBe(false);

    // 2) 重新打开并点「允许并继续」→ 置位 searchOptInNoticeAcknowledged
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector(".confirm-dialog")).not.toBeNull();
    });
    (document.querySelector(".confirm-dialog-confirm") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(store.getSettings().searchOptInNoticeAcknowledged).toBe(true);
    });
    expect(store.getSettings().webSearchEnabled).toBe(true);
    expect(document.getElementById("searchReadyBadge")?.getAttribute("data-ready")).toBe("true");

    ctrl.dispose();
  });

  it("步骤 1 固定图标图示按运行时切换：Chromium 显示图钉，Firefox 显示齿轮菜单指引", async () => {
    installOnboardingRuntimeMock();
    const runtime = globalThis.chrome.runtime as unknown as { getURL: (p: string) => string };
    runtime.getURL = (p: string) => `chrome-extension://test-id/${p}`;

    const { mountOnboardingPage } = await import("../../extension/entry/onboarding.js");
    const chromeCtrl = await mountOnboardingPage(document);
    expect(document.getElementById("onboardingExtMenuTitle")?.textContent).toBe("扩展程序");
    expect(document.getElementById("onboardingPinCaption")?.textContent).toBe("点击图钉固定到工具栏");
    expect(document.getElementById("onboardingPinIconChromium")?.getAttribute("display")).toBeNull();
    expect(document.getElementById("onboardingPinIconFirefox")?.getAttribute("display")).toBe("none");
    chromeCtrl.dispose();

    loadOnboardingDom();
    runtime.getURL = (p: string) => `moz-extension://test-uuid/${p}`;
    const ffCtrl = await mountOnboardingPage(document);
    expect(document.getElementById("onboardingExtMenuTitle")?.textContent).toBe("扩展");
    expect(document.getElementById("onboardingPinCaption")?.textContent).toBe("点齿轮选择固定到工具栏");
    expect(document.getElementById("onboardingPinIconChromium")?.getAttribute("display")).toBe("none");
    expect(document.getElementById("onboardingPinIconFirefox")?.getAttribute("display")).toBeNull();
    ffCtrl.dispose();
  });

  it("表单校验未通过时不提前触发域名权限申请（拉取/测试/保存五处一致）", async () => {
    installOnboardingRuntimeMock();
    const requestMock = (globalThis.chrome as unknown as { permissions: { request: ReturnType<typeof vi.fn> } })
      .permissions.request;
    const { mountOnboardingPage } = await import("../../extension/entry/onboarding.js");
    const ctrl = await mountOnboardingPage(document);

    // 默认 ModelScope 与 SiliconFlow 均要求 API Key，留空触发全部 5 个操作应直接拦截
    (document.getElementById("aiFetchModelsBtn") as HTMLButtonElement).click();
    (document.getElementById("aiTestBtn") as HTMLButtonElement).click();
    (document.getElementById("onboardingAiForm") as HTMLFormElement).dispatchEvent(
      new Event("submit", { cancelable: true, bubbles: true })
    );
    (document.getElementById("asrTestBtn") as HTMLButtonElement).click();
    (document.getElementById("onboardingAsrForm") as HTMLFormElement).dispatchEvent(
      new Event("submit", { cancelable: true, bubbles: true })
    );

    expect(requestMock).not.toHaveBeenCalled();
    expect(document.getElementById("aiApiKeyInput")?.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById("asrApiKeyInput")?.getAttribute("aria-invalid")).toBe("true");

    ctrl.dispose();
  });

  it("模型输入框自带下拉箭头：拉取 38 个模型后可展开、搜索过滤、点击选中并支持外点与 Esc 收起", async () => {
    const fetchedModels = Array.from({ length: 38 }, (_, i) =>
      i === 0 ? "Qwen/Qwen3-235B-A22B-Instruct-2507" : `vendor/model-${i + 1}`
    );
    installOnboardingRuntimeMock({ fetchedModels });
    const { mountOnboardingPage } = await import("../../extension/entry/onboarding.js");
    const ctrl = await mountOnboardingPage(document);

    const toggle = document.getElementById("aiModelDropdownToggle") as HTMLButtonElement;
    const dropdown = document.getElementById("aiModelDropdown") as HTMLElement;
    const modelInput = document.getElementById("aiModelInput") as HTMLInputElement;
    const apiKeyInput = document.getElementById("aiApiKeyInput") as HTMLInputElement;
    const fetchBtn = document.getElementById("aiFetchModelsBtn") as HTMLButtonElement;

    expect(toggle).toBeInstanceOf(HTMLButtonElement);
    expect(dropdown.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    // 1) 未拉取前点下拉箭头可直接看到当前预设的推荐模型
    toggle.click();
    expect(dropdown.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(dropdown.querySelectorAll(".model-picker-option").length).toBeGreaterThanOrEqual(3);

    // 点外部区域收起
    document.body.click();
    expect(dropdown.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    // 2) 填写 API Key 并点击「拉取模型」后，下拉展示 38+ 模型与搜索框
    apiKeyInput.value = "ms-test-key";
    fetchBtn.click();
    await vi.waitFor(() => {
      expect(document.getElementById("aiStatus")?.textContent).toBe("已获取 38 个可用模型");
    });

    toggle.click();
    expect(dropdown.hidden).toBe(false);
    const searchInput = dropdown.querySelector<HTMLInputElement>(".model-picker-search-input")!;
    expect(searchInput).not.toBeNull();
    expect(dropdown.querySelectorAll(".model-picker-option").length).toBeGreaterThanOrEqual(38);

    // 搜索过滤并选中某一项
    searchInput.value = "model-27";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    const visibleOptions = Array.from(dropdown.querySelectorAll<HTMLElement>(".model-picker-option")).filter(
      (el) => !el.hidden
    );
    expect(visibleOptions.map((el) => el.dataset.model)).toEqual(["vendor/model-27"]);

    visibleOptions[0].click();
    expect(modelInput.value).toBe("vendor/model-27");
    expect(dropdown.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    // 3) 输入框按 ArrowDown 可展开，按 Esc 收起并归焦按钮
    modelInput.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(dropdown.hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dropdown.hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);

    ctrl.dispose();
  });

  it("平台预设 / 接口协议 / 转写平台接入 custom-select，全页下拉箭头与设置回退样式统一为 14px chevron", async () => {
    installOnboardingRuntimeMock();
    const { mountOnboardingPage } = await import("../../extension/entry/onboarding.js");
    const ctrl = await mountOnboardingPage(document);

    const modelArrowPath = document
      .querySelector("#aiModelDropdownToggle svg path")
      ?.getAttribute("d");
    expect(modelArrowPath).toBe("m6 9 6 6 6-6");

    for (const selectId of ["aiPresetSelect", "aiProtocolSelect", "asrPresetSelect"]) {
      const select = document.getElementById(selectId) as HTMLSelectElement;
      const wrapper = select.closest(".custom-select-wrapper");
      expect(wrapper, `${selectId} 应接入 custom-select-wrapper`).not.toBeNull();
      expect(select.style.display).toBe("none");
      const arrowPath = wrapper?.querySelector(".custom-select-arrow svg path")?.getAttribute("d");
      expect(arrowPath).toBe(modelArrowPath);
    }

    // 通过 custom-select 切换平台预设（支持搜索）后同步更新地址与默认模型
    const presetWrapper = document.getElementById("aiPresetSelect")!.closest(".custom-select-wrapper")!;
    const presetTrigger = presetWrapper.querySelector<HTMLButtonElement>(".custom-select-trigger")!;
    const presetDropdown = presetWrapper.querySelector<HTMLElement>(".custom-select-dropdown")!;
    presetTrigger.click();
    expect(presetDropdown.hidden).toBe(false);
    const searchInput = presetDropdown.querySelector<HTMLInputElement>(".custom-select-search-input");
    expect(searchInput).not.toBeNull();

    const deepseekOption = presetDropdown.querySelector<HTMLElement>(
      '.custom-select-option[data-value="deepseek"]'
    )!;
    deepseekOption.click();
    expect(presetDropdown.hidden).toBe(true);
    expect((document.getElementById("aiPresetSelect") as HTMLSelectElement).value).toBe("deepseek");
    expect(presetTrigger.querySelector(".custom-select-value")?.textContent).toBe("DeepSeek");
    expect((document.getElementById("aiProtocolSelect") as HTMLSelectElement).value).toBe("anthropic");
    expect(
      document
        .getElementById("aiProtocolSelect")!
        .closest(".custom-select-wrapper")!
        .querySelector(".custom-select-value")?.textContent
    ).toContain("Anthropic");
    expect((document.getElementById("aiBaseUrlInput") as HTMLInputElement).value).toBe(
      "https://api.deepseek.com/anthropic"
    );

    const onboardingCss = readFileSync(join(process.cwd(), "extension", "entry", "styles", "onboarding.css"), "utf8");
    const shellCss = readFileSync(
      join(process.cwd(), "extension", "entry", "styles", "reader-settings-shell.css"),
      "utf8"
    );
    expect(onboardingCss).not.toMatch(/linear-gradient\(45deg,/);
    expect(shellCss).not.toMatch(/linear-gradient\(45deg,/);

    ctrl.dispose();
  });
});
