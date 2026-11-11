import { escapeHtml } from "../shared/string-utils.js";
import { ids } from "../reader/state.js";
import { observeSettingsPanelHidden } from "./settings-panel-hidden.js";

export function buildAgentBridgeInstallPrompt(address: string): string {
  const port = new URL(address).port;
  const portStep = port === "18492"
    ? ""
    : `\n   当前扩展使用端口 ${port}，运行技能命令前请在同一环境设置 BILISCRIPT_BRIDGE_PORT=${port}。`;
  return `请帮我安装并配置 BiliScript 本地 Agent 技能，用于通过本机浏览器扩展读取 B 站视频字幕、评论和关键帧。

1. 执行：npx skills add Edmund724/BiliScript
2. 阅读已安装技能的 SKILL.md，定位其中的 scripts/biliscript.mjs。
3. 运行：node "<技能目录>/scripts/biliscript.mjs" status，按技能说明启动本地 Bridge。${portStep}
4. 我已安装 BiliScript 浏览器扩展。技能就绪后，提醒我回到扩展的「设置 → 本地 Agent」点击「去连接」。
5. 再运行一次 status，确认 extensionOnline 为 true，并告诉我安装与连接结果。

如果安装或连接失败，请给出完整错误信息，不要反复重启 Bridge。`;
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
    <section class="confirm-dialog agent-bridge-install-dialog" role="dialog" aria-modal="true" aria-labelledby="agentBridgeInstallTitle" tabindex="-1">
      <h2 id="agentBridgeInstallTitle">无法连接本地 Agent</h2>
      <p>把下面的安装 Prompt 发给你的 Agent，完成安装后再点击「去连接」。</p>
      <textarea class="agent-bridge-install-prompt" readonly aria-label="BiliScript 安装 Prompt">${escapeHtml(prompt)}</textarea>
      <footer class="confirm-dialog-foot">
        <button type="button" class="confirm-dialog-cancel" data-agent-install-action="close">关闭</button>
        <button type="button" class="confirm-dialog-confirm" data-agent-install-action="copy">复制安装 Prompt</button>
      </footer>
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
