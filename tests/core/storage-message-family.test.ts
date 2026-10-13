// 存储消息族工厂（core/storage-message-family.js）的真值表 seam：
// 工厂吃一族声明（type / op 表 / 未知 op 文案 / 可选 toError），产出
// (message, sender, sendResponse) 形状的 handler——内部只做 op 判别、未知 op 拒绝、
// withOkResponse 信封，不碰任何域逻辑。本文件用假声明的假 op 表直接驱动它，不装载
// SW 入口与任何域模块，钉住三条支路：
//   ① 已声明 op → 回包 op 分支体的决议值原样（不二次包装）；
//   ② 未声明 op（含缺 op / 命中原型成员的 op）→ { ok:false, error: 族文案 + op 原文 }；
//   ③ 分支体拒绝 → { ok:false, error } 恒为可读串（非 Error / undefined 也不写成
//      undefined），缺省归一 = withOkResponse 的 errorText 单源，声明带 toError 时用它。

import { describe, expect, it, vi } from "vitest";
import { defineStorageMessageFamily } from "../../extension/core/storage-message-family.js";

type FakeMessage = { type: "fake-family"; op: "load" | "save"; payload?: unknown };
type FakeResponse = { ok: boolean; value?: unknown; error?: string };

const UNKNOWN_OP_TEXT = "不支持的假族操作：";

function drive(
  handler: (message: FakeMessage, sender: unknown, sendResponse: (response: FakeResponse) => void) => void,
  message: unknown
): Promise<FakeResponse> {
  return new Promise<FakeResponse>((resolve) => {
    handler(message as FakeMessage, {}, resolve);
  });
}

function declare(ops: Partial<Record<"load" | "save", (message: FakeMessage) => FakeResponse | Promise<FakeResponse>>>,
  toError?: (error: unknown) => string) {
  return defineStorageMessageFamily<FakeMessage, FakeResponse>({
    type: "fake-family",
    unknownOpText: UNKNOWN_OP_TEXT,
    ops: {
      load: ops.load ?? (() => ({ ok: true })),
      save: ops.save ?? (() => ({ ok: true }))
    },
    ...(toError ? { toError } : {})
  });
}

describe("存储消息族工厂：op 判别与信封", () => {
  it("已声明 op → 回包分支体决议值原样，handler 自身返回 void（回包时机不归它）", async () => {
    const handler = declare({
      load: async (message) => ({ ok: true, value: message.payload })
    });
    const sendResponse = vi.fn();

    expect(handler({ type: "fake-family", op: "load", payload: 42 }, {}, sendResponse)).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
    await expect(drive(handler, { type: "fake-family", op: "load", payload: 42 })).resolves.toEqual({
      ok: true,
      value: 42
    });
  });

  it("未声明 op → { ok:false, error: 族文案 + op 原文 }（缺 op / 原型成员 op 同走未知支）", async () => {
    const handler = declare({});

    for (const op of ["purge", undefined, "toString", "constructor"]) {
      const response = await drive(handler, { type: "fake-family", op });
      expect(response, String(op)).toEqual({ ok: false, error: UNKNOWN_OP_TEXT + String(op) });
    }
  });

  it("分支体拒绝 → error 是可读串：Error 取 message，非 Error / undefined 走 String", async () => {
    const cases: Array<[unknown, string]> = [
      [new Error("storage down"), "storage down"],
      ["raw failure", "raw failure"],
      [undefined, "undefined"],
      [null, "null"]
    ];

    for (const [rejected, expected] of cases) {
      const handler = declare({
        load: async () => {
          throw rejected;
        }
      });
      const response = await drive(handler, { type: "fake-family", op: "load" });

      expect(response.ok).toBe(false);
      expect(response.error).toBe(expected);
    }
  });

  it("声明带 toError → 拒绝文案归它（缺省单源是 withOkResponse 的 errorText）", async () => {
    const handler = declare(
      {
        load: async () => {
          throw new Error("boom");
        }
      },
      (error) => `族前缀：${(error as Error).message}`
    );

    await expect(drive(handler, { type: "fake-family", op: "load" })).resolves.toEqual({
      ok: false,
      error: "族前缀：boom"
    });
  });
});
