// 端到端走查：字幕抓取失败的真 payload 回放（风控 / 空轨 / CDN 403 / 参数错误）。
//
// 本文件跑真实模块（extension/bilibili/gateway.ts 的 fetchSubtitleBundle /
// fetchHotCommentsJson / bgFetchJson、extension/subtitle/core.ts 的 refreshHotComments、
// extension/bilibili/bili-api-shared.ts 的错误归因、extension/shared/messaging.ts 的
// sendRuntimeMessage 跳板），只假 transport 与 chrome.runtime.sendMessage：
// 前者按 URL 路由到真 payload，后者把「background fetch-json」回包换成本文件里的
// 真 payload——其余全部是真代码。
//
// 真实 payload 清单（tests/fixtures/bilibili/，出处逐字写在各自 _provenance）：
//   - bilibili-reply-main-risk-control-352.json：真 `x/v2/reply/main` 风控响应
//     `{"code":-352,"message":"-352","ttl":1}`（本机裸请求稳定复现，39 字节）
//   - bilibili-player-v2-anonymous.json：真 `x/player/v2` 响应（code 0、匿名无字幕轨、
//     10 条真 view_points 章节）
//   - bilibili-player-wbi-v2-bad-params-400.json / bilibili-player-v2-bad-params-400.json：
//     真两条来源 URL（cid=0）的 `{"code":-400,"message":"请求错误","ttl":1}`
//   - aisubtitle-hdslb-403.json：真字幕 CDN（aisubtitle.hdslb.com）Tengine 403 报文
//
// 明确没有真实 payload、因此**不测**的面（不作近似）：
//   - 带字幕轨的真响应（`data.subtitle.subtitles[]` 非空）：需带 cookie / 登录，
//     匿名响应恒为空；仓库里只有形状转写记录
//     tests/fixtures/bilibili/bv1mAam6tEL8-subtitle-shape.md，没有响应副本。
//   - 字幕接口自己的风控 -352：本机对 player/v2、player/wbi/v2 连试多轮都是
//     code 0 或 -400，-352 只在 x/v2/reply/main 上复现，故风控用例落在合并热评链
//     （同一个 B 站信封、同一个 -352 码），不把它冒充字幕接口的响应。
//
// 走查末尾写出可复现工件（.scratch/tickets/test-suite-trim/artifacts/02-subtitle-failure-walkthrough.md）。

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

// ===== 被测模块（每用例新鲜加载）=====

let gateway: typeof import("../../extension/bilibili/gateway.js");
let subtitleCore: typeof import("../../extension/subtitle/core.js");
let core: typeof import("../../extension/core/state.js");

// 本文件不 mock gateway：① 经真 contentFetchJson 走真 fetch-json 跳板（跳板回包由
// chrome.runtime.sendMessage 换装成真 payload），②③④ 用 gateway 的 transport 注入缝。

/** 真 payload 的 transport：按 URL 精确路由，未命中的 URL 直接失败（防漏路由）。 */
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

/** chrome 桩：共享宿主（storage 三形状 + get(null) 快照 + onChanged）+ 按 type/url
 *  分发的 sendMessage（fetch-json 跳板用）；runtime 其余成员由宿主按层合并自 setup 桩。 */
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

// ===== ① 风控 -352（真报文）=====

