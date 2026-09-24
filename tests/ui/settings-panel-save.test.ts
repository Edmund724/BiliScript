// ui/settings-panel.ts saveSettings 保存链直测
//（arch-slim-2/05 测试网；provider-master-detail/02 起 saveSettings 只承载
// 其余设置项——AI/ASR 平台的收集/校验/落盘/权限申请整体移交 provider-editor
// Modal 的单平台链，见 provider-editor.test.js；笔记导出删除后本链只剩
// 收集 → 单路落盘）。
//
// 走真实模块 + DOM 仿真（script-button.test.js 同款）：saveSettings 未导出，
// 经唯一公开入口 renderReaderSettingsPanel 挂载面板后驱动——
// - 保存链：收集(collectFormPayload) → 单路落盘(save-settings)；平台相关的
//   request-provider-origins / ai-providers-save / asr-providers-save 消息
//   不再出自本链；
// - 模板口径：笔记导出的三个区块与三个导出选项行已删除，导出的保留项在场。
//
// chrome.runtime.sendMessage 换装成按 type 分发的消息总线（sent 记录全部出站
// 报文），loadSettings 是 fire-and-forget，mountPanel 用 vi.waitFor 等装载链
// 走完（最后一路 asr-providers-list）再操作表单。
//
// 触发点击统一走 fireClick（dispatchEvent）：tests/setup.ts 的 click 补丁会让
// HTMLElement.click() 双发事件（jsdom 原生派发 + 补丁再手动派发一次），监听器
// 双触发会把保存链并发跑两趟（第二趟收集到的可能已被第一趟重渲染清空）。产线
// 监听器对 dispatchEvent 与真实点击同样响应。

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { resetModuleState } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { DEFAULT_AI_SYSTEM_PROMPT, DEFAULT_INITIAL_QUICK_PROMPTS, DEFAULT_PLAYER_AI_QUICK_PROMPT } from "../../extension/core/default-prompts.js";

// AI 探针 mock：测试连接按钮直调 provider-test（不经 SW 消息），固定成功
vi.mock("../../extension/ai/provider-test.js", () => ({
  testAiProviderConnection: vi.fn(async () => ({ ok: true }))
}));

type SentMessage = { type: string; settings?: Record<string, unknown>; [key: string]: unknown };
type MessageResponder = (message: SentMessage) => Record<string, unknown>;
type SendMessageMock = Mock<(message: SentMessage, callback?: (response?: unknown) => void) => undefined>;

// 消息总线桩：chrome.runtime.sendMessage 的命名空间声明是重载函数，mock 只能经
// 断言赋值；mock 本体另存模块变量供用例读 calls（同 setup 的 chrome 桩面）。
let sendMessageMock: SendMessageMock | null = null;

function installMessageBus(overrides: Record<string, MessageResponder> = {}): SentMessage[] {
  const responders: Record<string, MessageResponder> = {
    "get-settings": () => ({ ok: true, settings: {} }),
    // 预设列表返回失败 → settings-panel 回落内置 PRESETS / ASR_PROVIDER_PRESETS
    "ai-presets-list": () => ({ ok: false }),
    "asr-presets-list": () => ({ ok: false }),
    "ai-providers-list": () => ({ ok: true, providers: [] }),
    "asr-providers-list": () => ({ ok: true, providers: [] }),
    "save-settings": () => ({ ok: true }),
    "ai-providers-save": () => ({ ok: true, providers: [] }),
    "asr-providers-save": () => ({ ok: true, providers: [] }),
    "request-provider-origins": () => ({ ok: true }),
    ...overrides
  };
  const sent: SentMessage[] = [];
  const mock: SendMessageMock = vi.fn((message: SentMessage, callback?: (response?: unknown) => void) => {
    sent.push(message);
    const respond = responders[message.type];
    callback?.(respond ? respond(message) : { ok: true });
    return undefined;
  });
  sendMessageMock = mock;
  chrome.runtime.sendMessage = mock as unknown as typeof chrome.runtime.sendMessage;
  return sent;
}

