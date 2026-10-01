// 设置抽屉「外观」分区（主题族 readerThemeFamily）模板与设置链直测。
//
// 两轴正交（2026-09）：主题族 bilibili | flyme 在设置抽屉手选，明暗
// light | dark 由 header 按钮两态切换（tests/reader/settings.test.ts 守链路）。
// 本文件守三件事：
//   1. 分区位置与模板契约（最前，AI 模型平台之前；id/类名/选项文案）；
//   2. 装载填值经 normalizeReaderThemeFamily（未知存量值回落 bilibili，
//      不是把非法值硬塞给 select 变成空选）；
//   3. 保存载荷携带 readerThemeFamily（collectFormPayload 收集口径）；
//   4. 「恢复默认偏好」载荷把族写回默认 bilibili——族是偏好键面的一部分，
//      重置后不留旧族（否则 UI 回 bilibili 而存储仍旧族）；
//   5. 主题族下拉选中即生效（change → save-settings），与平台行即时保存同口径，
//      不需要点「保存设置」；装载水合属程序化写值，不得误判成用户改选。
// 骨架与消息总线复用 tests/ui/settings-panel-save.test.ts 的同款手法。

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { resetModuleState } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { DEFAULT_AI_SYSTEM_PROMPT } from "../../extension/core/default-prompts.js";

type SentMessage = { type: string; settings?: Record<string, unknown>; [key: string]: unknown };
type MessageResponder = (message: SentMessage) => Record<string, unknown>;
type SendMessageMock = Mock<(message: SentMessage, callback?: (response?: unknown) => void) => undefined>;

let sendMessageMock: SendMessageMock | null = null;