describe("① 风控 -352（真 x/v2/reply/main 报文）→ 出声，不静默折成空数组", () => {
  it("fetchHotCommentsJson：真 -352 报文换成用户看得懂的病因（code/retryable 保留）", async () => {
    const { transport, calls } = fixtureTransport([[FIXTURE.risk352._provenance.source, FIXTURE.risk352]]);

    let caught: (Error & { code?: number; retryable?: boolean }) | null = null;
    try {
      await gateway.fetchHotCommentsJson(transport, AID, 20);
    } catch (error) {
      caught = error as Error & { code?: number; retryable?: boolean };
    }

    // 真原报文就是裸码（message 即 "-352"），直接抛出去用户看不懂
    expect(FIXTURE.risk352).toMatchObject({ code: -352, message: "-352", ttl: 1 });
    expect(caught?.message).toBe("B 站风控校验失败（-352），拿不到热评目录");
    expect(caught?.code).toBe(-352);
    expect(caught?.retryable).toBe(true);
    // 请求 URL 与报文出处逐字一致（真报文配真请求形状）
    expect(calls).toEqual([FIXTURE.risk352._provenance.source]);
  });

  it("refreshHotComments：真 -352 经真 fetch-json 跳板落到状态行（热评清空 + 病因文案）", async () => {
    const stub = stubChrome((url) => {
      if (url === FIXTURE.risk352._provenance.source) return FIXTURE.risk352;
      throw new Error(`unexpected fetch-json url: ${url}`);
    });
    core.clipState.setAid(String(AID));
    core.clipState.setHotComments([]);

    await subtitleCore.refreshHotComments();

    // 真 URL 经真 fetch-json 跳板发出（跳板回包是上面 stub 的真报文）
    expect(stub.sentUrls).toEqual([FIXTURE.risk352._provenance.source]);
    expect(core.clipState.hotComments).toEqual([]);
    // 状态行文案的组装口径：refreshHotComments 用 getErrorMessage(error)，
    // 于是可读病因后面还会跟一段码（当前状态：两者都带 -352）
    expect(core.state.ui.messageText).toBe(
      "热评没拿到（B 站风控校验失败（-352），拿不到热评目录 (code: -352)）：本次概览没有评论目录。"
    );
  });
});

// ===== ② 空字幕（真报文）=====

describe("② 匿名真响应（code 0 + 空字幕轨）→ 轨空、章节照收，且不编造原因", () => {
  it("fetchSubtitleBundle：真 player/v2 报文 → tracks 空 + 10 条真 view_points 章节", async () => {
    const raw = FIXTURE.playerEmpty;
    // 真报文自身的形状：匿名时轨为空，且报文并没有「需要登录」这种可归因信号
    expect(raw.code).toBe(0);
    expect(raw.data.subtitle.subtitles).toEqual([]);
    expect(raw.data.login_mid).toBe(0);
    expect(raw.data.need_login_subtitle).toBe(false);
    expect(raw.data.view_points).toHaveLength(10);

    // 不带 aid → buildSubtitleInfoRequests 只发次来源（player/v2），与报文出处逐字同 URL
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
    // 归因事实：轨为空时网关只能报「无轨」，报文里的 login_mid / need_login_subtitle
    // 没有任何映射出口——「为什么没有」由 ASR 回退与状态行承担（见 ① 与 ASR 走查）
    expect(Object.keys(bundle.tracks)).toHaveLength(0);
  });
});

// ===== ③ CDN 403（真报文）=====

