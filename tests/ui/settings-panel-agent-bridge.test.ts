import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installSettingsPanelBus, type BusMessage, type BusResponder } from "../helpers/settings-panel-bus.js";

let clipboardWrite: ReturnType<typeof vi.fn>;

function setHostPlatform(options: { uaDataPlatform?: string; platform?: string; userAgent?: string }): void {
  Object.defineProperty(navigator, "userAgentData", {
    configurable: true,
    value: options.uaDataPlatform !== undefined ? { platform: options.uaDataPlatform } : undefined
  });
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: options.platform ?? ""
  });
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: options.userAgent ?? ""
  });
}

beforeEach(() => {
  resetModuleState();
  setHostPlatform({ uaDataPlatform: "Windows", platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
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
    host.querySelector<HTMLButtonElement>("#openAgentSettingsBtn")!.click();
    expect(host.querySelector<HTMLElement>("#agentBridgeAddressSummary")?.textContent).toBe("ws://127.0.0.1:18492");

    host.querySelector<HTMLButtonElement>("#agentBridgeAddressBtn")!.click();
    const input = host.querySelector<HTMLInputElement>("#agentBridgeUrl")!;
    const view = host.querySelector<HTMLElement>("#agentBridgeAddressView")!;
    const agentView = host.querySelector<HTMLElement>("#biliscriptSettingsSubpageAgent")!;
    const navBar = host.querySelector<HTMLElement>(".biliscript-settings-nav-bar")!;
    const title = host.querySelector<HTMLElement>("#biliscriptSettingsTitle")!;
    expect(view.hidden).toBe(false);
    expect(agentView.hidden).toBe(true);
    expect(navBar.hidden).toBe(false);
    expect(title.textContent?.trim()).toBe("连接地址");
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
    expect(host.querySelector<HTMLElement>("#agentBridgeAddressSummary")?.textContent).toBe("ws://127.0.0.1:19000");

    input.value = "https://example.com/agent";
    host.querySelector<HTMLButtonElement>("#agentBridgeTestBtn")!.click();
    expect(host.querySelector("#agentBridgeAddressStatus")?.textContent).toContain("本机 WebSocket 地址");
    expect(sent.filter((message) => message.type === "agent-bridge-test")).toHaveLength(1);

    host.querySelector<HTMLButtonElement>("#biliscript-reading-settings-back-btn")!.click();
    expect(view.hidden).toBe(true);
    expect(agentView.hidden).toBe(false);
    expect(navBar.hidden).toBe(false);
    expect(title.textContent?.trim()).toBe("本地 Agent 连接");
  });

  it("输入 localhost 与 [::1] 测试和保存时归一为 127.0.0.1，并拒绝非法协议、非回环与缺失端口", async () => {
    const { host, sent } = await mountPanel({
      "agent-bridge-test": () => ({ ok: true, connected: true })
    });
    host.querySelector<HTMLButtonElement>("#openAgentSettingsBtn")!.click();
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

  it("精简本地 Agent 设置卡片次级说明，保留开关、连接操作与地址入口", async () => {
    const { host } = await mountPanel();
    const card = host.querySelector<HTMLElement>('[data-settings-section="agent"] .biliscript-agent-bridge-card')!;
    expect(card).not.toBeNull();
    expect(card.querySelector("p")).toBeNull();
    expect(card.textContent).not.toContain("远程操控 BiliScript");
    expect(card.querySelector("#enableAgentBridge")).not.toBeNull();
    expect(card.querySelector("#agentBridgeConnectBtn")).not.toBeNull();
    expect(card.querySelector("#agentBridgeAddressBtn")).not.toBeNull();
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
    document.querySelector<HTMLButtonElement>(".agent-bridge-install-close")!.click();
  });

  it("复制指令后播报 role=status 并延时复位，重复点击重置计时且不禁用按钮", async () => {
    vi.useFakeTimers();
    await mountPanel({
      "agent-bridge-connect": () => ({ ok: true, connected: false })
    });
    document.querySelector<HTMLButtonElement>("#agentBridgeConnectBtn")!.click();

    await vi.waitFor(() => {
      expect(document.querySelector(".agent-bridge-install-dialog")).not.toBeNull();
    });

    const copyButton = document.querySelector<HTMLButtonElement>('[data-agent-install-action="copy"]')!;
    const status = document.querySelector<HTMLElement>('.agent-bridge-install-dialog [role="status"]')!;
    const prompt = document.querySelector<HTMLTextAreaElement>(".agent-bridge-install-prompt")!;
    expect(copyButton.textContent).toBe("复制指令");
    expect(status.textContent).toBe("");

    copyButton.click();
    await vi.waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));
    expect(clipboardWrite).toHaveBeenLastCalledWith(prompt.value);
    expect(copyButton.textContent).toBe("已复制");
    expect(copyButton.disabled).toBe(false);
    expect(status.textContent).toContain("已复制");

    await vi.advanceTimersByTimeAsync(1500);
    expect(copyButton.textContent).toBe("已复制");

    copyButton.click();
    await vi.waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(2));
    expect(copyButton.disabled).toBe(false);
    expect(copyButton.textContent).toBe("已复制");

    await vi.advanceTimersByTimeAsync(1500);
    expect(copyButton.textContent).toBe("已复制");

    await vi.advanceTimersByTimeAsync(600);
    expect(copyButton.textContent).toBe("复制指令");
    expect(status.textContent).toBe("");
    document.querySelector<HTMLButtonElement>(".agent-bridge-install-close")!.click();
  });

  it("剪贴板写入被拒时选中文本、提示手动复制并向 status 区域播报失败", async () => {
    clipboardWrite.mockRejectedValueOnce(new Error("NotAllowedError"));
    await mountPanel({
      "agent-bridge-connect": () => ({ ok: true, connected: false })
    });
    document.querySelector<HTMLButtonElement>("#agentBridgeConnectBtn")!.click();

    await vi.waitFor(() => {
      expect(document.querySelector(".agent-bridge-install-dialog")).not.toBeNull();
    });

    const copyButton = document.querySelector<HTMLButtonElement>('[data-agent-install-action="copy"]')!;
    const status = document.querySelector<HTMLElement>('.agent-bridge-install-dialog [role="status"]')!;
    const prompt = document.querySelector<HTMLTextAreaElement>(".agent-bridge-install-prompt")!;

    copyButton.click();
    await vi.waitFor(() => expect(copyButton.textContent).toBe("请手动复制"));
    expect(copyButton.disabled).toBe(false);
    expect(document.activeElement).toBe(prompt);
    expect(prompt.selectionStart).toBe(0);
    expect(prompt.selectionEnd).toBe(prompt.value.length);
    expect(status.textContent).toContain("复制失败");
    expect(status.textContent).toContain("手动复制");
    document.querySelector<HTMLButtonElement>(".agent-bridge-install-close")!.click();
  });

  it("按宿主系统生成 Windows / macOS / Linux 安装 Prompt（含默认与自定义端口）", async () => {
    const { buildAgentBridgeInstallPrompt } = await import("../../extension/ui/agent-bridge-install-dialog.js");

    setHostPlatform({ uaDataPlatform: "macOS", platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)" });
    const macDefault = buildAgentBridgeInstallPrompt("ws://127.0.0.1:18492");
    const macCustom = buildAgentBridgeInstallPrompt("ws://127.0.0.1:19000");
    expect(macDefault).toContain("macOS 宿主机");
    expect(macDefault).toContain("非沙箱、非容器");
    expect(macDefault).toContain("curl -fsSL https://raw.githubusercontent.com/Edmund724/BiliScript/main/scripts/install-agent.sh | sh");
    expect(macDefault).not.toContain("BILISCRIPT_BRIDGE_PORT");
    expect(macDefault.length).toBeLessThan(300);
    expect(macCustom).toContain("curl -fsSL https://raw.githubusercontent.com/Edmund724/BiliScript/main/scripts/install-agent.sh | BILISCRIPT_BRIDGE_PORT=19000 sh");
    expect(macCustom.length).toBeLessThan(300);

    setHostPlatform({ uaDataPlatform: "Linux", platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" });
    const linuxDefault = buildAgentBridgeInstallPrompt("ws://127.0.0.1:18492");
    const linuxCustom = buildAgentBridgeInstallPrompt("ws://127.0.0.1:19000");
    expect(linuxDefault).toContain("Linux 宿主机");
    expect(linuxDefault).toContain("非沙箱、非容器");
    expect(linuxDefault).toContain("curl -fsSL https://raw.githubusercontent.com/Edmund724/BiliScript/main/scripts/install-agent.sh | sh");
    expect(linuxDefault.length).toBeLessThan(300);
    expect(linuxCustom).toContain("BILISCRIPT_BRIDGE_PORT=19000 sh");
    expect(linuxCustom.length).toBeLessThan(300);

    await mountPanel({
      "get-settings": () => ({ ok: true, settings: { agentBridgeUrl: "ws://127.0.0.1:19000" } }),
      "agent-bridge-connect": () => ({ ok: true, connected: false })
    });
    document.querySelector<HTMLButtonElement>("#agentBridgeConnectBtn")!.click();
    const dialogPrompt = await vi.waitFor(() => {
      const element = document.querySelector<HTMLTextAreaElement>(".agent-bridge-install-prompt");
      if (!element) throw new Error("安装 Prompt 弹窗未打开");
      return element;
    });
    expect(dialogPrompt.value).toBe(linuxCustom);
    document.querySelector<HTMLButtonElement>(".agent-bridge-install-close")!.click();
  });
});
