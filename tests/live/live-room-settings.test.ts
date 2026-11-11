import { afterEach, describe, expect, it, vi } from "vitest";
import { closeLiveRoomSettings, openLiveRoomSettings } from "../../extension/live/live-room-settings.js";

vi.mock("../../extension/ui/settings-panel.js", () => ({
  renderReaderSettingsPanel: vi.fn(),
  openLiveSettings: vi.fn(async () => {})
}));

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");

afterEach(() => {
  document.body.innerHTML = "";
  closeLiveRoomSettings();
  vi.clearAllMocks();
  if (originalShowModal) {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShowModal);
  } else {
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  }
  if (originalClose) {
    Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose);
  } else {
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  }
});

describe("直播间伴看设置", () => {
  it("点击后按需装载设置面板，复用对话框并可彻底关闭", async () => {
    const showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    const close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    });
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { value: showModal, configurable: true });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { value: close, configurable: true });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const panel = await import("../../extension/ui/settings-panel.js");

    await openLiveRoomSettings("live", () => host);
    const dialog = host.querySelector<HTMLDialogElement>(".biliscript-live-room-settings");
    expect(dialog?.open).toBe(true);
    expect(dialog?.getAttribute("aria-label")).toBe("伴看平台与密钥");
    expect(dialog?.querySelector("#biliscript-reading-settings-host")).not.toBeNull();
    expect(panel.renderReaderSettingsPanel).toHaveBeenCalledTimes(1);
    expect(panel.openLiveSettings).toHaveBeenCalledWith("live");
    expect(showModal).toHaveBeenCalledTimes(1);

    await openLiveRoomSettings("gemini-key", () => host);
    expect(host.querySelectorAll(".biliscript-live-room-settings")).toHaveLength(1);
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(panel.openLiveSettings).toHaveBeenCalledWith("gemini-key");

    closeLiveRoomSettings();
    expect(close).toHaveBeenCalled();
    expect(host.querySelector(".biliscript-live-room-settings")).toBeNull();
  });
});
