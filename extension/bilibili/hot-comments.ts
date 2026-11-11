import { getErrorMessage } from "../shared/error-helpers.js";
import {
  buildHotCommentsApiError,
  mergeHotCommentsFromPayload,
  subReplyMessages,
  subReplyRootIds,
  type HotComment,
  type SubReplyInput
} from "./bili-api-shared.js";
import type { JsonTransport } from "./gateway-core.js";

const MAX_SUB_REPLY_ROOTS = 5;
const SUB_REPLY_PAGE_SIZE = 20;

async function fetchSubReplyInputs(
  transport: JsonTransport,
  aid: number,
  payload: unknown
): Promise<SubReplyInput[]> {
  const roots = subReplyRootIds(payload).slice(0, MAX_SUB_REPLY_ROOTS);
  return Promise.all(
    roots.map(async (root) => {
      const url =
        `https://api.bilibili.com/x/v2/reply/reply` +
        `?oid=${aid}&type=1&root=${encodeURIComponent(String(root))}` +
        `&ps=${SUB_REPLY_PAGE_SIZE}&pn=1`;
      const subPayload = await transport(url).catch(() => null);
      return { root, messages: subReplyMessages(subPayload) };
    })
  );
}

export async function fetchHotCommentsJson(
  transport: JsonTransport,
  aid: number | string,
  count = 18
): Promise<HotComment[]> {
  const safeAid = Number(aid || 0) || 0;
  const safeCount = Math.max(0, Number(count) || 0);
  if (!safeAid || !safeCount) {
    return [];
  }

  const url = `https://api.bilibili.com/x/v2/reply/main?type=1&oid=${safeAid}&mode=3&ps=${safeCount}&pn=1`;
  const payload = await transport(url).catch((error: unknown) => {
    throw new Error(`热评请求失败：${getErrorMessage(error)}`);
  });
  const apiError = buildHotCommentsApiError(payload);
  if (apiError) {
    throw apiError;
  }
  const subReplies = await fetchSubReplyInputs(transport, safeAid, payload);
  return mergeHotCommentsFromPayload(payload, safeCount, subReplies);
}
