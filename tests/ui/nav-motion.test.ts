// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { installSettingsPanelBus } from "../helpers/settings-panel-bus.js";

interface FakeAnimationRecord {
  target: HTMLElement;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  cancel: ReturnType<typeof vi.fn>;
  finish: () => void;
}

function installFakeWaapi(): FakeAnimationRecord[] {
  const records: FakeAnimationRecord[] = [];
  HTMLElement.prototype.animate = vi.fn(function (
    this: HTMLElement,
    keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    options?: number | KeyframeAnimationOptions
  ) {
    const listeners = new Map<string, Set<() => void>>();
    let done = false;
    const emit = (type: string) => {
      if (done) return;
      done = true;
      listeners.get(type)?.forEach((cb) => cb());
    };
    const cancel = vi.fn(() => emit("cancel"));
    const finish = () => emit("finish");
    const anim = {
      cancel,
      finish,
      addEventListener: vi.fn((type: string, cb: () => void) => {
        let set = listeners.get(type);
        if (!set) {
          set = new Set();
          listeners.set(type, set);
        }
        set.add(cb);
      })
    };
    records.push({
      target: this,
      keyframes: Array.isArray(keyframes) ? keyframes : [],
      options: typeof options === "number" ? { duration: options } : (options ?? {}),
      cancel,
      finish
    });
    return anim as unknown as Animation;
  }) as unknown as typeof HTMLElement.prototype.animate;
  return records;
}

function mockReducedMotion(matches: boolean): void {
  window.matchMedia = vi.fn().mockReturnValue({
    matches,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  }) as unknown as typeof window.matchMedia;
}

