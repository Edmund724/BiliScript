import { sendRuntimeMessage } from "../shared/messaging.js";
import type { CheckProviderOriginMessage, CheckProviderOriginResponse } from "../shared/messaging-protocol.js";

export const HOST_PERMISSION_HINT = "该平台域名未授权，请在保存时允许权限";
export const HOST_INVALID_ORIGIN_HINT = "请求地址不合法，请检查平台 baseUrl 配置";

export type HostPermissionStatus = "granted" | "denied" | "invalid-origin";
export type HostPermissionResult =
  | { granted: true; status: "granted" }
  | { granted: false; status: "denied" | "invalid-origin" };

export const PERMISSION_GRANT_PAGE_PATH = "entry/permission-grant.html" as const;
export const PERMISSION_GRANT_KEEPALIVE_PORT_NAME = "permission-grant-keepalive" as const;

export interface PermissionGrantParams {
  reqId: string;
  origins: string[];
}

export function formatPermissionRequestError(error: unknown): string {
  return `申请域名权限失败：${(error as Error | undefined)?.message || error}`;
}

export function buildPermissionGrantQuery(reqId: string, origins: readonly string[]): string {
  return new URLSearchParams({
    reqId,
    origins: JSON.stringify(origins)
  }).toString();
}

export function parsePermissionGrantParams(search: string): PermissionGrantParams {
  const params = new URLSearchParams(search);
  const reqId = (params.get("reqId") || "").trim();
  const rawOrigins = params.get("origins");
  if (!rawOrigins) {
    return { reqId, origins: [] };
  }
  try {
    const parsed: unknown = JSON.parse(rawOrigins);
    return { reqId, origins: collectPermissionMatchPatterns(parsed) };
  } catch {
    return { reqId, origins: [] };
  }
}

export function extractOriginFromBaseUrl(baseUrl: unknown): string | null {
  const text = String(baseUrl || "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "ws:" && url.protocol !== "wss:") {
      return null;
    }
    return `${url.origin}/*`;
  } catch {
    return null;
  }
}

export function toPermissionMatchPattern(input: unknown): string | null {
  const text = String(input || "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "ws:" && url.protocol !== "wss:") ||
      !url.hostname
    ) {
      return null;
    }
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return null;
  }
}

export function collectPermissionMatchPatterns(baseUrls: unknown): string[] {
  const patterns: string[] = [];
  for (const baseUrl of Array.isArray(baseUrls) ? baseUrls : []) {
    const pattern = toPermissionMatchPattern(baseUrl);
    if (pattern && !patterns.includes(pattern)) {
      patterns.push(pattern);
    }
  }
  return patterns;
}

export const permissionDeniedErrorMessage = (origins: string[]): string =>
  `未授权 ${origins.join("、")}，操作已中止：请在权限弹窗中选择允许后重试`;

interface RequestResult {
  ok: boolean;
  origins: string[];
  error?: string;
}

export async function requestProviderOrigins(
  baseUrls: unknown,
  requestPermissions: typeof chrome.permissions.request | undefined = globalThis.chrome?.permissions?.request
): Promise<RequestResult> {
  const origins = collectPermissionMatchPatterns(baseUrls);
  if (origins.length === 0) {
    return { ok: true, origins };
  }
  if (typeof requestPermissions !== "function") {
    return { ok: false, error: "当前环境不支持申请权限", origins };
  }
  let granted = false;
  try {
    granted = await requestPermissions({ origins });
  } catch (error) {
    return { ok: false, error: formatPermissionRequestError(error), origins };
  }
  if (!granted) {
    return {
      ok: false,
      error: permissionDeniedErrorMessage(origins),
      origins
    };
  }
  return { ok: true, origins };
}

export interface ProviderOriginsProxyResult {
  ok: boolean;
  error?: string;
}

export async function requestProviderOriginsViaBackground(baseUrls: string[]): Promise<ProviderOriginsProxyResult> {
  if (typeof globalThis.chrome?.permissions?.request === "function") {
    const result = await requestProviderOrigins(baseUrls);
    return { ok: result.ok, error: result.error };
  }
  const resp = await sendRuntimeMessage({ type: "request-provider-origins", baseUrls });
  return { ok: Boolean(resp?.ok), error: resp?.error };
}

export async function checkHostPermission(
  target: unknown,
  contains: typeof chrome.permissions.contains | undefined = globalThis.chrome?.permissions?.contains
): Promise<HostPermissionResult> {
  const origin = toPermissionMatchPattern(target);
  if (!origin) {
    return { granted: false, status: "invalid-origin" };
  }
  if (typeof contains !== "function") {
    return { granted: true, status: "granted" };
  }
  try {
    return (await contains({ origins: [origin] }))
      ? { granted: true, status: "granted" }
      : { granted: false, status: "denied" };
  } catch {
    return { granted: true, status: "granted" };
  }
}

export async function hasHostPermission(
  target: unknown,
  contains: typeof chrome.permissions.contains | undefined = globalThis.chrome?.permissions?.contains
): Promise<boolean> {
  return (await checkHostPermission(target, contains)).granted;
}

type CheckProviderOriginSender = (
  message: CheckProviderOriginMessage
) => Promise<Partial<CheckProviderOriginResponse> | null | undefined>;