function installMessageBus(overrides: Record<string, MessageResponder> = {}): SentMessage[] {
  const responders: Record<string, MessageResponder> = {
    "get-settings": () => ({ ok: true, settings: {} }),
    // 预设列表返回失败 → settings-panel 回落内置预设，装载链照常走完
    "ai-presets-list": () => ({ ok: false }),
    "asr-presets-list": () => ({ ok: false }),
    "ai-providers-list": () => ({ ok: true, providers: [] }),
    "asr-providers-list": () => ({ ok: true, providers: [] }),
    "search-providers-list": () => ({ ok: true, providers: [] }),
    "save-settings": () => ({ ok: true }),
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
  document.body.innerHTML =
    '<div id="biliscript-reading-view"><div id="biliscript-reading-settings-host"></div></div>';
  const panel = await import("../../extension/ui/settings-panel.js");
  panel.renderReaderSettingsPanel();
  const host = document.getElementById("biliscript-reading-settings-host")!;
  // loadSettings 是 fire-and-forget：等装载链末路（search-providers-list）走完
  await vi.waitFor(() => {
    expect(sendMessageMock!.mock.calls.some(([message]) => message.type === "search-providers-list")).toBe(true);
  });
  return host;
}

function fireClick(node: Element): void {
  node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

// 接管壳按初始化标记等待（tests/ui/custom-select.test.ts 同款）：挂载点在
// loadSettings（fire-and-forget）内，等标记比等异步消息更贴真实就绪时刻。
async function waitForCustomSelect(host: HTMLElement, selectId: string): Promise<HTMLSelectElement> {
  let select: HTMLSelectElement | null = null;
  await vi.waitFor(() => {
    select = host.querySelector<HTMLSelectElement>(`#${selectId}`);
    expect(select?.dataset.customSelectInitialized, `#${selectId} 的自定义下拉壳未挂载`).toBe("1");
  });
  return select!;
}

beforeEach(() => {
  resetModuleState();
});

describe("设置抽屉「外观」分区：主题族下拉", () => {
  it("分区排在最前（AI 模型平台之前），标题/标签/选项文案齐备", async () => {
    installMessageBus();
    const host = await mountPanel();

    const firstGroup = host.querySelector<HTMLElement>(".biliscript-set-group")!;
    expect(firstGroup.querySelector(".biliscript-set-h")?.textContent).toBe("外观");
    const select = firstGroup.querySelector<HTMLSelectElement>("#readerThemeFamily")!;
    expect(select, "外观分区应含 #readerThemeFamily 下拉").toBeTruthy();
    expect(select.classList.contains("biliscript-set-select")).toBe(true);
    expect(firstGroup.querySelector(".biliscript-set-label")?.textContent).toBe("主题");

    const groups = [...host.querySelectorAll<HTMLElement>(".biliscript-set-group")];
    const aiIndex = groups.findIndex(
      (group) => group.querySelector(".biliscript-set-h")?.textContent === "AI 模型平台"
    );
    expect(aiIndex, "AI 模型平台分区应在场").toBeGreaterThan(0);

    const options = [...select.options].map((option) => [option.value, option.textContent]);
    expect(options).toEqual([
      ["bilibili", "Bilibili"],
      ["flyme", "Flyme"]
    ]);
  });

  it("装载时按设置填值（flyme）", async () => {
    installMessageBus({ "get-settings": () => ({ ok: true, settings: { readerThemeFamily: "flyme" } }) });
    const host = await mountPanel();

    expect(host.querySelector<HTMLSelectElement>("#readerThemeFamily")!.value).toBe("flyme");
  });

  it("装载时未知存量值经归一化回落 bilibili（不落空选）", async () => {
    installMessageBus({ "get-settings": () => ({ ok: true, settings: { readerThemeFamily: "paper" } }) });
    const host = await mountPanel();

    expect(host.querySelector<HTMLSelectElement>("#readerThemeFamily")!.value).toBe("bilibili");
  });

  it("保存载荷携带主题族（选 flyme → save-settings.readerThemeFamily = flyme）", async () => {
    const sent = installMessageBus();
    const host = await mountPanel();

    host.querySelector<HTMLSelectElement>("#readerThemeFamily")!.value = "flyme";
    fireClick(host.querySelector("#biliscriptSettingsSaveBtn")!);

    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "save-settings")).toBe(true);
    });
    const saveMessage = sent.find((message) => message.type === "save-settings")!;
    expect(saveMessage.settings).toMatchObject({ readerThemeFamily: "flyme" });
  });

  // 恢复默认的二次确认走 ui/confirm-dialog.js 面板内弹层：点确认后按
  // buildDefaultPreferencePayload 的键面落盘。装载值是 flyme，重置载荷必须回
  // bilibili（证明写的是默认值而不是回写装载值）。
  it("恢复默认偏好：载荷把主题族写回默认 bilibili", async () => {
    const sent = installMessageBus({
      "get-settings": () => ({ ok: true, settings: { readerThemeFamily: "flyme" } })
    });
    const host = await mountPanel();

    fireClick(host.querySelector("#biliscriptSettingsResetBtn")!);
    fireClick(
      await vi.waitFor(() => {
        const node = document.querySelector(".confirm-dialog-confirm");
        if (!node) throw new Error("确认弹层未打开");
        return node;
      })
    );

    await vi.waitFor(() => {
      expect(sent.some((message) => message.settings?.aiSystemPrompt === DEFAULT_AI_SYSTEM_PROMPT)).toBe(true);
    });
    const resetPayload = sent.find((message) => message.settings?.aiSystemPrompt === DEFAULT_AI_SYSTEM_PROMPT)!.settings!;
    expect(resetPayload.readerThemeFamily).toBe(DEFAULT_SETTINGS.readerThemeFamily);
    expect(resetPayload.readerThemeFamily).toBe("bilibili");
  });
});

