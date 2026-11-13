// tests/ui/provider-editor-form.test.ts
// 票 10：编辑器表单、焦点与权限恢复的行为契约（jsdom 能表达的部分）。
//
// 失败方式（每条对应下面一组用例）：
//   F1 提交不是语义化表单：保存键点击 / Enter 隐式提交不是同一条链；
//   F2 字段错误只有状态行、不定位控件：错误无 aria-invalid/描述、焦点不在首个
//      无效字段；
//   F3 输入修正清掉未解决错误：改 API 地址把 Key 错误一起清掉，或普通状态行被
//      输入误清；
//   F4 合法提交可重复落盘：双击 / 连发表单触发两次保存；
//   F5 焦点逃出当前层或关闭后不归还仍有效的触发控件；
//   F6 权限拒绝与普通失败混在一起：测试 / 拉取 / 保存不可区分且无重新授权路径；
//   F7 权限申请拆成多次：多 origin 平台一条消息之外再发一条（或手势链断裂）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { ASR_PROVIDER_PRESETS, PRESETS } from "../../extension/core/presets.js";
import { LIVE_PROVIDER_PRESETS } from "../../extension/live/live-provider-store.js";
import type { ProviderRowItem } from "../../extension/ui/provider-row.js";

type SentMessage = { type: string } & Record<string, any>;

const { testAsrConnection, testLiveConnection } = vi.hoisted(() => ({
  testAsrConnection: vi.fn(async (_params: { baseUrl?: string; model?: string }) => ({ ok: true })),
  testLiveConnection: vi.fn(async (_params: { baseUrl?: string; model?: string }) => ({ ok: true }))
}));

vi.mock("../../extension/asr/provider-test.js", () => ({ testAsrConnection }));
vi.mock("../../extension/asr/provider-models.js", () => ({
  listAsrModels: vi.fn(async () => ({ ok: false, error: "not used" }))
}));
vi.mock("../../extension/live/live-provider-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/live/live-provider-store.js")>();
  return {
    ...actual,
    testLiveConnection,
    listLiveVoices: vi.fn(async () => ({ ok: false, error: "not used" })),
    listLiveModels: vi.fn(async () => ({ ok: false, error: "not used" }))
  };
});

let sent: SentMessage[] = [];
let denyOrigins: string | null = null;

function installBus(): void {
  sent = [];
  const sendMessage = vi.fn((message: SentMessage, callback?: (response?: unknown) => void) => {
    sent.push(message);
    if (message.type === "request-provider-origins") {
      callback?.(denyOrigins ? { ok: false, error: denyOrigins } : { ok: true });
      return undefined;
    }
    callback?.({ ok: true, providers: [] });
    return undefined;
  });
  (chrome as unknown as { runtime: { sendMessage: unknown } }).runtime.sendMessage = sendMessage;
}

function mountView(): void {
  document.body.innerHTML = `
    <div id="biliscript-reading-view">
      <section id="biliscript-reading-settings-panel"></section>
    </div>`;
}

async function openEditor(options: {
  kind?: "ai" | "asr" | "search" | "live";
  firstSetup?: boolean;
  item?: ProviderRowItem | null;
  onSave?: (kind: string, upsert: ProviderRowItem) => Promise<{ ok: boolean; error?: string; permissionDenied?: boolean }>;
} = {}): Promise<HTMLElement> {
  const kind = options.kind ?? "ai";
  const presets =
    kind === "asr"
      ? ASR_PROVIDER_PRESETS
      : kind === "live"
        ? LIVE_PROVIDER_PRESETS
        : PRESETS;
  const { openProviderEditor } = await import("../../extension/ui/provider-editor.js");
  openProviderEditor({
    kind,
    item: options.item ?? null,
    presets,
    onSave: options.onSave ?? (async () => ({ ok: true })),
    firstSetup: options.firstSetup === true
  });
  return document.querySelector<HTMLElement>(".provider-editor-dialog")!;
}

