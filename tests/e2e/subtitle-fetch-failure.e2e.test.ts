import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installChromeHost } from "../helpers/chrome-host.js";

const BILI_FIXTURE_DIR = join(process.cwd(), "tests", "fixtures", "bilibili");
const ARTIFACT_DIR = join(process.cwd(), ".scratch", "tickets", "test-suite-trim", "artifacts");

const FIXTURE = {
  risk352: JSON.parse(
    readFileSync(join(BILI_FIXTURE_DIR, "bilibili-reply-main-risk-control-352.json"), "utf8")
  ),
  playerEmpty: JSON.parse(
    readFileSync(join(BILI_FIXTURE_DIR, "bilibili-player-v2-anonymous.json"), "utf8")
  ),
  primary400: JSON.parse(
    readFileSync(join(BILI_FIXTURE_DIR, "bilibili-player-wbi-v2-bad-params-400.json"), "utf8")
  ),
  secondary400: JSON.parse(
    readFileSync(join(BILI_FIXTURE_DIR, "bilibili-player-v2-bad-params-400.json"), "utf8")
  ),
  cdn403: JSON.parse(readFileSync(join(BILI_FIXTURE_DIR, "aisubtitle-hdslb-403.json"), "utf8"))
} as const;

const BVID = "BV1q9He6SEyX";
const AID = 117376775358202;
const CID = "42428139464";

let gateway: typeof import("../../extension/bilibili/gateway.js");
let subtitleCore: typeof import("../../extension/subtitle/core.js");
let core: typeof import("../../extension/core/state.js");

function fixtureTransport(routes: Array<[url: string, payload: unknown]>) {
  const calls: string[] = [];
  const transport = vi.fn(async (url: string) => {
    calls.push(url);
    const route = routes.find(([expected]) => expected === url);
    if (!route) throw new Error(`unexpected url: ${url}`);
    return route[1];
  });
  return { transport, calls };
}

function stubChrome(routeFetchJson: (url: string) => unknown) {
  const sentUrls: string[] = [];
  installChromeHost({
    runtime: {
      sendMessage: vi.fn((message: { type?: string; url?: string }, callback?: (resp: unknown) => void) => {
        if (message?.type === "fetch-json" && typeof message.url === "string") {
          sentUrls.push(message.url);
          callback?.({ ok: true, data: routeFetchJson(message.url) });
          return undefined;
        }
        callback?.({ ok: true });
        return undefined;
      })
    }
  });
  return { sentUrls };
}