// ADR-0007：设置页下拉统一到 ui/custom-select.ts。主题族下拉曾漏接（原生 select
// 在 Windows 上弹系统方角菜单，与已接管的下载格式不是一族观感）。本组守三件事：
// 结构接管、水合显示与值一致、选项点击后的值/收集链同步。
describe("设置抽屉「外观」分区：主题族下拉接入 custom-select（ADR-0007）", () => {
  it("原生 select 被组件接管：落在 wrapper 内，有 trigger，视觉隐藏且退出 Tab 序", async () => {
    installMessageBus();
    const host = await mountPanel();
    const select = await waitForCustomSelect(host, "readerThemeFamily");

    const wrapper = select.closest<HTMLElement>(".custom-select-wrapper");
    expect(wrapper, "#readerThemeFamily 未落进 .custom-select-wrapper").toBeTruthy();
    expect(wrapper!.querySelector<HTMLElement>(".custom-select-trigger")).toBeTruthy();
    expect(wrapper!.querySelector<HTMLElement>(".custom-select-dropdown")).toBeTruthy();
    // 隐藏走内联 display:none：select 天然退出 Tab 序与无障碍树，不再加类/tabIndex/
    // aria-hidden，也不被宿主里 100%×32px 的原生 select 外观规则压回
    expect(select.style.display).toBe("none");
    expect(select.getAttribute("tabindex")).toBeNull();
    expect(select.getAttribute("aria-hidden")).toBeNull();
  });

  it("水合值（flyme）与 trigger 显示值一致（Flyme）", async () => {
    installMessageBus({ "get-settings": () => ({ ok: true, settings: { readerThemeFamily: "flyme" } }) });
    const host = await mountPanel();
    const select = await waitForCustomSelect(host, "readerThemeFamily");

    const trigger = select.closest<HTMLElement>(".custom-select-wrapper")!.querySelector<HTMLElement>(".custom-select-trigger")!;
    expect(select.value).toBe("flyme");
    expect(trigger.querySelector(".custom-select-value")!.textContent).toBe("Flyme");
  });

  it("经 trigger 选项选中：select.value 写回且保存载荷取到新值", async () => {
    const sent = installMessageBus();
    const host = await mountPanel();
    const select = await waitForCustomSelect(host, "readerThemeFamily");
    const option = select
      .closest<HTMLElement>(".custom-select-wrapper")!
      .querySelector<HTMLElement>('.custom-select-option[data-value="flyme"]')!;

    fireClick(option);
    expect(select.value).toBe("flyme");

    fireClick(host.querySelector("#biliscriptSettingsSaveBtn")!);
    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === "save-settings")).toBe(true);
    });
    expect(sent.find((message) => message.type === "save-settings")!.settings).toMatchObject({
      readerThemeFamily: "flyme"
    });
  });
});

