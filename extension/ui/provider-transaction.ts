import { permissionRevokeErrorMessage, revokeOrphanOriginViaBackground } from "../core/host-permissions.js";
import { PROVIDER_FAMILY_ROWS } from "./provider-family.js";
import type { ProviderEditorKind } from "./provider-editor-state.js";
import type { ProviderRowItem } from "./provider-row.js";

export interface ProviderTransactionFamily {
  list(): Promise<{ ok?: boolean; providers?: ProviderRowItem[]; error?: string }>;
  save(providers: ProviderRowItem[]): Promise<{ ok?: boolean; providers?: ProviderRowItem[]; error?: string }>;
  remove?(providerId: string): Promise<{ ok?: boolean; providers?: ProviderRowItem[]; error?: string }>;
  loadProviders?(): Promise<ProviderRowItem[]>;
  generateId(): string;
  optionalHostPermission: boolean;
}

export type ProviderFamilyTable = Partial<Record<ProviderEditorKind, ProviderTransactionFamily>>;

export interface UpsertProviderOptions {
  matchExisting?: (
    list: readonly ProviderRowItem[],
    upsert: ProviderRowItem
  ) => ProviderRowItem | null | undefined;
  buildUpsert?: (
    existing: ProviderRowItem | null,
    providerId: string
  ) => { ok: true; upsert: ProviderRowItem } | { ok: false; error: string };
}

export interface UpsertProviderResult {
  ok: boolean;
  providerId?: string;
  providers?: ProviderRowItem[];
  error?: string;
  permissionDenied?: boolean;
}

export interface ProviderTransactionsDeps {
  families: ProviderFamilyTable;
  requestOrigins(baseUrls: string[]): Promise<{ ok: boolean; error?: string }>;
  rerender?: (kind: ProviderEditorKind, providers: ProviderRowItem[]) => void;
  reportOriginRevokeFailure?: (message: string) => void;
}

export interface ProviderTransactions {
  upsertProvider(
    kind: ProviderEditorKind,
    upsert: ProviderRowItem,
    options?: UpsertProviderOptions
  ): Promise<UpsertProviderResult>;
  deleteProvider(
    kind: ProviderEditorKind,
    target: { id: string; baseUrl: string }
  ): Promise<{ ok: boolean; error?: string }>;
}

export async function loadOriginSharingProviders(families: ProviderFamilyTable): Promise<ProviderRowItem[]> {
  const eligible = Object.values(families).filter(
    (family): family is ProviderTransactionFamily =>
      Boolean(family && family.optionalHostPermission && typeof family.loadProviders === "function")
  );
  const lists = await Promise.all(eligible.map((family) => family.loadProviders!()));
  return lists.flat();
}

export function createProviderTransactions(deps: ProviderTransactionsDeps): ProviderTransactions {
  async function upsertProvider(
    kind: ProviderEditorKind,
    upsert: ProviderRowItem,
    options?: UpsertProviderOptions
  ): Promise<UpsertProviderResult> {
    const family = deps.families[kind];
    if (!family) {
      return { ok: false, error: `不支持的平台类型：${kind}` };
    }
    if (family.optionalHostPermission && upsert.baseUrl) {
      const rawUrl = String(upsert.baseUrl);
      const model = typeof upsert.model === "string" ? upsert.model : undefined;
      const permission = await deps.requestOrigins(
        PROVIDER_FAMILY_ROWS[kind].editor.resolvePermissionOrigins(rawUrl, model)
      );
      if (!permission.ok) {
        return { ok: false, error: permission.error, permissionDenied: true };
      }
    }
    try {
      const listResp = await family.list();
      const list: ProviderRowItem[] = listResp?.ok && Array.isArray(listResp.providers) ? listResp.providers : [];
      const upsertId = String(upsert.id || "");
      const matchedById = upsertId
        ? list.find((provider) => String(provider?.id || "") === upsertId)
        : undefined;
      const existing = matchedById ?? options?.matchExisting?.(list, upsert) ?? null;
      const providerId = String(existing?.id || "") || upsertId || family.generateId();

      let patch = upsert;
      if (options?.buildUpsert) {
        const built = options.buildUpsert(existing, providerId);
        if (!built.ok) {
          return { ok: false, error: built.error };
        }
        patch = built.upsert;
      }

      const merged: ProviderRowItem = existing
        ? { ...existing, ...patch, id: providerId }
        : { ...patch, id: providerId };
      const next = existing
        ? list.map((provider) => (String(provider?.id || "") === providerId ? merged : provider))
        : [...list, merged];
      const saveResp = await family.save(next);
      if (!saveResp?.ok) {
        return { ok: false, error: saveResp?.error || "保存失败" };
      }
      const providers = saveResp.providers || [];
      deps.rerender?.(kind, providers);
      return { ok: true, providerId, providers };
    } catch (error) {
      return { ok: false, error: (error as Error).message || "保存失败" };
    }
  }

  async function deleteProvider(
    kind: ProviderEditorKind,
    target: { id: string; baseUrl: string }
  ): Promise<{ ok: boolean; error?: string }> {
    const family = deps.families[kind];
    if (!family || typeof family.remove !== "function") {
      return { ok: false, error: "删除失败" };
    }
    try {
      if (family.optionalHostPermission) {
        const providers = await loadOriginSharingProviders(deps.families);
        const { origins, revoked } = await revokeOrphanOriginViaBackground(
          { id: target.id, baseUrl: target.baseUrl },
          providers
        );
        if (origins.length > 0 && !revoked) {
          deps.reportOriginRevokeFailure?.(permissionRevokeErrorMessage(origins));
        }
      }
      const resp = await family.remove(target.id);
      if (!resp?.ok) {
        return { ok: false, error: resp?.error || "删除失败" };
      }
      if (Array.isArray(resp.providers)) {
        deps.rerender?.(kind, resp.providers);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message || "删除失败" };
    }
  }

  return { upsertProvider, deleteProvider };
}