beforeEach(async () => {
  resetModuleState();
  gateway = await import("../../extension/bilibili/gateway.js");
  subtitleCore = await import("../../extension/subtitle/core.js");
  core = await import("../../extension/core/state.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("① 风控 -352（真 x/v2/reply/main 报文）→ 出声，不静默折成空数组", () => {
  it("fetchHotCommentsJson：真 -352 报文换成用户看得懂的病因（code/retryable 保留）", async () => {
    const { transport, calls } = fixtureTransport([[FIXTURE.risk352._provenance.source, FIXTURE.risk352]]);

    let caught: (Error & { code?: number; retryable?: boolean }) | null = null;
    try {
      await gateway.fetchHotCommentsJson(transport, AID, 20);
    } catch (error) {
      caught = error as Error & { code?: number; retryable?: boolean };
    }

    expect(FIXTURE.risk352).toMatchObject({ code: -352, message: "-352", ttl: 1 });
    expect(caught?.message).toBe("B 站风控校验失败（-352），拿不到热评目录");
    expect(caught?.code).toBe(-352);
    expect(caught?.retryable).toBe(true);
    expect(calls).toEqual([FIXTURE.risk352._provenance.source]);
  });

  it("refreshHotComments：真 -352 经真 fetch-json 跳板落到 clip 失败字段（热评清空 + 病因文案）", async () => {
    const stub = stubChrome((url) => {
      if (url === FIXTURE.risk352._provenance.source) return FIXTURE.risk352;
      throw new Error(`unexpected fetch-json url: ${url}`);
    });
    core.clipState.setAid(String(AID));
    core.clipState.setHotComments([]);
    core.clipState.setHotCommentsNotice("");

    await subtitleCore.refreshHotComments();

    expect(stub.sentUrls).toEqual([FIXTURE.risk352._provenance.source]);
    expect(core.clipState.hotComments).toEqual([]);
    expect(core.clipState.hotCommentsNotice).toBe(
      "热评没拿到（B 站风控校验失败（-352），拿不到热评目录 (code: -352)）：本次概览没有评论目录。"
    );
  });
});

describe("② 匿名真响应（code 0 + 空字幕轨）→ 轨空、章节照收，且不编造原因", () => {
  it("fetchSubtitleBundle：真 player/v2 报文 → tracks 空 + 10 条真 view_points 章节", async () => {
    const raw = FIXTURE.playerEmpty;
    expect(raw.code).toBe(0);
    expect(raw.data.subtitle.subtitles).toEqual([]);
    expect(raw.data.login_mid).toBe(0);
    expect(raw.data.need_login_subtitle).toBe(false);
    expect(raw.data.view_points).toHaveLength(10);

    const { transport, calls } = fixtureTransport([[raw._provenance.source, raw]]);
    const bundle = await gateway.fetchSubtitleBundle(transport, { bvid: BVID, cid: CID });

    expect(calls).toEqual([raw._provenance.source]);
    expect(bundle.tracks).toEqual([]);
    expect(bundle.chapters).toEqual([
      { title: "暖场与名字来历", from: 0, to: 65, source: "player-view-points" },
      { title: "信任阶梯", from: 65, to: 738, source: "player-view-points" },
      { title: "米其林厨房比喻", from: 738, to: 1034, source: "player-view-points" },
      { title: "验证与CLI", from: 1034, to: 1568, source: "player-view-points" },
      { title: "Dune框架约束", from: 1568, to: 2048, source: "player-view-points" },
      { title: "2500个PR机制", from: 2048, to: 2520, source: "player-view-points" },
      { title: "内外双循环", from: 2520, to: 3023, source: "player-view-points" },
      { title: "review抽样", from: 3023, to: 3176, source: "player-view-points" },
      { title: "agent自合并PR", from: 3176, to: 3641, source: "player-view-points" },
      { title: "skills互补", from: 3641, to: 4005, source: "player-view-points" }
    ]);
    expect(Object.keys(bundle.tracks)).toHaveLength(0);
  });
});

describe("③ 字幕 CDN 403（真 Tengine 报文）→ 传输叶只报状态码，不泄漏 HTML", () => {
  it("bgFetchJson：真 403 → 抛 HTTP 403，且真请求构造（B 站头 + referrer）逐项核对", async () => {
    const cdn = FIXTURE.cdn403;
    const url = cdn._provenance.source;
    expect(cdn).toMatchObject({ status: 403, contentType: "text/html" });
    expect(cdn.body).toContain("<h1>403 Forbidden</h1>");
    expect(cdn.body).toContain("Powered by Tengine");
    expect(() => JSON.parse(cdn.body)).toThrow();

    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (requestUrl: string, init: RequestInit) => {
        calls.push({ url: requestUrl, init });
        return { ok: false, status: cdn.status, json: async () => JSON.parse(cdn.body) };
      })
    );

    expect(gateway.isBiliUrl(url)).toBe(true);

    let caught: Error | null = null;
    try {
      await gateway.bgFetchJson(url);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toBe("HTTP 403");
    expect(caught?.message).not.toContain("Tengine");
    expect(caught?.message).not.toContain("<h1>");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(url);
    expect(calls[0].init).toMatchObject({
      method: "GET",
      credentials: "include",
      cache: "no-store",
      referrer: "https://www.bilibili.com/",
      referrerPolicy: "strict-origin-when-cross-origin"
    });
  });
});

