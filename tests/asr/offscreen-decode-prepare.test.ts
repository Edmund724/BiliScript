import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import type { MessageSender } from "../../extension/shared/messaging-protocol.js";

interface FakeSessionRule {
  id: number;
  priority?: number;
  action?: unknown;
  condition?: unknown;
}

type BridgeResponse = { ok: boolean; ruleId?: number; error?: string };

type PrepareResponse = { ok: boolean; ruleId: number; error?: string };

interface StubSwEnvOptions {
  contextsResult?: unknown[];
  contextsError?: unknown;
  updateSessionRules?: (options: { removeRuleIds?: number[]; addRules?: FakeSessionRule[] }) => Promise<void>;
  getSessionRules?: () => Promise<FakeSessionRule[]>;
  tabsGet?: (tabId: number) => Promise<{ id: number }>;
}

function makeRuleStore(initialRules: FakeSessionRule[] = []) {
  const rules = new Map(initialRules.map((rule) => [rule.id, rule] as const));
  const updateSessionRules = vi.fn(async ({ removeRuleIds = [], addRules = [] }: { removeRuleIds?: number[]; addRules?: FakeSessionRule[] }) => {
    for (const id of removeRuleIds) rules.delete(id);
    for (const rule of addRules) rules.set(rule.id, rule);
  });
  const getSessionRules = vi.fn(async () => [...rules.values()]);
  return { rules, updateSessionRules, getSessionRules };
}

function stubSwEnv({ contextsResult, contextsError, updateSessionRules, getSessionRules, tabsGet }: StubSwEnvOptions = {}) {
  const createDocument = vi.fn(async (_options: unknown) => ({}));
  const getContexts = vi.fn(async () => {
    if (contextsError) throw contextsError;
    return contextsResult || [];
  });
  const updateRules = updateSessionRules || vi.fn(async () => {});
  const getRules = getSessionRules || vi.fn(async () => []);
  vi.stubGlobal("chrome", {
    runtime: {
      lastError: null,
      sendMessage: vi.fn((_message, callback) => {
        callback?.({ ok: true });
        return undefined;
      }),
      getURL: (path: string) => `chrome-extension://test/${path}`,
      getContexts,
      onMessage: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn() }
    },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
    },
    tabs: { get: tabsGet || vi.fn(async () => ({ id: 1 })) },
    offscreen: { createDocument },
    declarativeNetRequest: { updateSessionRules: updateRules, getSessionRules: getRules }
  });
  return { createDocument, getContexts, updateSessionRules: updateRules, getSessionRules: getRules };
}

const existingDocContexts = [{ contextType: "OFFSCREEN_DOCUMENT" }];

let bridge: typeof import("../../extension/asr/offscreen-bridge.bg.js");

beforeEach(() => {
  resetModuleState();
});

describe("handleAsrDecodePrepare 的 offscreen 文档守卫", () => {
  it("无文档时真正创建 offscreen 文档", async () => {
    const { createDocument } = stubSwEnv({ contextsResult: [] });
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const sendResponse = vi.fn();
    await bridge.handleAsrDecodePrepare({ taskType: "asr-decode-prepare" }, {}, sendResponse);

    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(createDocument.mock.calls[0][0]).toMatchObject({
      url: "chrome-extension://test/entry/offscreen.html",
      reasons: ["BLOBS"]
    });
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, ruleId: 32001 });
  });

  it("文档已存在（如 sidepanel 聊天创建的 offscreen-chat 文档）时不重复创建", async () => {
    const { createDocument } = stubSwEnv({ contextsResult: existingDocContexts });
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const sendResponse = vi.fn();
    await bridge.handleAsrDecodePrepare({ taskType: "asr-decode-prepare" }, {}, sendResponse);

    expect(createDocument).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, ruleId: 32001 });
  });

  it("getContexts 异常降级为直接尝试创建：仍返回 ok:true（前探测失败也不吞创建失败）", async () => {
    const { createDocument } = stubSwEnv({ contextsError: new Error("boom") });
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const sendResponse = vi.fn();
    await bridge.handleAsrDecodePrepare({ taskType: "asr-decode-prepare" }, {}, sendResponse);

    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, ruleId: 32001 });
  });

  it("createDocument 真实失败不再吞掉：ok:false 带原始错误，ruleId 归还不泄漏", async () => {
    const { createDocument } = stubSwEnv({
      contextsResult: [],
      updateSessionRules: vi.fn(async () => {})
    });
    createDocument.mockRejectedValueOnce(new Error("offscreen reasons invalid"));
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const sendResponse = vi.fn();
    await bridge.handleAsrDecodePrepare({ taskType: "asr-decode-prepare" }, {}, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "offscreen reasons invalid" });

    const retried: BridgeResponse[] = [];
    await bridge.handleAsrDecodePrepare({ taskType: "asr-decode-prepare" }, {}, (r) => retried.push(r as BridgeResponse));
    expect(retried[0]).toEqual({ ok: true, ruleId: 32001 });
  });

  it.each([
    "Only a single offscreen document may be created.",
    "Single offscreen document already exists."
  ])("createDocument 抛「文档已存在」（%s）视同成功", async (message) => {
    const { createDocument } = stubSwEnv({
      contextsError: new Error("boom"),
      updateSessionRules: vi.fn(async () => {})
    });
    createDocument.mockRejectedValueOnce(new Error(message));
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const sendResponse = vi.fn();
    await bridge.handleAsrDecodePrepare({ taskType: "asr-decode-prepare" }, {}, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({ ok: true, ruleId: 32001 });
  });

  it("createDocument 抛无关错误（非已存在竞态）仍上抛为 ok:false", async () => {
    const { createDocument } = stubSwEnv({
      contextsError: new Error("boom"),
      updateSessionRules: vi.fn(async () => {})
    });
    createDocument.mockRejectedValueOnce(new Error("offscreen reasons invalid"));
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const sendResponse = vi.fn();
    await bridge.handleAsrDecodePrepare({ taskType: "asr-decode-prepare" }, {}, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "offscreen reasons invalid" });
  });
});

