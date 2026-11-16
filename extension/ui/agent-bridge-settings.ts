import { DEFAULT_SETTINGS, type Settings } from "../core/defaults.js";
import { normalizeAgentBridgeUrl, parseAgentBridgeUrl } from "../core/validators.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { openAgentBridgeInstallDialog } from "./agent-bridge-install-dialog.js";
import { syncToggleSwitch } from "./toggle-switch.js";

export interface AgentBridgeSettingsElements {
  enableAgentBridge: HTMLInputElement;
  agentBridgeConnectBtn: HTMLButtonElement;
  agentBridgeAddressBtn: HTMLButtonElement;
  agentBridgeAddressSummary: HTMLElement;
  agentBridgeUrl: HTMLInputElement;
  agentBridgeResetUrlBtn: HTMLButtonElement;
  agentBridgeTestBtn: HTMLButtonElement;
  agentBridgeSaveBtn: HTMLButtonElement;
  agentBridgeAddressStatus: HTMLElement;
}

export interface AgentBridgeSettingsState {
  enabled: boolean;
  connected: boolean;
  savedUrl: string;
}

export interface AgentBridgeSettingsOptions {
  onOpenAddress?: () => void;
  onStateChange?: (state: AgentBridgeSettingsState) => void;
}

export interface AgentBridgeSettingsController {
  sync(settings: Settings): void;
  updateUrl(value: unknown): void;
  refresh(): Promise<void>;
  onAddressViewClosed(options?: { focusButton?: boolean }): void;
  getSummaryState(): AgentBridgeSettingsState;
}

export function bindAgentBridgeSettings(
  elements: AgentBridgeSettingsElements,
  setStatus: (text: string, isError?: boolean) => void,
  options?: AgentBridgeSettingsOptions
): AgentBridgeSettingsController {
  let savedUrl = DEFAULT_SETTINGS.agentBridgeUrl;
  let connected = false;
  let pending: "connect" | "disconnect" | null = null;
  let addressOpen = false;
  let statusGeneration = 0;
  let addressBusy = false;

  function getSummaryState(): AgentBridgeSettingsState {
    return {
      enabled: elements.enableAgentBridge.checked,
      connected,
      savedUrl
    };
  }

  function renderAddressSummary(): void {
    elements.agentBridgeAddressSummary.textContent = savedUrl;
  }

  function emitStateChange(): void {
    renderAddressSummary();
    options?.onStateChange?.(getSummaryState());
  }

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
    emitStateChange();
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
    options?.onOpenAddress?.();
    elements.agentBridgeUrl.focus({ preventScroll: true });
  }

  function onAddressViewClosed({ focusButton = true }: { focusButton?: boolean } = {}): void {
    const wasOpen = addressOpen;
    addressOpen = false;
    if (!wasOpen) return;
    if (focusButton) {
      elements.agentBridgeAddressBtn.focus({ preventScroll: true });
    }
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
        elements.enableAgentBridge.checked = false;
        syncToggleSwitch(elements.enableAgentBridge);
        connected = false;
        setStatus("已断开本地 Agent");
      } catch (error) {
        setStatus((error as Error).message || "断开失败", true);
      } finally {
        pending = null;
        renderConnection();
        emitStateChange();
      }
      return;
    }

    pending = "connect";
    renderConnection();
    try {
      const response = await sendRuntimeMessage({ type: "agent-bridge-connect" });
      connected = response?.ok === true && response.connected === true;
      if (!connected) {
        openAgentBridgeInstallDialog(savedUrl);
        return;
      }
      const saved = await sendRuntimeMessage({ type: "save-settings", settings: { enableAgentBridge: true } });
      if (!saved?.ok) {
        setStatus(saved?.error || "无法启用本地 Agent 桥接", true);
        return;
      }
      elements.enableAgentBridge.checked = true;
      syncToggleSwitch(elements.enableAgentBridge);
      setStatus("本地 Agent 已连接");
    } catch {
      connected = false;
      openAgentBridgeInstallDialog(savedUrl);
    } finally {
      pending = null;
      renderConnection();
      emitStateChange();
    }
  }

  async function testAddress(): Promise<void> {
    const url = readAddress();
    if (!url || addressBusy) return;
    elements.agentBridgeUrl.value = url;
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
      emitStateChange();
      void refresh();
    } catch (error) {
      setAddressStatus((error as Error).message || "保存失败", true);
    } finally {
      setAddressBusy(false);
    }
  }

  elements.agentBridgeConnectBtn.addEventListener("click", () => void connect());
  elements.agentBridgeAddressBtn.addEventListener("click", openAddress);
  elements.agentBridgeResetUrlBtn.addEventListener("click", () => {
    elements.agentBridgeUrl.value = DEFAULT_SETTINGS.agentBridgeUrl;
    setAddressStatus("");
    elements.agentBridgeUrl.focus();
  });
  elements.agentBridgeTestBtn.addEventListener("click", () => void testAddress());
  elements.agentBridgeSaveBtn.addEventListener("click", () => void saveAddress());
  renderConnection();
  renderAddressSummary();

  return {
    sync(settings) {
      elements.enableAgentBridge.checked = settings.enableAgentBridge === true;
      savedUrl = normalizeAgentBridgeUrl(settings.agentBridgeUrl);
      if (!addressOpen) elements.agentBridgeUrl.value = savedUrl;
      emitStateChange();
      void refresh();
    },
    updateUrl(value) {
      savedUrl = normalizeAgentBridgeUrl(value);
      if (!addressOpen) elements.agentBridgeUrl.value = savedUrl;
      emitStateChange();
    },
    refresh,
    onAddressViewClosed,
    getSummaryState
  };
}
