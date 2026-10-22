// 换片事务（entry/clip-switch-transaction.ts）的 seam 测试：假步骤 + 假订阅者直接
// 驱动，锁定同步段的次序不变量（runId 递增先行于异步步骤启动）、签名守卫的零步骤
// 语义、三档互斥分支的步骤集合与「每步恰一次」，以及完成边恰发布一次。
//
// 事务不静态依赖任何域，故本文件不需要 state / DOM 夹具，只注入假依赖；断言与读
// 取都走调用序日志（记录调用名与参数），不 mock 模块。

import { describe, expect, it, vi } from "vitest";
import {
  createClipSwitchTransaction,
  type ClipSwitchTransactionDeps
} from "../../extension/entry/clip-switch-transaction.js";

const URL = "https://www.bilibili.com/video/BV1fake/";

// 假依赖 + 调用序日志：调用名（带参数时以空格分隔）即事件，暴露每个依赖被调用
// 的次数与先后。
function createDeps() {
  const calls: string[] = [];
  const deps: ClipSwitchTransactionDeps = {
    readUrl: () => {
      calls.push("readUrl");
      return URL;
    },
    computeSignature: () => {
      calls.push("computeSignature");
      return "sig-new";
    },
    readSignature: () => {
      calls.push("readSignature");
      return "sig-old";
    },
    writeIdentity: (url, signature) => {
      calls.push(`writeIdentity ${url} ${signature}`);
    },
    readRunId: () => {
      calls.push("readRunId");
      return 5;
    },
    writeRunId: (runId) => {
      calls.push(`writeRunId ${runId}`);
    },
    enforceNormalPageStateIfNeeded: (url) => {
      calls.push(`enforceNormalPageStateIfNeeded ${url}`);
    },
    isReaderViewOpen: () => {
      calls.push("isReaderViewOpen");
      return false;
    },
    isReaderMode: (url) => {
      calls.push(`isReaderMode ${url}`);
      return false;
    },
    isPlayerAiLoaded: () => {
      calls.push("isPlayerAiLoaded");
      return false;
    },
    ensureUiReady: async () => {
      calls.push("ensureUiReady");
    },
    resetClipState: () => {
      calls.push("resetClipState");
    },
    syncPlayerAiQuickAction: () => {
      calls.push("syncPlayerAiQuickAction");
    },
    enterReaderShellOnUrlNavigation: async () => {
      calls.push("enterReaderShellOnUrlNavigation");
    },
    refreshReaderClip: async () => {
      calls.push("refreshReaderClip");
    },
    startSubtitlePrefetch: () => {
      calls.push("startSubtitlePrefetch");
    },
    logWarn: (message) => {
      calls.push(`logWarn ${message}`);
    }
  };
  return { deps, calls };
}

// 调用次数（步骤名或「名 参数」都算同一步）。
function times(calls: string[], name: string): number {
  return calls.filter((call) => call === name || call.startsWith(`${name} `)).length;
}

// 让已完成步骤的 continuation 与完成边（microtask 链）全部落地。
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("同步段：签名守卫与 runId 递增", () => {
  it("签名变化 → 同步段写身份、递增 runId，且递增先于任何异步步骤启动", async () => {
    const { deps, calls } = createDeps();
    deps.isReaderViewOpen = () => {
      calls.push("isReaderViewOpen");
      return true;
    };
    const transaction = createClipSwitchTransaction(deps);
    const settled = vi.fn();
    transaction.subscribeSettled(settled);

    transaction.handleUrlChange();

    // handleUrlChange 返回时身份与代次已落（同步段），reset 步骤的收尾还没到。
    expect(calls).toContain(`writeIdentity ${URL} sig-new`);
    expect(calls).toContain("writeRunId 6");
    expect(calls).not.toContain("resetClipState");
    // 递增先于异步步骤（这里以 reset 步骤的第一个依赖调用为代表）。
    expect(calls.indexOf("writeRunId 6")).toBeLessThan(calls.indexOf("ensureUiReady"));

    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
    expect(calls).toContain("resetClipState");
    expect(calls.indexOf("writeRunId 6")).toBeLessThan(calls.indexOf("resetClipState"));
  });

  it("签名不变 → 零步骤、不发完成边", async () => {
    const { deps, calls } = createDeps();
    deps.readSignature = () => {
      calls.push("readSignature");
      return "sig-new";
    };
    const transaction = createClipSwitchTransaction(deps);
    const settled = vi.fn();
    transaction.subscribeSettled(settled);

    transaction.handleUrlChange();
    await flush();

    expect(calls).toEqual(["readUrl", "computeSignature", "readSignature"]);
    expect(settled).not.toHaveBeenCalled();
  });
});