async function checkProviderOriginViaSW(target: unknown, send: CheckProviderOriginSender): Promise<HostPermissionResult> {
  const origin = toPermissionMatchPattern(target);
  if (!origin) {
    return { granted: false, status: "invalid-origin" };
  }
  try {
    const resp = await send({ type: "check-provider-origin", origin });
    if (resp?.granted === false) {
      return {
        granted: false,
        status: resp.status === "invalid-origin" ? "invalid-origin" : "denied"
      };
    }
    return { granted: true, status: "granted" };
  } catch {
    return { granted: true, status: "granted" };
  }
}

export async function checkHostPermissionViaBackground(target: unknown): Promise<HostPermissionResult> {
  if (!toPermissionMatchPattern(target)) {
    return { granted: false, status: "invalid-origin" };
  }
  if (typeof globalThis.chrome?.permissions?.contains === "function") {
    return checkHostPermission(target);
  }
  if (typeof globalThis.chrome?.runtime?.sendMessage !== "function") {
    return { granted: true, status: "granted" };
  }
  return checkProviderOriginViaSW(target, sendRuntimeMessage);
}

export async function hasHostPermissionViaBackground(target: unknown): Promise<boolean> {
  return (await checkHostPermissionViaBackground(target)).granted;
}

export async function checkHostPermissionFromOffscreen(target: unknown): Promise<HostPermissionResult> {
  return checkProviderOriginViaSW(
    target,
    async (message) => (await chrome.runtime.sendMessage(message)) as Partial<CheckProviderOriginResponse> | null | undefined
  );
}

export async function hasHostPermissionFromOffscreen(target: unknown): Promise<boolean> {
  return (await checkHostPermissionFromOffscreen(target)).granted;
}

interface ProviderLike {
  id?: string | number;
  baseUrl?: unknown;
}

interface RevokeResult {
  origins: string[];
  revoked: boolean;
}

interface RevokeDependencies {
  contains?: typeof chrome.permissions.contains;
  remove?: typeof chrome.permissions.remove;
  staticHostPermissions?: readonly string[];
}

function readManifestHostPermissions(): readonly string[] {
  try {
    const manifest = globalThis.chrome?.runtime?.getManifest?.() as { host_permissions?: unknown } | undefined;
    return Array.isArray(manifest?.host_permissions)
      ? manifest.host_permissions.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function isStaticHostPermission(
  pattern: string,
  staticHostPermissions: readonly string[] = readManifestHostPermissions()
): boolean {
  const normalizedTarget = toPermissionMatchPattern(pattern);
  if (!normalizedTarget) {
    return false;
  }
  return staticHostPermissions.some((entry) => {
    const trimmed = String(entry || "").trim();
    if (!trimmed) return false;
    return trimmed === normalizedTarget || toPermissionMatchPattern(trimmed) === normalizedTarget;
  });
}

export async function revokeOriginPermission(
  origin: unknown,
  {
    contains = globalThis.chrome?.permissions?.contains,
    remove = globalThis.chrome?.permissions?.remove,
    staticHostPermissions = readManifestHostPermissions()
  }: RevokeDependencies = {}
): Promise<RevokeResult> {
  const pattern = toPermissionMatchPattern(origin);
  if (!pattern || isStaticHostPermission(pattern, staticHostPermissions)) {
    return { origins: [], revoked: false };
  }
  const origins = [pattern];
  if (typeof contains === "function") {
    try {
      if (!(await contains({ origins }))) {
        return { origins: [], revoked: false };
      }
    } catch {}
  }
  if (typeof remove !== "function") {
    return { origins, revoked: false };
  }
  try {
    return { origins, revoked: Boolean(await remove({ origins })) };
  } catch {
    return { origins, revoked: false };
  }
}

function resolveOrphanPattern(deleted: ProviderLike, providers: unknown): string | null {
  const deletedId = String(deleted?.id || "");
  const survivors = (Array.isArray(providers) ? providers : []).filter(
    (provider) => String((provider as ProviderLike)?.id || "") !== deletedId
  );
  const pattern = toPermissionMatchPattern(deleted?.baseUrl);
  if (!pattern) {
    return null;
  }
  const stillUsed = survivors.some(
    (provider) => toPermissionMatchPattern((provider as ProviderLike)?.baseUrl) === pattern
  );
  return stillUsed ? null : pattern;
}

export async function revokeOrphanOriginViaBackground(
  deleted: ProviderLike,
  providers: unknown
): Promise<RevokeResult> {
  const pattern = resolveOrphanPattern(deleted, providers);
  if (!pattern || isStaticHostPermission(pattern)) {
    return { origins: [], revoked: false };
  }
  if (typeof globalThis.chrome?.permissions?.remove === "function") {
    return revokeOriginPermission(pattern);
  }
  if (typeof globalThis.chrome?.runtime?.sendMessage !== "function") {
    return { origins: [pattern], revoked: false };
  }
  try {
    const resp = await sendRuntimeMessage({ type: "revoke-provider-origin", origin: pattern });
    if (resp && Array.isArray(resp.origins)) {
      return { origins: resp.origins, revoked: Boolean(resp.revoked) };
    }
    return { origins: [pattern], revoked: false };
  } catch {
    return { origins: [pattern], revoked: false };
  }
}

export const permissionRevokeErrorMessage = (origins: string[]): string =>
  `已删除平台，但回收域名权限失败（${origins.join("、")}），不影响使用，可到浏览器扩展权限设置手动移除`;
