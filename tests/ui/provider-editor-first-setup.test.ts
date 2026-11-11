// 首配模式的平台编辑 Modal（票 provider-onboarding-consistency/01）：
// - 保存钮文案「保存并继续」（普通编辑仍「保存」）；
// - 首个 AI 平台至少一个模型才可保存（普通编辑仍允许空目录，multi-model Q13）；
// - 保存成功后先 onAfterSave（装配方消费续跑意图/退出设置）再关 Modal；
// - 保存失败：不关 Modal、状态行报错、onAfterSave 不触发；
// - 取消（未改动直关）：onSessionEnd 结算（装配方作废未消费意图）；
// - 重复保存：两次落盘同一 upsert，回调不炸（续跑一次性由意图叶消费保证）。
//
// 手法：真实 provider-editor 模块 + DOM 仿真，openProviderEditor 直开
// （不经设置面板），字段驱动同 tests/ui/provider-editor-save.test.ts。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { PRESETS } from "../../extension/core/presets.js";
import type { ProviderRowItem } from "../../extension/ui/provider-row.js";

type SaveResult = { ok: boolean; error?: string };

async function openFirstSetupEditor(session: {
  onSave?: (kind: string, upsert: ProviderRowItem) => Promise<SaveResult>;
  onAfterSave?: (() => void) | null;
  onSessionEnd?: (() => void) | null;
  firstSetup?: boolean;
  submitLabel?: string;
}) {
  const { openProviderEditor } = await import("../../extension/ui/provider-editor.js");
  const firstSetup = session.firstSetup ?? true;
  openProviderEditor({
    kind: "ai",
    item: null,
    presets: PRESETS,
    onSave: session.onSave ?? (async () => ({ ok: true })),
    onDelete: async () => ({ ok: true }),
    submitLabel: session.submitLabel ?? (firstSetup ? "保存并继续" : undefined),
    firstSetup,
    onAfterSave: session.onAfterSave ?? null,
    onSessionEnd: session.onSessionEnd ?? null
  });
  return document.querySelector<HTMLElement>(".provider-editor-dialog")!;
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".provider-editor-dialog");
}

function statusText(): string {
  return document.querySelector<HTMLElement>(".provider-editor-status")?.textContent || "";
}

function fireClick(node: Element) {
  node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function setFieldValue(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// 填齐首配必填：地址 + Key + 一个模型行
function fillRequiredFields(model = "test-model") {
  setFieldValue(".provider-editor-baseurl", "https://api.test/v1");
  setFieldValue(".provider-editor-apikey", "sk-test");
  fireClick(document.querySelector('[data-provider-editor-action="add-model"]')!);
  setFieldValue(".provider-editor-model-id", model);
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = `<div id="biliscript-reading-view"></div>`;
});

afterEach(async () => {
  const { closeProviderEditor } = await import("../../extension/ui/provider-editor.js");
  closeProviderEditor(true);
});

describe("首配保存钮文案", () => {
  it("首配模式：保存钮为「保存并继续」", async () => {
    const editor = await openFirstSetupEditor({});
    expect(editor.querySelector(".provider-editor-save")?.textContent).toBe("保存并继续");
  });

  it("普通编辑：保存钮仍为「保存」", async () => {
    const editor = await openFirstSetupEditor({ firstSetup: false });
    expect(editor.querySelector(".provider-editor-save")?.textContent).toBe("保存");
  });
});

describe("首配模型门槛", () => {
  it("缺模型：拦截保存、状态行提示、onSave 不触发", async () => {
    const onSave = vi.fn(async () => ({ ok: true }));
    await openFirstSetupEditor({ onSave });
    setFieldValue(".provider-editor-baseurl", "https://api.test/v1");
    setFieldValue(".provider-editor-apikey", "sk-test");
    fireClick(document.querySelector('[data-provider-editor-action="save"]')!);
    await vi.waitFor(() => {
      expect(statusText()).toContain("请至少添加一个模型");
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
  });

  it("有模型：保存通过，upsert 带 Key 与模型目录", async () => {
    const onSave = vi.fn(async (_kind: string, _upsert: ProviderRowItem) => ({ ok: true }));
    await openFirstSetupEditor({ onSave });
    fillRequiredFields();
    fireClick(document.querySelector('[data-provider-editor-action="save"]')!);
    await vi.waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    const upsert = onSave.mock.calls[0][1] as ProviderRowItem;
    expect(upsert.apiKey).toBe("sk-test");
    expect(upsert.models).toEqual(["test-model"]);
  });

  it("普通编辑：空模型目录仍可保存（Q13 语义不被首配收紧）", async () => {
    const onSave = vi.fn(async (_kind: string, _upsert: ProviderRowItem) => ({ ok: true }));
    await openFirstSetupEditor({ onSave, firstSetup: false });
    setFieldValue(".provider-editor-baseurl", "https://api.test/v1");
    setFieldValue(".provider-editor-apikey", "sk-test");
    fireClick(document.querySelector('[data-provider-editor-action="save"]')!);
    await vi.waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    expect((onSave.mock.calls[0][1] as ProviderRowItem).models).toEqual([]);
  });
});

describe("首配会话回调", () => {
  it("保存成功：先 onAfterSave（此刻 Modal 未关）再关 Modal，onSessionEnd 最后结算", async () => {
    const events: string[] = [];
    await openFirstSetupEditor({
      onAfterSave: () => {
        events.push(`afterSave:dialog=${dialog() !== null}`);
      },
      onSessionEnd: () => {
        events.push("sessionEnd");
      }
    });
    fillRequiredFields();
    fireClick(document.querySelector('[data-provider-editor-action="save"]')!);
    await vi.waitFor(() => {
      expect(events.length).toBe(2);
    });
    expect(events[0]).toBe("afterSave:dialog=true");
    expect(events[1]).toBe("sessionEnd");
    expect(dialog()).toBeNull();
  });

  it("保存失败：不关 Modal、状态行报错、onAfterSave 不触发、意图语义可重试", async () => {
    const onAfterSave = vi.fn();
    await openFirstSetupEditor({
      onSave: async () => ({ ok: false, error: "落盘失败" }),
      onAfterSave
    });
    fillRequiredFields();
    fireClick(document.querySelector('[data-provider-editor-action="save"]')!);
    await vi.waitFor(() => {
      expect(statusText()).toContain("落盘失败");
    });
    expect(dialog()).not.toBeNull();
    expect(onAfterSave).not.toHaveBeenCalled();
  });

  it("取消（未改动直关）：onSessionEnd 结算，Modal 关闭", async () => {
    const onSessionEnd = vi.fn();
    await openFirstSetupEditor({ onSessionEnd });
    fireClick(document.querySelector('[data-provider-editor-action="close"]')!);
    expect(dialog()).toBeNull();
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
  });

  it("重复保存：两次落盘同一 upsert；首次保存已关 Modal，装配方出口只触发一次", async () => {
    const onSave = vi.fn(async (_kind: string, _upsert: ProviderRowItem) => ({ ok: true }));
    const onAfterSave = vi.fn();
    const { save } = await import("../../extension/ui/provider-editor-modal.js");
    await openFirstSetupEditor({ onSave, onAfterSave });
    fillRequiredFields();
    void save();
    void save();
    await vi.waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(2);
    });
    // 第二次保存的落盘仍在（事务幂等），但首次保存已收掉 Modal 与回调槽——
    // 装配方出口（消费续跑意图）绝不重复触发。
    expect(onAfterSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][1]).toEqual(onSave.mock.calls[1][1]);
  });
});
