// ASR 会话规则管理器：负责防盗链 DNR 规则的生命周期簿记。
// 内聚单调计数器、活跃集、空闲池复用、冷启动平台事实源对账、死标签页孤儿回收与整池清理。
// 所有簿记变量封装于 createAsrSessionRuleManager 闭包中，对外暴露统一的 5 个管理方法与查询接口。

// 防盗链会话规则 id 池区间常量：
// id 按任务独立分配（一个任务一条规则，多任务并发时规则并存、cleanup 只删自己的），
// 自此单调递增；任务结束归还空闲池复用，防止长会话 id 无限增长。
export const ASR_AUDIO_SESSION_RULE_ID_BASE: number = 32001;
export const ASR_AUDIO_SESSION_RULE_ID_MAX: number = 32100;

export interface AsrSessionRuleManager {
  ensureReconciled(): Promise<void>;
  allocate(owner: string): Promise<number>;
  release(ruleId: number): void;
  reapOrphans(): Promise<void>;
  clearAll(): Promise<void>;
  getOwner(ruleId: number): string | undefined;
}

export function createAsrSessionRuleManager(): AsrSessionRuleManager {
  // 单调递增计数器、活跃集与空闲池
  let nextSessionRuleId: number = ASR_AUDIO_SESSION_RULE_ID_BASE;
  const activeSessionRuleIds = new Map<number, string>();
  const freeSessionRuleIds: number[] = [];

  // SW 冷启动对账单飞 Promise：账本随 SW 实例生灭，而会话规则生命周期是整个浏览器会话。
  // 首次分配前以平台为事实源对账一次：区间内已有规则一律收进活跃集（owner 记为 "" 来源未知）、
  // 计数器越过平台最大 id、空闲池清空。
  let sessionRuleIdsReconcilePromise: Promise<void> | null = null;

  async function reconcileSessionRuleIds(): Promise<void> {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    let maxSessionRuleId = ASR_AUDIO_SESSION_RULE_ID_BASE - 1;
    for (const rule of rules) {
      const id = Number(rule?.id) || 0;
      // 只收本池区间内的 id，区间外规则不误入账本；来源未知（""）→ cleanup 放行
      if (id >= ASR_AUDIO_SESSION_RULE_ID_BASE && id <= ASR_AUDIO_SESSION_RULE_ID_MAX) {
        activeSessionRuleIds.set(id, "");
        if (id > maxSessionRuleId) {
          maxSessionRuleId = id;
        }
      }
    }
    nextSessionRuleId = Math.max(ASR_AUDIO_SESSION_RULE_ID_BASE, maxSessionRuleId + 1);
    freeSessionRuleIds.length = 0;
  }

  function ensureReconciled(): Promise<void> {
    if (!sessionRuleIdsReconcilePromise) {
      sessionRuleIdsReconcilePromise = reconcileSessionRuleIds().catch((error) => {
        // 失败不缓存且账本分文未动（赋值在查询成功后一次完成）：下次 prepare
        // 重试对账；错误原样抛出，沿 prepare 既有错误路径上报，不吞错也不
        // 静默降级为带撞车风险的裸分配。
        sessionRuleIdsReconcilePromise = null;
        throw error;
      });
    }
    return sessionRuleIdsReconcilePromise;
  }

  async function allocate(owner: string): Promise<number> {
    // 首次分配前对账一次（实例内幂等缓存），避免与上一 SW 实例残留的会话规则撞 id
    await ensureReconciled();

    let ruleId = freeSessionRuleIds.pop();
    if (ruleId === undefined) {
      if (nextSessionRuleId > ASR_AUDIO_SESSION_RULE_ID_MAX) {
        throw new Error("防盗链规则 id 已耗尽（活跃转写任务过多），请稍后重试");
      }
      ruleId = nextSessionRuleId++;
    }
    activeSessionRuleIds.set(ruleId, owner);
    return ruleId;
  }

  function release(ruleId: number): void {
    const id = Number(ruleId) || 0;
    // 活跃集守卫：未分配/已归还的 id（重复 cleanup、陈旧 id）不动池状态
    if (!activeSessionRuleIds.delete(id)) {
      return;
    }
    freeSessionRuleIds.push(id);
  }

  // 标签页是否仍存活：只把 Chrome 对已关闭标签页的确定性错误
  //（"No tab with id: N."）判为死亡；API 缺失或其他异常一律按存活处理——
  // 回收是防泄漏兜底，宁可漏收也不可误收正被依赖的规则。
  async function isTabAlive(tabId: number): Promise<boolean> {
    if (!(tabId > 0)) {
      return false;
    }
    try {
      await chrome.tabs.get(tabId);
      return true;
    } catch (error) {
      const message = String((error as { message?: string } | null)?.message || error);
      return !/no tab with id/i.test(message);
    }
  }

  // 泄漏兜底：回收归属标签页已关闭的残留规则。
  // 每次 prepare 前把「归属标签页已不存在」的活跃规则回收掉（owner 键为
  // "t<tabId>" 的才可核验；offscreen / 对账收编的来源无法核验，保守保留）。
  async function reapOrphans(): Promise<void> {
    if (activeSessionRuleIds.size === 0) {
      return;
    }
    const deadIds: number[] = [];
    for (const [id, owner] of activeSessionRuleIds) {
      if (!owner.startsWith("t")) {
        continue;
      }
      if (!(await isTabAlive(Number(owner.slice(1)) || 0))) {
        deadIds.push(id);
      }
    }
    for (const id of deadIds) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
      release(id);
    }
  }

  // 整池清理：把池区间内平台上现存的全部会话规则清掉，并重置内部账本。
  async function clearAll(): Promise<void> {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const removeRuleIds = rules
      .map((rule) => Number(rule?.id) || 0)
      .filter((id) => id >= ASR_AUDIO_SESSION_RULE_ID_BASE && id <= ASR_AUDIO_SESSION_RULE_ID_MAX);
    if (removeRuleIds.length > 0) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds });
    }
    // 账本整体重置（对账缓存一并作废，下次 prepare 重新按平台对账）
    nextSessionRuleId = ASR_AUDIO_SESSION_RULE_ID_BASE;
    activeSessionRuleIds.clear();
    freeSessionRuleIds.length = 0;
    sessionRuleIdsReconcilePromise = null;
  }

  function getOwner(ruleId: number): string | undefined {
    return activeSessionRuleIds.get(Number(ruleId) || 0);
  }

  return {
    ensureReconciled,
    allocate,
    release,
    reapOrphans,
    clearAll,
    getOwner
  };
}