async function mountPanel(): Promise<HTMLElement> {
  document.body.innerHTML = '<div id="biliscript-reading-view"><div id="biliscript-reading-settings-host"></div></div>';
  const panel = await import("../../extension/ui/settings-panel.js");
  panel.renderReaderSettingsPanel();
  const host = document.getElementById("biliscript-reading-settings-host")!;
  await vi.waitFor(() => {
    expect(sendMessageMock!.mock.calls.some(([message]) => message.type === "asr-providers-list")).toBe(true);
  });
  return host;
}

function messageTypes(sent: SentMessage[]): string[] {
  return sent.map((message) => message.type);
}

function lastStatus(host: HTMLElement): HTMLElement {
  return host.querySelector<HTMLElement>("#biliscriptSettingsStatus")!;
}

// 单发 click（见文件头说明）
function fireClick(node: Element): void {
  node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  resetModuleState();
});

// ===== M15 INP（本 describe 置顶是有意为之）=====
// 外点关闭委托的 document 级监听器不随 vi.resetModules 清理（setup.ts 只重置
// 模块缓存）：每个 mountPanel 泄漏一个旧面板监听器到 document，先注册先执行。
// 快速通道的 spy 断言依赖「本用例的面板监听器是 document 上唯一的/最先收到
// 事件的收拢路径」——正向对照若在任何挂载过面板的用例之后运行，旧监听器会先
// 把开着的三族弹层关掉（旧模块实例调用，不经本用例的 spy），本用例监听器守卫
// 随后早退，spy 恒空。故本 describe 必须保持在文件首位、正向对照保持在
// describe 首位；其余用例只断言 DOM 终态，对泄漏不敏感。
describe("设置分区渲染隔离与外点关闭委托（M15 INP）", () => {
  // 正向对照（r1 评审 P2-1）：证明 spy 链路真实拦截 settings-panel 的静态导入
  // 绑定——若下方「常态快速通道」的 not-called 断言因 spy 未拦截而恒真，这条会红。
  it("快速通道正向对照：自定义下拉展开时外点 → closeAllCustomSelects 被调用且下拉收起", async () => {
    installMessageBus();
    const host = await mountPanel();
    const customSelect = await import("../../extension/ui/custom-select.js");
    const spy = vi.spyOn(customSelect, "closeAllCustomSelects");

    // 组件自开（trigger 监听器 stopPropagation，不经外点委托；openList 对
    // closeAllCustomSelects 的内部调用走模块内局部绑定，不经命名空间，不计入 spy）
    const trigger = host
      .querySelector("#downloadFormat")!
      .closest(".custom-select-wrapper")!
      .querySelector(".custom-select-trigger")!;
    fireClick(trigger);
    const dropdown = host.querySelector<HTMLElement>(".custom-select-dropdown")!;
    expect(dropdown.hidden).toBe(false);

    fireClick(document.body);
    expect(spy).toHaveBeenCalled();
    expect(dropdown.hidden).toBe(true);
  });

  it("分区挂载即套 containment：contain: layout style（无 paint——弹层溢出分区边界不可裁）", async () => {
    installMessageBus();
    const host = await mountPanel();

    const groups = host.querySelectorAll<HTMLElement>(".biliscript-set-group");
    expect(groups.length).toBeGreaterThan(0);
    groups.forEach((group) => {
      expect(group.style.contain).toBe("layout style");
      expect(group.style.contentVisibility).toBe("");
    });
  });

  it("常态快速通道：三类弹层全关时 document 点击零收起动作", async () => {
    installMessageBus();
    const host = await mountPanel();
    const customSelect = await import("../../extension/ui/custom-select.js");
    const spy = vi.spyOn(customSelect, "closeAllCustomSelects");

    expect(
      document.querySelector(
        '.fixed-property-type-picker[data-open="true"], .ai-provider-model-dropdown:not([hidden]), .custom-select-dropdown:not([hidden])'
      )
    ).toBeNull();
    fireClick(document.body);

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("saveSettings 保存链（保存按钮手势）", () => {
  it("全链成功：收集→单路落盘（平台消息不再出自本链），状态条成功、busy 复位", async () => {
    const sent = installMessageBus();
    const host = await mountPanel();

    // 收集段：改表单若干值（布尔 / textarea trim 口径）
    host.querySelector<HTMLInputElement>("#enableDebugLogs")!.checked = true;
    host.querySelector<HTMLTextAreaElement>("#aiSystemPrompt")!.value = "  自定义系统提示词  ";

    fireClick(host.querySelector("#biliscriptSettingsSaveBtn")!);

    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "save-settings")).toBe(true);
    });

    // provider-master-detail/02：平台收集/权限代申请/平台落盘段已整体退役，
    // 保存设置按钮只发 save-settings 一路
    const types = messageTypes(sent);
    expect(types).toContain("save-settings");
    expect(types).not.toContain("request-provider-origins");
    expect(types).not.toContain("ai-providers-save");
    expect(types).not.toContain("asr-providers-save");

    const saveMessage = sent.find((message) => message.type === "save-settings")!;
    expect(saveMessage.settings).toMatchObject({
      downloadFormat: "srt",
      includeDateInFilename: true,
      includeTimestampInBody: true,
      enableDebugLogs: true,
      aiSystemPrompt: "自定义系统提示词"
    });
    // 笔记导出的字段已退出收集口径（键不在载荷里）
    for (const key of [
      "tags",
      "includeHotCommentsInNote",
      "includePlayerEmbedInNote",
      "frontmatterFields",
      "fixedFrontmatterProperties",
      "notePlaceholderSections"
    ]) {
      expect(saveMessage.settings, `${key} 不应出现在负载里`).not.toHaveProperty(key);
    }
    expect(saveMessage.settings!.aiInitialQuickPrompts).toEqual(DEFAULT_INITIAL_QUICK_PROMPTS);
    expect(saveMessage.settings!.aiPresetPrompts).toHaveLength(3);

    // 状态条与 busy 复位
    const status = lastStatus(host);
    expect(status.textContent).toBe("保存成功");
    expect(status.dataset.error).toBe("false");
    const saveBtn = host.querySelector<HTMLButtonElement>("#biliscriptSettingsSaveBtn")!;
    expect(saveBtn.disabled).toBe(false);
    expect(saveBtn.textContent).toBe("保存设置");
  });

  it("save-settings 失败：状态条报错，busy 复位", async () => {
    const sent = installMessageBus({ "save-settings": () => ({ ok: false, error: "写入失败" }) });
    const host = await mountPanel();

    fireClick(host.querySelector("#biliscriptSettingsSaveBtn")!);

    await vi.waitFor(() => {
      expect(lastStatus(host).textContent).toBe("写入失败");
    });

    expect(lastStatus(host).dataset.error).toBe("true");
    expect(host.querySelector<HTMLButtonElement>("#biliscriptSettingsSaveBtn")!.disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>("#biliscriptSettingsSaveBtn")!.textContent).toBe("保存设置");
  });
});