describe("cleanup 的标签页归属校验（跨标签页请求拒绝执行）", () => {
  async function prepareFrom(sender: MessageSender) {
    const responses: BridgeResponse[] = [];
    await bridge.handleAsrDecodePrepare({ taskType: "asr-decode-prepare" }, sender, (r) => responses.push(r as BridgeResponse));
    return responses[0] as PrepareResponse;
  }

  async function cleanupFrom(sender: MessageSender, ruleId: number) {
    const responses: BridgeResponse[] = [];
    await bridge.handleAsrDecodeCleanup({ taskType: "asr-decode-cleanup", ruleId }, sender, (r) => responses.push(r as BridgeResponse));
    return responses[0];
  }

  function freshBridge() {
    const store = makeRuleStore();
    stubSwEnv({
      contextsResult: existingDocContexts,
      updateSessionRules: store.updateSessionRules,
      getSessionRules: store.getSessionRules
    });
    return store;
  }

  it("同标签页 cleanup 照常删除自己的规则", async () => {
    const store = freshBridge();
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const prepared = await prepareFrom({ tab: { id: 7 } });
    await expect(cleanupFrom({ tab: { id: 7 } }, prepared.ruleId)).resolves.toEqual({ ok: true });
    expect(store.rules.size).toBe(0);
  });

  it("跨标签页 cleanup 被拒绝：ok:false 且规则不被删、不影响池状态", async () => {
    const store = freshBridge();
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const prepared = await prepareFrom({ tab: { id: 7 } });
    await expect(cleanupFrom({ tab: { id: 8 } }, prepared.ruleId)).resolves.toEqual({
      ok: false,
      error: "防盗链规则不属于当前来源"
    });
    expect(store.rules.size).toBe(1);
    await expect(cleanupFrom({ tab: { id: 7 } }, prepared.ruleId)).resolves.toEqual({ ok: true });
    expect(store.rules.size).toBe(0);
  });

  it("offscreen 来源的 ruleId 不能被标签页 cleanup 冒领", async () => {
    const store = freshBridge();
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const prepared = await prepareFrom({ url: "chrome-extension://test/entry/offscreen.html" });
    await expect(cleanupFrom({ tab: { id: 7 } }, prepared.ruleId)).resolves.toMatchObject({ ok: false });
    expect(store.rules.size).toBe(1);
  });
});

const EXPECTED_RULE_SHAPE = {
  priority: 1,
  action: {
    type: "modifyHeaders",
    requestHeaders: [
      { header: "Referer", operation: "set", value: "https://www.bilibili.com" },
      { header: "Origin", operation: "set", value: "https://www.bilibili.com" }
    ]
  },
  condition: { requestDomains: ["bilivideo.com", "bilivideo.cn", "akamaized.net"], resourceTypes: ["xmlhttprequest"] }
};

