// extension/ui/provider-transaction.ts — 平台编辑的「一次保存 / 删除事务」（owner 3）。
//
// 单平台 upsert / delete 的全部宿主侧动作收在这一处：
//   权限代申请 → 现查权威列表 → 按 id 合并 / 追加（或回收 orphan origin）
//   → 整列表落盘 / 删除 → 用响应存活列表重渲。
// Modal 侧的 onSave / onDelete 只回 {ok, error?}（不再各自拼事务），也不再必须
// 挂载整个设置面板才能测：族分派面、权限代申请、重渲与抽屉状态条都经 deps 注入
//（见 tests/ui/provider-transaction.test.ts）。
//
// 手势不变式：upsertProvider 函数体开头到 deps.requestOrigins 之间零先行 await——
// baseUrl 由 upsert 参数直供，无需先查列表（等价行为断言见该测试文件的 T2）。
//
// orphan origin 的存活并集只从分派表推导（optionalHostPermission 的族）；
// 设置面板的行删除路径复用同一函数（loadOriginSharingProviders），新增一族只改表。

import { permissionRevokeErrorMessage, revokeOrphanOrigin } from "../core/host-permissions.js";
import type { ProviderEditorKind } from "./provider-editor-state.js";
import type { ProviderRowItem } from "./provider-row.js";

// 族 → 事务所需的最小分派面（设置面板的 PROVIDER_FAMILY_UI 结构兼容）
export interface ProviderTransactionFamily {
  // 整列表现查（upsert 前的权威列表，失败由事务兜底成空列表）
  list(): Promise<{ ok?: boolean; providers?: ProviderRowItem[]; error?: string }>;
  // 整列表替换保存（回最新列表，含 hasSavedKey）
  save(providers: ProviderRowItem[]): Promise<{ ok?: boolean; providers?: ProviderRowItem[]; error?: string }>;
  // 单条删除（回删除后存活列表）
  remove(providerId: string): Promise<{ ok?: boolean; providers?: ProviderRowItem[]; error?: string }>;
  // 现查列表并兜底成空数组（orphan 回收判定用）
  loadProviders(): Promise<ProviderRowItem[]>;
  // 新平台 id 生成（沿用各行 id 前缀）
  generateId(): string;
  // 域名是否走 optional host 权限（搜索族是 manifest 静态 host 权限，不代申请、
  // 也不参与 orphan 回收）
  optionalHostPermission: boolean;
}

export type ProviderFamilyTable = Record<ProviderEditorKind, ProviderTransactionFamily>;

export interface ProviderTransactionsDeps {
  families: ProviderFamilyTable;
  // 权限代申请（手势同步链上的唯一点；注入便于测试零先行 await）
  requestOrigins(baseUrls: string[]): Promise<{ ok: boolean; error?: string }>;
  // 落盘 / 删除成功后的列表重渲（宿主侧按 kind 分派）
  rerender(kind: ProviderEditorKind, providers: ProviderRowItem[]): void;
  // 回收失败（删除已完成，权限残留）的抽屉级提示
  reportOriginRevokeFailure(message: string): void;
}

export interface ProviderTransactions {
  upsertProvider(kind: ProviderEditorKind, upsert: ProviderRowItem): Promise<{ ok: boolean; error?: string }>;
  deleteProvider(
    kind: ProviderEditorKind,
    target: { id: string; baseUrl: string }
  ): Promise<{ ok: boolean; error?: string }>;
}

// orphan origin 回收的存活并集：问分派表里所有 optionalHostPermission 的族
// （当前 ai+asr；搜索是 manifest 静态 host 权限不参与）。两条删除路径
//（deleteProvider / 设置面板行删除）共用，新增一族只改表。
export async function loadOriginSharingProviders(families: ProviderFamilyTable): Promise<ProviderRowItem[]> {
  const eligible = Object.values(families).filter((family) => family.optionalHostPermission);
  const lists = await Promise.all(eligible.map((family) => family.loadProviders()));
  return lists.flat();
}

export function createProviderTransactions(deps: ProviderTransactionsDeps): ProviderTransactions {
  // 单平台 upsert：只保存这一个平台——列表从后端现查（权威数据），平铺行未保存的
  // 行内编辑不混入；upsert 按 id 替换 / 追加后发整列表消息（ai/asr/search-providers-save
  // 本就是整列表替换语义，SW 协议零改动）。API Key 仍单独落 chrome.storage.local
  //（saveProviders 后台语义：空输入沿用已存 Key 不清除）。
  async function upsertProvider(
    kind: ProviderEditorKind,
    upsert: ProviderRowItem
  ): Promise<{ ok: boolean; error?: string }> {
    const family = deps.families[kind];
    // 搜索平台域名是静态 host 权限（manifest host_permissions，spec §2.4），不走
    // optional 权限代申请。手势不变式：本调用之前零先行 await。
    if (family.optionalHostPermission && upsert.baseUrl) {
      const permission = await deps.requestOrigins([String(upsert.baseUrl)]);
      if (!permission.ok) {
        return { ok: false, error: permission.error };
      }
    }
    try {
      const listResp = await family.list();
      const list: ProviderRowItem[] = listResp?.ok && Array.isArray(listResp.providers) ? listResp.providers : [];
      const providerId = String(upsert.id || "") || family.generateId();
      const next = list.some((provider) => String(provider?.id || "") === providerId)
        ? list.map((provider) => (String(provider?.id || "") === providerId ? { ...provider, ...upsert, id: providerId } : provider))
        : [...list, { ...upsert, id: providerId }];
      const saveResp = await family.save(next);
      if (!saveResp?.ok) {
        return { ok: false, error: saveResp?.error || "保存失败" };
      }
      deps.rerender(kind, saveResp.providers || []);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message || "保存失败" };
    }
  }

  // 单平台删除：回收 orphan origin（与列表行删除共用判定，存活列表现查）→ 删除
  // 消息 → 用响应存活列表重渲。回收失败不阻断删除（与列表行同语义），错误文案
  // 落抽屉状态条。
  async function deleteProvider(
    kind: ProviderEditorKind,
    target: { id: string; baseUrl: string }
  ): Promise<{ ok: boolean; error?: string }> {
    const family = deps.families[kind];
    try {
      if (family.optionalHostPermission) {
        // 搜索平台域名是静态 host 权限（无 optional 授权可回收），跳过 orphan
        // origin 判定；参与判定的存活并集由分派表推导（见 loadOriginSharingProviders）
        const providers = await loadOriginSharingProviders(deps.families);
        const { origins, revoked } = await revokeOrphanOrigin(
          { id: target.id, baseUrl: target.baseUrl },
          providers
        );
        if (origins.length > 0 && !revoked) {
          deps.reportOriginRevokeFailure(permissionRevokeErrorMessage(origins));
        }
      }
      const resp = await family.remove(target.id);
      if (!resp?.ok) {
        return { ok: false, error: resp?.error || "删除失败" };
      }
      if (Array.isArray(resp.providers)) {
        deps.rerender(kind, resp.providers);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message || "删除失败" };
    }
  }

  return { upsertProvider, deleteProvider };
}