describe("设置导航水平过渡（主视图 ↔ 设置面板 & 总览 ↔ 多级子页）", () => {
  const origAnimate = HTMLElement.prototype.animate;
  const origMatchMedia = window.matchMedia;

  beforeEach(() => {
    resetModuleState();
    setLocationUrl(NORMAL_PAGE_URL);
    document.body.innerHTML = "";
    mockReducedMotion(false);
  });

  afterEach(() => {
    HTMLElement.prototype.animate = origAnimate;
    window.matchMedia = origMatchMedia;
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("主视图 ↔ 设置面板走双向水平推入/退回，关闭离场期间延迟复位子页并在收尾清理状态属性", async () => {
    const records = installFakeWaapi();
    const uiRenderer = await import("../../extension/ui/ui-renderer.js");
    const {
      closeReaderSettingsMode,
      openReaderSettingsMode,
      registerReaderSettingsCloseListener
    } = await import("../../extension/reader/settings-mode.js");
    const { ids } = await import("../../extension/reader/state.js");

    uiRenderer.ensureUiReady({ forceRecreate: true });
    const scriptPanel = document.getElementById(ids.readingScriptPanel)!;
    const settingsPanel = document.getElementById(ids.readingSettingsPanel)!;
    const tabsRow = scriptPanel.querySelector<HTMLElement>(".biliscript-reading-tabs-row")!;
    const subtitleBody = document.getElementById(ids.readingTabBodySubtitle)!;

    const onClose = vi.fn();
    const unregister = registerReaderSettingsCloseListener(onClose);

    try {
      openReaderSettingsMode();
      expect(settingsPanel.hidden).toBe(false);
      expect(scriptPanel.getAttribute("data-biliscript-settings-motion")).toBe("opening");

      const tabsExit = records.find((r) => r.target === tabsRow);
      const bodyExit = records.find((r) => r.target === subtitleBody);
      const settingsEnter = records.find((r) => r.target === settingsPanel);

      expect(tabsExit?.keyframes[1]?.transform).toBe("translate3d(-14px, 0px, 0)");
      expect(bodyExit?.keyframes[1]?.transform).toBe("translate3d(-14px, 0px, 0)");
      expect(settingsEnter?.keyframes[0]?.transform).toBe("translate3d(22px, 0, 0)");
      expect(settingsEnter?.keyframes[1]?.transform).toBe("translate3d(0, 0, 0)");

      const countBeforeSecondProject = records.length;
      const { projectReaderSettingsMode } = await import("../../extension/reader/settings-mode.js");
      projectReaderSettingsMode();
      expect(records.length).toBe(countBeforeSecondProject);

      tabsExit!.finish();
      bodyExit!.finish();
      expect(scriptPanel.getAttribute("data-biliscript-settings-motion")).toBeNull();
      settingsEnter!.finish();

      records.length = 0;
      closeReaderSettingsMode();
      expect(settingsPanel.hidden).toBe(true);
      expect(settingsPanel.getAttribute("data-biliscript-settings-leaving")).toBe("1");
      expect(scriptPanel.getAttribute("data-biliscript-settings-motion")).toBe("closing");
      expect(onClose).not.toHaveBeenCalled();

      const settingsExit = records.find((r) => r.target === settingsPanel);
      const tabsEnter = records.find((r) => r.target === tabsRow);
      const bodyEnter = records.find((r) => r.target === subtitleBody);

      expect(settingsExit?.keyframes[1]?.transform).toBe("translate3d(22px, 0px, 0)");
      expect(tabsEnter?.keyframes[0]?.transform).toBe("translate3d(-14px, 0, 0)");
      expect(bodyEnter?.keyframes[0]?.transform).toBe("translate3d(-14px, 0, 0)");

      settingsExit!.finish();
      expect(settingsPanel.getAttribute("data-biliscript-settings-leaving")).toBeNull();
      expect(onClose).toHaveBeenCalledTimes(1);

      tabsEnter!.finish();
      bodyEnter!.finish();
      expect(scriptPanel.getAttribute("data-biliscript-settings-motion")).toBeNull();
    } finally {
      unregister();
    }
  });

  it("关闭中途再次点击打开会立即中断并结算待执行复位，不残留离场标记", async () => {
    const records = installFakeWaapi();
    const uiRenderer = await import("../../extension/ui/ui-renderer.js");
    const {
      closeReaderSettingsMode,
      openReaderSettingsMode,
      registerReaderSettingsCloseListener
    } = await import("../../extension/reader/settings-mode.js");
    const { ids } = await import("../../extension/reader/state.js");

    uiRenderer.ensureUiReady({ forceRecreate: true });
    const scriptPanel = document.getElementById(ids.readingScriptPanel)!;
    const settingsPanel = document.getElementById(ids.readingSettingsPanel)!;
    const onClose = vi.fn();
    const unregister = registerReaderSettingsCloseListener(onClose);

    try {
      openReaderSettingsMode();
      records.forEach((r) => r.finish());
      records.length = 0;

      closeReaderSettingsMode();
      expect(settingsPanel.getAttribute("data-biliscript-settings-leaving")).toBe("1");
      expect(onClose).not.toHaveBeenCalled();

      openReaderSettingsMode();
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(settingsPanel.getAttribute("data-biliscript-settings-leaving")).toBeNull();
      expect(settingsPanel.hidden).toBe(false);
      expect(scriptPanel.getAttribute("data-biliscript-settings-motion")).toBe("opening");
    } finally {
      unregister();
    }
  });

  it("设置总览 ↔ 二级子页 ↔ 三级地址页复用同向水平推入/退回与标题滑动，收尾清除 leaving 状态", async () => {
    const records = installFakeWaapi();
    document.body.innerHTML = `
      <div id="biliscript-reading-view">
        <section id="biliscript-reading-settings-panel">
          <section class="biliscript-reading-settings-group biliscript-reading-settings-extension">
            <div id="biliscript-reading-settings-host"></div>
          </section>
        </section>
      </div>
    `;
    installSettingsPanelBus();
    const panel = await import("../../extension/ui/settings-panel.js");
    await panel.renderReaderSettingsPanel();

    const host = document.getElementById("biliscript-reading-settings-host")!;
    const rootView = host.querySelector<HTMLElement>("#biliscriptSettingsRootView")!;
    const agentView = host.querySelector<HTMLElement>("#biliscriptSettingsSubpageAgent")!;
    const addressView = host.querySelector<HTMLElement>("#agentBridgeAddressView")!;
    const title = host.querySelector<HTMLElement>("#biliscriptSettingsTitle")!;
    const backBtn = host.querySelector<HTMLButtonElement>("#biliscript-reading-settings-back-btn")!;

    records.length = 0;
    host.querySelector<HTMLButtonElement>("#openAgentSettingsBtn")!.click();

    expect(rootView.hidden).toBe(true);
    expect(agentView.hidden).toBe(false);
    expect(rootView.getAttribute("data-settings-view-leaving")).toBe("forward");

    const rootOut = records.find((r) => r.target === rootView);
    const agentIn = records.find((r) => r.target === agentView);
    const titleForward = records.find((r) => r.target === title);

    expect(rootOut?.keyframes[1]?.transform).toBe("translate3d(-16px, 0px, 0)");
    expect(agentIn?.keyframes[0]?.transform).toBe("translate3d(20px, 0, 0)");
    expect(titleForward?.keyframes[0]?.transform).toBe("translate3d(10px, 0, 0)");

    rootOut!.finish();
    expect(rootView.getAttribute("data-settings-view-leaving")).toBeNull();
    agentIn!.finish();
    titleForward!.finish();

    records.length = 0;
    host.querySelector<HTMLButtonElement>("#agentBridgeAddressBtn")!.click();
    expect(agentView.getAttribute("data-settings-view-leaving")).toBe("forward");
    expect(records.find((r) => r.target === addressView)?.keyframes[0]?.transform).toBe("translate3d(20px, 0, 0)");
    records.forEach((r) => r.finish());

    records.length = 0;
    backBtn.click();
    expect(addressView.getAttribute("data-settings-view-leaving")).toBe("backward");

    const addrOut = records.find((r) => r.target === addressView);
    const agentBackIn = records.find((r) => r.target === agentView);
    const titleBackward = records.find((r) => r.target === title);

    expect(addrOut?.keyframes[1]?.transform).toBe("translate3d(20px, 0px, 0)");
    expect(agentBackIn?.keyframes[0]?.transform).toBe("translate3d(-16px, 0, 0)");
    expect(titleBackward?.keyframes[0]?.transform).toBe("translate3d(-10px, 0, 0)");

    addrOut!.finish();
    expect(addressView.getAttribute("data-settings-view-leaving")).toBeNull();
  });

  it("prefers-reduced-motion: reduce 退化为纯透明度淡入且不产生水平位移", async () => {
    mockReducedMotion(true);
    const records = installFakeWaapi();
    const uiRenderer = await import("../../extension/ui/ui-renderer.js");
    const { openReaderSettingsMode } = await import("../../extension/reader/settings-mode.js");
    const { ids } = await import("../../extension/reader/state.js");

    uiRenderer.ensureUiReady({ forceRecreate: true });
    const scriptPanel = document.getElementById(ids.readingScriptPanel)!;
    const settingsPanel = document.getElementById(ids.readingSettingsPanel)!;

    openReaderSettingsMode();
    expect(scriptPanel.getAttribute("data-biliscript-settings-motion")).toBeNull();
    const enterAnim = records.find((r) => r.target === settingsPanel);
    expect(enterAnim?.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  });
});