describe("异步段：三档互斥分支的步骤集合", () => {
  it("普通页换片：不建 UI 壳但仍重置 clip，只起字幕预抓取", async () => {
    const { deps, calls } = createDeps();
    const transaction = createClipSwitchTransaction(deps);
    const settled = vi.fn();
    transaction.subscribeSettled(settled);

    transaction.handleUrlChange();
    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1));

    expect(times(calls, "ensureUiReady")).toBe(0);
    expect(times(calls, "resetClipState")).toBe(1);
    expect(times(calls, "startSubtitlePrefetch")).toBe(1);
    expect(times(calls, "refreshReaderClip")).toBe(0);
    expect(times(calls, "enterReaderShellOnUrlNavigation")).toBe(0);
  });

  it("阅读视图已开：建壳 + 重置 + 刷新阅读字幕，不起预抓取、不进壳", async () => {
    const { deps, calls } = createDeps();
    deps.isReaderViewOpen = () => {
      calls.push("isReaderViewOpen");
      return true;
    };
    const transaction = createClipSwitchTransaction(deps);
    const settled = vi.fn();
    transaction.subscribeSettled(settled);

    transaction.handleUrlChange();
    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1));

    expect(times(calls, "ensureUiReady")).toBe(1);
    expect(times(calls, "resetClipState")).toBe(1);
    expect(times(calls, "refreshReaderClip")).toBe(1);
    expect(times(calls, "enterReaderShellOnUrlNavigation")).toBe(0);
    expect(times(calls, "startSubtitlePrefetch")).toBe(0);
  });

  it("进入阅读模式档：建壳 + 重置 + 进壳，不刷新、不起预抓取", async () => {
    const { deps, calls } = createDeps();
    deps.isReaderMode = () => {
      calls.push("isReaderMode");
      return true;
    };
    const transaction = createClipSwitchTransaction(deps);
    const settled = vi.fn();
    transaction.subscribeSettled(settled);

    transaction.handleUrlChange();
    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1));

    expect(times(calls, "ensureUiReady")).toBe(1);
    expect(times(calls, "resetClipState")).toBe(1);
    expect(times(calls, "enterReaderShellOnUrlNavigation")).toBe(1);
    expect(times(calls, "refreshReaderClip")).toBe(0);
    expect(times(calls, "startSubtitlePrefetch")).toBe(0);
  });

  it("player-ai 未加载不起同步步骤；已加载恰起一次", async () => {
    const { deps, calls } = createDeps();
    const transaction = createClipSwitchTransaction(deps);
    transaction.handleUrlChange();
    await flush();
    expect(times(calls, "syncPlayerAiQuickAction")).toBe(0);

    const loaded = createDeps();
    loaded.deps.isPlayerAiLoaded = () => {
      loaded.calls.push("isPlayerAiLoaded");
      return true;
    };
    createClipSwitchTransaction(loaded.deps).handleUrlChange();
    await flush();
    expect(times(loaded.calls, "syncPlayerAiQuickAction")).toBe(1);
  });
});

describe("步骤内的错误收口", () => {
  it("壳装载失败：记日志并中止 reset，后续分支照走", async () => {
    const { deps, calls } = createDeps();
    deps.isReaderViewOpen = () => {
      calls.push("isReaderViewOpen");
      return true;
    };
    deps.ensureUiReady = async () => {
      calls.push("ensureUiReady");
      throw new Error("chunk 装载失败");
    };
    const transaction = createClipSwitchTransaction(deps);
    const settled = vi.fn();
    transaction.subscribeSettled(settled);

    transaction.handleUrlChange();
    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1));

    expect(calls).toContain("logWarn [BILISCRIPT] UI shell ensure after URL change failed");
    expect(times(calls, "resetClipState")).toBe(0);
    expect(times(calls, "refreshReaderClip")).toBe(1);
  });

  it("reset 失败：记日志不中断，步骤仍算 settle", async () => {
    const { deps, calls } = createDeps();
    deps.resetClipState = () => {
      calls.push("resetClipState");
      throw new Error("总结链装载失败");
    };
    const transaction = createClipSwitchTransaction(deps);
    const settled = vi.fn();
    transaction.subscribeSettled(settled);

    transaction.handleUrlChange();
    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1));

    expect(calls).toContain("logWarn [BILISCRIPT] clip state reset after URL change failed");
    expect(times(calls, "startSubtitlePrefetch")).toBe(1);
  });
});

describe("完成边", () => {
  it("步骤全部 settle 后恰发布一次——某步骤 reject 也不例外", async () => {
    const { deps, calls } = createDeps();
    deps.isReaderViewOpen = () => {
      calls.push("isReaderViewOpen");
      return true;
    };
    deps.refreshReaderClip = async () => {
      calls.push("refreshReaderClip");
      throw new Error("刷新链炸了");
    };
    const transaction = createClipSwitchTransaction(deps);
    const settled = vi.fn();
    transaction.subscribeSettled(settled);

    transaction.handleUrlChange();
    // 步骤未 settle 前不发边
    expect(settled).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
    await flush();
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("shouldAutoOpen 为 true 且视图未开：触发 enterReaderShellOnUrlNavigation", async () => {
    const { deps, calls } = createDeps();
    deps.isReaderMode = () => false;
    deps.shouldAutoOpen = () => true;
    const transaction = createClipSwitchTransaction(deps);

    transaction.handleUrlChange();
    await vi.waitFor(() => {
      expect(calls).toContain("enterReaderShellOnUrlNavigation");
    });
  });

  it("订阅者抛错被吞：不影响同轮其它订阅者，也不影响下一轮", async () => {
    const { deps, calls } = createDeps();
    const transaction = createClipSwitchTransaction(deps);
    const faulty = vi.fn(() => {
      throw new Error("订阅者炸了");
    });
    const healthy = vi.fn();
    const unsubscribe = transaction.subscribeSettled(faulty);
    transaction.subscribeSettled(healthy);

    transaction.handleUrlChange();
    await vi.waitFor(() => expect(healthy).toHaveBeenCalledTimes(1));
    expect(faulty).toHaveBeenCalledTimes(1);

    unsubscribe();
    deps.readSignature = () => {
      calls.push("readSignature");
      return "sig-next";
    };
    transaction.handleUrlChange();
    await vi.waitFor(() => expect(healthy).toHaveBeenCalledTimes(2));
    expect(faulty).toHaveBeenCalledTimes(1);
  });
});
