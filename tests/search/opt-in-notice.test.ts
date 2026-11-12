// tests/search/opt-in-notice.test.ts
// 联网搜索首次授权闸（spec §6.7 / 票 11）：标题与查询词外发说明、双动作文案、
// 付费平台费用提示、同意持久化、拒绝关闭联网偏好、写失败不阻断、偏好关闭后不重复
// 询问、重新开启再询问、授权与平台可用性分开、无阅读视图 fail-closed。
// chrome 桩按 type 路由（get-settings / resolve-search-provider / save-settings）；
// 弹层是真实 ui/confirm-dialog（DOM 由阅读视图宿主承载），断言面向用户可见文案与
// 出向消息，不直接调用内部步骤。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

interface StubSettings {
  webSearchEnabled?: boolean;
  searchOptInNoticeAcknowledged?: boolean;
}

interface StubOptions {
  settings?: StubSettings;
  // resolve-search-provider 的候选链（缺省 = 空链：未配置任何搜索平台）
  chain?: Array<{ provider: Record<string, unknown>; apiKey: string }>;
  // save-settings 一律失败（模拟授权写失败）
  saveFails?: boolean;
}

const DEFAULT_SETTINGS: StubSettings = { webSearchEnabled: true, searchOptInNoticeAcknowledged: false };

function stubChrome(options: StubOptions = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const settings: StubSettings = { ...DEFAULT_SETTINGS, ...(options.settings || {}) };
  const chromeStub = {
    runtime: {
      lastError: null as { message?: string } | null,
      getURL: (path: string) => `chrome-extension://test/${path}`,
      sendMessage: (msg: Record<string, unknown>, cb?: (response: unknown) => void) => {
        sent.push(msg);
        if (msg?.type === "get-settings") {
          cb?.({ ok: true, settings: { ...settings } });
          return undefined;
        }
        if (msg?.type === "resolve-search-provider") {
          cb?.(
            options.chain
              ? { ok: true, chain: options.chain, maxToolCalls: 3 }
              : { ok: true }
          );
          return undefined;
        }
        if (msg?.type === "save-settings") {
          if (options.saveFails) {
            chromeStub.runtime.lastError = { message: "storage write failed" };
            cb?.(undefined);
            chromeStub.runtime.lastError = null;
            return undefined;
          }
          Object.assign(settings, (msg.settings || {}) as StubSettings);
          cb?.({ ok: true });
          return undefined;
        }
        cb?.({ ok: true });
        return undefined;
      }
    }
  };
  vi.stubGlobal("chrome", chromeStub);
  return { sent, settings };
}

function mountReadingView(): void {
  document.body.innerHTML = '<div id="biliscript-reading-view"></div>';
}

async function loadOptIn() {
  return import("../../extension/search/opt-in-notice.js");
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".confirm-dialog");
}

function clickAction(action: "confirm" | "cancel"): void {
  const button = dialog()!.querySelector<HTMLButtonElement>(`[data-confirm-dialog-action="${action}"]`)!;
  button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ensureWebSearchOptIn：授权弹层内容", () => {
  it("明确标题 + 查询词外发说明 + 「允许并继续 / 关闭联网搜索」双动作", async () => {
    const { sent } = stubChrome();
    mountReadingView();
    const { ensureWebSearchOptIn } = await loadOptIn();

    const pending = ensureWebSearchOptIn();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());

    const box = dialog()!;
    expect(box.querySelector(".confirm-dialog-title")!.textContent).toBe("允许联网搜索？");
    const message = box.querySelector(".confirm-dialog-message")!.textContent!;
    expect(message).toContain("联网搜索会把查询词发往内置的免 Key 服务");
    expect(message).toContain("你配置过 Key 的搜索平台");
    expect(box.querySelector(".confirm-dialog-confirm")!.textContent).toBe("允许并继续");
    expect(box.querySelector(".confirm-dialog-cancel")!.textContent).toBe("关闭联网搜索");
    // 同意前只做本地链可用性探测（不执行搜索、不带查询词）
    expect(sent.some((m) => m.type === "resolve-search-provider")).toBe(true);
    expect(sent.some((m) => m.type === "search-cache")).toBe(false);

    clickAction("confirm");
    await expect(pending).resolves.toBe(true);
  });

  it("链含付费平台：文案提示会产生费用，且不写成价格承诺", async () => {
    stubChrome({
      chain: [
        {
          provider: {
            id: "search_deepseek",
            presetId: "deepseek",
            name: "DeepSeek Search",
            type: "deepseek",
            baseUrl: "https://api.deepseek.com",
            access: "paid"
          },
          apiKey: "sk-deepseek"
        }
      ]
    });
    mountReadingView();
    const { ensureWebSearchOptIn } = await loadOptIn();

    const pending = ensureWebSearchOptIn();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    const message = dialog()!.querySelector(".confirm-dialog-message")!.textContent!;
    expect(message).toContain("使用付费平台会产生费用");
    expect(message).toContain("具体计费方式以该平台为准");
    // 不写具体价格 / 免费额度承诺
    expect(message).not.toMatch(/¥|\$\d|\d+\s*元|免费额度/);

    clickAction("cancel");
    await expect(pending).resolves.toBe(false);
  });

  it("链不含付费平台：不追加费用提示", async () => {
    stubChrome({
      chain: [
        {
          provider: { id: "search_tavily", presetId: "tavily", name: "Tavily", type: "tavily", baseUrl: "https://api.tavily.com" },
          apiKey: ""
        }
      ]
    });
    mountReadingView();
    const { ensureWebSearchOptIn } = await loadOptIn();

    const pending = ensureWebSearchOptIn();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    expect(dialog()!.querySelector(".confirm-dialog-message")!.textContent).not.toContain("使用付费平台会产生费用");
    clickAction("cancel");
    await pending;
  });
});

