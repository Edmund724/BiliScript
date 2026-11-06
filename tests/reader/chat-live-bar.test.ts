import { describe, expect, it } from "vitest";
import { buildChatTabBodyHtml } from "../../extension/reader/chat-template.js";
import { ids } from "../../extension/reader/state.js";

describe("chat-live-bar and multi-state composer template", () => {
  it("renders live-bar with tabular-nums timer, mute, volume, speed, and end button", () => {
    const html = buildChatTabBodyHtml();
    const div = document.createElement("div");
    div.innerHTML = html;

    const liveBar = div.querySelector(`#${ids.readingChatLiveBar}`) as HTMLElement;
    expect(liveBar).not.toBeNull();
    expect(liveBar.hidden).toBe(true);

    const timer = div.querySelector(`#${ids.readingChatLiveTimer}`) as HTMLElement;
    expect(timer).not.toBeNull();
    expect(timer.textContent).toBe("00:00");

    const muteBtn = div.querySelector(`#${ids.readingChatLiveBarMuteBtn}`) as HTMLButtonElement;
    expect(muteBtn).not.toBeNull();

    const volBtn = div.querySelector(`#${ids.readingChatLiveBarVolumeBtn}`) as HTMLButtonElement;
    expect(volBtn).not.toBeNull();
    const volPop = div.querySelector(`#${ids.readingChatLiveBarVolumePop}`) as HTMLElement;
    expect(volPop.hidden).toBe(true);

    const speedBtn = div.querySelector(`#${ids.readingChatLiveBarSpeedBtn}`) as HTMLButtonElement;
    expect(speedBtn).not.toBeNull();
    const speedPop = div.querySelector(`#${ids.readingChatLiveBarSpeedPop}`) as HTMLElement;
    expect(speedPop.hidden).toBe(true);

    const endBtn = div.querySelector(`#${ids.readingChatLiveBarEndBtn}`) as HTMLButtonElement;
    expect(endBtn).not.toBeNull();
    expect(endBtn.textContent).toContain("End");
  });

  it("removes legacy standalone chatLiveBtn from toolbar and includes liveSwitchBtn next to sendBtn", () => {
    const html = buildChatTabBodyHtml();
    const div = document.createElement("div");
    div.innerHTML = html;

    // Legacy button on left is removed
    expect(div.querySelector(`#${ids.readingChatLiveBtn}`)).toBeNull();

    // Multi-state send button is present with is-live
    const sendBtn = div.querySelector(`#${ids.readingChatSendBtn}`) as HTMLButtonElement;
    expect(sendBtn).not.toBeNull();
    expect(sendBtn.classList.contains("is-live")).toBe(true);

    // Streaming switch button is present and hidden by default
    const switchBtn = div.querySelector(`#${ids.readingChatLiveSwitchBtn}`) as HTMLButtonElement;
    expect(switchBtn).not.toBeNull();
    expect(switchBtn.hidden).toBe(true);
  });

  it("decouples live volume in action area from speech volume in more menu", () => {
    const html = buildChatTabBodyHtml();
    const div = document.createElement("div");
    div.innerHTML = html;

    // Live bar has its own volume input for real-time live accompaniment
    const liveVolumeInput = div.querySelector(`#${ids.readingChatLiveBarVolumeInput}`) as HTMLInputElement;
    expect(liveVolumeInput).not.toBeNull();
    expect(liveVolumeInput.min).toBe("0");
    expect(liveVolumeInput.max).toBe("100");

    // Speed input in live bar has 5 discrete steps
    const speedInput = div.querySelector(`#${ids.readingChatLiveBarSpeedInput}`) as HTMLInputElement;
    expect(speedInput).not.toBeNull();
    expect(speedInput.min).toBe("0");
    expect(speedInput.max).toBe("4");
    expect(speedInput.step).toBe("1");
  });

  it("structures popovers with header badge and separate slider row to prevent number overflow", () => {
    const html = buildChatTabBodyHtml();
    const div = document.createElement("div");
    div.innerHTML = html;

    const volPop = div.querySelector(`#${ids.readingChatLiveBarVolumePop}`) as HTMLElement;
    const volHead = volPop.querySelector(".chat-live-pop-head");
    expect(volHead).not.toBeNull();
    const volBadge = volPop.querySelector(`#${ids.readingChatLiveBarVolumeValue}`);
    expect(volBadge?.classList.contains("chat-live-pop-badge")).toBe(true);
    expect(volBadge?.textContent).toBe("100%");

    const volSliderRow = volPop.querySelector(".chat-live-pop-slider-row");
    expect(volSliderRow).not.toBeNull();
    expect(volSliderRow?.querySelector(`#${ids.readingChatLiveBarVolumeInput}`)).not.toBeNull();

    const speedPop = div.querySelector(`#${ids.readingChatLiveBarSpeedPop}`) as HTMLElement;
    const speedBadge = speedPop.querySelector(`#${ids.readingChatLiveBarSpeedValue}`);
    expect(speedBadge?.classList.contains("chat-live-pop-badge")).toBe(true);
    expect(speedBadge?.textContent).toBe("1x");

    const ticks = speedPop.querySelectorAll(".chat-live-speed-tick");
    expect(ticks).toHaveLength(5);
  });
});
