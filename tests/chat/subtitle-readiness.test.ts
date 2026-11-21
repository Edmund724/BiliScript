import { describe, expect, it } from "vitest";
import type { SubtitleBodyItem } from "../../extension/ai/types.js";
import {
  isNoSubtitleEmpty,
  isPending,
  isSubtitleFetchFailed,
  readinessFromClip,
  readinessFromSnapshot,
  wantsWaitNotice
} from "../../extension/chat/subtitle-readiness.js";
import type { ClipState } from "../../extension/core/state.js";

function clip(overrides: Record<string, unknown> = {}): ClipState {
  return {
    bvid: "BV1",
    subtitleBody: [],
    subtitleFetchState: "idle",
    ...overrides
  } as unknown as ClipState;
}

describe("readinessFromClip（content 侧进程内权威状态入口）", () => {
  it("字幕体非空：hasBody，fetchState 原样透传", () => {
    const view = readinessFromClip(clip({ subtitleBody: [{ from: 0, to: 1, content: "x" }], subtitleFetchState: "ready" }));
    expect(view).toEqual({ hasBody: true, fetchState: "ready", asrActive: false });
  });

  it("字幕体为空：状态原样，asrActive 恒 false（clip 不携带转写广播信号）", () => {
    const view = readinessFromClip(clip({ subtitleFetchState: "loading" }));
    expect(view).toEqual({ hasBody: false, fetchState: "loading", asrActive: false });
  });

  it("字幕体字段异常（非数组）：折算为空体", () => {
    const view = readinessFromClip(clip({ subtitleBody: "x" }));
    expect(view.hasBody).toBe(false);
  });
});

describe("readinessFromSnapshot（上下文快照入口）", () => {
  it("快照缺失（读取失败）：投影为 null 视图", () => {
    expect(readinessFromSnapshot(null)).toBeNull();
    expect(readinessFromSnapshot(undefined)).toBeNull();
  });

  it("字幕体非空：hasBody；转写广播默认 false", () => {
    const view = readinessFromSnapshot({ subtitleFetchState: "loading", subtitleBody: [{ from: 0, to: 1, content: "x" }] });
    expect(view).toEqual({ hasBody: true, fetchState: "loading", asrActive: false });
  });

  it("转写广播活跃：asrActive 透传", () => {
    const view = readinessFromSnapshot({ subtitleFetchState: "idle", subtitleBody: [] }, { asrTranscribingActive: true });
    expect(view).toEqual({ hasBody: false, fetchState: "idle", asrActive: true });
  });

  it("状态字段缺失或联合外脏值：折算 idle（与 payload 工厂的缺省口径一致）", () => {
    expect(readinessFromSnapshot({ subtitleBody: [] })!.fetchState).toBe("idle");
    expect(readinessFromSnapshot({ subtitleFetchState: "junk", subtitleBody: [] })!.fetchState).toBe("idle");
  });

  it("字幕体字段异常（非数组）：折算为空体", () => {
    const view = readinessFromSnapshot({ subtitleFetchState: "empty", subtitleBody: "x" as unknown as SubtitleBodyItem[] });
    expect(view!.hasBody).toBe(false);
    expect(isNoSubtitleEmpty(view)).toBe(true);
  });
});

describe("isPending（等待闸：还在抓取/转写中）", () => {
  it("loading 且字幕体为空：pending", () => {
    expect(isPending(readinessFromSnapshot({ subtitleFetchState: "loading", subtitleBody: [] }))).toBe(true);
  });

  it("字幕体非空：不 pending（就绪优先于一切信号）", () => {
    expect(
      isPending(readinessFromSnapshot({ subtitleFetchState: "loading", subtitleBody: [{ from: 0, to: 1, content: "x" }] }))
    ).toBe(false);
  });

  it("快照状态被清（idle）但转写广播活跃：仍 pending（兜底信号）", () => {
    expect(
      isPending(readinessFromSnapshot({ subtitleFetchState: "idle", subtitleBody: [] }, { asrTranscribingActive: true }))
    ).toBe(true);
  });

  it("非 loading 且无广播：不 pending（抓取失败/无人声/未启用转写，放行凭标题总结）", () => {
    expect(isPending(readinessFromSnapshot({ subtitleFetchState: "idle", subtitleBody: [] }))).toBe(false);
    expect(isPending(readinessFromSnapshot({ subtitleFetchState: "error", subtitleBody: [] }))).toBe(false);
    expect(isPending(readinessFromSnapshot({ subtitleFetchState: "empty", subtitleBody: [] }))).toBe(false);
  });

  it("clip 入口不参与转写兜底：快照被清但广播活跃的场景由快照入口承担", () => {
    expect(isPending(readinessFromClip(clip({ subtitleFetchState: "idle" })))).toBe(false);
    expect(isPending(readinessFromClip(clip({ subtitleFetchState: "loading" })))).toBe(true);
  });

  it("空视图（快照为 null，读取失败）：不 pending，由 ok=false 走失败路径", () => {
    expect(isPending(readinessFromSnapshot(null))).toBe(false);
    expect(isPending(readinessFromSnapshot(undefined, { asrTranscribingActive: true }))).toBe(false);
    expect(isPending(null)).toBe(false);
    expect(isPending(undefined)).toBe(false);
  });
});