describe("ensureWebSearchOptIn：同意 / 拒绝 / 写失败", () => {
  it("同意：持久化授权位并放行本轮搜索", async () => {
    const { sent, settings } = stubChrome();
    mountReadingView();
    const { ensureWebSearchOptIn } = await loadOptIn();

    const pending = ensureWebSearchOptIn();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    clickAction("confirm");

    await expect(pending).resolves.toBe(true);
    expect(sent).toContainEqual({ type: "save-settings", settings: { searchOptInNoticeAcknowledged: true } });
    expect(settings.searchOptInNoticeAcknowledged).toBe(true);
    expect(settings.webSearchEnabled).toBe(true);
  });

  it("拒绝：关闭联网偏好并回落本轮不搜索，弹层不残留", async () => {
    const { sent, settings } = stubChrome();
    mountReadingView();
    const { ensureWebSearchOptIn } = await loadOptIn();

    const pending = ensureWebSearchOptIn();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    clickAction("cancel");

    await expect(pending).resolves.toBe(false);
    expect(sent).toContainEqual({ type: "save-settings", settings: { webSearchEnabled: false } });
    expect(settings.webSearchEnabled).toBe(false);
    expect(settings.searchOptInNoticeAcknowledged).toBe(false);
    expect(dialog()).toBeNull();
  });

  it("授权写失败：本轮照常带搜索继续，不伪造授权位；下次仍会询问", async () => {
    const { sent, settings } = stubChrome({ saveFails: true });
    mountReadingView();
    const { ensureWebSearchOptIn } = await loadOptIn();

    const first = ensureWebSearchOptIn();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    clickAction("confirm");
    await expect(first).resolves.toBe(true);
    // 没有伪造成功：授权位仍未置位（下次询问）
    expect(settings.searchOptInNoticeAcknowledged).toBe(false);
    expect(sent.filter((m) => m.type === "save-settings")).toHaveLength(1);

    // 第二次：仍弹出授权（位没写成功，不假装已授权）
    const second = ensureWebSearchOptIn();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    clickAction("cancel");
    await second;
  });

  it("拒绝写失败不阻断本轮：照常返回不搜索", async () => {
    stubChrome({ saveFails: true });
    mountReadingView();
    const { ensureWebSearchOptIn } = await loadOptIn();

    const pending = ensureWebSearchOptIn();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    clickAction("cancel");
    await expect(pending).resolves.toBe(false);
  });
});

describe("ensureWebSearchOptIn：偏好关闭后不重复询问", () => {
  it("拒绝后的下一条消息（调用方残留开启态）不再弹层；重新开启才再次询问", async () => {
    const { settings } = stubChrome();
    mountReadingView();
    const { ensureWebSearchOptIn } = await loadOptIn();

    const first = ensureWebSearchOptIn(true);
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    clickAction("cancel");
    await expect(first).resolves.toBe(false);

    // 调用方仍以为开关开着（存储变更尚未同步）：偏好已关 → 直接本轮不搜索，不弹层
    await expect(ensureWebSearchOptIn(true)).resolves.toBe(false);
    expect(dialog()).toBeNull();

    // 用户重新开启开关（偏好回到 true）→ 再次询问
    settings.webSearchEnabled = true;
    const reopened = ensureWebSearchOptIn(true);
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    clickAction("confirm");
    await expect(reopened).resolves.toBe(true);
  });

  it("偏好本来就关：不弹层、不写设置", async () => {
    const { sent } = stubChrome({ settings: { webSearchEnabled: false } });
    mountReadingView();
    const { ensureWebSearchOptIn } = await loadOptIn();

    await expect(ensureWebSearchOptIn()).resolves.toBe(false);
    await expect(ensureWebSearchOptIn(true)).resolves.toBe(false);
    expect(dialog()).toBeNull();
    expect(sent.some((m) => m.type === "save-settings")).toBe(false);
  });

  it("已置位授权：直接放行，不弹层、不再写设置", async () => {
    const { sent } = stubChrome({ settings: { searchOptInNoticeAcknowledged: true } });
    mountReadingView();
    const { ensureWebSearchOptIn } = await loadOptIn();

    await expect(ensureWebSearchOptIn(true)).resolves.toBe(true);
    expect(dialog()).toBeNull();
    expect(sent.some((m) => m.type === "save-settings")).toBe(false);
  });
});

