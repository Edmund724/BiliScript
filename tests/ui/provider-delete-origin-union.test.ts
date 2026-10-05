// tests/ui/provider-delete-origin-union.test.ts
// orphan origin 存活并集「只从分派表推导」的行为契约。
//
// 原断言是三段源码文本切片（deleteFromEditor / revokeOriginOnDelete 的
// functionBody 是否点 ai/asr 名）。owner 3 把回收并集收进 provider-transaction
// 的 loadOriginSharingProviders(families) 之后，等价判据可以经接口驱动：
//   1. 并集的成员由 family.optionalHostPermission 决定——翻转标志即翻转行为
//      （等价于「不得按族名硬写、不得取反」）；
//   2. 并集 = 各族现查结果拼接；
//   3. 设置面板行删除路径确实经该并集（optional 族被现查、静态 host 权限的
//      搜索族不被拉进来）。
//
// 失败方式：并集按族名点名单（新增族静默漏回收）、取反（把搜索族拉进回收，
// 错收用户仍需要的搜索域权限）、或行删除路径绕过并集。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import type { ProviderRowItem } from "../../extension/ui/provider-row.js";

type FamilyStub = {
  list: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  loadProviders: ReturnType<typeof vi.fn>;
  generateId: ReturnType<typeof vi.fn>;
  optionalHostPermission: boolean;
};

function familyStub(optionalHostPermission: boolean, providers: ProviderRowItem[] = []): FamilyStub {
  return {
    list: vi.fn(async () => ({ ok: true, providers: [] })),
    save: vi.fn(async (next: ProviderRowItem[]) => ({ ok: true, providers: next })),
    remove: vi.fn(async () => ({ ok: true, providers: [] })),
    loadProviders: vi.fn(async () => providers),
    generateId: vi.fn(() => "p_new"),
    optionalHostPermission
  };
}

type SentMessage = { type: string } & Record<string, any>;
type MessageResponder = (message: SentMessage) => unknown;

function chromeStub(): { runtime: { sendMessage: ReturnType<typeof vi.fn> } } {
  return chrome as unknown as { runtime: { sendMessage: ReturnType<typeof vi.fn> } };
}

function installMessageBus(overrides: Record<string, MessageResponder> = {}) {
  const responders: Record<string, MessageResponder> = {
    "get-settings": () => ({ ok: true, settings: {} }),
    "ai-presets-list": () => ({ ok: false }),
    "asr-presets-list": () => ({ ok: false }),
    "ai-providers-list": () => ({ ok: true, providers: [AI_ITEM] }),
    "asr-providers-list": () => ({ ok: true, providers: [] }),
    "search-providers-list": () => ({ ok: true, providers: [] }),
    "save-settings": () => ({ ok: true }),
    "ai-providers-delete": () => ({ ok: true, providers: [] }),
    ...overrides
  };
  const sent: SentMessage[] = [];
  chromeStub().runtime.sendMessage = vi.fn((message: SentMessage, callback?: (response?: unknown) => void) => {
    sent.push(message);
    const respond = responders[message.type];
    callback?.(respond ? respond(message) : { ok: true });
    return undefined;
  });
  return sent;
}

const AI_ITEM = {
  id: "p1",
  presetId: "custom",
  name: "自定义",
  baseUrl: "https://api.example.com/v1",
  models: ["gpt-4o-mini"],
  requiresKey: true,
  enabled: true,
  hasSavedKey: true
};

function countOf(sent: SentMessage[], type: string): number {
  return sent.filter((message) => message.type === type).length;
}

async function mountPanel() {
  document.body.innerHTML = `
    <div id="biliscript-reading-view">
      <section id="biliscript-reading-settings-panel">
        <div id="biliscript-reading-settings-host"></div>
      </section>
    </div>`;
  const sent = installMessageBus();
  const panel = await import("../../extension/ui/settings-panel.js");
  panel.renderReaderSettingsPanel();
  const host = document.getElementById("biliscript-reading-settings-host")!;
  await vi.waitFor(() => {
    expect(chromeStub().runtime.sendMessage.mock.calls.some(([message]) => message.type === "asr-providers-list")).toBe(true);
  });
  return { sent, host };
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
  delete (globalThis.chrome as unknown as { permissions?: unknown }).permissions;
});

afterEach(async () => {
  const { closeProviderEditor } = await import("../../extension/ui/provider-editor.js");
  closeProviderEditor(true);
  delete (globalThis.chrome as unknown as { permissions?: unknown }).permissions;
});

describe("loadOriginSharingProviders：并集由 optionalHostPermission 推导", () => {
  it("参与并集的是 optional 族：翻转标志即翻转行为（不按族名点名单、不取反）", async () => {
    const { loadOriginSharingProviders } = await import("../../extension/ui/provider-transaction.js");

    const first = { ai: familyStub(true), asr: familyStub(false), search: familyStub(false) };
    await loadOriginSharingProviders(first as never);
    expect(first.ai.loadProviders).toHaveBeenCalledTimes(1);
    expect(first.asr.loadProviders).not.toHaveBeenCalled();
    expect(first.search.loadProviders).not.toHaveBeenCalled();

    const flipped = { ai: familyStub(false), asr: familyStub(true), search: familyStub(true) };
    await loadOriginSharingProviders(flipped as never);
    expect(flipped.ai.loadProviders).not.toHaveBeenCalled();
    expect(flipped.asr.loadProviders).toHaveBeenCalledTimes(1);
    expect(flipped.search.loadProviders).toHaveBeenCalledTimes(1);
  });

  it("并集 = 各族现查结果拼接（分派表顺序）", async () => {
    const { loadOriginSharingProviders } = await import("../../extension/ui/provider-transaction.js");
    const families = {
      ai: familyStub(true, [{ id: "a1" }]),
      asr: familyStub(true, [{ id: "s1" }]),
      search: familyStub(false, [{ id: "q1" }])
    };

    await expect(loadOriginSharingProviders(families as never)).resolves.toEqual([{ id: "a1" }, { id: "s1" }]);
  });
});

describe("行删除路径：回收并集只含 optional 族", () => {
  it("确认删除 AI 行：现查 ai+asr 存活并集，静态 host 权限的搜索族不参与回收", async () => {
    const { sent, host } = await mountPanel();
    const searchBefore = countOf(sent, "search-providers-list");
    const aiBefore = countOf(sent, "ai-providers-list");
    const asrBefore = countOf(sent, "asr-providers-list");

    const row = host.querySelector<HTMLElement>("#aiProvidersList .ai-provider-row")!;
    row.querySelector(".provider-row-remove")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(document.querySelector(".confirm-dialog-confirm")).toBeTruthy();
    });
    document.querySelector(".confirm-dialog-confirm")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(countOf(sent, "ai-providers-delete")).toBe(1);
    });
    await vi.waitFor(() => {
      expect(countOf(sent, "ai-providers-list")).toBeGreaterThan(aiBefore);
      expect(countOf(sent, "asr-providers-list")).toBeGreaterThan(asrBefore);
    });
    expect(countOf(sent, "search-providers-list"), "搜索族是静态 host 权限，不得被拉进回收并集").toBe(searchBefore);
  });
});
