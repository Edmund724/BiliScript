import { activeById } from "../shared/active-host.js";
import { resolveNodeWindow, writeActiveClipboardText } from "../shared/cross-doc.js";
import { ids } from "../shared/dom-ids.js";
import { escapeHtml } from "../shared/string-utils.js";
import { DEFAULT_COPY_FEEDBACK_MS } from "./copy-feedback.js";
import { READING_HEADER_ICONS } from "./reading-header-icons.js";
import { mountPanelModalShell, type PanelModalShell } from "./focus-scope.js";

export type HostPlatform = "windows" | "macos" | "linux";
export type AgentBridgeInstallTab = "skill" | "mcp";

export interface AgentBridgeMcpConfig {
  installCommand: string;
  configJson: string;
}

const DEFAULT_BRIDGE_PORT = "18492";
const INSTALL_BASE_URL = "https://raw.githubusercontent.com/Edmund724/BiliScript/main/scripts";
const INITIAL_COPY_LABEL = "复制指令";
const INITIAL_COPY_CMD_LABEL = "复制命令";
const INITIAL_COPY_MCP_LABEL = "复制配置";
const COPIED_LABEL = "已复制";
const COPY_FAILED_LABEL = "请手动复制";
const SKILL_DESCRIPTION = "将指令发给你的 Agent，安装完成后回到这里点击「去连接」。";
const MCP_DESCRIPTION = "先在本机运行安装命令，再粘贴配置到客户端并点击「去连接」。";
const TAB_ORDER: readonly AgentBridgeInstallTab[] = ["skill", "mcp"];

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

function buildAgentBridgeInstallCommand(address: string, platform: HostPlatform): string {
  const port = resolveBridgePort(address);
  if (platform === "windows") {
    const portPrefix = port === DEFAULT_BRIDGE_PORT
      ? ""
      : `$env:BILISCRIPT_BRIDGE_PORT='${port}'; `;
    return `${portPrefix}irm ${INSTALL_BASE_URL}/install-agent.ps1 | iex`;
  }
  const portEnv = port === DEFAULT_BRIDGE_PORT
    ? ""
    : `BILISCRIPT_BRIDGE_PORT=${port} `;
  return `curl -fsSL ${INSTALL_BASE_URL}/install-agent.sh | ${portEnv}sh`;
}

function defaultScriptPathForPlatform(platform: HostPlatform): string {
  if (platform === "windows") {
    return "C:\\Users\\<你的用户名>\\.agents\\skills\\biliscript\\scripts\\biliscript.mjs";
  }
  if (platform === "macos") {
    return "/Users/<你的用户名>/.agents/skills/biliscript/scripts/biliscript.mjs";
  }
  return "/home/<你的用户名>/.agents/skills/biliscript/scripts/biliscript.mjs";
}

export function buildAgentBridgeInstallPrompt(
  address: string,
  platform: HostPlatform = detectHostPlatform()
): string {
  const installCommand = buildAgentBridgeInstallCommand(address, platform);
  if (platform === "windows") {
    return `请使用以下命令帮我安装并配置 BiliScript 本地 Agent。
必须在运行浏览器的 Windows 宿主机（非沙箱、非容器、非 WSL）中执行。若你无法访问该环境，请让我自行在本机 PowerShell 执行，不要在其他环境中启动 Bridge：
${installCommand}
完成后提醒我回扩展点击「去连接」。若失败，请给出完整错误。`;
  }

  const hostLabel = platform === "macos" ? "macOS" : "Linux";
  return `请使用以下命令帮我安装并配置 BiliScript 本地 Agent。
必须在运行浏览器的 ${hostLabel} 宿主机（非沙箱、非容器）中执行。若你无法访问该环境，请让我自行在本机终端执行，不要在其他环境中启动 Bridge：
${installCommand}
完成后提醒我回扩展点击「去连接」。若失败，请给出完整错误。`;
}

export function buildAgentBridgeMcpConfig(
  address: string,
  platform: HostPlatform = detectHostPlatform()
): AgentBridgeMcpConfig {
  const port = resolveBridgePort(address);
  const server: {
    command: string;
    args: string[];
    env?: { BILISCRIPT_BRIDGE_PORT: string };
  } = {
    command: "node",
    args: [defaultScriptPathForPlatform(platform), "mcp"]
  };
  if (port !== DEFAULT_BRIDGE_PORT) {
    server.env = { BILISCRIPT_BRIDGE_PORT: port };
  }
  return {
    installCommand: buildAgentBridgeInstallCommand(address, platform),
    configJson: JSON.stringify({ mcpServers: { biliscript: server } }, null, 2)
  };
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
  const shell = state.shell;
  state.shell = null;
  try {
    shell.dispose();
  } catch {
  }
}

export function closeAgentBridgeInstallDialog(): void {
  closeDialog();
}

