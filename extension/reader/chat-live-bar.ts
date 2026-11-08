// extension/reader/chat-live-bar.ts
// 文摘面板「AI 对话」tab 顶部的实时伴看状态条（LiveBar）视图控制器。
// 内聚：
// 1. 会话计时器（00:00）、连接/说话状态圆点、麦克风 VAD 动效与视频原声状态文案
// 2. 音量与语速气泡弹层的开合互斥、外点关闭与 Esc 收起
// 3. 音量滑轨、语速刻度滑轨、分享视频原声与语音优先开关的 DOM 绑定及设置持久化

import { state } from "../core/state.js";
import { normalizeLiveVoiceVolume } from "../core/validators.js";
import type { LiveChatController, LiveChatState } from "../live/live-chat-controller.js";
import { persistLiveAudioSettings } from "../live/live-overlay-binding.js";
import {
  DEFAULT_LIVE_VOICE_SPEED,
  LIVE_VOICE_SPEED_STEPS
} from "../live/moss-live-protocol.js";

export interface ChatLiveBarElements {
  liveBar: HTMLElement | null;
  liveStatusDot: HTMLElement | null;
  liveTimer: HTMLElement | null;
  liveBarMuteBtn: HTMLButtonElement | null;
  liveMuteBtn: HTMLButtonElement | null;
  liveBarVolumeBtn: HTMLButtonElement | null;
  liveBarVolumePop: HTMLElement | null;
  liveBarVolumeInput: HTMLInputElement | null;
  liveBarVolumeValue: HTMLElement | null;
  liveBarShareAudioSwitch: HTMLButtonElement | null;
  liveBarShareAudioStatus: HTMLElement | null;
  liveBarVoicePrioritySwitch: HTMLButtonElement | null;
  liveBarSpeedBtn: HTMLButtonElement | null;
  liveBarSpeedPop: HTMLElement | null;
  liveBarSpeedInput: HTMLInputElement | null;
  liveBarSpeedValue: HTMLElement | null;
  liveBarEndBtn: HTMLButtonElement | null;
  liveSwitchBtn: HTMLButtonElement | null;
}

export interface CreateChatLiveBarDeps {
  elements: ChatLiveBarElements;
  getLiveController: () => LiveChatController | null;
  onSyncComposerSendState: () => void;
  onBeforeManualStart?: () => void;
}

export interface ChatLiveBar {
  bindEvents(): {
    initialVolume: number;
    initialShareVideoAudio: boolean;
    initialVoicePriority: boolean;
  };
  syncState(liveState: LiveChatState): void;
  syncSpeaking(speaking: boolean): void;
  syncVad(active: boolean): void;
  syncVideoAudioStatus(status: string): void;
  syncVolume(volumePercent: number): void;
  syncVoicePriority(enabled: boolean): void;
  syncShareVideoAudio(enabled: boolean): void;
  closePopovers(): void;
  handleOutsideClick(event: MouseEvent): void;
}