async function prepareOnce() {
  const responses: BridgeResponse[] = [];
  await bridge.handleAsrDecodePrepare({ taskType: "asr-decode-prepare" }, {}, (r) => responses.push(r as BridgeResponse));
  return responses[0] as PrepareResponse;
}

async function cleanupOnce(ruleId: number) {
  const responses: BridgeResponse[] = [];
  await bridge.handleAsrDecodeCleanup(
    { taskType: "asr-decode-cleanup", ruleId },
    {},
    (r) => responses.push(r as BridgeResponse)
  );
  return responses[0];
}

describe("防盗链规则 id 按任务分配（多转写任务并发互不删除）", () => {
  it("并发两次 prepare 分配不同 ruleId，两条规则并存且内容与旧版一致", async () => {
    const store = makeRuleStore();
    stubSwEnv({
      contextsResult: existingDocContexts,
      updateSessionRules: store.updateSessionRules,
      getSessionRules: store.getSessionRules
    });
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const first = await prepareOnce();
    const second = await prepareOnce();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.ruleId).toBe(bridge.ASR_AUDIO_SESSION_RULE_ID_BASE + 1);
    expect(second.ruleId).not.toBe(first.ruleId);
    expect(store.rules.size).toBe(2);
    expect([...store.rules.keys()].sort((a, b) => a - b)).toEqual([
      bridge.ASR_AUDIO_SESSION_RULE_ID_BASE,
      bridge.ASR_AUDIO_SESSION_RULE_ID_BASE + 1
    ]);
    for (const rule of store.rules.values()) {
      expect(rule).toMatchObject(EXPECTED_RULE_SHAPE);
    }
  });

  it("一次 cleanup 只删自己的 ruleId，另一并发任务的规则仍在", async () => {
    const store = makeRuleStore();
    stubSwEnv({
      contextsResult: existingDocContexts,
      updateSessionRules: store.updateSessionRules,
      getSessionRules: store.getSessionRules
    });
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const first = await prepareOnce();
    const second = await prepareOnce();
    const cleanupResponses: BridgeResponse[] = [];
    await bridge.handleAsrDecodeCleanup(
      { taskType: "asr-decode-cleanup", ruleId: first.ruleId },
      {},
      (r) => cleanupResponses.push(r as BridgeResponse)
    );

    expect(cleanupResponses[0]).toEqual({ ok: true });
    expect([...store.rules.keys()]).toEqual([second.ruleId]);
  });

  it("重复 cleanup 与未知 ruleId 的 cleanup 幂等：ok:true、不抛、不污染 id 池", async () => {
    const store = makeRuleStore();
    stubSwEnv({
      contextsResult: existingDocContexts,
      updateSessionRules: store.updateSessionRules,
      getSessionRules: store.getSessionRules
    });
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const first = await prepareOnce();
    const cleanup = (ruleId: number) => cleanupOnce(ruleId);

    await expect(cleanup(first.ruleId)).resolves.toEqual({ ok: true });
    await expect(cleanup(first.ruleId)).resolves.toEqual({ ok: true });
    const unknownId = bridge.ASR_AUDIO_SESSION_RULE_ID_BASE + 500;
    await expect(cleanup(unknownId)).resolves.toEqual({ ok: true });
    expect(store.rules.size).toBe(0);

    const next = await prepareOnce();
    expect(next.ruleId).toBe(bridge.ASR_AUDIO_SESSION_RULE_ID_BASE);
  });

  it("cleanup 归还 id 后分配器复用：新任务拿回已释放的 id", async () => {
    const store = makeRuleStore();
    stubSwEnv({
      contextsResult: existingDocContexts,
      updateSessionRules: store.updateSessionRules,
      getSessionRules: store.getSessionRules
    });
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const first = await prepareOnce();
    await cleanupOnce(first.ruleId);
    const reused = await prepareOnce();

    expect(reused.ruleId).toBe(first.ruleId);
    expect(store.rules.size).toBe(1);
  });

  it("updateSessionRules 失败照既有错误路径上报（不吞），id 归还不随失败泄漏", async () => {
    const store = makeRuleStore();
    stubSwEnv({
      contextsResult: existingDocContexts,
      updateSessionRules: vi.fn()
        .mockImplementationOnce(async () => {
          throw new Error("dnr quota exceeded");
        })
        .mockImplementation(store.updateSessionRules),
      getSessionRules: store.getSessionRules
    });
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const failed = await prepareOnce();
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("dnr quota exceeded");

    const retried = await prepareOnce();
    expect(retried).toEqual({ ok: true, ruleId: bridge.ASR_AUDIO_SESSION_RULE_ID_BASE });
  });
});

