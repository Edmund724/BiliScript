import { ids } from "../shared/dom-ids.js";
import { escapeHtml } from "../shared/string-utils.js";
import { DEFAULT_COPY_FEEDBACK_MS } from "./copy-feedback.js";
import { READING_HEADER_ICONS } from "./reading-header-icons.js";
import { mountPanelModalShell, type PanelModalShell } from "./focus-scope.js";

export type HostPlatform = "windows" | "macos" | "linux";

const DEFAULT_BRIDGE_PORT = "18492";
const INSTALL_BASE_URL = "https://raw.githubusercontent.com/Edmund724/BiliScript/main/scripts";
const INITIAL_COPY_LABEL = "复制指令";
const COPIED_LABEL = "已复制";
const COPY_FAILED_LABEL = "请手动复制";

type NavigatorWithUAData = Navigator & {
  userAgentData?: { platform?: string };
};

function matchHostPlatform(hint: string): HostPlatform | null {
  const lower = hint.trim().toLowerCase();
  if (!lower) return null;
  if (lower.includes("mac") || lower.includes("darwin")) return "macos";
  if (lower.includes("windows") || /\bwin(?:32|64)?\b/.test(lower)) return "windows";
  if (lower.includes("linux") || lower.includes("x11") || lower.includes("cros")) return "linux";
  return null;
}

export function detectHostPlatform(): HostPlatform {
  if (typeof navigator === "undefined") return "windows";
  const nav = navigator as NavigatorWithUAData;
  return (
    matchHostPlatform(nav.userAgentData?.platform ?? "") ??
    matchHostPlatform(navigator.platform ?? "") ??
    matchHostPlatform(navigator.userAgent ?? "") ??
    "windows"
  );
}

function resolveBridgePort(address: string): string {
  try {
    const port = new URL(address).port;
    if (/^\d+$/.test(port)) return port;
  } catch {
  }
  return DEFAULT_BRIDGE_PORT;
}

export function buildAgentBridgeInstallPrompt(
  address: string,
  platform: HostPlatform = detectHostPlatform()
): string {
  const port = resolveBridgePort(address);
  if (platform === "windows") {
    const portPrefix = port === DEFAULT_BRIDGE_PORT
      ? ""
      : `$env:BILISCRIPT_BRIDGE_PORT='${port}'; `;
    return `请使用以下命令帮我安装并配置 BiliScript 本地 Agent。
必须在运行浏览器的 Windows 宿主机（非沙箱、非容器、非 WSL）中执行。若你无法访问该环境，请让我自行在本机 PowerShell 执行，不要在其他环境中启动 Bridge：
${portPrefix}irm ${INSTALL_BASE_URL}/install-agent.ps1 | iex
完成后提醒我回扩展点击「去连接」。若失败，请给出完整错误。`;
  }

  const hostLabel = platform === "macos" ? "macOS" : "Linux";
  const portEnv = port === DEFAULT_BRIDGE_PORT
    ? ""
    : `BILISCRIPT_BRIDGE_PORT=${port} `;
  return `请使用以下命令帮我安装并配置 BiliScript 本地 Agent。
必须在运行浏览器的 ${hostLabel} 宿主机（非沙箱、非容器）中执行。若你无法访问该环境，请让我自行在本机终端执行，不要在其他环境中启动 Bridge：
curl -fsSL ${INSTALL_BASE_URL}/install-agent.sh | ${portEnv}sh
完成后提醒我回扩展点击「去连接」。若失败，请给出完整错误。`;
}

interface DialogState {
  shell: PanelModalShell | null;
  generation: number;
  copyTimer: ReturnType<typeof setTimeout> | null;
  copySeq: number;
}

const state: DialogState = {
  shell: null,
  generation: 0,
  copyTimer: null,
  copySeq: 0
};

function clearCopyTimer(): void {
  if (state.copyTimer !== null) {
    clearTimeout(state.copyTimer);
    state.copyTimer = null;
  }
}

function closeDialog(generation = state.generation): void {
  if (generation !== state.generation || !state.shell) return;
  clearCopyTimer();
  state.copySeq += 1;
  state.shell.dispose();
  state.shell = null;
}