describe("④ 字幕列表两条来源都失败（真 -400 报文，URL 逐字一致）", () => {
  it("主来源失败才试次来源；两条都失败时抛出次来源的归因（-400 → 请求错误）", async () => {
    const { transport, calls } = fixtureTransport([
      [FIXTURE.primary400._provenance.source, FIXTURE.primary400],
      [FIXTURE.secondary400._provenance.source, FIXTURE.secondary400]
    ]);

    let caught: (Error & { code?: number; retryable?: boolean }) | null = null;
    try {
      await gateway.fetchSubtitleBundle(transport, { bvid: BVID, cid: "0", aid: AID });
    } catch (error) {
      caught = error as Error & { code?: number; retryable?: boolean };
    }

    expect(calls).toEqual([
      "https://api.bilibili.com/x/player/wbi/v2?aid=117376775358202&cid=0&bvid=BV1q9He6SEyX",
      "https://api.bilibili.com/x/player/v2?bvid=BV1q9He6SEyX&cid=0&aid=117376775358202"
    ]);
    expect(FIXTURE.primary400._provenance.source).toBe(calls[0]);
    expect(FIXTURE.secondary400._provenance.source).toBe(calls[1]);

    expect(FIXTURE.primary400).toMatchObject({ code: -400, message: "请求错误", ttl: 1 });
    expect(caught?.message).toBe("请求错误");
    expect(caught?.code).toBe(-400);
    expect(caught?.retryable).toBe(true);
    expect(`抓取失败：${getErrorMessageLike(caught)}`).toBe("抓取失败：请求错误 (code: -400)");
  });
});

function getErrorMessageLike(error: (Error & { code?: unknown }) | null): string {
  const message = String(error?.message || "");
  const code = error?.code === undefined || error?.code === null ? "" : String(error.code);
  return message ? (code ? `${message} (code: ${code})` : message) : code ? `code: ${code}` : "";
}

