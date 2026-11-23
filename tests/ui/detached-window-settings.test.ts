import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installSettingsPanelBus } from "../helpers/settings-panel-bus.js";
import { DETACHED_WINDOW_BOUNDS_KEY } from "../../extension/core/detached-bounds-store.js";

type SentMessage = { type: string; settings?: Record<string, unknown>; [key: string]: unknown };

function fireClick(node: Element): void {
  node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

async function mountPanel(initialSettings: Record<string, unknown> = {}): Promise<{
  host: HTMLElement;
  sent: SentMessage[];
}> {
  const bus = installSettingsPanelBus<SentMessage>({
    "get-settings": () => ({ ok: true, settings: initialSettings })
  });
  document.body.innerHTML =
    '<div id="biliscript-reading-view"><div id="biliscript-reading-settings-host"></div></div>';
  const panel = await import("../../extension/ui/settings-panel.js");
  panel.renderReaderSettingsPanel();
  const host = document.getElementById("biliscript-reading-settings-host")!;
  await vi.waitFor(() => {
    expect(bus.sent.some((message) => message.type === "asr-providers-list")).toBe(true);
  });
  return { host, sent: bus.sent };
}

beforeEach(() => {
  resetModuleState();
});

describe("detachedWindowMode 设置控件与偏好重置", () => {
  it("在「阅读器与播放器」渲染并回填当前值，切换选项保存至 sync 且受外部变更同步", async () => {
    const addListenerCalls: Array<
      (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void
    > = [];
    vi.spyOn(chrome.storage.onChanged, "addListener").mockImplementation((fn) => {
      addListenerCalls.push(fn);
    });

    const { host, sent } = await mountPanel({ detachedWindowMode: "popup" });

    const subpage = host.querySelector("#biliscriptSettingsSubpageAppearance")!;
    const select = subpage.querySelector<HTMLSelectElement>("#detachedWindowMode")!;
    expect(select).toBeTruthy();
    await vi.waitFor(() => {
      expect(select.value).toBe("popup");
    });

    const wrapper = select.closest<HTMLElement>(".custom-select-wrapper")!;
    const pipOption = wrapper.querySelector<HTMLElement>('.custom-select-option[data-value="pip"]')!;
    fireClick(pipOption);

    await vi.waitFor(() => {
      expect(
        sent.some(
          (message) =>
            message.type === "save-settings" && message.settings?.detachedWindowMode === "pip"
        )
      ).toBe(true);
    });

    for (const listener of addListenerCalls) {
      listener(
        {
          detachedWindowMode: { oldValue: "pip", newValue: "popup" }
        },
        "sync"
      );
    }
    expect(select.value).toBe("popup");
  });

  it("停靠态切换不触发模式迁移钩子；独立窗口态下在 change 同步栈内立即触发 requestDetachedModeSwitch", async () => {
    const activeHost = await import("../../extension/shared/active-host.js");
    const switchEvents: string[] = [];
    const unregister = activeHost.registerDetachedModeSwitchHandler((mode) => {
      switchEvents.push(mode);
    });

    const { host, sent } = await mountPanel({ detachedWindowMode: "pip" });
    const select = host.querySelector<HTMLSelectElement>("#detachedWindowMode")!;

    select.value = "popup";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(switchEvents).toEqual([]);

    const detachedDoc = document.implementation.createHTMLDocument("Detached");
    const detachedWin = { closed: false } as unknown as Window;
    activeHost.setActiveReaderHost(detachedDoc, detachedWin);

    const saveCountBefore = sent.filter((message) => message.type === "save-settings").length;
    select.value = "pip";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    expect(switchEvents).toEqual(["pip"]);
    expect(sent.filter((message) => message.type === "save-settings").length).toBeGreaterThan(
      saveCountBefore
    );

    unregister();
  });

  it("独立窗口态模式切换回调异步拒绝时不产生未处理 rejection", async () => {
    const activeHost = await import("../../extension/shared/active-host.js");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const unregister = activeHost.registerDetachedModeSwitchHandler(() =>
      Promise.reject(new Error("switch failed"))
    );

    try {
      const { host } = await mountPanel({ detachedWindowMode: "pip" });
      const detachedDoc = document.implementation.createHTMLDocument("Detached");
      const detachedWin = { closed: false } as unknown as Window;
      activeHost.setActiveReaderHost(detachedDoc, detachedWin);

      const select = host.querySelector<HTMLSelectElement>("#detachedWindowMode")!;
      select.value = "popup";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      unregister();
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("独立窗口态模式切换回调同步抛出时不触发 window error 且仍保存设置", async () => {
    const activeHost = await import("../../extension/shared/active-host.js");
    const windowErrors: unknown[] = [];
    const onWindowError = (event: ErrorEvent) => {
      event.preventDefault();
      windowErrors.push(event.error ?? event.message);
    };
    window.addEventListener("error", onWindowError);
    const unregister = activeHost.registerDetachedModeSwitchHandler(() => {
      throw new Error("sync switch failed");
    });

    try {
      const { host, sent } = await mountPanel({ detachedWindowMode: "pip" });
      const detachedDoc = document.implementation.createHTMLDocument("Detached");
      const detachedWin = { closed: false } as unknown as Window;
      activeHost.setActiveReaderHost(detachedDoc, detachedWin);

      const sentBefore = sent.length;
      const select = host.querySelector<HTMLSelectElement>("#detachedWindowMode")!;
      select.value = "popup";
      select.dispatchEvent(new Event("change", { bubbles: true }));

      await vi.waitFor(() => {
        expect(
          sent
            .slice(sentBefore)
            .some(
              (message) =>
                message.type === "save-settings" && message.settings?.detachedWindowMode === "popup"
            )
        ).toBe(true);
      });
      expect(windowErrors).toEqual([]);
    } finally {
      unregister();
      window.removeEventListener("error", onWindowError);
    }
  });

  it("「恢复默认偏好」重置 sync detachedWindowMode 为 pip 并清除 local 窗口尺寸；取消则保留 local 尺寸", async () => {
    await chrome.storage.local.set({ [DETACHED_WINDOW_BOUNDS_KEY]: { width: 620, height: 700 } });
    const { host, sent } = await mountPanel({ detachedWindowMode: "popup" });

    fireClick(host.querySelector("#biliscriptSettingsResetBtn")!);
    const cancelBtn = await vi.waitFor(() => {
      const node = document.querySelector(".confirm-dialog-cancel");
      if (!node) throw new Error("确认弹层未打开");
      return node;
    });
    fireClick(cancelBtn);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const storedAfterCancel = await chrome.storage.local.get([DETACHED_WINDOW_BOUNDS_KEY]);
    expect(storedAfterCancel[DETACHED_WINDOW_BOUNDS_KEY]).toEqual({ width: 620, height: 700 });

    fireClick(host.querySelector("#biliscriptSettingsResetBtn")!);
    const confirmBtn = await vi.waitFor(() => {
      const node = document.querySelector(".confirm-dialog-confirm");
      if (!node) throw new Error("确认弹层未打开");
      return node;
    });
    fireClick(confirmBtn);

    await vi.waitFor(() => {
      expect(
        sent.some(
          (message) =>
            message.type === "save-settings" && message.settings?.detachedWindowMode === "pip"
        )
      ).toBe(true);
    });

    await vi.waitFor(async () => {
      const storedAfterReset = await chrome.storage.local.get([DETACHED_WINDOW_BOUNDS_KEY]);
      expect(storedAfterReset[DETACHED_WINDOW_BOUNDS_KEY]).toBeUndefined();
    });
  });
});
