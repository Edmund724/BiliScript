import { DEFAULT_SETTINGS, type Settings } from "../core/defaults.js";
import { normalizeAgentBridgeUrl, parseAgentBridgeUrl } from "../core/validators.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { openAgentBridgeInstallDialog } from "./agent-bridge-install-dialog.js";

export interface AgentBridgeSettingsElements {
  agentBridgeConnectBtn: HTMLButtonElement;
  agentBridgeAddressBtn: HTMLButtonElement;
  agentBridgeAddressView: HTMLElement;
  agentBridgeAddressBackBtn: HTMLButtonElement;
  agentBridgeUrl: HTMLInputElement;
  agentBridgeResetUrlBtn: HTMLButtonElement;
  agentBridgeTestBtn: HTMLButtonElement;
  agentBridgeSaveBtn: HTMLButtonElement;
  agentBridgeAddressStatus: HTMLElement;
}

export interface AgentBridgeSettingsController {
  sync(settings: Settings): void;
  updateUrl(value: unknown): void;
  refresh(): Promise<void>;
}

export function bindAgentBridgeSettings(
  host: HTMLElement,
  elements: AgentBridgeSettingsElements,
  setStatus: (text: string, isError?: boolean) => void
): AgentBridgeSettingsController {
  let savedUrl = DEFAULT_SETTINGS.agentBridgeUrl;
  let connected = false;
  let pending: "connect" | "disconnect" | null = null;
  let addressOpen = false;
  let statusGeneration = 0;
  let addressBusy = false;

  function renderConnection(): void {
    const button = elements.agentBridgeConnectBtn;
    button.disabled = pending !== null;
    button.dataset.state = pending === "connect" ? "connecting" : connected ? "connected" : "disconnected";
    button.textContent = pending === "connect" ? "连接中…" : pending === "disconnect" ? "断开中…" : connected ? "断开" : "去连接";
    button.setAttribute("aria-label", connected ? "断开本地 Agent" : "连接本地 Agent");
  }

  async function refresh(): Promise<void> {
    if (pending) return;
    const generation = ++statusGeneration;
    try {
      const response = await sendRuntimeMessage({ type: "agent-bridge-status" });
      if (generation !== statusGeneration) return;
      connected = response?.ok === true && response.connected === true;
    } catch {
      if (generation !== statusGeneration) return;
      connected = false;
    }
    renderConnection();
  }

  function setAddressStatus(text: string, isError = false): void {
    elements.agentBridgeAddressStatus.textContent = text;
    elements.agentBridgeAddressStatus.dataset.error = isError ? "true" : "false";
  }

  function setAddressBusy(busy: boolean, testing = false): void {
    addressBusy = busy;
    elements.agentBridgeResetUrlBtn.disabled = busy;
    elements.agentBridgeTestBtn.disabled = busy;
    elements.agentBridgeSaveBtn.disabled = busy;
    if (testing) elements.agentBridgeTestBtn.textContent = "测试中…";
    if (!busy) elements.agentBridgeTestBtn.textContent = "测试";
  }

  function openAddress(): void {
    addressOpen = true;
    elements.agentBridgeUrl.value = savedUrl;
    setAddressStatus("");
    for (const child of Array.from(host.children)) {
      if (child === elements.agentBridgeAddressView) continue;
      if (!(child as HTMLElement).hidden) (child as HTMLElement).dataset.agentAddressHidden = "true";
      (child as HTMLElement).hidden = true;
    }
    elements.agentBridgeAddressView.hidden = false;
    elements.agentBridgeUrl.focus({ preventScroll: true });
  }

  function closeAddress(): void {
    addressOpen = false;
    elements.agentBridgeAddressView.hidden = true;
    for (const child of Array.from(host.children)) {
      const element = child as HTMLElement;
      if (element.dataset.agentAddressHidden === "true") {
        element.hidden = false;
        delete element.dataset.agentAddressHidden;
      }
    }
    elements.agentBridgeAddressBtn.focus({ preventScroll: true });
    void refresh();
  }

  function readAddress(): string | null {
    const url = parseAgentBridgeUrl(elements.agentBridgeUrl.value);
    if (!url) setAddressStatus("请输入带端口的本机 WebSocket 地址，例如 ws://127.0.0.1:18492", true);
    return url;
  }

  async function connect(): Promise<void> {
    statusGeneration++;
    if (connected) {
      pending = "disconnect";
      renderConnection();
      try {
        const response = await sendRuntimeMessage({ type: "save-settings", settings: { enableAgentBridge: false } });
        if (!response?.ok) {
          setStatus(response?.error || "断开失败", true);
          return;
        }
        connected = false;
        setStatus("已断开本地 Agent");
      } catch (error) {
        setStatus((error as Error).message || "断开失败", true);
      } finally {
        pending = null;
        renderConnection();
      }
      return;
    }

    pending = "connect";
    renderConnection();
    try {
      const saved = await sendRuntimeMessage({ type: "save-settings", settings: { enableAgentBridge: true } });
      if (!saved?.ok) {
        setStatus(saved?.error || "无法启用本地 Agent 桥接", true);
        return;
      }
      const response = await sendRuntimeMessage({ type: "agent-bridge-connect" });
      connected = response?.ok === true && response.connected === true;
      if (!connected) {
        openAgentBridgeInstallDialog(savedUrl);
        return;
      }
      setStatus("本地 Agent 已连接");
    } catch {
      connected = false;
      openAgentBridgeInstallDialog(savedUrl);
    } finally {
      pending = null;
      renderConnection();
    }
  }

  async function testAddress(): Promise<void> {
    const url = readAddress();
    if (!url || addressBusy) return;
    setAddressBusy(true, true);
    setAddressStatus("");
    try {
      const response = await sendRuntimeMessage({ type: "agent-bridge-test", url });
      const ok = response?.ok === true && response.connected === true;
      setAddressStatus(ok ? "连接成功" : response?.error || "连接失败，请确认本地 Agent 已启动", !ok);
    } catch {
      setAddressStatus("连接失败，请确认本地 Agent 已启动", true);
    } finally {
      setAddressBusy(false);
    }
  }

  async function saveAddress(): Promise<void> {
    const url = readAddress();
    if (!url || addressBusy) return;
    setAddressBusy(true);
    try {
      const response = await sendRuntimeMessage({ type: "save-settings", settings: { agentBridgeUrl: url } });
      if (!response?.ok) {
        setAddressStatus(response?.error || "保存失败", true);
        return;
      }
      savedUrl = url;
      elements.agentBridgeUrl.value = url;
      setAddressStatus("已保存");
      void refresh();
    } catch (error) {
      setAddressStatus((error as Error).message || "保存失败", true);
    } finally {
      setAddressBusy(false);
    }
  }

  elements.agentBridgeConnectBtn.addEventListener("click", () => void connect());
  elements.agentBridgeAddressBtn.addEventListener("click", openAddress);
  elements.agentBridgeAddressBackBtn.addEventListener("click", closeAddress);
  elements.agentBridgeResetUrlBtn.addEventListener("click", () => {
    elements.agentBridgeUrl.value = DEFAULT_SETTINGS.agentBridgeUrl;
    setAddressStatus("");
    elements.agentBridgeUrl.focus();
  });
  elements.agentBridgeTestBtn.addEventListener("click", () => void testAddress());
  elements.agentBridgeSaveBtn.addEventListener("click", () => void saveAddress());
  renderConnection();

  return {
    sync(settings) {
      savedUrl = normalizeAgentBridgeUrl(settings.agentBridgeUrl);
      if (!addressOpen) elements.agentBridgeUrl.value = savedUrl;
      void refresh();
    },
    updateUrl(value) {
      savedUrl = normalizeAgentBridgeUrl(value);
      if (!addressOpen) elements.agentBridgeUrl.value = savedUrl;
    },
    refresh
  };
}
