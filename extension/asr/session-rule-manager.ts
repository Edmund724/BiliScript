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
  let nextSessionRuleId: number = ASR_AUDIO_SESSION_RULE_ID_BASE;
  const activeSessionRuleIds = new Map<number, string>();
  const freeSessionRuleIds: number[] = [];

  let sessionRuleIdsReconcilePromise: Promise<void> | null = null;

  async function reconcileSessionRuleIds(): Promise<void> {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    let maxSessionRuleId = ASR_AUDIO_SESSION_RULE_ID_BASE - 1;
    for (const rule of rules) {
      const id = Number(rule?.id) || 0;
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
        sessionRuleIdsReconcilePromise = null;
        throw error;
      });
    }
    return sessionRuleIdsReconcilePromise;
  }

  async function allocate(owner: string): Promise<number> {
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
    if (!activeSessionRuleIds.delete(id)) {
      return;
    }
    freeSessionRuleIds.push(id);
  }

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

  async function clearAll(): Promise<void> {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const removeRuleIds = rules
      .map((rule) => Number(rule?.id) || 0)
      .filter((id) => id >= ASR_AUDIO_SESSION_RULE_ID_BASE && id <= ASR_AUDIO_SESSION_RULE_ID_MAX);
    if (removeRuleIds.length > 0) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds });
    }
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
