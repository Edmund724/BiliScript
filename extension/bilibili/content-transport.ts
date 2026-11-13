import { isExtensionContextInvalidated, toReadableText } from "../shared/error-helpers.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { isBiliUrl } from "./gateway-core.js";

export async function contentFetchJson<T = unknown>(url: string): Promise<T> {
  if (!isBiliUrl(url)) {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error(`请求失败：${response.status}`);
    return response.json() as Promise<T>;
  }

  try {
    const resp = await sendRuntimeMessage({ type: "fetch-json", url });
    if (!resp?.ok) throw new Error(toReadableText(resp?.error, "Background fetch failed"));
    return resp.data as T;
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      throw new Error("扩展刚刚更新，请刷新当前页面后重试。");
    }
    throw error;
  }
}