// 主题族选中即生效：与平台行的即时保存同口径（settings-panel.ts 里 provider 删除
// 处理器直接发 save-settings），改选即落盘，不依赖「保存设置」按钮——用户以为切了
// 就生效、实际要再点一次保存的错位是最容易踩的坑。水合是程序化写 select.value，
// 不派发 change，天然不该落盘；拿它当反例守住「监听的是用户改选而不是值变化」。
describe("设置抽屉「外观」分区：主题族下拉选中即生效（不经「保存设置」）", () => {
  function saveMessages(sent: SentMessage[]): SentMessage[] {
    return sent.filter((message) => message.type === "save-settings");
  }

  function optionOf(select: HTMLSelectElement, value: string): HTMLElement {
    return select
      .closest<HTMLElement>(".custom-select-wrapper")!
      .querySelector<HTMLElement>(`.custom-select-option[data-value="${value}"]`)!;
  }

  it("经自定义下拉选中 Flyme：不点保存设置，save-settings 立即发出且只带族", async () => {
    const sent = installMessageBus();
    const host = await mountPanel();
    const select = await waitForCustomSelect(host, "readerThemeFamily");

    fireClick(optionOf(select, "flyme"));

    await vi.waitFor(() => {
      expect(saveMessages(sent).length, "选中 Flyme 后未立即发出 save-settings").toBe(1);
    });
    expect(saveMessages(sent)[0].settings).toEqual({ readerThemeFamily: "flyme" });
  });

  it("经自定义下拉选回 Bilibili：立即落盘 bilibili", async () => {
    const sent = installMessageBus({
      "get-settings": () => ({ ok: true, settings: { readerThemeFamily: "flyme" } })
    });
    const host = await mountPanel();
    const select = await waitForCustomSelect(host, "readerThemeFamily");

    fireClick(optionOf(select, "bilibili"));

    await vi.waitFor(() => {
      expect(saveMessages(sent).length, "选回 Bilibili 后未立即发出 save-settings").toBe(1);
    });
    expect(saveMessages(sent)[0].settings).toEqual({ readerThemeFamily: "bilibili" });
  });

  it("装载水合（含二次装载）不触发即时保存", async () => {
    const sent = installMessageBus({
      "get-settings": () => ({ ok: true, settings: { readerThemeFamily: "flyme" } })
    });
    const host = await mountPanel();
    const select = await waitForCustomSelect(host, "readerThemeFamily");
    const trigger = select.closest<HTMLElement>(".custom-select-wrapper")!.querySelector<HTMLElement>(".custom-select-trigger")!;
    expect(select.value).toBe("flyme");
    expect(trigger.querySelector(".custom-select-value")!.textContent).toBe("Flyme");
    expect(saveMessages(sent)).toEqual([]);

    // 抽屉二次打开：loadSettings 再跑一轮（select 已接管，initCustomSelect 幂等），
    // 这轮程序化写值同样不得被当成用户改选；显示同样从现值派生（不滞留旧值）。
    const panel = await import("../../extension/ui/settings-panel.js");
    panel.renderReaderSettingsPanel();
    await vi.waitFor(() => {
      expect(sent.filter((message) => message.type === "search-providers-list").length).toBe(2);
    });
    expect(select.value).toBe("flyme");
    expect(trigger.querySelector(".custom-select-value")!.textContent).toBe("Flyme");
    expect(saveMessages(sent)).toEqual([]);
  });
});

// 主题族下拉挂的挂载点与下载格式同一个（loadSettings 水合之后）：组件初始化时读一次
// select.value 生成 trigger 显示值，挂早一步就会写模板默认项。这条守住那处口径。
describe("设置抽屉下拉的统一挂载口径（水合值 → trigger 显示值）", () => {
  it("下载格式水合 txt：trigger 显示 TXT（不是模板默认 SRT）", async () => {
    installMessageBus({ "get-settings": () => ({ ok: true, settings: { downloadFormat: "txt" } }) });
    const host = await mountPanel();
    const select = await waitForCustomSelect(host, "downloadFormat");

    const trigger = select.closest<HTMLElement>(".custom-select-wrapper")!.querySelector<HTMLElement>(".custom-select-trigger")!;
    expect(select.value).toBe("txt");
    expect(trigger.querySelector(".custom-select-value")!.textContent).toBe("TXT");
  });

  it("恢复默认偏好：trigger 跟随默认值（重置写值后显示随之派生）", async () => {
    let resetSaved = false;
    installMessageBus({
      // 重置前存量值是 flyme；重置落盘后按默认值读取（模拟后台已写入默认）
      "get-settings": () => ({ ok: true, settings: resetSaved ? {} : { readerThemeFamily: "flyme" } }),
      "save-settings": () => {
        resetSaved = true;
        return { ok: true };
      }
    });
    const host = await mountPanel();
    const select = await waitForCustomSelect(host, "readerThemeFamily");
    const trigger = select.closest<HTMLElement>(".custom-select-wrapper")!.querySelector<HTMLElement>(".custom-select-trigger")!;
    expect(trigger.querySelector(".custom-select-value")!.textContent).toBe("Flyme");

    fireClick(host.querySelector("#biliscriptSettingsResetBtn")!);
    fireClick(
      await vi.waitFor(() => {
        const node = document.querySelector(".confirm-dialog-confirm");
        if (!node) throw new Error("确认弹层未打开");
        return node;
      })
    );

    await vi.waitFor(() => {
      expect(select.value).toBe("bilibili");
    });
    expect(trigger.querySelector(".custom-select-value")!.textContent).toBe("Bilibili");
  });
});
