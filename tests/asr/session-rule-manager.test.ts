// ASR 会话规则管理器单元测试：测试 createAsrSessionRuleManager 契约
// 包括分配/归还复用、幂等守卫、冷启动对账、孤儿回收与整池清理。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  createAsrSessionRuleManager,
  ASR_AUDIO_SESSION_RULE_ID_BASE,
  ASR_AUDIO_SESSION_RULE_ID_MAX
} from "../../extension/asr/session-rule-manager.js";

interface FakeSessionRule {
  id: number;
  priority?: number;
  action?: unknown;
  condition?: unknown;
}

function stubManagerEnv({
  initialRules = [],
  tabsGet
}: {
  initialRules?: FakeSessionRule[];
  tabsGet?: (tabId: number) => Promise<{ id: number }>;
} = {}) {
  const rules = new Map(initialRules.map((rule) => [rule.id, rule] as const));
  const updateSessionRules = vi.fn(
    async ({ removeRuleIds = [], addRules = [] }: { removeRuleIds?: number[]; addRules?: FakeSessionRule[] }) => {
      for (const id of removeRuleIds) rules.delete(id);
      for (const rule of addRules) rules.set(rule.id, rule);
    }
  );
  const getSessionRules = vi.fn(async () => [...rules.values()]);
  vi.stubGlobal("chrome", {
    tabs: { get: tabsGet || vi.fn(async (id: number) => ({ id })) },
    declarativeNetRequest: {
      updateSessionRules,
      getSessionRules
    }
  });
  return { rules, updateSessionRules, getSessionRules };
}

beforeEach(() => {
  resetModuleState();
});

describe("createAsrSessionRuleManager 分配与归还复用", () => {
  it("首次 allocate 分配 BASE (32001)，多次 allocate 计数器单调递增", async () => {
    stubManagerEnv();
    const manager = createAsrSessionRuleManager();

    const id1 = await manager.allocate("t1");
    const id2 = await manager.allocate("t2");
    const id3 = await manager.allocate("t3");

    expect(id1).toBe(ASR_AUDIO_SESSION_RULE_ID_BASE);
    expect(id2).toBe(ASR_AUDIO_SESSION_RULE_ID_BASE + 1);
    expect(id3).toBe(ASR_AUDIO_SESSION_RULE_ID_BASE + 2);
    expect(manager.getOwner(id1)).toBe("t1");
    expect(manager.getOwner(id2)).toBe("t2");
  });

  it("release 后优先复用空闲池中的 id", async () => {
    stubManagerEnv();
    const manager = createAsrSessionRuleManager();

    const id1 = await manager.allocate("t1");
    const id2 = await manager.allocate("t2");

    manager.release(id1);
    expect(manager.getOwner(id1)).toBeUndefined();

    const reused = await manager.allocate("t3");
    expect(reused).toBe(id1);
    expect(manager.getOwner(reused)).toBe("t3");

    const id3 = await manager.allocate("t4");
    expect(id3).toBe(ASR_AUDIO_SESSION_RULE_ID_BASE + 2);
  });

  it("未分配或已归还 id 的 release 保持幂等：不动池状态，不污染空闲池", async () => {
    stubManagerEnv();
    const manager = createAsrSessionRuleManager();

    const id1 = await manager.allocate("t1");
    manager.release(id1);
    // 重复 release
    manager.release(id1);
    // 未分配的杂 id release
    manager.release(99999);
    manager.release(ASR_AUDIO_SESSION_RULE_ID_BASE + 50);

    // 复用 id1
    const next1 = await manager.allocate("t2");
    expect(next1).toBe(id1);
    // 下一个应该走计数器递增，而不是 99999 或其他杂 id
    const next2 = await manager.allocate("t3");
    expect(next2).toBe(ASR_AUDIO_SESSION_RULE_ID_BASE + 1);
  });

  it("id 超过 MAX 且无空闲池时抛出耗尽错误", async () => {
    stubManagerEnv();
    const manager = createAsrSessionRuleManager();

    // 模拟分配到 MAX
    for (let i = ASR_AUDIO_SESSION_RULE_ID_BASE; i <= ASR_AUDIO_SESSION_RULE_ID_MAX; i++) {
      const id = await manager.allocate(`t${i}`);
      expect(id).toBe(i);
    }

    await expect(manager.allocate("overflow")).rejects.toThrow("防盗链规则 id 已耗尽（活跃转写任务过多），请稍后重试");

    // 释放一个后可再次分配
    manager.release(ASR_AUDIO_SESSION_RULE_ID_BASE + 5);
    const reused = await manager.allocate("t-reused");
    expect(reused).toBe(ASR_AUDIO_SESSION_RULE_ID_BASE + 5);
  });
});