describe("③ 字幕 CDN 403（真 Tengine 报文）→ 传输叶只报状态码，不泄漏 HTML", () => {
  it("bgFetchJson：真 403 → 抛 HTTP 403，且真请求构造（B 站头 + referrer）逐项核对", async () => {
    const cdn = FIXTURE.cdn403;
    const url = cdn._provenance.source;
    // 真报文是 Tengine 的 HTML 403 页（不是 JSON）
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

    // 真是字幕 CDN 主机 → 走 background 传输（B 站头 + referrer）
    expect(gateway.isBiliUrl(url)).toBe(true);

    let caught: Error | null = null;
    try {
      await gateway.bgFetchJson(url);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toBe("HTTP 403");
    // 归因边界：错误只带状态码，238 字节的 CDN HTML 不进用户可见文案
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
    // B 站请求头（Accept / Accept-Language / Cache-Control / Pragma）挂在
    // `Headers.size > 0` 守卫之后：jsdom 的 Headers 没有 size 属性，该守卫在本
    // 测试环境不成立（实测 init.headers 为 undefined），故这里不断言头——头要断言
    // 得走真机 harness。本用例只锁两个环境都成立的请求构造 + 403 归因。
  });
});

// ===== ④ 两条来源都失败（真 -400 报文）=====

describe("④ 字幕列表两条来源都失败（真 -400 报文，URL 逐字一致）", () => {
  it("主来源失败才试次来源；两条都失败时抛出次来源的归因（-400 → 请求错误）", async () => {
    const { transport, calls } = fixtureTransport([
      [FIXTURE.primary400._provenance.source, FIXTURE.primary400],
      [FIXTURE.secondary400._provenance.source, FIXTURE.secondary400]
    ]);

    let caught: (Error & { code?: number; retryable?: boolean }) | null = null;
    try {
      // 真两条来源 URL 就是 buildSubtitleInfoRequests({bvid, cid:"0", aid}) 的产出
      await gateway.fetchSubtitleBundle(transport, { bvid: BVID, cid: "0", aid: AID });
    } catch (error) {
      caught = error as Error & { code?: number; retryable?: boolean };
    }

    // 请求顺序 = 主来源（wbi）→ 次来源（v2），两条 URL 都与报文出处逐字一致
    expect(calls).toEqual([
      "https://api.bilibili.com/x/player/wbi/v2?aid=117376775358202&cid=0&bvid=BV1q9He6SEyX",
      "https://api.bilibili.com/x/player/v2?bvid=BV1q9He6SEyX&cid=0&aid=117376775358202"
    ]);
    expect(FIXTURE.primary400._provenance.source).toBe(calls[0]);
    expect(FIXTURE.secondary400._provenance.source).toBe(calls[1]);

    // 真 -400 报文本身带可读 message（与热评 -352 的裸码不同），故归因直接用 message
    expect(FIXTURE.primary400).toMatchObject({ code: -400, message: "请求错误", ttl: 1 });
    expect(caught?.message).toBe("请求错误");
    expect(caught?.code).toBe(-400);
    expect(caught?.retryable).toBe(true); // 负数码 → retryAsync 会重试（真重试语义）
    // 状态行文案就是 fetcher 的组装式：`抓取失败：${getErrorMessage(error)}`
    expect(`抓取失败：${getErrorMessageLike(caught)}`).toBe("抓取失败：请求错误 (code: -400)");
  });
});

// getErrorMessage 的组装口径（fetcher 的 catch 用的就是这个函数的输出形状）：
// message + " (code: " + code + ")"。这里只复算形状，真函数行为由 test ① 的
// 状态行（真 refreshHotComments 路径）与 tests/shared/error-helpers 覆盖。
function getErrorMessageLike(error: (Error & { code?: unknown }) | null): string {
  const message = String(error?.message || "");
  const code = error?.code === undefined || error?.code === null ? "" : String(error.code);
  return message ? (code ? `${message} (code: ${code})` : message) : code ? `code: ${code}` : "";
}

// ===== ⑤ 走查工件：可复现、可对账 =====

describe("⑤ 走查工件（重跑逐字节一致，末尾与真实报文对账）", () => {
  it("写出 02-subtitle-failure-walkthrough.md 并与真报文出处对账", async () => {
    const risk = FIXTURE.risk352;
    const empty = FIXTURE.playerEmpty;
    const cdn = FIXTURE.cdn403;

    // 三条链路各自的真实归因（与上面用例同一口径，此处再跑一遍供工件）
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
        `- 热评风控：真 \`{"code":-352,"message":"-352","ttl":1}\` → 真 fetchHotCommentsJson → \`${riskMessage}\` → 真 refreshHotComments 状态行 \`热评没拿到（${riskMessage} (code: ${risk.code})）：本次概览没有评论目录。\`（状态行用 getErrorMessage，可读病因后仍跟一段码）`,
        `- 空字幕轨：真 code 0 / subtitles=[] / login_mid=${empty.data.login_mid} / need_login_subtitle=${empty.data.need_login_subtitle} → tracks=0、章节 ${emptyBundle.chapters.length} 条（${emptyBundle.chapters[0].title} … ${emptyBundle.chapters[emptyBundle.chapters.length - 1].title}）`,
        `- 两条来源都失败：真 -400 报文 → 请求顺序 主来源(wbi) → 次来源(v2)，最终归因 \`${fourMessage}\`（code -400，retryable=true）`,
        `- CDN 403：真 Tengine HTML（${cdn.byteLength} 字节）→ 传输叶抛 \`HTTP 403\`，HTML 不出现在文案里`,
        "",
        "## 没有真实报文、故不测的面",
        "- 带字幕轨的真响应（subtitles 非空）：需带 cookie / 登录；匿名响应恒为空，仓库只有形状转写记录（bv1mAam6tEL8-subtitle-shape.md）",
        "- 字幕接口自身的 -352：本机对 player/v2、player/wbi/v2 多轮实测为 code 0 / -400，-352 只在 x/v2/reply/main 上复现，故风控用例落在合并热评链",
        "",
        "## 结论",
        `- 风控（-352）不再静默折空数组，病因可读且状态行出声（真报文 + 真跳板）`,
        `- 空轨与风控在同一条链上是两种结局：前者 tracks=[] 照常收章节，后者抛错 → 状态行常驻`,
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
