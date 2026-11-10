import type { LiveChatState } from "../live/live-chat-controller.js";
import type { LiveFailureKind } from "../live/live-session-tracker.js";
import type { LiveSettingsTarget } from "../live/fullscreen-live-overlay.js";

export interface ChatLiveStatusDeps {
  root: HTMLElement | null;
  getState: () => LiveChatState;
  isReconnecting: () => boolean;
  onStart: () => void;
  onRetry: () => void;
  onStop: () => void;
  onRestore: () => void;
  onOpenSettings: (target: LiveSettingsTarget) => void;
}

export interface ChatLiveStatus {
  setOpen(open: boolean): void;
  sync(state?: LiveChatState, error?: string, failureKind?: LiveFailureKind): void;
}

type LiveStatusAction = "start" | "cancel" | "restore" | "retry" | "settings" | "stop";

const ACTIONS: Record<string, LiveStatusAction[]> = {
  idle: ["start", "settings"],
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

  root?.querySelectorAll<HTMLButtonElement>("[data-live-status-action]").forEach((button) => {
    const action = button.dataset.liveStatusAction as LiveStatusAction;
    buttons.set(action, button);
    button.addEventListener("click", () => {
      if (action === "start") deps.onStart();
      else if (action === "retry") deps.onRetry();
      else if (action === "stop" || action === "cancel") deps.onStop();
      else if (action === "restore") deps.onRestore();
      else if (action === "settings") {
        deps.onOpenSettings(currentFailureKind === "gemini-credential" ? "gemini-key" : "live");
      }
    });
  });

  function render(reconnecting: boolean): void {
    if (!root || !text || !open) return;
    const viewState = currentState === "connecting" && reconnecting ? "reconnecting" : currentState;
    root.dataset.state = viewState;
    if (viewState === "idle") text.textContent = "伴看未开启";
    else if (viewState === "connecting") text.textContent = "正在连接伴看…";
    else if (viewState === "connected") text.textContent = "伴看已连接";
    else if (viewState === "reconnecting") text.textContent = "伴看连接中断，正在重连…";
    else text.textContent = currentError?.trim() ? `伴看连接失败：${currentError}` : "伴看连接失败";

    const visibleActions = ACTIONS[viewState];
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
  }

  function setOpen(nextOpen: boolean): void {
    open = nextOpen;
    if (root) root.hidden = !open;
    if (open) sync();
  }

  return { setOpen, sync };
}