export function openAgentBridgeInstallDialog(address: string): void {
  closeDialog();
  const mountHost = document.getElementById(ids.readingView);
  if (!mountHost) return;
  const prompt = buildAgentBridgeInstallPrompt(address);
  const generation = state.generation + 1;
  state.generation = generation;

  const shell = mountPanelModalShell({
    mountHost,
    hostClassName: "confirm-dialog-host agent-bridge-install-host",
    dialogSelector: ".agent-bridge-install-dialog",
    html: `
    <div class="confirm-dialog-mask" data-agent-install-action="close"></div>
    <section class="confirm-dialog agent-bridge-install-dialog" role="dialog" aria-modal="true" aria-labelledby="agentBridgeInstallTitle" aria-describedby="agentBridgeInstallDescription" tabindex="-1">
      <button type="button" class="agent-bridge-install-close" data-agent-install-action="close" aria-label="关闭" title="关闭">${READING_HEADER_ICONS.close}</button>
      <h2 id="agentBridgeInstallTitle">本地 Agent 未连接</h2>
      <p id="agentBridgeInstallDescription">将指令发给你的 Agent，安装完成后回到这里点击「去连接」。</p>
      <div class="agent-bridge-install-prompt-card">
        <textarea class="agent-bridge-install-prompt" readonly aria-label="BiliScript 安装 Prompt">${escapeHtml(prompt)}</textarea>
        <button type="button" class="agent-bridge-install-copy" data-agent-install-action="copy">${INITIAL_COPY_LABEL}</button>
        <p class="biliscript-sr-only agent-bridge-install-status" role="status" aria-live="polite" aria-atomic="true"></p>
      </div>
    </section>`,
    isTopLayer: () => state.generation === generation,
    onRequestDismiss: () => closeDialog(generation),
    onForceDismiss: () => closeDialog(generation)
  });
  state.shell = shell;

  const promptTextarea = shell.host.querySelector<HTMLTextAreaElement>(".agent-bridge-install-prompt");
  if (promptTextarea && (typeof CSS === "undefined" || !CSS.supports?.("field-sizing", "content"))) {
    promptTextarea.style.height = "auto";
    const measuredHeight = promptTextarea.scrollHeight;
    if (measuredHeight > 0) {
      promptTextarea.style.height = `${measuredHeight}px`;
    }
  }

  shell.host.addEventListener("click", (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>("[data-agent-install-action]")?.dataset.agentInstallAction;
    if (action === "close") {
      closeDialog(generation);
      return;
    }
    if (action !== "copy") return;
    const button = shell.host.querySelector<HTMLButtonElement>('[data-agent-install-action="copy"]')!;
    const textarea = shell.host.querySelector<HTMLTextAreaElement>(".agent-bridge-install-prompt")!;
    const statusEl = shell.host.querySelector<HTMLElement>(".agent-bridge-install-status")!;
    const seq = ++state.copySeq;
    clearCopyTimer();

    const announceStatus = (text: string): void => {
      if (statusEl.textContent === text) {
        statusEl.textContent = "";
      }
      statusEl.textContent = text;
    };

    void (async () => {
      try {
        if (!navigator.clipboard?.writeText) {
          throw new Error("clipboard unavailable");
        }
        await navigator.clipboard.writeText(prompt);
        if (state.generation !== generation || state.copySeq !== seq) return;
        button.textContent = COPIED_LABEL;
        button.classList.add("is-copied");
        announceStatus("已复制安装指令");
        state.copyTimer = setTimeout(() => {
          state.copyTimer = null;
          if (state.generation !== generation || state.copySeq !== seq) return;
          button.textContent = INITIAL_COPY_LABEL;
          button.classList.remove("is-copied");
          statusEl.textContent = "";
        }, DEFAULT_COPY_FEEDBACK_MS);
      } catch {
        if (state.generation !== generation || state.copySeq !== seq) return;
        textarea.focus();
        textarea.select();
        button.textContent = COPY_FAILED_LABEL;
        button.classList.remove("is-copied");
        announceStatus("复制失败，已选中指令文本，请手动复制");
      }
    })();
  });
}
