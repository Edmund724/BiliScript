import type { LiveChatState } from "../live/live-chat-controller.js";
import type { LiveFailureKind } from "../live/live-session-tracker.js";
import type { LiveSettingsTarget } from "../live/fullscreen-live-overlay.js";
import type { LiveTextToolRecord } from "../live/live-text-tool-records.js";
import { createChatLiveTextRecords } from "./chat-live-text-records.js";

export interface ChatLiveStatusDeps {
  root: HTMLElement | null;
  getState: () => LiveChatState;
  isReconnecting: () => boolean;
  getTextToolRecords?: () => LiveTextToolRecord[];
  subscribeTextToolRecords?: (listener: () => void) => () => void;
  onRetry: () => void;
  onStop: () => void;
  onRestore: () => void;
  onOpenSettings: (target: LiveSettingsTarget) => void;
  onRetryTextToolRecord?: (callId: string) => void;
  onContinueTextToolRecord?: (callId: string) => void;
}

export interface ChatLiveStatus {
  setOpen(open: boolean): void;
  sync(state?: LiveChatState, error?: string, failureKind?: LiveFailureKind): void;
}

type LiveStatusAction = "cancel" | "restore" | "retry" | "settings" | "stop";

const ACTIONS: Record<string, LiveStatusAction[]> = {
  idle: [],
  connecting: ["cancel"],
  connected: ["restore", "stop"],
  reconnecting: ["restore", "cancel"],
  failure: ["retry", "settings", "stop"]
};

export function createChatLiveStatus(deps: ChatLiveStatusDeps): ChatLiveStatus {
  const root = deps.root;
  const text = root?.querySelector<HTMLElement>(".chat-live-status-text") ?? null;
  const buttons = new Map<LiveStatusAction, HTMLButtonElement>();
  let open = false;
  let currentState: LiveChatState = "idle";
  let currentError: string | undefined;
  let currentFailureKind: LiveFailureKind | undefined;
  const textRecords = createChatLiveTextRecords({
    root: root?.querySelector<HTMLElement>(".chat-live-tool-records") ?? null,
    getRecords: deps.getTextToolRecords ?? (() => []),
    subscribe: deps.subscribeTextToolRecords ?? (() => () => {}),
    onRetry: (callId) => deps.onRetryTextToolRecord?.(callId),
    onContinue: (callId) => deps.onContinueTextToolRecord?.(callId)
  });

  root?.querySelectorAll<HTMLButtonElement>("[data-live-status-action]").forEach((button) => {
    const action = button.dataset.liveStatusAction as LiveStatusAction;
    buttons.set(action, button);
    button.addEventListener("click", () => {
      if (action === "retry") deps.onRetry();
      else if (action === "stop" || action === "cancel") deps.onStop();
      else if (action === "restore") deps.onRestore();
      else if (action === "settings") {
        deps.onOpenSettings(currentFailureKind === "gemini-credential" ? "gemini-key" : "live");
      }
    });
  });

  function render(reconnecting: boolean): void {
    if (!root || !text) return;
    const viewState = currentState === "connecting" && reconnecting ? "reconnecting" : currentState;
    root.dataset.state = viewState;
    const isIdle = viewState === "idle";
    root.hidden = !open || isIdle;
    if (!open) return;

    if (isIdle) {
      text.textContent = "";
    } else if (viewState === "connecting") {
      text.textContent = "正在连接伴看…";
    } else if (viewState === "connected") {
      text.textContent = "伴看已连接";
    } else if (viewState === "reconnecting") {
      text.textContent = "伴看连接中断，正在重连…";
    } else {
      text.textContent = currentError?.trim() ? `伴看连接失败：${currentError}` : "伴看连接失败";
    }

    const visibleActions = ACTIONS[viewState] ?? [];
    buttons.forEach((button, action) => {
      button.hidden = !visibleActions.includes(action);
    });
  }

  function sync(state = deps.getState(), error?: string, failureKind?: LiveFailureKind): void {
    currentState = state;
    if (state === "failure") {
      if (error !== undefined || failureKind !== undefined) {
        currentError = error;
        currentFailureKind = failureKind;
      }
    } else {
      currentError = undefined;
      currentFailureKind = undefined;
    }
    render(state === "connecting" && deps.isReconnecting());
    textRecords.sync();
  }

  function setOpen(nextOpen: boolean): void {
    open = nextOpen;
    textRecords.setOpen(open);
    if (!open) {
      if (root) root.hidden = true;
    } else {
      sync();
    }
  }

  return { setOpen, sync };
}
