import { describe, it, expect } from "vitest";
import { resolvePageContext } from "../../extension/reader/page-context.js";

interface MetaOverrides {
  aid?: string;
  defaultCid?: string;
  defaultDuration?: number;
  pages?: Array<{ cid: string; page: number; part: string; duration: number }>;
}

function buildMeta(overrides: MetaOverrides = {}) {
  return {
    aid: "170001",
    defaultCid: "101",
    defaultDuration: 300,
    pages: [
      { cid: "101", page: 1, part: "第一P", duration: 300 },
      { cid: "102", page: 2, part: "第二P", duration: 400 },
      { cid: "103", page: 3, part: "第三P", duration: 500 }
    ],
    ...overrides
  };
}

function stubVideoCtx(src: string) {
  const video = { currentSrc: src || "", src: src || "" };
  return { getVideo: () => video as unknown as HTMLVideoElement };
}

describe("resolvePageContext 多 P 解析", () => {
  it("URL 带 ?p= 显式页码：直接采用该分P，不依赖 oid/DOM", () => {
    const url = "https://www.bilibili.com/video/BV1xx411c7mD/?p=2";
    const result = resolvePageContext(url, buildMeta());
    expect(result).toEqual({
      pageIndex: 2,
      cid: "102",
      cidSource: "meta-pages",
      duration: 400,
      pageTitle: "第二P"
    });
  });

  it("单分P：无 ?p= 时回退到 P1，cid 取 meta.defaultCid", () => {
    const url = "https://www.bilibili.com/video/BV1xx411c7mD/";
    const meta = buildMeta({ pages: [{ cid: "101", page: 1, part: "唯一P", duration: 120 }] });
    const result = resolvePageContext(url, meta);
    expect(result).toEqual({
      pageIndex: 1,
      cid: "101",
      cidSource: "meta-pages",
      duration: 120,
      pageTitle: "唯一P"
    });
  });

  it("多分P 且无 ?p=：oid 命中 cid 时解析到对应分P", () => {
    const url = "https://www.bilibili.com/video/BV1xx411c7mD/?oid=103";
    const result = resolvePageContext(url, buildMeta());
    expect(result.pageIndex).toBe(3);
    expect(result.cid).toBe("103");
    expect(result.pageTitle).toBe("第三P");
  });

  it("多分P 且无 ?p= / oid 无意义：回退到 P1", () => {
    const url = "https://www.bilibili.com/video/BV1xx411c7mD/";
    const result = resolvePageContext(url, buildMeta(), { getVideo: () => null });
    expect(result.pageIndex).toBe(1);
    expect(result.cid).toBe("101");
    expect(result.pageTitle).toBe("第一P");
  });
});

describe("watchlater 页面状态路径（oid 为 aid）", () => {
  it("oid === aid 且页面状态 player.page 存在：解析到该分P", () => {
    const url = "https://www.bilibili.com/list/watchlater?bvid=BV1xx411c7mD&oid=170001";
    const options = {
      ctx: {
        __INITIAL_STATE__: { player: { page: 2 } }
      },
      getVideo: () => null
    };
    const result = resolvePageContext(url, buildMeta(), options);
    expect(result.pageIndex).toBe(2);
    expect(result.cid).toBe("102");
    expect(result.pageTitle).toBe("第二P");
  });

  it("oid === aid 且页面状态 videoData.cid 命中：解析到对应分P", () => {
    const url = "https://www.bilibili.com/list/watchlater?bvid=BV1xx411c7mD&oid=170001";
    const options = {
      ctx: {
        __INITIAL_STATE__: { videoData: { cid: "103" } }
      },
      getVideo: () => null
    };
    const result = resolvePageContext(url, buildMeta(), options);
    expect(result.pageIndex).toBe(3);
    expect(result.cid).toBe("103");
  });

  it("oid === aid 且页面状态为空：回退到 defaultCid 对应的分P", () => {
    const url = "https://www.bilibili.com/list/watchlater?bvid=BV1xx411c7mD&oid=170001";
    const options = {
      ctx: { __INITIAL_STATE__: {} },
      getVideo: () => null
    };
    const meta = buildMeta({ defaultCid: "102" });
    const result = resolvePageContext(url, meta, options);
    expect(result.pageIndex).toBe(2);
    expect(result.cid).toBe("102");
  });
});

