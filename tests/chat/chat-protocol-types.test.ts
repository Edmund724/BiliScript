// chat 出向流式事件协议联合的类型级守卫（ticket 08，照
// tests/core/state-fetch-state-types.test.ts 的 @ts-expect-error 负向用例模式）：
// ChatPortMessage 单源在 extension/chat/protocol.ts，事件名 typo / 形状漂移
// 在 tsc --noEmit（typecheck 覆盖 tests/**/*.ts）下编译被拒——本文件的负向
// 断言行就是验收：联合一旦放宽（成员回退成宽 payload 或放行未知名），typecheck
// 会因「未使用的期望错误指令」变红。运行时分派行为的回归由
// tests/chat/chat-runtime-stream.test.js 锁定（既有用例零改动绿 = 分派不变），
// 本文件只做类型赋值面的正/负断言。

import { describe, expect, it } from "vitest";
import type { ChatPortMessage } from "../../extension/chat/protocol.js";

describe("chat 出向协议联合（编译期守卫）", () => {
  it("事件名 typo 编译被拒", () => {
    // @ts-expect-error "toke" 不在 ChatPortMessage 联合内（正确名是 "token"）
    const typo: ChatPortMessage = { type: "toke", data: "x" };
    expect(typo.type).toBe("toke");
  });

  it("形状漂移编译被拒：token 缺必填 data 不满足任何联合成员", () => {
    // @ts-expect-error token 分支 data: string 必填，缺 data 无成员可匹配
    const missing: ChatPortMessage = { type: "token" };
    expect(missing.type).toBe("token");
  });

  it("流式事件成员可赋值（satisfies 保留字面量类型以读取分支字段）", () => {
    const token = { type: "token", data: "增量", cachedContextKey: "k1" } satisfies ChatPortMessage;
    const stopped = { type: "stopped", reason: "已停止生成" } satisfies ChatPortMessage;
    expect(token.data).toBe("增量");
    expect(stopped.reason).toBe("已停止生成");
  });

  it("非引擎成员可赋值：cost-guard 载荷与 error 的类型化 code", () => {
    const guard = { type: "cost-guard", data: { message: "预计 3 次调用" } } satisfies ChatPortMessage;
    const error = { type: "error", error: "字幕体缺失", code: "subtitle-body-missing" } satisfies ChatPortMessage;
    expect(guard.data?.message).toBe("预计 3 次调用");
    expect(error.code).toBe("subtitle-body-missing");
  });

  it("token-batch 合帧成员可赋值（07 票）：data 为 string[]，缺 data 编译被拒", () => {
    const batch = { type: "token-batch", data: ["增", "量"] } satisfies ChatPortMessage;
    expect(batch.data).toEqual(["增", "量"]);
    // @ts-expect-error token-batch 分支 data: string[] 必填，缺 data 无成员可匹配
    const missing: ChatPortMessage = { type: "token-batch" };
    expect(missing.type).toBe("token-batch");
  });
});

describe("联网搜索 port 事件（spec §2.2/§2.5）", () => {
  it("tool-status 成员可赋值：status 三态 + query + 可选 resultCount/platform", () => {
    const searching = { type: "tool-status", status: "searching", query: "x" } satisfies ChatPortMessage;
    const done = { type: "tool-status", status: "done", query: "x", resultCount: 5, platform: "Tavily" } satisfies ChatPortMessage;
    const failed = { type: "tool-status", status: "failed", query: "x" } satisfies ChatPortMessage;
    expect(searching.status).toBe("searching");
    expect(done.resultCount).toBe(5);
    expect(failed.status).toBe("failed");
    // @ts-expect-error status 词表外的取值无成员可匹配
    const bad: ChatPortMessage = { type: "tool-status", status: "unknown", query: "x" };
    expect(bad).toBeTruthy();
  });

  it("tool-turn 成员可赋值：messages 为 ChatMessage[]（assistant/tool 轮持久化副本）", () => {
    const turn = {
      type: "tool-turn",
      messages: [
        { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "[]" }
      ]
    } satisfies ChatPortMessage;
    expect(turnPayload(turn)).toBe(2);
  });
});

function turnPayload(msg: unknown): number {
  return (msg as { messages: unknown[] }).messages.length;
}
