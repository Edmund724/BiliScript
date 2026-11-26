import { listAsrModels } from "../asr/provider-models.js";
import { testAsrConnection } from "../asr/provider-test.js";
import { listLiveModels, testLiveConnection } from "../live/live-provider-probe.js";
import { testSearchConnection } from "../search/provider-test.js";
import { confirmDialog, isConfirmDialogOpen } from "./confirm-dialog.js";
import type { ModelPickerFetchResult } from "./model-picker.js";
import type { ProviderEditorKind, ProviderEditorSession } from "./provider-editor-session.js";
import { PROVIDER_FAMILY_ROWS } from "./provider-family.js";

export interface PlatformProbeIo {
  readonly preflightOrigin: boolean;
  readonly fetchModels?: (params: {
    baseUrl: string;
    apiKey?: string;
    providerId?: string;
    type?: string;
  }) => Promise<ModelPickerFetchResult | null>;
  readonly probePlatform: (params: {
    id: string;
    presetId: string;
    name: string;
    type: string;
    baseUrl: string;
    model: string;
    apiKey?: string;
    requiresKey: boolean;
  }) => Promise<{ ok?: boolean; message?: string; error?: string }>;
  readonly formatFailure: (error?: string) => string;
}

export const PLATFORM_PROBE_IO: Partial<Record<ProviderEditorKind, PlatformProbeIo>> = {
  asr: {
    preflightOrigin: true,
    fetchModels: listAsrModels,
    probePlatform: ({ id, name, type, baseUrl, model, apiKey }) =>
      testAsrConnection({
        id,
        name,
        type: type || "openai-transcriptions",
        baseUrl,
        model,
        ...(apiKey ? { apiKey } : {})
      }),
    formatFailure: (error) => `失败：${error || "未知错误"}`
  },
  live: {
    preflightOrigin: true,
    fetchModels: listLiveModels,
    probePlatform: ({ id, presetId, name, type, baseUrl, model, apiKey }) =>
      testLiveConnection({
        id,
        presetId,
        name,
        type: type || "moss-live",
        baseUrl,
        model,
        ...(apiKey ? { apiKey } : {})
      }),
    formatFailure: (error) => `失败：${error || "未知错误"}`
  },
  search: {
    preflightOrigin: false,
    probePlatform: ({ id, presetId, type, baseUrl, apiKey, requiresKey }) =>
      testSearchConnection({
        id,
        presetId,
        type,
        baseUrl,
        apiKey,
        requiresKey
      }),
    formatFailure: (error) => error || "连接失败：未知错误"
  }
};

export async function saveSession(session: ProviderEditorSession): Promise<void> {
  if (session.isActionBusy() || isConfirmDialogOpen()) return;
  if (session.validateForSave().length > 0) return;
  const { upsert, validationError } = session.collectUpsert();
  if (validationError) {
    session.showStatus(validationError, true);
    return;
  }
  session.saveInFlight = true;
  session.setBusy(true);
  session.showStatus("正在保存...");
  await session.runIfCurrent(
    () => session.onSave(session.kind, upsert),
    {
      ok: (result) => {
        if (result.ok) {
          if (session.onAfterSave) {
            try {
              session.onAfterSave();
            } catch {}
          }
          session.dispose();
          return;
        }
        session.saveInFlight = false;
        session.setBusy(false);
        session.showStatus(
          result.permissionDenied
            ? `未保存：${result.error || "未取得该平台域名权限，保存已中止"}。请重新授权后重试`
            : result.error || "保存失败",
          true
        );
      },
      fail: (error) => {
        session.saveInFlight = false;
        session.setBusy(false);
        session.showStatus(`保存失败：${(error as Error).message || "未知错误"}`, true);
      }
    }
  );
}

export async function deleteSessionProvider(session: ProviderEditorSession): Promise<void> {
  if (session.isActionBusy() || isConfirmDialogOpen()) return;
  const onDelete = session.onDelete;
  if (!session.editingId || !onDelete) return;
  const confirmed = await confirmDialog({
    title: "删除平台",
    message: "确定要删除这个平台吗？删除后需要重新配置。",
    confirmText: "删除",
    danger: true,
    mountHost: session.host.parentElement || undefined
  });
  if (!confirmed || !session.isOpen() || session.isActionBusy()) {
    return;
  }
  session.deleteInFlight = true;
  session.setBusy(true);
  session.showStatus("正在删除...");
  await session.runIfCurrent(
    () => onDelete(session.kind, { id: session.editingId, baseUrl: session.openBaseUrl }),
    {
      ok: (result) => {
        if (result.ok) {
          session.dispose();
          return;
        }
        session.deleteInFlight = false;
        session.setBusy(false);
        session.showStatus(result.error || "删除失败", true);
      },
      fail: (error) => {
        session.deleteInFlight = false;
        session.setBusy(false);
        session.showStatus(`删除失败：${(error as Error).message || "未知错误"}`, true);
      }
    }
  );
}

export async function testSessionPlatform(session: ProviderEditorSession): Promise<void> {
  if (session.isActionBusy() || isConfirmDialogOpen()) return;
  const family = PROVIDER_FAMILY_ROWS[session.kind];
  const probeIo = PLATFORM_PROBE_IO[session.kind];
  if (!family.editor.supportsPlatformTest || !probeIo) return;
  const baseUrl = session.draft.baseUrl.trim();
  const model = session.draft.model.trim();
  if (!baseUrl) {
    session.showStatus("请填写 API 地址", true);
    return;
  }
  if (family.editor.modelSource === "input" && !model) {
    session.showStatus("请填写模型名", true);
    return;
  }
  const preset = family.resolvePreset(session.presets, session.draft.presetId);
  const apiKey = session.draft.apiKey.trim();
  const reconfirm = session.resolveKeyReconfirm();
  const requiresKey = family.editor.isKeyRequired(preset);
  if (!apiKey && reconfirm.required) {
    session.showReconfirmStatus();
    return;
  }
  session.testInFlight = true;
  session.setBusy(true);
  session.showStatus("正在测试...");
  const probeParams = {
    id: reconfirm.remoteProviderId,
    presetId: session.draft.presetId,
    name: session.draft.name.trim() || preset?.name || "自定义",
    type: preset?.type || "",
    baseUrl,
    model,
    ...(apiKey ? { apiKey } : {}),
    requiresKey
  };
  const onOk = (resp: { ok?: boolean; message?: string; error?: string }): void => {
    session.testInFlight = false;
    session.setBusy(false);
    if (!resp?.ok) {
      session.showStatus(probeIo.formatFailure(resp?.error), true);
      return;
    }
    session.showStatus(resp.message || "连接成功");
  };
  const onFail = (error: unknown): void => {
    session.testInFlight = false;
    session.setBusy(false);
    session.showStatus(probeIo.formatFailure((error as Error)?.message), true);
  };
  if (probeIo.preflightOrigin) {
    await session.runWithOriginPreflight(
      family.editor.resolvePermissionOrigins(baseUrl, model),
      () => probeIo.probePlatform(probeParams),
      {
        denied: (error) => {
          session.testInFlight = false;
          session.setBusy(false);
          session.showStatus(
            `未测试：${error || "未取得该平台域名权限，无法测试连接"}。请重新授权后重试`,
            true
          );
        },
        ok: onOk,
        fail: onFail
      }
    );
    return;
  }
  await session.runIfCurrent(() => probeIo.probePlatform(probeParams), { ok: onOk, fail: onFail });
}
