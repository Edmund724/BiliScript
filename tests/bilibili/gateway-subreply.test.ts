// bilibili/gateway.ts fetchHotCommentsJson 的楼中楼续篇补抓（F3/F4）。
//
// 背景（2026-09-30 实跑回归）：置顶长目录评论的第二段是它的楼中楼
// （x/v2/reply/reply），旧实现只拉顶层评论（x/v2/reply/main），续篇整段丢失，
// 概览分章因此断尾。口径：只对**正文含时间戳行**的顶层评论补抓楼中楼
// （省请求、精准覆盖续篇）；续篇正文挂进 HotComment.subMessages，只供章节目录
// 解析（hotCommentsText），聊天展示仍只显示顶层 message。
//
// 与 gateway.test.ts 同法：transport 注入，零真实 fetch。

import { describe, expect, it, vi } from "vitest";
import { fetchHotCommentsJson } from "../../extension/bilibili/gateway.js";

function fakeTransport(routes: [match: string, handler: unknown][]) {
  const calls: string[] = [];
  const transport = vi.fn(async (url: string) => {
    calls.push(url);
    const route = routes.find(([match]) => url.includes(match));
    if (!route) {
      throw new Error(`unexpected url: ${url}`);
    }
    const handler = route[1];
    return typeof handler === "function" ? (handler as (u: string) => unknown)(url) : handler;
  });
  return Object.assign(transport, { calls });
}

// 置顶目录评论（正文含时间戳行）+ 一条普通评论（无时间戳）
const pinnedRoot = {
  rpid: 315310607649,
  member: { uname: "硅谷101" },
  like: 520,
  content: { message: "00:00 开场\n05:12 正题\n10:00 深入" }
};
const plainRoot = {
  rpid: 222,
  member: { uname: "观众乙" },
  like: 7,
  content: { message: "讲得真好，没有任何目录" }
};

function mainPayload() {
  return {
    code: 0,
    data: {
      replies: [plainRoot],
      top: null,
      top_replies: [pinnedRoot],
      upper: { top: pinnedRoot }
    }
  };
}

// 楼中楼续篇（置顶评论的子评论，承载 25:00 之后的目录）
function subReplyPayload() {
  return {
    code: 0,
    data: {
      replies: [
        {
          rpid: 9001,
          member: { uname: "硅谷101" },
          like: 10,
          content: { message: "25:00 核心原则\n30:00 尾声" }
        }
      ]
    }
  };
}

const mainMatch = "x/v2/reply/main";
const subMatch = "x/v2/reply/reply";

describe("fetchHotCommentsJson：楼中楼续篇补抓", () => {
  it("正文含时间戳行的顶层评论：补抓其楼中楼，续篇正文挂到 subMessages", async () => {
    const transport = fakeTransport([
      [mainMatch, mainPayload()],
      [subMatch, subReplyPayload()]
    ]);

    const comments = await fetchHotCommentsJson(transport, 123, 20);

    expect(comments[0]).toEqual({
      uname: "硅谷101",
      like: 520,
      message: "00:00 开场\n05:12 正题\n10:00 深入",
      subMessages: ["25:00 核心原则\n30:00 尾声"]
    });
  });

  it("只对含时间戳行的顶层评论发楼中楼请求：普通评论零请求", async () => {
    const transport = fakeTransport([
      [mainMatch, mainPayload()],
      [subMatch, subReplyPayload()]
    ]);

    await fetchHotCommentsJson(transport, 123, 20);

    const subCalls = transport.calls.filter((url) => url.includes(subMatch));
    expect(subCalls).toHaveLength(1);
    expect(subCalls[0]).toContain("root=315310607649");
    expect(subCalls[0]).toContain("oid=123");
    expect(subCalls[0]).toContain("type=1");
  });

  it("无时间戳行的评论区：一个楼中楼请求都不发", async () => {
    const transport = fakeTransport([
      [
        mainMatch,
        { code: 0, data: { replies: [plainRoot], top: null, top_replies: [], upper: { top: null } } }
      ],
      [subMatch, subReplyPayload()]
    ]);

    const comments = await fetchHotCommentsJson(transport, 123, 20);

    expect(transport.calls.filter((url) => url.includes(subMatch))).toHaveLength(0);
    expect(comments[0].subMessages).toBeUndefined();
  });

  it("楼中楼拉取失败：顶层评论照常返回，只是没有续篇（不抛错）", async () => {
    const transport = fakeTransport([
      [mainMatch, mainPayload()],
      [
        subMatch,
        () => {
          throw new Error("接口挂了");
        }
      ]
    ]);

    const comments = await fetchHotCommentsJson(transport, 123, 20);

    expect(comments[0]).toEqual({
      uname: "硅谷101",
      like: 520,
      message: "00:00 开场\n05:12 正题\n10:00 深入"
    });
    expect(comments).toHaveLength(2);
  });

  it("多条楼中楼：全部续篇正文按序收进 subMessages", async () => {
    const transport = fakeTransport([
      [mainMatch, mainPayload()],
      [
        subMatch,
        {
          code: 0,
          data: {
            replies: [
              { rpid: 9001, member: { uname: "硅谷101" }, like: 10, content: { message: "25:00 核心原则" } },
              { rpid: 9002, member: { uname: "硅谷101" }, like: 4, content: { message: "30:00 尾声" } }
            ]
          }
        }
      ]
    ]);

    const comments = await fetchHotCommentsJson(transport, 123, 20);

    expect(comments[0].subMessages).toEqual(["25:00 核心原则", "30:00 尾声"]);
  });
});
