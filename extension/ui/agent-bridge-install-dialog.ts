import { escapeHtml } from "../shared/string-utils.js";
import { ids } from "../reader/state.js";
import { READING_HEADER_ICONS } from "./reading-header-icons.js";
import { observeSettingsPanelHidden } from "./settings-panel-hidden.js";

export function buildAgentBridgeInstallPrompt(address: string): string {
  const port = new URL(address).port;
  const portPrefix = port === "18492"
    ? ""
    : `$env:BILISCRIPT_BRIDGE_PORT='${port}'; `;
  return `请使用以下命令帮我安装并配置 BiliScript 本地 Agent。
必须在运行浏览器的 Windows 宿主机（非沙箱、非容器、非 WSL）中执行。若你无法访问该环境，请让我自行在本机 PowerShell 执行，不要在其他环境中启动 Bridge：
${portPrefix}irm https://raw.githubusercontent.com/Edmund724/BiliScript/main/scripts/install-agent.ps1 | iex
完成后提醒我回扩展点击「去连接」。若失败，请给出完整错误。`;
}

interface DialogState {
  host: HTMLElement | null;
  observer: MutationObserver | null;
  generation: number;
}

const state: DialogState = { host: null, observer: null, generation: 0 };

function closeDialog(generation = state.generation): void {
  if (generation !== state.generation) return;
  state.observer?.disconnect();
  state.observer = null;
  document.removeEventListener("click", onDocumentClick, true);
  document.removeEventListener("keydown", onDocumentKeyDown, true);
  state.host?.remove();
  state.host = null;
}

function onDocumentClick(event: MouseEvent): void {
  const view = state.host?.parentElement;
  if (!view || (event.target instanceof Node && view.contains(event.target))) return;
  event.stopPropagation();
  closeDialog();
}

function onDocumentKeyDown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  closeDialog();
}

export function openAgentBridgeInstallDialog(address: string): void {
  closeDialog();
  const view = document.getElementById(ids.readingView);
  if (!view) return;
  const prompt = buildAgentBridgeInstallPrompt(address);
  const host = document.createElement("div");
  host.className = "confirm-dialog-host agent-bridge-install-host";
  host.innerHTML = `
    <div class="confirm-dialog-mask" data-agent-install-action="close"></div>
    <section class="confirm-dialog agent-bridge-install-dialog" role="dialog" aria-modal="true" aria-labelledby="agentBridgeInstallTitle" aria-describedby="agentBridgeInstallDescription" tabindex="-1">
      <button type="button" class="agent-bridge-install-close" data-agent-install-action="close" aria-label="关闭" title="关闭">${READING_HEADER_ICONS.close}</button>
      <h2 id="agentBridgeInstallTitle">本地 Agent 未连接</h2>
      <p id="agentBridgeInstallDescription">将指令发给你的 Agent，安装完成后回到这里点击「去连接」。</p>
      <div class="agent-bridge-install-prompt-card">
        <textarea class="agent-bridge-install-prompt" readonly aria-label="BiliScript 安装 Prompt">${escapeHtml(prompt)}</textarea>
        <button type="button" class="agent-bridge-install-copy" data-agent-install-action="copy">复制指令</button>
      </div>
    </section>`;
  const generation = state.generation + 1;
  state.generation = generation;
  state.host = host;
  view.appendChild(host);

  host.addEventListener("click", (event) => {
    event.stopPropagation();
    const action = (event.target as HTMLElement).closest<HTMLElement>("[data-agent-install-action]")?.dataset.agentInstallAction;
    if (action === "close") {
      closeDialog(generation);
      return;
    }
    if (action !== "copy") return;
    const button = host.querySelector<HTMLButtonElement>('[data-agent-install-action="copy"]')!;
    const textarea = host.querySelector<HTMLTextAreaElement>(".agent-bridge-install-prompt")!;
    void (async () => {
      try {
        await navigator.clipboard.writeText(prompt);
        button.textContent = "已复制";
      } catch {
        textarea.focus();
        textarea.select();
        button.textContent = "请手动复制";
      }
    })();
  });

  host.querySelector<HTMLElement>(".agent-bridge-install-dialog")?.focus({ preventScroll: true });
  document.addEventListener("click", onDocumentClick, true);
  document.addEventListener("keydown", onDocumentKeyDown, true);
  observeSettingsPanelHidden(() => closeDialog(generation), state);
}
