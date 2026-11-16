import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installSettingsPanelBus, type BusMessage, type BusResponder } from "../helpers/settings-panel-bus.js";

let clipboardWrite: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetModuleState();
  clipboardWrite = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardWrite }
  });
});

async function mountPanel(overrides: Record<string, BusResponder> = {}) {
  document.body.innerHTML = `
    <div id="biliscript-reading-view">
      <section id="biliscript-reading-settings-panel">
        <div id="biliscript-reading-settings-host"></div>
      </section>
    </div>`;
  const bus = installSettingsPanelBus<BusMessage>(overrides);
  const panel = await import("../../extension/ui/settings-panel.js");
  panel.renderReaderSettingsPanel();
  const host = document.getElementById("biliscript-reading-settings-host")!;
  await vi.waitFor(() => expect(host.dataset.biliscriptSettingsRendered).toBe("1"));
  return { host, sent: bus.sent };
}

describe("本地 Agent 设置", () => {
  it("默认关闭本地 Agent 开关，手动切换开关才保存轮询启停", async () => {
    const { host, sent } = await mountPanel();
    const toggle = host.querySelector<HTMLInputElement>("#enableAgentBridge")!;
    expect(toggle.checked).toBe(false);

    toggle.click();
    await vi.waitFor(() => {
      expect(sent).toContainEqual({ type: "save-settings", settings: { enableAgentBridge: true } });
    });
    expect(toggle.checked).toBe(true);

    toggle.click();
    await vi.waitFor(() => {
      expect(sent).toContainEqual({ type: "save-settings", settings: { enableAgentBridge: false } });
    });
    expect(toggle.checked).toBe(false);
  });

  it("连接失败时展示可复制安装 Prompt 且不开启后台轮询", async () => {
    const { host, sent } = await mountPanel({
      "agent-bridge-connect": () => ({ ok: true, connected: false })
    });
    const toggle = host.querySelector<HTMLInputElement>("#enableAgentBridge")!;

    host.querySelector<HTMLButtonElement>("#agentBridgeConnectBtn")!.click();

    const prompt = await vi.waitFor(() => {
      const element = document.querySelector<HTMLTextAreaElement>(".agent-bridge-install-prompt");
      if (!element) throw new Error("安装 Prompt 弹窗未打开");
      return element;
    });
    expect(prompt.value).toContain("irm https://raw.githubusercontent.com/Edmund724/BiliScript/main/scripts/install-agent.ps1 | iex");
    expect(prompt.value).toContain("非沙箱");
    expect(prompt.value).toContain("本机 PowerShell");
    expect(prompt.value).toContain("去连接");
    expect(prompt.value).toContain("完整错误");
    expect(prompt.value.length).toBeLessThan(300);
    expect(sent).toContainEqual({ type: "agent-bridge-connect" });
    expect(sent.some((message) => message.type === "save-settings")).toBe(false);
    expect(toggle.checked).toBe(false);

    const copyButton = document.querySelector<HTMLButtonElement>('[data-agent-install-action="copy"]')!;
    expect(copyButton.closest(".agent-bridge-install-prompt-card")).not.toBeNull();
    expect(document.querySelector(".agent-bridge-install-dialog .confirm-dialog-foot")).toBeNull();
    copyButton.click();
    await vi.waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(prompt.value));
    expect(copyButton.textContent).toBe("已复制");
    document.querySelector<HTMLButtonElement>(".agent-bridge-install-close")!.click();
  });

  it("连接成功不弹安装引导，同步打开开关并保留断开入口", async () => {
    let bridgeConnected = false;
    const { host, sent } = await mountPanel({
      "agent-bridge-status": () => ({ ok: true, connected: bridgeConnected }),
      "agent-bridge-connect": () => {
        bridgeConnected = true;
        return { ok: true, connected: true };
      },
      "save-settings": (message) => {
        if (message.settings && typeof message.settings === "object" && "enableAgentBridge" in message.settings) {
          bridgeConnected = message.settings.enableAgentBridge === true;
        }
        return { ok: true };
      }
    });
    const button = host.querySelector<HTMLButtonElement>("#agentBridgeConnectBtn")!;
    const toggle = host.querySelector<HTMLInputElement>("#enableAgentBridge")!;

    button.click();
    await vi.waitFor(() => expect(button.textContent).toBe("断开"));
    expect(toggle.checked).toBe(true);
    expect(sent).toContainEqual({ type: "save-settings", settings: { enableAgentBridge: true } });
    expect(document.querySelector(".agent-bridge-install-prompt")).toBeNull();

    button.click();
    await vi.waitFor(() => {
      expect(sent).toContainEqual({ type: "save-settings", settings: { enableAgentBridge: false } });
    });
    expect(toggle.checked).toBe(false);
    expect(button.textContent).toBe("去连接");
  });

  it("地址页测试使用当前输入且不落盘，保存只写合法的本机地址", async () => {
    const { host, sent } = await mountPanel({
      "agent-bridge-test": () => ({ ok: true, connected: true })
    });
    host.querySelector<HTMLButtonElement>("#agentBridgeAddressBtn")!.click();
    const input = host.querySelector<HTMLInputElement>("#agentBridgeUrl")!;
    const view = host.querySelector<HTMLElement>("#agentBridgeAddressView")!;
    expect(view.hidden).toBe(false);
    expect(host.querySelector<HTMLElement>(".biliscript-settings-nav-bar")?.hidden).toBe(true);
    expect(input.value).toBe("ws://127.0.0.1:18492");

    input.value = "ws://127.0.0.1:19000";
    host.querySelector<HTMLButtonElement>("#agentBridgeTestBtn")!.click();
    await vi.waitFor(() => expect(host.querySelector("#agentBridgeAddressStatus")?.textContent).toBe("连接成功"));
    expect(sent).toContainEqual({ type: "agent-bridge-test", url: "ws://127.0.0.1:19000" });
    expect(sent.some((message) => message.type === "save-settings")).toBe(false);

    host.querySelector<HTMLButtonElement>("#agentBridgeSaveBtn")!.click();
    await vi.waitFor(() => {
      expect(sent).toContainEqual({ type: "save-settings", settings: { agentBridgeUrl: "ws://127.0.0.1:19000" } });
    });

    input.value = "https://example.com/agent";
    host.querySelector<HTMLButtonElement>("#agentBridgeTestBtn")!.click();
    expect(host.querySelector("#agentBridgeAddressStatus")?.textContent).toContain("本机 WebSocket 地址");
    expect(sent.filter((message) => message.type === "agent-bridge-test")).toHaveLength(1);

    host.querySelector<HTMLButtonElement>("#agentBridgeAddressBackBtn")!.click();
    expect(view.hidden).toBe(true);
    expect(host.querySelector<HTMLElement>(".biliscript-settings-nav-bar")?.hidden).toBe(false);
  });

  it("输入 localhost 与 [::1] 测试和保存时归一为 127.0.0.1，并拒绝非法协议、非回环与缺失端口", async () => {
    const { host, sent } = await mountPanel({
      "agent-bridge-test": () => ({ ok: true, connected: true })
    });
    host.querySelector<HTMLButtonElement>("#agentBridgeAddressBtn")!.click();
    const input = host.querySelector<HTMLInputElement>("#agentBridgeUrl")!;
    const status = host.querySelector<HTMLElement>("#agentBridgeAddressStatus")!;

    input.value = "ws://localhost:19000";
    host.querySelector<HTMLButtonElement>("#agentBridgeTestBtn")!.click();
    await vi.waitFor(() => expect(status.textContent).toBe("连接成功"));
    expect(input.value).toBe("ws://127.0.0.1:19000");
    expect(sent).toContainEqual({ type: "agent-bridge-test", url: "ws://127.0.0.1:19000" });

    input.value = "ws://[::1]:19001";
    host.querySelector<HTMLButtonElement>("#agentBridgeSaveBtn")!.click();
    await vi.waitFor(() => {
      expect(sent).toContainEqual({ type: "save-settings", settings: { agentBridgeUrl: "ws://127.0.0.1:19001" } });
    });
    expect(input.value).toBe("ws://127.0.0.1:19001");
    expect(status.textContent).toBe("已保存");

    input.value = "wss://localhost:19001";
    host.querySelector<HTMLButtonElement>("#agentBridgeSaveBtn")!.click();
    expect(status.dataset.error).toBe("true");
    expect(status.textContent).toContain("带端口的本机 WebSocket 地址");

    input.value = "ws://192.168.1.5:19001";
    host.querySelector<HTMLButtonElement>("#agentBridgeTestBtn")!.click();
    expect(status.dataset.error).toBe("true");
    expect(status.textContent).toContain("本机 WebSocket 地址");

    input.value = "ws://localhost";
    host.querySelector<HTMLButtonElement>("#agentBridgeSaveBtn")!.click();
    expect(status.dataset.error).toBe("true");
    expect(status.textContent).toContain("带端口");

    expect(sent.filter((message) => message.type === "agent-bridge-test")).toHaveLength(1);
    expect(sent.filter((message) => message.type === "save-settings")).toHaveLength(1);
  });

  it("失败 Prompt 对自定义端口附带 CLI 环境变量", async () => {
    await mountPanel({
      "get-settings": () => ({ ok: true, settings: { agentBridgeUrl: "ws://127.0.0.1:19000" } }),
      "agent-bridge-connect": () => ({ ok: true, connected: false })
    });
    document.querySelector<HTMLButtonElement>("#agentBridgeConnectBtn")!.click();

    const prompt = await vi.waitFor(() => {
      const element = document.querySelector<HTMLTextAreaElement>(".agent-bridge-install-prompt");
      if (!element) throw new Error("安装 Prompt 弹窗未打开");
      return element;
    });
    expect(prompt.value).toContain("$env:BILISCRIPT_BRIDGE_PORT='19000'; irm ");
  });
});