describe("player DOM 推断路径", () => {
  const WATCHLATER_URL = "https://www.bilibili.com/list/watchlater?bvid=BV1xx411c7mD&oid=170001";

  it("video currentSrc 的 cid 命中分P", () => {
    const options = {
      ...stubVideoCtx("https://upos-sz-mirror08.bilivideo.com/upgcx/code/av1/...?cid=103&qn=64"),
      ctx: { __INITIAL_STATE__: {} }
    };
    const result = resolvePageContext(WATCHLATER_URL, buildMeta(), options);
    expect(result.pageIndex).toBe(3);
    expect(result.cid).toBe("103");
  });

  it("video currentSrc 带 page 参数", () => {
    const options = {
      ...stubVideoCtx("https://example.com/stream?page=2"),
      ctx: { __INITIAL_STATE__: {} }
    };
    const result = resolvePageContext(WATCHLATER_URL, buildMeta(), options);
    expect(result.pageIndex).toBe(2);
    expect(result.cid).toBe("102");
  });

  it("iframe src 的 page 参数", () => {
    const iframe = { src: "https://player.bilibili.com/player.html?aid=170001&cid=102&page=3" };
    const options = {
      ctx: {
        __INITIAL_STATE__: {},
        document: { querySelector: () => iframe as unknown as Element }
      },
      getVideo: () => null
    };
    const result = resolvePageContext(WATCHLATER_URL, buildMeta(), options);
    expect(result.pageIndex).toBe(3);
    expect(result.cid).toBe("103");
  });

  it("播放器控制栏文本推断（如 第2集）", () => {
    const playerRoot = { textContent: "第2集 第二P" };
    const options = {
      ctx: {
        __INITIAL_STATE__: {},
        document: { querySelector: () => playerRoot as unknown as Element }
      },
      getVideo: () => null
    };
    const result = resolvePageContext(WATCHLATER_URL, buildMeta(), options);
    expect(result.pageIndex).toBe(2);
    expect(result.cid).toBe("102");
  });
});

describe("duration 选取", () => {
  it("命中分P时取该分P的 duration", () => {
    const url = "https://www.bilibili.com/video/BV1xx411c7mD/?p=2";
    const result = resolvePageContext(url, buildMeta());
    expect(result.duration).toBe(400);
  });

  it("分P缺失 duration 时回退到首页 duration", () => {
    const url = "https://www.bilibili.com/video/BV1xx411c7mD/?p=2";
    const meta = buildMeta({
      pages: [
        { cid: "101", page: 1, part: "第一P", duration: 300 },
        { cid: "102", page: 2, part: "第二P", duration: 0 }
      ]
    });
    const result = resolvePageContext(url, meta);
    expect(result.duration).toBe(300);
  });

  it("无有效 duration 时回退到 meta.defaultDuration", () => {
    const url = "https://www.bilibili.com/video/BV1xx411c7mD/";
    const meta = buildMeta({
      defaultDuration: 999,
      pages: [{ cid: "101", page: 1, part: "第一P", duration: 0 }]
    });
    const result = resolvePageContext(url, meta);
    expect(result.duration).toBe(999);
  });
});

describe("非法 URL 与异常收敛边界", () => {
  it("非法 URL 与非法 ctx.href 安全降级，不抛异常", () => {
    const fallbackResult = resolvePageContext("not-a-valid-url", buildMeta(), {
      ctx: { href: "also-invalid-url" },
      getVideo: () => null
    });
    expect(fallbackResult.pageIndex).toBe(1);
    expect(fallbackResult.cid).toBe("101");

    const watchlaterUrl = "https://www.bilibili.com/list/watchlater?bvid=BV1xx411c7mD&oid=170001";
    const stateResult = resolvePageContext(watchlaterUrl, buildMeta(), {
      ctx: { href: "also-invalid-url", __INITIAL_STATE__: { player: { page: 2 } } },
      getVideo: () => null
    });
    expect(stateResult.pageIndex).toBe(2);
    expect(stateResult.cid).toBe("102");
  });

  it("跨域 SecurityError 在各探测边界安全降级", () => {
    const url = "https://www.bilibili.com/list/watchlater?bvid=BV1xx411c7mD&oid=170001";
    const restrictedCtx = {
      get href(): string {
        throw new DOMException("Blocked cross-origin href", "SecurityError");
      },
      get __INITIAL_STATE__(): Record<string, unknown> {
        throw new DOMException("Blocked cross-origin state", "SecurityError");
      },
      get document(): { querySelector: (selector: string) => Element | null } {
        throw new DOMException("Blocked cross-origin document", "SecurityError");
      }
    };
    const result = resolvePageContext(url, buildMeta({ defaultCid: "102" }), {
      ctx: restrictedCtx,
      getVideo: () => {
        throw new DOMException("Blocked cross-origin video", "SecurityError");
      }
    });
    expect(result.pageIndex).toBe(2);
    expect(result.cid).toBe("102");
  });

  it("非 SecurityError 异常（如 TypeError）不会被静默吞掉", () => {
    const url = "https://www.bilibili.com/list/watchlater?bvid=BV1xx411c7mD&oid=170001";
    expect(() =>
      resolvePageContext(url, buildMeta(), {
        ctx: { __INITIAL_STATE__: {} },
        getVideo: () => {
          throw new TypeError("broken getVideo probe");
        }
      })
    ).toThrow(TypeError);

    expect(() =>
      resolvePageContext(url, buildMeta(), {
        ctx: {
          __INITIAL_STATE__: {},
          document: {
            querySelector: () => {
              throw new TypeError("broken querySelector mock");
            }
          }
        },
        getVideo: () => null
      })
    ).toThrow(TypeError);
  });
});
