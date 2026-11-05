#!/usr/bin/env node
import path from "node:path";
import { build } from "esbuild";
import {
  REPO_ROOT,
  artifactDir,
  attachPage,
  launchBrowser,
  log,
  teardown,
  writeEvidence
} from "../harness.mjs";

const NAME = "live-overview-summary";
const OUT_DIR = artifactDir(path.join("scenarios", NAME));
const checks = [];

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(detail)}`);
}

const bundled = await build({
  entryPoints: [path.join(REPO_ROOT, "extension/live/live-tools-bridge.ts")],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "LiveTools",
  platform: "browser"
});
const bridgeSource = bundled.outputFiles[0].text;
const browser = await launchBrowser({ autoplay: true });
const page = await attachPage(browser);

try {
  await page.cdp.send("Page.setDocumentContent", {
    frameId: page.target.id,
    html: `<!doctype html><html><body><div class="bpx-player-video-wrap"><video preload="auto"></video></div></body></html>`
  });
  await page.cdp.evaluate(bridgeSource);
  await page.cdp.evaluate(`(() => {
    const clip = {
      bvid: 'BV1live000000',
      cid: '987',
      title: '实时伴看按需概览验证',
      pageIndex: 1,
      pageCount: 1,
      pageTitle: '',
      subtitleFetchState: 'ready',
      subtitleBody: [
        { from: 0, to: 4, content: '开场介绍本期主题' },
        { from: 10, to: 20, content: '详细剖析核心脉络' },
        { from: 30, to: 40, content: '最后总结核心观点' }
      ],
      chapters: []
    };

    let generatorCallCount = 0;
    let overviewState = { phase: 'idle', analysis: null, errorText: '' };
    let declineCostGuard = false;

    const testBridge = LiveTools.createLiveToolsBridge({
      getClip: () => clip,
      getUrl: () => 'https://www.bilibili.com/video/BV1live000000/',
      getOverview: () => overviewState,
      ensureOverview: async () => {
        generatorCallCount++;
        if (declineCostGuard) {
          overviewState = {
            phase: 'cancelled',
            analysis: null,
            errorText: '费用确认已取消，未生成全片概览'
          };
          return overviewState;
        }
        overviewState = {
          phase: 'ready',
          analysis: {
            summary: '全片深入讲解了实时伴看的按需概览生成机制。',
            chapters: [
              { from: 0, to: 10, title: '开场', summary: '介绍背景' },
              { from: 10, to: 30, title: '核心分析', summary: '剖析脉络' }
            ],
            quotes: [{ from: 30, content: '核心观点总结' }]
          },
          errorText: ''
        };
        return overviewState;
      }
    });

    window.testBridge = testBridge;
    window.getGeneratorCallCount = () => generatorCallCount;
    window.setOverviewState = (s) => { overviewState = s; };
    window.setDeclineCostGuard = (val) => { declineCostGuard = val; };
    window.testCall = (name, args, stampedVideo = { bvid: 'BV1live000000', cid: '987', pageIndex: 1 }) =>
      testBridge.executeTool({ callId: Math.random().toString(36), name, arguments: args, video: stampedVideo });
  })()`);

  const results = await page.cdp.evaluate(`(async () => {
    const output = {};
    // 1. 首次生成：概览未就绪时触发 ensureOverview
    output.firstGen = await testCall('summarize_video', {});
    output.firstGenCalls = getGeneratorCallCount();

    // 2. 缓存命中：第二次调用直接复用已有概览，不再触发生成
    output.cacheHit = await testCall('summarize_video', {});
    output.cacheHitCalls = getGeneratorCallCount();

    // 3. 部分覆盖：覆盖不完整时明确返回 partial 与 failedRanges
    setOverviewState({
      phase: 'partial',
      analysis: {
        summary: '部分内容生成概览',
        chapters: [{ from: 0, to: 10, title: '片段', summary: '局部' }],
        quotes: [],
        failedRanges: [{ from: 20, to: 40 }]
      },
      errorText: ''
    });
    output.partial = await testCall('summarize_video', {});

    // 4. 费用确认取消
    setOverviewState({ phase: 'idle', analysis: null, errorText: '' });
    setDeclineCostGuard(true);
    output.cancelled = await testCall('summarize_video', {});

    return output;
  })()`);

  check(
    "first-generation",
    results.firstGen.ok === true &&
      results.firstGen.coverage === "complete" &&
      results.firstGen.summary.includes("实时伴看") &&
      results.firstGenCalls === 1,
    results.firstGen
  );

  check(
    "cache-hit",
    results.cacheHit.ok === true &&
      results.cacheHit.coverage === "complete" &&
      results.cacheHitCalls === 1, // 调用计数依然为 1，说明未发起二次生成
    { cacheHit: results.cacheHit, calls: results.cacheHitCalls }
  );

  check(
    "partial-coverage",
    results.partial.ok === true &&
      results.partial.coverage === "partial" &&
      Array.isArray(results.partial.failedRanges) &&
      results.partial.failedRanges.length === 1,
    results.partial
  );

  check(
    "cost-guard-cancelled",
    results.cancelled.ok === false &&
      results.cancelled.error.includes("取消"),
    results.cancelled
  );

  await writeEvidence(OUT_DIR, {
    failed: checks.filter((entry) => !entry.ok).map((entry) => entry.name),
    checks,
    results
  });

  if (checks.some((entry) => !entry.ok)) process.exitCode = 1;
} finally {
  await teardown({ browser, cdps: [page.cdp] });
}
