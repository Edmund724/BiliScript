// bilibili/bili-api-shared.ts 直测：热评 payload 挑/合并（纯函数，零 transport）。
//
// 背景（2026-09-29 匿名实跑 x/v2/reply?type=1&oid=117346425377969&sort=2）：
// UP 置顶评论（rpid 315310607649）只出现在 data.top_replies[]（data.upper.top
// 同为该条），data.top 为 null，而 data.replies[] 只有 3 条普通评论。
// 旧实现只读 data.replies[]，置顶的时间轴目录因此永远进不了 hotComments。
//
// 本文件锁定合并语义：四来源合并 → 按 rpid 去重（保留首个，即前置的置顶条）
// → 走既有 normalizeHotComments 归一 + limit 裁剪；字段缺失/类型不对一律容错。
//
// 被测函数纯逻辑，无 DOM/chrome/fetch 依赖，真实模块直接导入即可。

import { describe, expect, it } from "vitest";
import { mergeHotCommentsFromPayload } from "../../extension/bilibili/bili-api-shared.js";

// 置顶评论（UP 硅谷101 的时间轴目录），来自实跑样本
const pinnedReply = {
  rpid: 315310607649,
  member: { uname: "硅谷101" },
  like: 520,
  content: { message: "00:00 开场\n05:12 正题" }
};

const normalReplies = [
  { rpid: 111, member: { uname: "观众甲" }, like: 12, content: { message: "第一条" } },
  { rpid: 222, member: { uname: "观众乙" }, like: 7, content: { message: "第二条" } },
  { rpid: 333, member: { uname: "观众丙" }, like: 3, content: { message: "第三条" } }
];

// main 接口实跑形状：replies 无置顶条，置顶条在 top_replies / upper.top
function mainPayload(data: Record<string, unknown> = {}) {
  return {
    code: 0,
    data: {
      replies: normalReplies,
      top: null,
      top_replies: [pinnedReply],
      upper: { top: pinnedReply },
      ...data
    }
  };
}

describe("mergeHotCommentsFromPayload：置顶评论合并", () => {
  it("置顶条在 top_replies、不在 replies：合并后置于结果首位（实跑回归）", () => {
    const comments = mergeHotCommentsFromPayload(mainPayload());

    expect(comments.map((item) => item.message)).toEqual([
      "00:00 开场\n05:12 正题",
      "第一条",
      "第二条",
      "第三条"
    ]);
    expect(comments[0]).toEqual({ uname: "硅谷101", like: 520, message: "00:00 开场\n05:12 正题" });
  });

  it("data.top 为单条对象（不是数组）：也收，且排在普通评论之前", () => {
    const comments = mergeHotCommentsFromPayload(
      mainPayload({ top: pinnedReply, top_replies: [], upper: { top: null } })
    );

    expect(comments.map((item) => item.message)).toEqual([
      "00:00 开场\n05:12 正题",
      "第一条",
      "第二条",
      "第三条"
    ]);
  });

  it("data.upper.top 为单条对象：也收（不与 replies 混序）", () => {
    const upperPinned = { rpid: 999, member: { uname: "UP主" }, like: 1, content: { message: "UP 置顶" } };
    const comments = mergeHotCommentsFromPayload(
      mainPayload({ top: null, top_replies: [], upper: { top: upperPinned } })
    );

    expect(comments.map((item) => item.message)).toEqual(["UP 置顶", "第一条", "第二条", "第三条"]);
  });

  it("replies 与 top_replies 含同 rpid：只留一条（置顶来源前置，保留置顶那份）", () => {
    const repliesCopy = { ...pinnedReply, like: 1, content: { message: "replies 里的同一置顶条" } };
    const comments = mergeHotCommentsFromPayload(
      mainPayload({ top: null, top_replies: [pinnedReply], replies: [...normalReplies, repliesCopy] })
    );

    expect(comments).toHaveLength(4);
    expect(comments[0]).toEqual({ uname: "硅谷101", like: 520, message: "00:00 开场\n05:12 正题" });
    expect(comments.filter((item) => item.message === "replies 里的同一置顶条")).toEqual([]);
  });

  it("top 与 upper.top 同 rpid：只留一条", () => {
    const comments = mergeHotCommentsFromPayload(
      mainPayload({ top: pinnedReply, top_replies: [], upper: { top: pinnedReply } })
    );

    expect(comments).toHaveLength(4);
    expect(comments.filter((item) => item.message === "00:00 开场\n05:12 正题")).toHaveLength(1);
  });

  it("超 limit：按既有 normalizeHotComments 规则裁剪，置顶条保留在首位", () => {
    const comments = mergeHotCommentsFromPayload(mainPayload(), 2);

    expect(comments.map((item) => item.message)).toEqual(["00:00 开场\n05:12 正题", "第一条"]);
  });

  it("字段缺失/类型不对：不抛错，返回空列表", () => {
    expect(mergeHotCommentsFromPayload(null)).toEqual([]);
    expect(mergeHotCommentsFromPayload(undefined)).toEqual([]);
    expect(mergeHotCommentsFromPayload({})).toEqual([]);
    expect(mergeHotCommentsFromPayload({ data: null })).toEqual([]);
    expect(mergeHotCommentsFromPayload({ data: "oops" })).toEqual([]);
    expect(mergeHotCommentsFromPayload({ data: { replies: "oops", top_replies: 42, top: "x", upper: 5 } })).toEqual([]);
    expect(mergeHotCommentsFromPayload({ data: { replies: [] } })).toEqual([]);
    // top / upper.top 为数组或空对象时不产出条目
    expect(mergeHotCommentsFromPayload({ data: { top: [], upper: { top: [] } } })).toEqual([]);
  });

  it("数组里混入 null/非对象/无 message 项：跳过，不产生空条目", () => {
    const comments = mergeHotCommentsFromPayload({
      data: {
        top_replies: [null, "oops", 7, {}, { rpid: 1, member: {}, content: {} }],
        replies: [{ rpid: 2, member: { uname: "有效用户" }, like: "9", content: { message: "  有效评论  " } }]
      }
    });

    expect(comments).toEqual([{ uname: "有效用户", like: 9, message: "有效评论" }]);
  });
});
