// tests/ui/provider-transaction.test.ts
// owner 3「单点事务」的行为契约：upsertProvider / deleteProvider 一处持有
// 权限申请 → 现查-按 id 合并/追加-落盘-重渲，以及删除侧的 orphan 回收 +
// 双口径文案。
//
// 先列失败方式（每条对应下面的用例）：
//   T1 合并口径漂移：按 id 替换变成追加（或反之）→ 整列表被覆盖/重复；
//   T2 权限申请被挪到先行 await 之后（手势丢失）：权限调用不再落在调用同步链上；
//   T3 权限被拒仍落盘 / 仍重渲；
//   T4 落盘失败仍重渲（用失败响应当成功列表）；
//   T5 静态 host 权限的族被拉进 optional 申请（搜索族多弹一次权限框）；
//   T6 orphan 回收失败静默：删了吗、文案有没有、删除是否被阻断；
//   T7 回收成功仍报错（文案假阳性）；
//   T8 静态 host 权限的族被拉进回收并集（错收搜索域权限）。
//
// 事务不碰 DOM（重渲与抽屉状态条都经 deps 注入），因此本文件无需挂载设置面板。

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

function familyStub(overrides: Partial<FamilyStub> = {}): FamilyStub {
  return {
    list: vi.fn(async () => ({ ok: true, providers: [] })),
    save: vi.fn(async (providers: ProviderRowItem[]) => ({ ok: true, providers })),
    remove: vi.fn(async () => ({ ok: true, providers: [] })),
    loadProviders: vi.fn(async () => [] as ProviderRowItem[]),
    generateId: vi.fn(() => "p_new"),
    optionalHostPermission: true,
    ...overrides
  };
}

async function makeTransactions(overrides: Partial<Record<string, unknown>> = {}) {
  const { createProviderTransactions } = await import("../../extension/ui/provider-transaction.js");
  const families = {
    ai: familyStub(),
    asr: familyStub(),
    search: familyStub({ optionalHostPermission: false, generateId: vi.fn(() => "search_new") })
  };
  const deps = {
    families,
    requestOrigins: vi.fn(async () => ({ ok: true })),
    rerender: vi.fn(),
    reportOriginRevokeFailure: vi.fn(),
    ...overrides
  };
  return { tx: createProviderTransactions(deps as never), deps, families };
}

beforeEach(() => {
  resetModuleState();
  delete (globalThis.chrome as unknown as { permissions?: unknown }).permissions;
});

afterEach(() => {
  delete (globalThis.chrome as unknown as { permissions?: unknown }).permissions;
});

describe("upsertProvider：单点保存事务", () => {
  it("T1 新增：现查权威列表 → 生成 id 追加 → 整列表落盘 → 用响应列表重渲", async () => {
    const { tx, deps, families } = await makeTransactions();
    const saved = [{ id: "p_new", name: "自定义", baseUrl: "https://api.example.com/v1" }];
    families.ai.save.mockResolvedValueOnce({ ok: true, providers: saved });

    const result = await tx.upsertProvider("ai", { id: "", name: "自定义", baseUrl: "https://api.example.com/v1" });

    expect(result).toEqual({ ok: true });
    expect(families.ai.list).toHaveBeenCalledTimes(1);
    expect(families.ai.save).toHaveBeenCalledWith([
      { id: "p_new", name: "自定义", baseUrl: "https://api.example.com/v1" }
    ]);
    expect(deps.rerender).toHaveBeenCalledWith("ai", saved);
  });

  it("T1 编辑：按 id 合并替换（未提交字段保留）而不是追加", async () => {
    const { tx, families } = await makeTransactions();
    families.ai.list.mockResolvedValueOnce({
      ok: true,
      providers: [{ id: "p1", name: "旧名", baseUrl: "https://old.example.com/v1", requiresKey: true }]
    });

    await tx.upsertProvider("ai", { id: "p1", name: "新名", baseUrl: "https://new.example.com/v1" });

    expect(families.ai.save).toHaveBeenCalledWith([
      { id: "p1", name: "新名", baseUrl: "https://new.example.com/v1", requiresKey: true }
    ]);
  });

  it("T2 权限代申请落在调用同步链上（零先行 await）", async () => {
    const { tx, deps } = await makeTransactions();
    void tx.upsertProvider("ai", { id: "", baseUrl: "https://api.example.com/v1" });
    expect(deps.requestOrigins, "申请权限之前不得有先行 await").toHaveBeenCalledTimes(1);
    expect(deps.requestOrigins).toHaveBeenCalledWith(["https://api.example.com/v1"]);
  });

  it("T3 权限被拒：不现查不落盘不重渲，错误原样回给 Modal", async () => {
    const { tx, deps, families } = await makeTransactions({
      requestOrigins: vi.fn(async () => ({ ok: false, error: "未授权 https://api.example.com/*，保存已中止" }))
    });

    const result = await tx.upsertProvider("ai", { id: "", baseUrl: "https://api.example.com/v1" });

    expect(result).toEqual({ ok: false, error: "未授权 https://api.example.com/*，保存已中止" });
    expect(families.ai.list).not.toHaveBeenCalled();
    expect(families.ai.save).not.toHaveBeenCalled();
    expect(deps.rerender).not.toHaveBeenCalled();
  });

  it("T5 静态 host 权限的族（搜索）不申请 optional 权限", async () => {
    const { tx, deps, families } = await makeTransactions();

    await tx.upsertProvider("search", { id: "", baseUrl: "https://api.firecrawl.dev" });

    expect(deps.requestOrigins).not.toHaveBeenCalled();
    expect(families.search.save).toHaveBeenCalledTimes(1);
  });

  it("T4 落盘失败：错误回给 Modal，不重渲", async () => {
    const { tx, deps, families } = await makeTransactions();
    families.ai.save.mockResolvedValueOnce({ ok: false, error: "sync 配额不足" });

    const result = await tx.upsertProvider("ai", { id: "", baseUrl: "https://api.example.com/v1" });

    expect(result).toEqual({ ok: false, error: "sync 配额不足" });
    expect(deps.rerender).not.toHaveBeenCalled();
  });

  it("现查/落盘抛异常：兜底成错误回执（不冒泡）", async () => {
    const { tx, families } = await makeTransactions();
    families.ai.list.mockRejectedValueOnce(new Error("列表读取失败"));

    await expect(tx.upsertProvider("ai", { id: "", baseUrl: "https://api.example.com/v1" })).resolves.toEqual({
      ok: false,
      error: "列表读取失败"
    });

    const { tx: tx2, families: families2 } = await makeTransactions();
    families2.asr.save.mockRejectedValueOnce(new Error("落盘炸了"));
    await expect(tx2.upsertProvider("asr", { id: "", baseUrl: "https://asr.example.com/v1" })).resolves.toEqual({
      ok: false,
      error: "落盘炸了"
    });
    // 现查失败按空列表兜底（与整表语义一致）：save 仍被调用
    expect(families.ai.save).not.toHaveBeenCalled();
  });
});