function fitTextareaHeightFallback(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) return;
  if (typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content")) return;
  textarea.style.height = "auto";
  const measuredHeight = textarea.scrollHeight;
  if (measuredHeight > 0) {
    textarea.style.height = `${measuredHeight}px`;
  }
}

export function openAgentBridgeInstallDialog(address: string): void {
  closeDialog();
  const mountHost = activeById(ids.readingView);
  if (!mountHost) return;
  const platform = detectHostPlatform();
  const prompt = buildAgentBridgeInstallPrompt(address, platform);
  const mcpConfig = buildAgentBridgeMcpConfig(address, platform);
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
      <p id="agentBridgeInstallDescription" class="agent-bridge-install-desc">${SKILL_DESCRIPTION}</p>
      <div class="agent-bridge-install-tabs" role="tablist" aria-label="客户端接入方式">
        <button type="button" class="agent-bridge-install-tab is-active" id="agentBridgeTabSkill" role="tab" aria-selected="true" aria-controls="agentBridgePanelSkill" tabindex="0" data-agent-install-tab="skill">编程 Agent（Skill）</button>
        <button type="button" class="agent-bridge-install-tab" id="agentBridgeTabMcp" role="tab" aria-selected="false" aria-controls="agentBridgePanelMcp" tabindex="-1" data-agent-install-tab="mcp">桌面客户端（MCP）</button>
      </div>
      <div class="agent-bridge-install-panel" id="agentBridgePanelSkill" role="tabpanel" aria-labelledby="agentBridgeTabSkill" data-agent-install-panel="skill">
        <div class="agent-bridge-install-prompt-card">
          <textarea class="agent-bridge-install-prompt" readonly aria-label="BiliScript 安装 Prompt">${escapeHtml(prompt)}</textarea>
          <button type="button" class="agent-bridge-install-copy" data-agent-install-action="copy" data-initial-label="${INITIAL_COPY_LABEL}">${INITIAL_COPY_LABEL}</button>
        </div>
      </div>
      <div class="agent-bridge-install-panel" id="agentBridgePanelMcp" role="tabpanel" aria-labelledby="agentBridgeTabMcp" data-agent-install-panel="mcp" hidden>
        <div class="agent-bridge-install-step">
          <p class="agent-bridge-install-step-title">1. 在本机终端安装或更新 Bridge（Node.js 22.20+）</p>
          <div class="agent-bridge-install-cmd-card">
            <input type="text" class="agent-bridge-install-cmd" readonly aria-label="BiliScript 前置安装命令" value="${escapeHtml(mcpConfig.installCommand)}" />
            <button type="button" class="agent-bridge-install-copy agent-bridge-install-copy-inline" data-agent-install-action="copy-mcp-command" data-initial-label="${INITIAL_COPY_CMD_LABEL}">${INITIAL_COPY_CMD_LABEL}</button>
          </div>
        </div>
        <div class="agent-bridge-install-step">
          <p class="agent-bridge-install-step-title">2. 粘贴至客户端 MCP 配置（替换 &lt;你的用户名&gt;）</p>
          <div class="agent-bridge-install-prompt-card">
            <textarea class="agent-bridge-install-mcp-config" readonly aria-label="BiliScript MCP 配置 JSON">${escapeHtml(mcpConfig.configJson)}</textarea>
            <button type="button" class="agent-bridge-install-copy" data-agent-install-action="copy-mcp" data-initial-label="${INITIAL_COPY_MCP_LABEL}">${INITIAL_COPY_MCP_LABEL}</button>
          </div>
        </div>
      </div>
      <div class="biliscript-sr-only agent-bridge-install-status" role="status" aria-live="polite" aria-atomic="true"></div>
      <p class="agent-bridge-install-note">同一客户端仅需启用 Skill 或 MCP 其一，无需同时开启。</p>
    </section>`,
    isTopLayer: () => state.generation === generation,
    onRequestDismiss: () => closeDialog(generation),
    onForceDismiss: () => closeDialog(generation)
  });
  state.shell = shell;

  fitTextareaHeightFallback(shell.host.querySelector<HTMLTextAreaElement>(".agent-bridge-install-prompt"));

  let activeTab: AgentBridgeInstallTab = "skill";

  const resetCopyFeedback = (): void => {
    clearCopyTimer();
    state.copySeq += 1;
    const statusEl = shell.host.querySelector<HTMLElement>(".agent-bridge-install-status");
    if (statusEl) {
      statusEl.textContent = "";
    }
    shell.host.querySelectorAll<HTMLButtonElement>(".agent-bridge-install-copy").forEach((btn) => {
      btn.textContent = btn.dataset.initialLabel ?? INITIAL_COPY_LABEL;
      btn.classList.remove("is-copied");
    });
  };

  const activateTab = (nextTab: AgentBridgeInstallTab, moveFocus: boolean): void => {
    if (nextTab !== activeTab) {
      resetCopyFeedback();
      activeTab = nextTab;
    }
    shell.host.querySelectorAll<HTMLButtonElement>("[data-agent-install-tab]").forEach((tabBtn) => {
      const isSelected = tabBtn.dataset.agentInstallTab === nextTab;
      tabBtn.setAttribute("aria-selected", isSelected ? "true" : "false");
      tabBtn.tabIndex = isSelected ? 0 : -1;
      tabBtn.classList.toggle("is-active", isSelected);
      if (isSelected && moveFocus) {
        tabBtn.focus();
      }
    });
    shell.host.querySelectorAll<HTMLElement>("[data-agent-install-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.agentInstallPanel !== nextTab;
    });
    const descEl = shell.host.querySelector<HTMLElement>("#agentBridgeInstallDescription");
    if (descEl) {
      descEl.textContent = nextTab === "mcp" ? MCP_DESCRIPTION : SKILL_DESCRIPTION;
    }
    if (nextTab === "mcp") {
      fitTextareaHeightFallback(shell.host.querySelector<HTMLTextAreaElement>(".agent-bridge-install-mcp-config"));
    }
  };

  const tablist = shell.host.querySelector<HTMLElement>(".agent-bridge-install-tabs");
  tablist?.addEventListener("keydown", (event) => {
    if (state.generation !== generation) return;
    const currentIndex = TAB_ORDER.indexOf(activeTab);
    let nextTab: AgentBridgeInstallTab | null = null;
    if (event.key === "ArrowRight") {
      nextTab = TAB_ORDER[(currentIndex + 1) % TAB_ORDER.length];
    } else if (event.key === "ArrowLeft") {
      nextTab = TAB_ORDER[(currentIndex - 1 + TAB_ORDER.length) % TAB_ORDER.length];
    } else if (event.key === "Home") {
      nextTab = TAB_ORDER[0];
    } else if (event.key === "End") {
      nextTab = TAB_ORDER[TAB_ORDER.length - 1];
    }
    if (!nextTab) return;
    event.preventDefault();
    activateTab(nextTab, true);
  });

  shell.host.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const tabButton = target.closest<HTMLButtonElement>("[data-agent-install-tab]");
    if (tabButton) {
      const nextTab = tabButton.dataset.agentInstallTab;
      if (nextTab === "skill" || nextTab === "mcp") {
        activateTab(nextTab, false);
      }
      return;
    }

    const actionEl = target.closest<HTMLElement>("[data-agent-install-action]");
    const action = actionEl?.dataset.agentInstallAction;
    if (action === "close") {
      closeDialog(generation);
      return;
    }
    if (action !== "copy" && action !== "copy-mcp" && action !== "copy-mcp-command") return;

    const button = actionEl as HTMLButtonElement;
    const statusEl = shell.host.querySelector<HTMLElement>(".agent-bridge-install-status")!;
    const copySpec = action === "copy"
      ? {
          text: prompt,
          field: shell.host.querySelector<HTMLTextAreaElement>(".agent-bridge-install-prompt")!,
          initialLabel: INITIAL_COPY_LABEL,
          successMessage: "已复制安装指令",
          failMessage: "复制失败，已选中指令文本，请手动复制"
        }
      : action === "copy-mcp"
        ? {
            text: mcpConfig.configJson,
            field: shell.host.querySelector<HTMLTextAreaElement>(".agent-bridge-install-mcp-config")!,
            initialLabel: INITIAL_COPY_MCP_LABEL,
            successMessage: "已复制 MCP 配置",
            failMessage: "复制失败，已选中配置文本，请手动复制"
          }
        : {
            text: mcpConfig.installCommand,
            field: shell.host.querySelector<HTMLInputElement>(".agent-bridge-install-cmd")!,
            initialLabel: INITIAL_COPY_CMD_LABEL,
            successMessage: "已复制前置安装命令",
            failMessage: "复制失败，已选中安装命令，请手动复制"
          };

    shell.host.querySelectorAll<HTMLButtonElement>(".agent-bridge-install-copy").forEach((btn) => {
      if (btn !== button) {
        btn.textContent = btn.dataset.initialLabel ?? INITIAL_COPY_LABEL;
        btn.classList.remove("is-copied");
      }
    });

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
        await writeActiveClipboardText(copySpec.text, resolveNodeWindow(shell.host));
        if (state.generation !== generation || state.copySeq !== seq) return;
        button.textContent = COPIED_LABEL;
        button.classList.add("is-copied");
        announceStatus(copySpec.successMessage);
        state.copyTimer = setTimeout(() => {
          state.copyTimer = null;
          if (state.generation !== generation || state.copySeq !== seq) return;
          button.textContent = copySpec.initialLabel;
          button.classList.remove("is-copied");
          statusEl.textContent = "";
        }, DEFAULT_COPY_FEEDBACK_MS);
      } catch {
        if (state.generation !== generation || state.copySeq !== seq) return;
        copySpec.field.focus();
        copySpec.field.select();
        button.textContent = COPY_FAILED_LABEL;
        button.classList.remove("is-copied");
        announceStatus(copySpec.failMessage);
      }
    })();
  });
}
