import { ids } from "../shared/dom-ids.js";
import { escapeHtml } from "../shared/string-utils.js";
import { READING_HEADER_ICONS } from "./reading-header-icons.js";
import { mountPanelModalShell, type PanelModalShell } from "./focus-scope.js";

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
  shell: PanelModalShell | null;
  generation: number;
}

const state: DialogState = {
  shell: null,
  generation: 0
};

function closeDialog(generation = state.generation): void {
  if (generation !== state.generation || !state.shell) return;
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
        <button type="button" class="agent-bridge-install-copy" data-agent-install-action="copy">复制指令</button>
      </div>
    </section>`,
    isTopLayer: () => state.generation === generation,
    onRequestDismiss: () => closeDialog(generation),
    onForceDismiss: () => closeDialog(generation)
  });
  state.shell = shell;

  shell.host.addEventListener("click", (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>("[data-agent-install-action]")?.dataset.agentInstallAction;
    if (action === "close") {
      closeDialog(generation);
      return;
    }
    if (action !== "copy") return;
    const button = shell.host.querySelector<HTMLButtonElement>('[data-agent-install-action="copy"]')!;
    const textarea = shell.host.querySelector<HTMLTextAreaElement>(".agent-bridge-install-prompt")!;
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
}