describe("deleteProvider：删除事务与 orphan origin 双口径", () => {
  const deleted = { id: "p1", baseUrl: "https://api.example.com/v1" };

  it("参与回收的族现查存活并集；回收失败不阻断删除，文案走抽屉口径", async () => {
    const { tx, deps, families } = await makeTransactions();
    // 存活并集不含被删 origin → 回收失败（jsdom 无 chrome.permissions）
    families.ai.loadProviders.mockResolvedValueOnce([{ id: "p2", baseUrl: "https://other.example.com/v1" }]);
    families.asr.loadProviders.mockResolvedValueOnce([]);
    families.ai.remove.mockResolvedValueOnce({ ok: true, providers: [{ id: "p2" }] });

    const result = await tx.deleteProvider("ai", deleted);

    expect(result).toEqual({ ok: true });
    expect(families.ai.loadProviders).toHaveBeenCalledTimes(1);
    expect(families.asr.loadProviders).toHaveBeenCalledTimes(1);
    expect(families.search.loadProviders).not.toHaveBeenCalled();
    expect(families.ai.remove).toHaveBeenCalledWith("p1");
    expect(deps.rerender).toHaveBeenCalledWith("ai", [{ id: "p2" }]);
    expect(deps.reportOriginRevokeFailure).toHaveBeenCalledTimes(1);
    expect(deps.reportOriginRevokeFailure.mock.calls[0][0]).toContain("回收域名权限失败");
    expect(deps.reportOriginRevokeFailure.mock.calls[0][0]).toContain("https://api.example.com/*");
  });

  it("T7 回收成功：不发失败文案", async () => {
    const { tx, deps } = await makeTransactions();
    (globalThis.chrome as unknown as { permissions: unknown }).permissions = {
      contains: vi.fn(async () => true),
      remove: vi.fn(async () => true)
    };

    const result = await tx.deleteProvider("ai", deleted);

    expect(result).toEqual({ ok: true });
    expect(deps.reportOriginRevokeFailure).not.toHaveBeenCalled();
  });

  it("origin 仍被同族存活平台占用：不回收、不报错", async () => {
    const { tx, deps, families } = await makeTransactions();
    families.ai.loadProviders.mockResolvedValueOnce([{ id: "p2", baseUrl: "https://api.example.com/v2" }]);
    families.asr.loadProviders.mockResolvedValueOnce([]);
    const remove = vi.fn(async () => true);
    (globalThis.chrome as unknown as { permissions: unknown }).permissions = { contains: vi.fn(async () => true), remove };

    const result = await tx.deleteProvider("ai", deleted);

    expect(result).toEqual({ ok: true });
    expect(remove).not.toHaveBeenCalled();
    expect(deps.reportOriginRevokeFailure).not.toHaveBeenCalled();
  });

  it("T8 静态 host 权限的族：跳过回收并集与回收动作", async () => {
    const { tx, deps, families } = await makeTransactions();

    const result = await tx.deleteProvider("search", { id: "search_1", baseUrl: "https://api.tavily.com" });

    expect(result).toEqual({ ok: true });
    expect(families.ai.loadProviders).not.toHaveBeenCalled();
    expect(families.asr.loadProviders).not.toHaveBeenCalled();
    expect(deps.reportOriginRevokeFailure).not.toHaveBeenCalled();
    expect(families.search.remove).toHaveBeenCalledWith("search_1");
  });

  it("删除失败：错误回给 Modal，不重渲", async () => {
    const { tx, deps, families } = await makeTransactions();
    families.ai.remove.mockResolvedValueOnce({ ok: false, error: "删除失败" });

    const result = await tx.deleteProvider("ai", deleted);

    expect(result).toEqual({ ok: false, error: "删除失败" });
    expect(deps.rerender).not.toHaveBeenCalled();
  });

  it("响应不带存活列表：不重渲（保持既有口径）", async () => {
    const { tx, deps, families } = await makeTransactions();
    families.ai.remove.mockResolvedValueOnce({ ok: true });

    const result = await tx.deleteProvider("ai", deleted);

    expect(result).toEqual({ ok: true });
    expect(deps.rerender).not.toHaveBeenCalled();
  });

  it("删除抛异常：兜底成错误回执", async () => {
    const { tx, families } = await makeTransactions();
    families.ai.remove.mockRejectedValueOnce(new Error("后台失联"));

    await expect(tx.deleteProvider("ai", deleted)).resolves.toEqual({ ok: false, error: "后台失联" });
  });
});