function residueRule(id: number): FakeSessionRule {
  return { id, ...EXPECTED_RULE_SHAPE };
}

describe("SW 冷启动对账（分配器账本以平台为事实源重建）", () => {
  async function coldStartBridge(initialRules: FakeSessionRule[] = []) {
    const store = makeRuleStore(initialRules);
    stubSwEnv({
      contextsResult: existingDocContexts,
      updateSessionRules: store.updateSessionRules,
      getSessionRules: store.getSessionRules
    });
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");
    return store;
  }

  it("平台残留活跃规则 32001：新任务不复用（分配 32002/32003，残留不被覆写）", async () => {
    const residue = residueRule(32001);
    const store = await coldStartBridge([residue]);

    const first = await prepareOnce();
    const second = await prepareOnce();

    expect(first).toEqual({ ok: true, ruleId: 32002 });
    expect(second).toEqual({ ok: true, ruleId: 32003 });
    expect(store.rules.get(32001)).toBe(residue);
    expect(store.getSessionRules).toHaveBeenCalledTimes(1);
  });

  it("撞车链回归：残留 32001 时旧任务 cleanup 只删自己的，不误删新任务的 32002", async () => {
    const store = await coldStartBridge([residueRule(32001)]);

    const task2 = await prepareOnce();
    expect(task2.ruleId).toBe(32002);

    await expect(cleanupOnce(32001)).resolves.toEqual({ ok: true });
    expect(store.rules.has(32001)).toBe(false);
    expect(store.rules.has(task2.ruleId)).toBe(true);

    const task3 = await prepareOnce();
    expect(task3.ruleId).toBe(32001);
    expect(store.rules.size).toBe(2);
  });

  it("无残留时对账为空操作：首次分配仍是 32001，行为不变", async () => {
    const store = await coldStartBridge();

    const first = await prepareOnce();

    expect(first).toEqual({ ok: true, ruleId: 32001 });
    expect(store.rules.size).toBe(1);
    expect(store.getSessionRules).toHaveBeenCalledTimes(1);
  });

  it("旧任务 cleanup 先于对账到达：先删平台规则，随后的对账与分配不撞车", async () => {
    const store = await coldStartBridge([residueRule(32001)]);

    await expect(cleanupOnce(32001)).resolves.toEqual({ ok: true });
    expect(store.rules.size).toBe(0);

    const next = await prepareOnce();
    expect(next.ruleId).toBe(32001);
    expect(store.rules.size).toBe(1);
  });

  it("重复/未知 id 的 cleanup 幂等在对账后不回归：不抛、不重复入池", async () => {
    const store = await coldStartBridge([residueRule(32001)]);

    await prepareOnce();
    await expect(cleanupOnce(32001)).resolves.toEqual({ ok: true });
    await expect(cleanupOnce(32001)).resolves.toEqual({ ok: true });
    await expect(cleanupOnce(bridge.ASR_AUDIO_SESSION_RULE_ID_BASE + 4)).resolves.toEqual({ ok: true });

    const next = await prepareOnce();
    expect(next.ruleId).toBe(32001);
    const after = await prepareOnce();
    expect(after.ruleId).toBe(32003);
  });
});