describe("⑤ 走查工件（重跑逐字节一致，末尾与真实报文对账）", () => {
  it("写出 02-subtitle-failure-walkthrough.md 并与真报文出处对账", async () => {
    const risk = FIXTURE.risk352;
    const empty = FIXTURE.playerEmpty;
    const cdn = FIXTURE.cdn403;

    const riskCalls = fixtureTransport([[risk._provenance.source, risk]]);
    let riskMessage = "";
    try {
      await gateway.fetchHotCommentsJson(riskCalls.transport, AID, 20);
    } catch (error) {
      riskMessage = (error as Error).message;
    }

    const emptyCalls = fixtureTransport([[empty._provenance.source, empty]]);
    const emptyBundle = await gateway.fetchSubtitleBundle(emptyCalls.transport, { bvid: BVID, cid: CID });

    const four = fixtureTransport([
      [FIXTURE.primary400._provenance.source, FIXTURE.primary400],
      [FIXTURE.secondary400._provenance.source, FIXTURE.secondary400]
    ]);
    let fourMessage = "";
    try {
      await gateway.fetchSubtitleBundle(four.transport, { bvid: BVID, cid: "0", aid: AID });
    } catch (error) {
      fourMessage = (error as Error).message;
    }

    mkdirSync(ARTIFACT_DIR, { recursive: true });
    const artifactPath = join(ARTIFACT_DIR, "02-subtitle-failure-walkthrough.md");
    writeFileSync(
      artifactPath,
      [
        "# 字幕抓取失败走查工件（由 tests/e2e/subtitle-fetch-failure.e2e.test.ts 生成）",
        "",
        "## 真报文清单（tests/fixtures/bilibili/，出处见各自 _provenance）",
        "",
        "| fixture | 出处（逐字 URL） | HTTP | Content-Type | 字节 | 真实归因 |",
        "|---|---|---|---|---|---|",
        `| bilibili-reply-main-risk-control-352.json | ${risk._provenance.source} | ${risk._provenance.httpStatus} | ${risk._provenance.contentType} | ${risk._provenance.byteLength} | ${riskMessage} |`,
        `| bilibili-player-v2-anonymous.json | ${empty._provenance.source} | ${empty._provenance.httpStatus} | ${empty._provenance.contentType} | ${empty._provenance.rawByteLength}（裁剪前） | tracks=0（无归因信号可映射） |`,
        `| bilibili-player-wbi-v2-bad-params-400.json | ${FIXTURE.primary400._provenance.source} | ${FIXTURE.primary400._provenance.httpStatus} | ${FIXTURE.primary400._provenance.contentType} | ${FIXTURE.primary400._provenance.byteLength} | ${fourMessage}（主来源失败） |`,
        `| bilibili-player-v2-bad-params-400.json | ${FIXTURE.secondary400._provenance.source} | ${FIXTURE.secondary400._provenance.httpStatus} | ${FIXTURE.secondary400._provenance.contentType} | ${FIXTURE.secondary400._provenance.byteLength} | ${fourMessage}（两条都失败时抛出次来源归因） |`,
        `| aisubtitle-hdslb-403.json | ${cdn._provenance.source} | ${cdn.status} | ${cdn.contentType} | ${cdn.byteLength} | HTTP 403（HTML 正文不进文案） |`,
        "",
        "## 链路与归因",
        `- 热评风控：真 \`{"code":-352,"message":"-352","ttl":1}\` → 真 fetchHotCommentsJson → \`${riskMessage}\` → 真 refreshHotComments 落 clip 失败字段 \`热评没拿到（${riskMessage} (code: ${risk.code})）：本次概览没有评论目录。\`（getErrorMessage 组装，可读病因后仍跟一段码；06 号票起由概览 tab 状态条呈现，不写全局状态行）`,
        `- 空字幕轨：真 code 0 / subtitles=[] / login_mid=${empty.data.login_mid} / need_login_subtitle=${empty.data.need_login_subtitle} → tracks=0、章节 ${emptyBundle.chapters.length} 条（${emptyBundle.chapters[0].title} … ${emptyBundle.chapters[emptyBundle.chapters.length - 1].title}）`,
        `- 两条来源都失败：真 -400 报文 → 请求顺序 主来源(wbi) → 次来源(v2)，最终归因 \`${fourMessage}\`（code -400，retryable=true）`,
        `- CDN 403：真 Tengine HTML（${cdn.byteLength} 字节）→ 传输叶抛 \`HTTP 403\`，HTML 不出现在文案里`,
        "",
        "## 没有真实报文、故不测的面",
        "- 带字幕轨的真响应（subtitles 非空）：需带 cookie / 登录；匿名响应恒为空，仓库只有形状转写记录（bv1mAam6tEL8-subtitle-shape.md）",
        "- 字幕接口自身的 -352：本机对 player/v2、player/wbi/v2 多轮实测为 code 0 / -400，-352 只在 x/v2/reply/main 上复现，故风控用例落在合并热评链",
        "",
        "## 结论",
        `- 风控（-352）不再静默折空数组，病因可读且落 clip 失败字段（真报文 + 真跳板），概览 tab 状态条呈现`,
        `- 空轨与风控在同一条链上是两种结局：前者 tracks=[] 照常收章节，后者抛错 → 概览 tab 状态条提示`,
        `- CDN 403 的归因只有状态码，238 字节 HTML 不泄漏到用户文案`,
        ""
      ].join("\n")
    );

    const artifact = readFileSync(artifactPath, "utf8");
    expect(artifact).toContain(risk._provenance.source);
    expect(artifact).toContain(empty._provenance.source);
    expect(artifact).toContain(FIXTURE.primary400._provenance.source);
    expect(artifact).toContain(FIXTURE.secondary400._provenance.source);
    expect(artifact).toContain(cdn._provenance.source);
    expect(artifact).toContain(`- 热评风控`);
    expect(artifact).toContain("B 站风控校验失败（-352），拿不到热评目录");
    expect(artifact).toContain(
      `热评没拿到（${riskMessage} (code: ${risk.code})）：本次概览没有评论目录。`
    );
    expect(artifact).toContain("HTTP 403");
  });
});