// 笔记导出删除后的模板口径（要求 5）：三个区块（笔记属性 / 自定义属性 /
// 正文附加段落）与三个导出选项行（默认标签 / 热门评论 / 播放器嵌入）不再渲染，
// 字幕导出的保留项在场。
describe("设置抽屉模板：笔记导出区块已删除", () => {
  it("不含三个笔记属性区块，对应的 id 与行控点全部消失", async () => {
    installMessageBus();
    const host = await mountPanel();

    for (const label of ["笔记属性", "自定义属性", "正文附加段落"]) {
      expect(host.textContent, `仍渲染「${label}」区块`).not.toContain(label);
    }
    for (const id of [
      "tags",
      "includeHotCommentsInNote",
      "includePlayerEmbedInNote",
      "fixedPropertiesList",
      "fixedPropertiesEmpty",
      "addFixedPropertyBtn",
      "noteSectionsList",
      "noteSectionsEmpty",
      "addNoteSectionBtn"
    ]) {
      expect(host.querySelector(`#${id}`), `#${id} 应随笔记导出一并删除`).toBeNull();
    }
    expect(host.querySelectorAll('input[name="frontmatterField"]')).toHaveLength(0);
    expect(host.querySelector(".fixed-properties-list")).toBeNull();
    expect(host.querySelector(".note-sections-list")).toBeNull();
  });

  it("导出区保留下载格式 / 文件名日期 / 保留时间戳 / 调试日志四项", async () => {
    installMessageBus();
    const host = await mountPanel();

    for (const id of ["downloadFormat", "includeDateInFilename", "includeTimestampInBody", "enableDebugLogs"]) {
      expect(host.querySelector(`#${id}`), `#${id} 应保留`).toBeTruthy();
    }
    expect(host.textContent).toContain("下载格式");
    expect(host.textContent).toContain("文件名前包含导出日期");
    expect(host.textContent).toContain("在字幕正文中保留时间戳");
  });
});