describe("createAsrSessionRuleManager 冷启动对账", () => {
  it("平台残留活跃规则被收编进活跃集，计数器越过最大 id，空闲池清空", async () => {
    const residue = { id: 32001 };
    const foreignRule = { id: 100 }; // 区间外
    const { getSessionRules } = stubManagerEnv({ initialRules: [residue, foreignRule] });
    const manager = createAsrSessionRuleManager();

    const allocated = await manager.allocate("t1");
    expect(allocated).toBe(32002);
    expect(getSessionRules).toHaveBeenCalledTimes(1);

    // 对账收编的 32001 其 owner 记为空串 ""
    expect(manager.getOwner(32001)).toBe("");
    expect(manager.getOwner(32002)).toBe("t1");
    // 区间外规则不入账
    expect(manager.getOwner(100)).toBeUndefined();
  });

  it("单飞缓存：并发 ensureReconciled 只调用一次平台 getSessionRules", async () => {
    const { getSessionRules } = stubManagerEnv({ initialRules: [{ id: 32001 }] });
    const manager = createAsrSessionRuleManager();

    await Promise.all([
      manager.ensureReconciled(),
      manager.ensureReconciled(),
      manager.allocate("t1")
    ]);

    expect(getSessionRules).toHaveBeenCalledTimes(1);
  });

  it("对账失败不缓存且账本不动，下次调用重试", async () => {
    let callCount = 0;
    stubManagerEnv();
    vi.stubGlobal("chrome", {
      tabs: { get: vi.fn(async (id: number) => ({ id })) },
      declarativeNetRequest: {
        updateSessionRules: vi.fn(async () => {}),
        getSessionRules: vi.fn(async () => {
          callCount++;
          if (callCount === 1) {
            throw new Error("DNR unavailable");
          }
          return [{ id: 32001 }];
        })
      }
    });

    const manager = createAsrSessionRuleManager();

    await expect(manager.allocate("t1")).rejects.toThrow("DNR unavailable");

    // 第二次重试对账成功
    const id = await manager.allocate("t1");
    expect(id).toBe(32002);
    expect(callCount).toBe(2);
  });
});

describe("createAsrSessionRuleManager 孤儿回收 reapOrphans", () => {
  it("回收已关闭标签页的规则，保留存活标签页与无法核验来源的规则", async () => {
    const tabsGet = vi.fn(async (tabId: number) => {
      if (tabId === 7) {
        throw new Error("No tab with id: 7.");
      }
      return { id: tabId };
    });
    const { rules, updateSessionRules } = stubManagerEnv({ tabsGet });
    const manager = createAsrSessionRuleManager();

    const idTab7 = await manager.allocate("t7");
    const idTab8 = await manager.allocate("t8");
    const idOffscreen = await manager.allocate("o");

    rules.set(idTab7, { id: idTab7 });
    rules.set(idTab8, { id: idTab8 });
    rules.set(idOffscreen, { id: idOffscreen });

    await manager.reapOrphans();

    // tab 7 的规则被移除
    expect(updateSessionRules).toHaveBeenCalledWith({ removeRuleIds: [idTab7] });
    expect(rules.has(idTab7)).toBe(false);
    expect(manager.getOwner(idTab7)).toBeUndefined();

    // tab 8 与 offscreen 规则保留
    expect(rules.has(idTab8)).toBe(true);
    expect(rules.has(idOffscreen)).toBe(true);
    expect(manager.getOwner(idTab8)).toBe("t8");
    expect(manager.getOwner(idOffscreen)).toBe("o");

    // 被回收的 idTab7 立即可以被复用
    const reused = await manager.allocate("t9");
    expect(reused).toBe(idTab7);
  });

  it("tabs.get 发生非关闭错误时保守保留规则", async () => {
    const tabsGet = vi.fn(async () => {
      throw new Error("Internal extension error");
    });
    const { rules, updateSessionRules } = stubManagerEnv({ tabsGet });
    const manager = createAsrSessionRuleManager();

    const id = await manager.allocate("t10");
    rules.set(id, { id });

    await manager.reapOrphans();

    expect(updateSessionRules).not.toHaveBeenCalled();
    expect(rules.has(id)).toBe(true);
    expect(manager.getOwner(id)).toBe("t10");
  });

  it("无活跃规则时为无操作，不调用 tabs.get", async () => {
    const tabsGet = vi.fn(async (id: number) => ({ id }));
    stubManagerEnv({ tabsGet });
    const manager = createAsrSessionRuleManager();

    await manager.reapOrphans();
    expect(tabsGet).not.toHaveBeenCalled();
  });
});

describe("createAsrSessionRuleManager 整池清理 clearAll", () => {
  it("清空平台区间内规则，重置内部账本与对账缓存", async () => {
    const initialRules = [
      { id: 32001 },
      { id: 32005 },
      { id: 999 } // 区间外规则
    ];
    const { rules, updateSessionRules } = stubManagerEnv({ initialRules });
    const manager = createAsrSessionRuleManager();

    // 先做一次分配，建立状态
    const id = await manager.allocate("t1");
    expect(id).toBe(32006);
    rules.set(id, { id });

    await manager.clearAll();

    // 平台区间内规则被删，区间外规则未受影响
    expect(updateSessionRules).toHaveBeenCalledWith({ removeRuleIds: [32001, 32005, 32006] });
    expect(rules.has(999)).toBe(true);
    expect(rules.has(32001)).toBe(false);
    expect(rules.has(32006)).toBe(false);

    // 内部账本完全重置，下次分配重新从 BASE 开始
    const freshId = await manager.allocate("t2");
    expect(freshId).toBe(ASR_AUDIO_SESSION_RULE_ID_BASE);
  });
});
