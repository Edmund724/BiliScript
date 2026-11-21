import { describe, expect, it } from "vitest";
import { mergeHotCommentsFromPayload } from "../../extension/bilibili/bili-api-shared.js";
import { hotCommentsText, parseChapterOutline } from "../../extension/shared/chapter-outline.js";

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

describe("热评全文通道：不截断", () => {
  const head = Array.from({ length: 9 }, (_, i) => `0${i}:00 小节${i}：${"甲".repeat(43)}`).join("\n");
  const longMessage = `${head}\n25:00 核心原则：智能体设计的五个层次\n30:00 尾声`;

  function longPinnedPayload() {
    return {
      data: {
        replies: [],
        top: null,
        top_replies: [{ rpid: 1, member: { uname: "硅谷101" }, like: 520, content: { message: longMessage } }],
        upper: { top: null }
      }
    };
  }

  it("超 500 字符的置顶目录评论：全文保留，不截断", () => {
    const comments = mergeHotCommentsFromPayload(longPinnedPayload());

    expect(longMessage.length).toBeGreaterThan(500);
    expect(comments[0].message).toBe(longMessage);
  });

  it("目录解析拿到全文：500 字符之后的章节行（25:00/30:00）全部识别", () => {
    const comments = mergeHotCommentsFromPayload(longPinnedPayload());
    const chapters = parseChapterOutline(hotCommentsText(comments));

    expect(chapters).toHaveLength(11);
    expect(chapters[9]).toEqual({ seconds: 25 * 60, title: "核心原则：智能体设计的五个层次" });
    expect(chapters[10]).toEqual({ seconds: 30 * 60, title: "尾声" });
  });
});