export function createChatLiveBar(deps: CreateChatLiveBarDeps): ChatLiveBar {
  const { elements: els } = deps;
  let liveTimerInterval: number | null = null;
  let liveSessionStartTime = 0;

  function stopLiveTimer(): void {
    if (liveTimerInterval !== null) {
      window.clearInterval(liveTimerInterval);
      liveTimerInterval = null;
    }
    if (els.liveTimer) {
      els.liveTimer.textContent = "00:00";
    }
  }

  function startLiveTimer(): void {
    stopLiveTimer();
    liveSessionStartTime = Date.now();
    liveTimerInterval = window.setInterval(() => {
      if (!els.liveTimer) return;
      const elapsedSec = Math.floor((Date.now() - liveSessionStartTime) / 1000);
      const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
      const ss = String(elapsedSec % 60).padStart(2, "0");
      els.liveTimer.textContent = `${mm}:${ss}`;
    }, 1000);
  }

  function closePopovers(): void {
    if (els.liveBarVolumePop) els.liveBarVolumePop.hidden = true;
    if (els.liveBarSpeedPop) els.liveBarSpeedPop.hidden = true;
  }

  function handleOutsideClick(event: MouseEvent): void {
    if (!event.target || !(event.target as HTMLElement).closest(".chat-live-pop-anchor")) {
      closePopovers();
    }
  }

  function syncState(liveState: LiveChatState): void {
    if (!els.liveBar) {
      deps.onSyncComposerSendState();
      return;
    }
    if (liveState === "connecting") {
      els.liveBar.hidden = false;
      if (els.liveStatusDot) {
        els.liveStatusDot.className = "chat-live-status-dot is-connecting";
      }
      stopLiveTimer();
    } else if (liveState === "connected") {
      els.liveBar.hidden = false;
      if (els.liveStatusDot) {
        els.liveStatusDot.className = "chat-live-status-dot";
      }
      startLiveTimer();
    } else {
      els.liveBar.hidden = true;
      if (els.liveStatusDot) {
        els.liveStatusDot.className = "chat-live-status-dot";
      }
      stopLiveTimer();
      closePopovers();
      if (els.liveBarShareAudioStatus) {
        els.liveBarShareAudioStatus.textContent = "未开启";
        els.liveBarShareAudioStatus.dataset.status = "未开启";
      }
    }
    deps.onSyncComposerSendState();
  }

  function syncSpeaking(speaking: boolean): void {
    if (els.liveStatusDot) {
      els.liveStatusDot.classList.toggle("is-speaking", speaking);
    }
    deps.onSyncComposerSendState();
  }

  function syncVad(active: boolean): void {
    const muteBtn = els.liveBarMuteBtn ?? els.liveMuteBtn;
    if (muteBtn) {
      muteBtn.classList.toggle("is-talking", active);
    }
  }

  function syncVideoAudioStatus(status: string): void {
    if (els.liveBarShareAudioStatus) {
      els.liveBarShareAudioStatus.textContent = status;
      els.liveBarShareAudioStatus.dataset.status = status;
    }
  }

  function syncVolume(volumePercent: number): void {
    if (els.liveBarVolumeInput) {
      els.liveBarVolumeInput.value = String(volumePercent);
      els.liveBarVolumeInput.style.setProperty("--live-progress", `${volumePercent}%`);
    }
    if (els.liveBarVolumeValue) {
      els.liveBarVolumeValue.textContent = `${volumePercent}%`;
    }
  }

  function syncVoicePriority(enabled: boolean): void {
    if (els.liveBarVoicePrioritySwitch) {
      els.liveBarVoicePrioritySwitch.dataset.on = String(enabled);
      els.liveBarVoicePrioritySwitch.setAttribute("aria-checked", String(enabled));
    }
  }

  function syncShareVideoAudio(enabled: boolean): void {
    if (els.liveBarShareAudioSwitch) {
      els.liveBarShareAudioSwitch.dataset.on = String(enabled);
      els.liveBarShareAudioSwitch.setAttribute("aria-checked", String(enabled));
    }
  }

  function bindEvents() {
    const initVol = normalizeLiveVoiceVolume(state.settings?.liveVoiceVolume);
    const initialShareVideoAudio = state.settings?.liveShareVideoAudio === true;
    const initialVoicePriority = state.settings?.liveVoicePriority !== false;

    if (els.liveBarVolumeInput) {
      syncVolume(initVol);
      els.liveBarVolumeInput.addEventListener("input", (e: Event) => {
        const target = e.target as HTMLInputElement;
        const val = normalizeLiveVoiceVolume(target.value);
        syncVolume(val);
        deps.getLiveController()?.setVolume(val / 100);
        persistLiveAudioSettings({ liveVoiceVolume: val });
      });
    }

    if (els.liveBarShareAudioSwitch) {
      const switchEl = els.liveBarShareAudioSwitch;
      syncShareVideoAudio(initialShareVideoAudio);
      switchEl.addEventListener("click", (e) => {
        e.stopPropagation();
        const nextOn = switchEl.dataset.on !== "true";
        syncShareVideoAudio(nextOn);
        deps.getLiveController()?.setShareVideoAudio(nextOn);
        persistLiveAudioSettings({ liveShareVideoAudio: nextOn });
        if (!nextOn) {
          syncVideoAudioStatus("未开启");
        }
      });
    }

    if (els.liveBarVoicePrioritySwitch) {
      const switchEl = els.liveBarVoicePrioritySwitch;
      syncVoicePriority(initialVoicePriority);
      switchEl.addEventListener("click", (e) => {
        e.stopPropagation();
        const nextOn = switchEl.dataset.on !== "true";
        syncVoicePriority(nextOn);
        deps.getLiveController()?.setVoicePriority(nextOn);
        persistLiveAudioSettings({ liveVoicePriority: nextOn });
      });
    }

    if (els.liveBarSpeedInput) {
      els.liveBarSpeedInput.value = "1";
      els.liveBarSpeedInput.style.setProperty("--live-progress", "25%");
      if (els.liveBarSpeedValue) {
        els.liveBarSpeedValue.textContent = "1x";
      }
      els.liveBarSpeedInput.addEventListener("input", (e: Event) => {
        const target = e.target as HTMLInputElement;
        const stepIdx = Number(target.value);
        const progressPct = Math.round((stepIdx / 4) * 100);
        target.style.setProperty("--live-progress", `${progressPct}%`);
        const speed = LIVE_VOICE_SPEED_STEPS[stepIdx] ?? DEFAULT_LIVE_VOICE_SPEED;
        if (els.liveBarSpeedValue) {
          els.liveBarSpeedValue.textContent = `${speed}x`;
        }
        deps.getLiveController()?.setSpeed(speed);
      });
    }

    els.liveBarVolumeBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (els.liveBarVolumePop) {
        const willOpen = els.liveBarVolumePop.hidden;
        closePopovers();
        els.liveBarVolumePop.hidden = !willOpen;
      }
    });

    els.liveBarSpeedBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (els.liveBarSpeedPop) {
        const willOpen = els.liveBarSpeedPop.hidden;
        closePopovers();
        els.liveBarSpeedPop.hidden = !willOpen;
      }
    });

    els.liveBarVolumePop?.addEventListener("click", (e) => {
      e.stopPropagation();
    });
    els.liveBarSpeedPop?.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    els.liveBarEndBtn?.addEventListener("click", () => {
      void deps.getLiveController()?.stop();
    });

    els.liveSwitchBtn?.addEventListener("click", () => {
      deps.onBeforeManualStart?.();
      void deps.getLiveController()?.start();
    });

    return {
      initialVolume: initVol / 100,
      initialShareVideoAudio,
      initialVoicePriority
    };
  }

  return {
    bindEvents,
    syncState,
    syncSpeaking,
    syncVad,
    syncVideoAudioStatus,
    syncVolume,
    syncVoicePriority,
    syncShareVideoAudio,
    closePopovers,
    handleOutsideClick
  };
}