describe("ensureWebSearchOptIn：授权与平台可用性分开", () => {
  it("链为空也照常请求授权（免 Key 平台无需先完成平台配置），未配置文案不进授权层", async () => {
    stubChrome();
    mountReadingView();
    const { ensureWebSearchOptIn } = await loadOptIn();

    const pending = ensureWebSearchOptIn();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    const message = dialog()!.querySelector(".confirm-dialog-message")!.textContent!;
    // 授权文案只讲外发与费用；平台可用性另有既有文案通道（搜索运行时 / 工具循环）
    expect(message).not.toContain("未配置搜索平台");

    clickAction("confirm");
    await expect(pending).resolves.toBe(true);
  });

  it("免 Key 候选（apiKey 为空）不影响授权通过", async () => {
    stubChrome({
      chain: [
        {
          provider: {
            id: "search_anysearch",
            presetId: "anysearch",
            name: "AnySearch",
            type: "anysearch",
            baseUrl: "https://api.anysearch.com"
          },
          apiKey: ""
        }
      ]
    });
    mountReadingView();
    const { ensureWebSearchOptIn } = await loadOptIn();

    const pending = ensureWebSearchOptIn();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    expect(dialog()!.querySelector(".confirm-dialog-message")!.textContent).not.toContain("使用付费平台会产生费用");
    clickAction("confirm");
    await expect(pending).resolves.toBe(true);
  });

  it("付费链探测失败（消息异常）：按不含付费平台处理，不阻断授权", async () => {
    const { sent } = stubChrome();
    mountReadingView();
    // resolve-search-provider 抛错（无接收方）
    const chromeStub = globalThis.chrome as unknown as {
      runtime: { sendMessage: (msg: Record<string, unknown>, cb?: (r: unknown) => void) => void; lastError: unknown };
    };
    const baseSend = chromeStub.runtime.sendMessage;
    chromeStub.runtime.sendMessage = (msg, cb) => {
      if (msg?.type === "resolve-search-provider") {
        baseSend(msg, (response) => {
          chromeStub.runtime.lastError = { message: "Could not establish connection" };
          cb?.(response);
          chromeStub.runtime.lastError = null;
        });
        return;
      }
      baseSend(msg, cb);
    };
    const { ensureWebSearchOptIn } = await loadOptIn();

    const pending = ensureWebSearchOptIn();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    expect(dialog()!.querySelector(".confirm-dialog-message")!.textContent).not.toContain("使用付费平台会产生费用");
    clickAction("cancel");
    await pending;
    expect(sent.some((m) => m.type === "resolve-search-provider")).toBe(true);
  });
});

describe("ensureWebSearchOptIn：无界面 fail-closed", () => {
  it("阅读视图未挂载：本轮不搜索，不弹层也不关闭偏好（用户未表达拒绝）", async () => {
    const { sent, settings } = stubChrome();
    const { ensureWebSearchOptIn } = await loadOptIn();

    await expect(ensureWebSearchOptIn()).resolves.toBe(false);
    expect(dialog()).toBeNull();
    expect(sent.some((m) => m.type === "save-settings")).toBe(false);
    expect(settings.webSearchEnabled).toBe(true);
  });
});

describe("resolveWebSearchOptIn：视图销毁", () => {
  it("等待授权时销毁：只 dismiss，不写授权位或联网偏好", async () => {
    const { sent, settings } = stubChrome();
    mountReadingView();
    const { resolveWebSearchOptIn } = await loadOptIn();
    const { dismissConfirmDialog } = await import("../../extension/ui/confirm-dialog.js");

    const pending = resolveWebSearchOptIn();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    dismissConfirmDialog();

    await expect(pending).resolves.toBe("view-destroyed");
    expect(dialog()).toBeNull();
    expect(sent.some((m) => m.type === "save-settings")).toBe(false);
    expect(settings).toEqual({ webSearchEnabled: true, searchOptInNoticeAcknowledged: false });
  });

  it("付费探测期间关闭并重开：旧授权不落成新视图的幽灵弹层", async () => {
    const { sent } = stubChrome();
    mountReadingView();
    const chromeStub = globalThis.chrome as unknown as {
      runtime: { sendMessage: (msg: Record<string, unknown>, cb?: (r: unknown) => void) => void };
    };
    const baseSend = chromeStub.runtime.sendMessage;
    let releaseProbe!: () => void;
    chromeStub.runtime.sendMessage = (msg, cb) => {
      if (msg.type === "resolve-search-provider") {
        releaseProbe = () => baseSend(msg, cb);
        return;
      }
      baseSend(msg, cb);
    };
    const { resolveWebSearchOptIn } = await loadOptIn();
    const { dismissConfirmDialog } = await import("../../extension/ui/confirm-dialog.js");

    const pending = resolveWebSearchOptIn();
    await vi.waitFor(() => expect(releaseProbe).toBeTypeOf("function"));
    dismissConfirmDialog();
    mountReadingView();
    releaseProbe();

    await expect(pending).resolves.toBe("view-destroyed");
    expect(dialog()).toBeNull();
    expect(sent.some((m) => m.type === "save-settings")).toBe(false);
  });
});