// 恢复默认的二次确认走 ui/confirm-dialog.js 面板内弹层（不用原生 confirm）：
// 弹层宿主挂在 #biliscript-reading-view 直下，mountPanel 需包上阅读视图；结算方式是
// 点击弹层内的确认/取消按钮。
describe("恢复默认偏好按钮", () => {
  async function openResetDialog() {
    const button = await vi.waitFor(() => {
      const node = document.querySelector(".confirm-dialog-confirm");
      if (!node) throw new Error("确认弹层未打开");
      return node;
    });
    return button;
  }

  it("面板内确认弹层：点「恢复默认」后把偏好键面写回默认值，平台域键不参与", async () => {
    const sent = installMessageBus();
    const host = await mountPanel();

    fireClick(host.querySelector("#biliscriptSettingsResetBtn")!);
    const confirmBtn = await openResetDialog();
    // 警示着色（danger）：与删除平台的确认同源的红色确认键
    expect(document.querySelector(".confirm-dialog-confirm-danger")).toBeTruthy();
    fireClick(confirmBtn);

    await vi.waitFor(() => {
      const payloads = sent
        .filter((message) => message.type === "save-settings")
        .map((message) => message.settings);
      expect(payloads.some((settings) => settings?.aiSystemPrompt === DEFAULT_AI_SYSTEM_PROMPT)).toBe(true);
    });
    const payloads = sent
      .filter((message) => message.type === "save-settings")
      .map((message) => message.settings);
    const resetPayload = payloads.find((settings) => settings?.aiSystemPrompt === DEFAULT_AI_SYSTEM_PROMPT)!;
    expect(resetPayload).toBeDefined();
    // 偏好键面：aiSystemPrompt/playerAiQuickPrompt 落当前默认文本，快捷提示词/开关也在载荷里
    expect(resetPayload.playerAiQuickPrompt).toBe(DEFAULT_PLAYER_AI_QUICK_PROMPT);
    expect(resetPayload.enablePlayerAiQuickAction).toBe(DEFAULT_SETTINGS.enablePlayerAiQuickAction);
    // 平台域配置（模型选择 / ASR 标量）与迁移旗标不参与重置
    expect(resetPayload).not.toHaveProperty("defaultModel");
    expect(resetPayload).not.toHaveProperty("activeAsrProviderId");
    expect(resetPayload).not.toHaveProperty("asrAutoFallback");
    expect(resetPayload).not.toHaveProperty("asrLanguage");
    expect(resetPayload).not.toHaveProperty("aiBtnDefaultOnMigrated");
    // 笔记导出字段已退出偏好键面：重置载荷不再携带
    for (const key of [
      "tags",
      "includeHotCommentsInNote",
      "includePlayerEmbedInNote",
      "frontmatterFields",
      "fixedFrontmatterProperties",
      "notePlaceholderSections"
    ]) {
      expect(resetPayload, `${key} 不应出现在重置载荷里`).not.toHaveProperty(key);
    }
    await vi.waitFor(() => {
      expect(lastStatus(host).textContent).toContain("已恢复默认设置");
    });
  });

  it("确认弹层点「取消」时不发任何保存消息", async () => {
    const sent = installMessageBus();
    const host = await mountPanel();

    fireClick(host.querySelector("#biliscriptSettingsResetBtn")!);
    const cancelBtn = await vi.waitFor(() => {
      const node = document.querySelector(".confirm-dialog-cancel");
      if (!node) throw new Error("确认弹层未打开");
      return node;
    });
    fireClick(cancelBtn);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sent.some((message) => message.type === "save-settings")).toBe(false);
    expect(lastStatus(host).textContent).not.toContain("已恢复默认设置");
  });
});