function fireClick(node: Element | null): void {
  node!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function setFieldValue(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function fieldError(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".provider-editor-dialog");
}

beforeEach(() => {
  resetModuleState();
  mountView();
  installBus();
  denyOrigins = null;
  testAsrConnection.mockReset();
  testAsrConnection.mockResolvedValue({ ok: true });
  testLiveConnection.mockReset();
  testLiveConnection.mockResolvedValue({ ok: true });
});

afterEach(async () => {
  const { closeProviderEditor } = await import("../../extension/ui/provider-editor.js");
  closeProviderEditor(true);
});

describe("语义化表单提交", () => {
  it("字段与底部动作同属 form：保存键是 submit、取消是 button，表单 submit 走同一条保存链", async () => {
    const onSave = vi.fn(async () => ({ ok: true }));
    const editor = await openEditor({ onSave });
    const form = editor.querySelector<HTMLFormElement>("form.provider-editor-form")!;
    expect(form).toBeTruthy();
    expect(form.noValidate).toBe(true);
    expect(editor.querySelector<HTMLButtonElement>(".provider-editor-save")!.type).toBe("submit");
    expect(editor.querySelector<HTMLButtonElement>(".provider-editor-cancel")!.type).toBe("button");

    setFieldValue(editor.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    setFieldValue(editor.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    // Enter 隐式提交走 form 的 submit（不点保存键）
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
  });

  it("保存键点击取消原生提交默认动作，不会与 form submit 重复结算", async () => {
    const onSave = vi.fn(async () => ({ ok: true }));
    const editor = await openEditor({ onSave });
    setFieldValue(editor.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    setFieldValue(editor.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");

    fireClick(editor.querySelector(".provider-editor-save"));

    await vi.waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
  });
});

describe("字段级校验与焦点定位", () => {
  it("AI 缺 URL / Key：错误落到具体控件，聚焦首个无效字段；修正只清已解决错误", async () => {
    const onSave = vi.fn(async () => ({ ok: true }));
    const editor = await openEditor({ onSave });
    const baseUrl = editor.querySelector<HTMLInputElement>(".provider-editor-baseurl")!;
    const apiKey = editor.querySelector<HTMLInputElement>(".provider-editor-apikey")!;

    fireClick(editor.querySelector(".provider-editor-save"));

    expect(onSave).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(baseUrl);
    expect(baseUrl.getAttribute("aria-invalid")).toBe("true");
    expect(baseUrl.getAttribute("aria-describedby")).toBe("provider-editor-error-baseurl");
    expect(fieldError("provider-editor-error-baseurl").hidden).toBe(false);
    expect(fieldError("provider-editor-error-baseurl").textContent).toBe("请填写 API 地址");
    expect(fieldError("provider-editor-error-apikey").hidden).toBe(false);
    expect(fieldError("provider-editor-error-apikey").textContent).toContain("需要填写 API Key");
    expect(editor.querySelector<HTMLElement>(".provider-editor-status")!.textContent).toBe("请填写 API 地址");

    // 只修正 API 地址：地址错误清掉，Key 错误仍在，汇总行换成剩余项
    setFieldValue(baseUrl, "https://api.example.com/v1");
    expect(baseUrl.getAttribute("aria-invalid")).toBeNull();
    expect(fieldError("provider-editor-error-baseurl").hidden).toBe(true);
    expect(fieldError("provider-editor-error-apikey").hidden).toBe(false);
    expect(editor.querySelector<HTMLElement>(".provider-editor-status")!.textContent).toContain("需要填写 API Key");

    // 修正 Key：全部字段错误与校验汇总清空
    setFieldValue(apiKey, "sk-test");
    expect(fieldError("provider-editor-error-apikey").hidden).toBe(true);
    expect(apiKey.getAttribute("aria-invalid")).toBeNull();
    expect(editor.querySelector<HTMLElement>(".provider-editor-status")!.hidden).toBe(true);
  });

  it("非法 API 地址：同样定位到地址控件", async () => {
    const onSave = vi.fn(async () => ({ ok: true }));
    const editor = await openEditor({ onSave });
    const baseUrl = editor.querySelector<HTMLInputElement>(".provider-editor-baseurl")!;
    setFieldValue(baseUrl, "api.example.com/v1");
    setFieldValue(editor.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");

    fireClick(editor.querySelector(".provider-editor-save"));

    expect(onSave).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(baseUrl);
    expect(fieldError("provider-editor-error-baseurl").textContent).toContain("http://");
  });

  it("ASR 单模型字段：缺模型名定位到模型输入", async () => {
    const onSave = vi.fn(async () => ({ ok: true }));
    const editor = await openEditor({ kind: "asr", onSave });
    setFieldValue(editor.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://asr.example.com/v1");
    setFieldValue(editor.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    // 预设自带模型名：清空以触发单模型字段错误
    setFieldValue(editor.querySelector<HTMLInputElement>(".provider-editor-model")!, "");

    fireClick(editor.querySelector(".provider-editor-save"));

    expect(onSave).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editor.querySelector<HTMLInputElement>(".provider-editor-model"));
    expect(fieldError("provider-editor-error-model").hidden).toBe(false);
    expect(fieldError("provider-editor-error-model").textContent).toBe("请填写模型名");
  });

  it("首配缺模型：错误定位到目录区，聚焦「添加模型」", async () => {
    const onSave = vi.fn(async () => ({ ok: true }));
    const editor = await openEditor({ firstSetup: true, onSave });
    setFieldValue(editor.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    setFieldValue(editor.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");

    fireClick(editor.querySelector(".provider-editor-save"));

    expect(onSave).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editor.querySelector(".provider-editor-model-add"));
    expect(fieldError("provider-editor-error-models").hidden).toBe(false);
    expect(fieldError("provider-editor-error-models").textContent).toBe("请至少添加一个模型后再保存");
    expect(editor.querySelector<HTMLElement>(".provider-editor-status")!.textContent).toContain("请至少添加一个模型");

    // 加一个模型：该错误随修正清掉
    fireClick(editor.querySelector(".provider-editor-model-add"));
    expect(fieldError("provider-editor-error-models").hidden).toBe(true);
  });

  it("普通保存失败（非权限）不被字段修正误清", async () => {
    const editor = await openEditor({
      onSave: async () => ({ ok: false, error: "sync 配额不足" })
    });
    setFieldValue(editor.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    setFieldValue(editor.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    fireClick(editor.querySelector(".provider-editor-save"));
    await vi.waitFor(() => {
      expect(editor.querySelector<HTMLElement>(".provider-editor-status")!.textContent).toBe("sync 配额不足");
    });

    // 修正一个已合法的字段不得清掉与它无关的落盘失败
    setFieldValue(editor.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api2.example.com/v1");
    expect(editor.querySelector<HTMLElement>(".provider-editor-status")!.textContent).toBe("sync 配额不足");
  });
});

describe("重复提交拦截", () => {
  it("合法提交在飞时忽略后一次（保存键双击 + 表单连发只落盘一次）", async () => {
    let resolveSave: ((result: { ok: boolean }) => void) | undefined;
    const onSave = vi.fn(
      () => new Promise<{ ok: boolean }>((resolve) => { resolveSave = resolve; })
    );
    const editor = await openEditor({ onSave });
    setFieldValue(editor.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    setFieldValue(editor.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");

    fireClick(editor.querySelector(".provider-editor-save"));
    fireClick(editor.querySelector(".provider-editor-save"));
    editor
      .querySelector("form.provider-editor-form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(editor.querySelector<HTMLButtonElement>(".provider-editor-save")!.disabled).toBe(true);

    resolveSave!({ ok: true });
    await vi.waitFor(() => {
      expect(dialog()).toBeNull();
    });
  });
});

describe("焦点约束与归还", () => {
  it("Tab 在当前层内环绕：末位 Tab 回首位，首位 Shift+Tab 回末位", async () => {
    const editor = await openEditor();
    const first = editor.querySelector<HTMLElement>(".custom-select-trigger")!;
    const last = editor.querySelector<HTMLElement>(".provider-editor-save")!;

    last.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(first);

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })
    );
    expect(document.activeElement).toBe(last);
  });

  it("取消关闭后焦点归还仍有效的触发控件", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "编辑";
    document.getElementById("biliscript-reading-view")!.appendChild(trigger);
    trigger.focus();

    await openEditor();
    expect(document.activeElement).toBe(dialog());

    fireClick(document.querySelector(".provider-editor-cancel"));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("触发控件已移除时不归还焦点", async () => {
    const trigger = document.createElement("button");
    document.getElementById("biliscript-reading-view")!.appendChild(trigger);
    trigger.focus();

    await openEditor();
    trigger.remove();
    fireClick(document.querySelector(".provider-editor-cancel"));
    expect(document.activeElement).not.toBe(trigger);
  });

  it("dirty 确认框打开后焦点进入确认层，Esc 只结算确认框；取消后焦点回编辑器", async () => {
    const editor = await openEditor();
    setFieldValue(editor.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    const confirm = document.querySelector<HTMLElement>(".confirm-dialog")!;
    expect(confirm).toBeTruthy();
    // 安全默认焦点在取消键；编辑器让位，焦点不留在下层
    expect(document.activeElement).toBe(confirm.querySelector(".confirm-dialog-cancel"));

    // Tab 被约束在确认层（下层编辑器的 Tab 陷阱不得抢先结算）
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(confirm.contains(document.activeElement)).toBe(true);

    // 一次 Esc 只关确认框，编辑器仍在；焦点归还编辑器层
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(document.querySelector(".confirm-dialog")).toBeNull();
    expect(dialog()).toBe(editor);
    expect(document.activeElement).toBe(editor);
  });

  it("设置抽屉收起：确认框与编辑器一起收场，不留孤儿弹层", async () => {
    const editor = await openEditor();
    setFieldValue(editor.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(document.querySelector(".confirm-dialog")).toBeTruthy();

    document.getElementById("biliscript-reading-settings-panel")!.hidden = true;
    await vi.waitFor(() => {
      expect(dialog()).toBeNull();
      expect(document.querySelector(".confirm-dialog-host")).toBeNull();
    });
  });
});

describe("权限失败区分与重新授权", () => {
  it("保存权限被拒：状态行标「未保存」，保存键保持可点（再次点击重新授权）", async () => {
    const onSave = vi.fn(async () => ({
      ok: false,
      error: "未授权 https://api.example.com/*，保存已中止",
      permissionDenied: true
    }));
    const editor = await openEditor({ onSave });
    setFieldValue(editor.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://api.example.com/v1");
    setFieldValue(editor.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");

    fireClick(editor.querySelector(".provider-editor-save"));
    await vi.waitFor(() => {
      expect(editor.querySelector<HTMLElement>(".provider-editor-status")!.textContent).toContain("未保存");
    });
    const status = editor.querySelector<HTMLElement>(".provider-editor-status")!;
    expect(status.textContent).toContain("重新授权");
    expect(editor.querySelector<HTMLButtonElement>(".provider-editor-save")!.disabled).toBe(false);

    // 重新点击即重新申请（装配方重新走权限链），不是一次性死状态
    fireClick(editor.querySelector(".provider-editor-save"));
    await vi.waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(2);
    });
  });

  it("测试权限被拒：状态行标「未测试」，不发探针、按钮可再点", async () => {
    denyOrigins = "未授权 https://asr.example.com/*，操作已中止";
    const editor = await openEditor({ kind: "asr" });
    setFieldValue(editor.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://asr.example.com/v1");
    setFieldValue(editor.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");
    setFieldValue(editor.querySelector<HTMLInputElement>(".provider-editor-model")!, "whisper-1");

    fireClick(editor.querySelector(".provider-editor-test"));

    await vi.waitFor(() => {
      expect(editor.querySelector<HTMLElement>(".provider-editor-status")!.textContent).toContain("未测试");
    });
    const status = editor.querySelector<HTMLElement>(".provider-editor-status")!;
    expect(status.textContent).toContain("重新授权");
    expect(testAsrConnection).not.toHaveBeenCalled();
    expect(editor.querySelector<HTMLButtonElement>(".provider-editor-test")!.disabled).toBe(false);
  });

  it("拉取模型权限被拒：子视图标「未拉取」并提供原位重试（重新授权）", async () => {
    denyOrigins = "未授权 https://token.sensenova.cn/*，操作已中止";
    const editor = await openEditor();
    setFieldValue(editor.querySelector<HTMLInputElement>(".provider-editor-baseurl")!, "https://token.sensenova.cn/v1");
    setFieldValue(editor.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");

    fireClick(editor.querySelector(".provider-editor-fetch"));

    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>(".provider-editor-fetch-error")!.hidden).toBe(false);
    });
    const error = document.querySelector<HTMLElement>(".provider-editor-fetch-error")!;
    expect(error.textContent).toContain("未拉取");
    expect(error.textContent).toContain("重新授权");
    const retry = error.querySelector<HTMLButtonElement>(".provider-editor-fetch-retry")!;
    expect(retry.textContent).toBe("重试");

    fireClick(retry);
    await vi.waitFor(() => {
      expect(sent.filter((message) => message.type === "request-provider-origins")).toHaveLength(2);
    });
  });

  it("Live 测试：读当前未保存草稿，多 origin 合并为单次权限请求且落在点击同步链上；成功不自动保存", async () => {
    const editor = await openEditor({ kind: "live" });
    const baseUrl = editor.querySelector<HTMLInputElement>(".provider-editor-baseurl")!;
    const model = editor.querySelector<HTMLInputElement>(".provider-editor-model")!;
    // 未保存草稿：测试必须用当前输入，而不是已存记录 / 预设默认值
    setFieldValue(baseUrl, "https://draft.mosi.cn");
    setFieldValue(model, "moss-live-draft");
    setFieldValue(editor.querySelector<HTMLInputElement>(".provider-editor-apikey")!, "sk-test");

    fireClick(editor.querySelector(".provider-editor-test"));

    // 点击当拍权限消息即出站（零先行 await），且两个 origin 合成一条请求
    const requests = sent.filter((message) => message.type === "request-provider-origins");
    expect(requests).toHaveLength(1);
    expect(requests[0].baseUrls).toEqual([
      "https://draft.mosi.cn",
      "wss://draft.mosi.cn/v1/realtime?model=moss-live-draft"
    ]);
    await vi.waitFor(() => {
      expect(testLiveConnection).toHaveBeenCalledTimes(1);
    });
    expect(testLiveConnection.mock.calls[0][0]).toMatchObject({
      baseUrl: "https://draft.mosi.cn",
      model: "moss-live-draft"
    });
    // 测试成功不写设置（只有保存动作落盘）
    expect(sent.some((message) => message.type === "live-providers-save")).toBe(false);
  });
});