describe("isNoSubtitleEmpty（无字幕收尾拦截）", () => {
  it("empty 且字幕体为空：拦截", () => {
    expect(isNoSubtitleEmpty(readinessFromSnapshot({ subtitleFetchState: "empty", subtitleBody: [] }))).toBe(true);
  });

  it("字幕体非空：一律放行（就绪优先于状态字段）", () => {
    expect(
      isNoSubtitleEmpty(readinessFromSnapshot({ subtitleFetchState: "empty", subtitleBody: [{ from: 0, to: 1, content: "x" }] }))
    ).toBe(false);
    expect(
      isNoSubtitleEmpty(readinessFromSnapshot({ subtitleFetchState: "ready", subtitleBody: [{ from: 0, to: 1, content: "x" }] }))
    ).toBe(false);
  });

  it("非 empty 状态不受影响（loading/idle/error/ready 均不拦截）", () => {
    expect(isNoSubtitleEmpty(readinessFromSnapshot({ subtitleFetchState: "loading", subtitleBody: [] }))).toBe(false);
    expect(isNoSubtitleEmpty(readinessFromSnapshot({ subtitleFetchState: "idle", subtitleBody: [] }))).toBe(false);
    expect(isNoSubtitleEmpty(readinessFromSnapshot({ subtitleFetchState: "error", subtitleBody: [] }))).toBe(false);
    expect(isNoSubtitleEmpty(readinessFromSnapshot({ subtitleFetchState: "ready", subtitleBody: [] }))).toBe(false);
  });

  it("空视图：不拦截（读取失败走既有 false 路径）", () => {
    expect(isNoSubtitleEmpty(readinessFromSnapshot(null))).toBe(false);
    expect(isNoSubtitleEmpty(null)).toBe(false);
  });
});

describe("isSubtitleFetchFailed（抓取失败拦截）", () => {
  it("error 且字幕体为空：拦截", () => {
    expect(isSubtitleFetchFailed(readinessFromSnapshot({ subtitleFetchState: "error", subtitleBody: [] }))).toBe(true);
  });

  it("字幕体非空：一律放行（失败前落账的完整字幕照样能总结）", () => {
    expect(
      isSubtitleFetchFailed(
        readinessFromSnapshot({ subtitleFetchState: "error", subtitleBody: [{ from: 0, to: 1, content: "x" }] })
      )
    ).toBe(false);
  });

  it("非 error 状态不受影响（empty 归无字幕出口，loading/idle/ready 放行走既有路径）", () => {
    expect(isSubtitleFetchFailed(readinessFromSnapshot({ subtitleFetchState: "empty", subtitleBody: [] }))).toBe(false);
    expect(isSubtitleFetchFailed(readinessFromSnapshot({ subtitleFetchState: "loading", subtitleBody: [] }))).toBe(false);
    expect(isSubtitleFetchFailed(readinessFromSnapshot({ subtitleFetchState: "idle", subtitleBody: [] }))).toBe(false);
    expect(isSubtitleFetchFailed(readinessFromSnapshot({ subtitleFetchState: "ready", subtitleBody: [] }))).toBe(false);
  });

  it("空视图：不拦截", () => {
    expect(isSubtitleFetchFailed(readinessFromSnapshot(null))).toBe(false);
    expect(isSubtitleFetchFailed(null)).toBe(false);
  });
});

describe("wantsWaitNotice（即时等待提示，ADR-0017 决定 6 的冻结口径）", () => {
  it("clip loading 且字幕体为空：显示等待提示", () => {
    expect(wantsWaitNotice(readinessFromClip(clip({ subtitleFetchState: "loading" })))).toBe(true);
  });

  it("字幕体非空：不显示（不闪一条又立刻撤）", () => {
    expect(
      wantsWaitNotice(readinessFromClip(clip({ subtitleBody: ["x"], subtitleFetchState: "loading" })))
    ).toBe(false);
  });

  it("非 loading（idle/ready/empty/error）：不显示", () => {
    for (const state of ["idle", "ready", "empty", "error"] as const) {
      expect(wantsWaitNotice(readinessFromClip(clip({ subtitleFetchState: state }))), state).toBe(false);
    }
  });

  it("转写广播活跃不参与：快照 idle + 广播活跃仍不显示（转写等待并入状态行，走另一条路由）", () => {
    expect(
      wantsWaitNotice(readinessFromSnapshot({ subtitleFetchState: "idle", subtitleBody: [] }, { asrTranscribingActive: true }))
    ).toBe(false);
  });

  it("空视图：不显示", () => {
    expect(wantsWaitNotice(readinessFromSnapshot(null))).toBe(false);
    expect(wantsWaitNotice(null)).toBe(false);
  });
});