describe("prepare 前的死标签页残留回收（异常取消 / 后台终止路径）", () => {
  async function freshBridge({ tabsGet, initialRules = [] }: { tabsGet?: StubSwEnvOptions["tabsGet"]; initialRules?: FakeSessionRule[] } = {}) {
    const store = makeRuleStore(initialRules);
    stubSwEnv({
      contextsResult: existingDocContexts,
      updateSessionRules: store.updateSessionRules,
      getSessionRules: store.getSessionRules,
      tabsGet
    });
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");
    return store;
  }

  async function prepareFrom(tabId: number) {
    const responses: BridgeResponse[] = [];
    await bridge.handleAsrDecodePrepare({ taskType: "asr-decode-prepare" }, { tab: { id: tabId } }, (r) => responses.push(r as BridgeResponse));
    expect(responses[0].ok).toBe(true);
    return responses[0] as PrepareResponse;
  }

  it("标签页关闭后（tabs.get 报 No tab with id），其名下规则在下一次 prepare 前被回收且 id 复用", async () => {
    const tabsGet = vi.fn(async (tabId) => {
      if (tabId === 7) throw new Error(`No tab with id: ${tabId}.`);
      return { id: tabId };
    });
    const store = await freshBridge({ tabsGet });

    const dead = await prepareFrom(7);
    expect(tabsGet).not.toHaveBeenCalled();

    const alive = await prepareFrom(9);
    expect(tabsGet).toHaveBeenCalledWith(7);
    expect(store.rules.size).toBe(1);
    expect(alive.ruleId).toBe(dead.ruleId);

    const third = await prepareFrom(9);
    expect(store.rules.has(alive.ruleId)).toBe(true);
    expect(store.rules.size).toBe(2);
    expect(third.ruleId).toBe(bridge.ASR_AUDIO_SESSION_RULE_ID_BASE + 1);
  });

  it("offscreen / 对账收编来源（无法核验）的规则不被误收；tabs.get 全线异常时保守保留", async () => {
    const store = await freshBridge({
      initialRules: [residueRule(32001)],
      tabsGet: vi.fn(async () => {
        throw new Error("tabs API down");
      })
    });

    const first = await prepareOnce();
    expect(first.ruleId).toBe(32002);

    const fromTab = await prepareFrom(9);
    expect(store.rules.has(32001)).toBe(true);
    expect(store.rules.has(32002)).toBe(true);
    expect(store.rules.has(fromTab.ruleId)).toBe(true);
    expect(store.rules.size).toBe(3);
  });

  it("无活跃规则时回收为无操作（不额外查询 tabs）", async () => {
    const tabsGet = vi.fn(async () => ({ id: 1 }));
    await freshBridge({ tabsGet });

    await prepareOnce();

    expect(tabsGet).not.toHaveBeenCalled();
  });
});

describe("reapAllSessionRules（安装/更新整池清理）", () => {
  it("清空池区间内全部规则，区间外的动态规则不受影响", async () => {
    const foreignRule = { id: 999, priority: 1, action: { type: "block" }, condition: {} };
    const store = makeRuleStore([residueRule(32001), foreignRule]);
    stubSwEnv({
      contextsResult: existingDocContexts,
      updateSessionRules: store.updateSessionRules,
      getSessionRules: store.getSessionRules
    });
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    await bridge.reapAllSessionRules();

    expect(store.rules.has(32001)).toBe(false);
    expect(store.rules.has(999)).toBe(true);
  });

  it("账本整体重置：清理后首个任务从池下界重新分配（对账缓存一并作废）", async () => {
    const store = makeRuleStore([]);
    stubSwEnv({
      contextsResult: existingDocContexts,
      updateSessionRules: store.updateSessionRules,
      getSessionRules: store.getSessionRules
    });
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const first = await prepareOnce();
    expect(first.ruleId).toBe(32001);
    await bridge.reapAllSessionRules();
    expect(store.rules.size).toBe(0);

    const after = await prepareOnce();
    expect(after.ruleId).toBe(32001);
    expect(store.rules.size).toBe(1);
  });
});

describe("后台视频帧媒体会话规则", () => {
  it("仅覆盖 media 与跨域响应头，与 ASR 并发分配不同 id 且独立清理", async () => {
    const store = makeRuleStore();
    stubSwEnv({
      contextsResult: existingDocContexts,
      updateSessionRules: store.updateSessionRules,
      getSessionRules: store.getSessionRules
    });
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const frameResponses: BridgeResponse[] = [];
    await bridge.handleVideoFramePrepare({}, {}, (response) => frameResponses.push(response as BridgeResponse));
    const frame = frameResponses[0] as PrepareResponse;
    const asr = await prepareOnce();

    expect(asr.ruleId).not.toBe(frame.ruleId);
    expect(store.rules.get(frame.ruleId)).toMatchObject({
      action: {
        requestHeaders: [
          { header: "Referer", operation: "set", value: "https://www.bilibili.com" },
          { header: "Origin", operation: "set", value: "https://www.bilibili.com" }
        ],
        responseHeaders: [
          { header: "Access-Control-Allow-Origin", operation: "set", value: "*" }
        ]
      },
      condition: {
        requestDomains: ["bilivideo.com", "bilivideo.cn", "akamaized.net"],
        resourceTypes: ["media"]
      }
    });
    expect(store.rules.get(asr.ruleId)).toMatchObject(EXPECTED_RULE_SHAPE);

    await cleanupOnce(frame.ruleId);
    expect(store.rules.has(frame.ruleId)).toBe(false);
    expect(store.rules.has(asr.ruleId)).toBe(true);
  });
});
