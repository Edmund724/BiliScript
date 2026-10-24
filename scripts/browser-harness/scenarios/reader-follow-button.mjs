#!/usr/bin/env node
// 跟随播放悬浮按钮真机场景 —— `pnpm harness:scenario reader-follow-button`。
//
// 判据（为什么在真机上跑）：按钮形态是样式收敛的产物。flyme 色板下它与选区
// 「解释」按钮、对话滚底圆钮同族收敛为液态玻璃胶囊：无框（border-color 透明）
// + card 透镜渐变底 + blur(20px) saturate(180%) 磨砂 + 顶沿折射高光与漫射浮层
// 阴影（明暗换档），hover 转 accent-soft 底 + accent 字（描边保持透明），按压
// scale 不变；editorial 色板保持基表旧态（1px 细边 + card 实底 + 0 6px 22px
// 浮影，零滤镜零玻璃）。computed style、真实几何、hover / :active 伪类、
// 明暗 × 色板四象限 token 全都够不着 jsdom；显隐契约（两条选择器）已由
// tests/reader/follow-button.test.ts 锁住，本场景只验「人眼看到的那个样子」。
//
// 数据口径（诚实标注）：字幕列表来自 tests/fixtures/bilibili/bilingual-walkthrough/
// 的 committed fixture（8 轨 + 197 句正文），经 SW 的 fetch 补丁换掉两个网络应答，
// 其余走真实扩展代码 + 真实渲染路径；页面本身是真 bilibili.com 视频页。
//
// 交互口径：manual 态由**真滚轮**触发（Input.dispatchMouseEvent mouseWheel 落在
// 字幕列表上 → noteManualReaderInteraction，暂停窗口约 3s），hover / 按压 /
// 点击同样走真指针事件；暂停窗口内读数，窗口掉了就再滚一次（每次滚轮都会重置
// 暂停窗口）。
//
// 硬约束：只杀自己 spawn 的进程（harness 的 teardown）；工件落
// `.scratch/browser-harness/scenarios/reader-follow-button/`；fixture 只读
// tests/fixtures/（可提交数据），场景代码里不出现 .scratch/ 路径。

import path from "node:path";
import { readFileSync } from "node:fs";
import {
  DEFAULT_DIST,
  DEFAULT_VIEWPORT,
  REPO_ROOT,
  artifactDir,
  attachPage,
  createWorkerSession,
  launchBrowser,
  log,
  screenshot,
  sleep,
  teardown,
  waitFor,
  watchPage,
  writeEvidence
} from "../harness.mjs";

const NAME = "reader-follow-button";
const OUT_DIR = artifactDir(path.join("scenarios", NAME));
const FIXTURE_DIR = path.join(REPO_ROOT, "tests", "fixtures", "bilibili", "bilingual-walkthrough");

// 与 bilingual-subtitles 同一份 committed fixture：本场景只用第一个样本视频
// （8 条可装载轨 + 197 句中文正文），不引入第二份数据。
const SAMPLE = { bvid: "BV1mAam6tEL8", url: "https://www.bilibili.com/video/BV1mAam6tEL8/" };
const VIEWPORT = DEFAULT_VIEWPORT;
const headed = process.argv.includes("--headed");
const fixtureOnly = process.argv.includes("--fixture-only");

// ===== 场景清单（代码即清单）。id 同时是 evidence.json 里的键。=====
const SCENARIOS = [
  { id: "F1", slug: "01-auto-hidden", title: "跟随中（auto）：按钮隐藏；文案无「↓」字素" },
  { id: "F2", slug: "02-manual-light", title: "手动滚离（manual）flyme 浅色：液态玻璃胶囊（无框 + card 渐变 + 磨砂 + 折射高光浮层阴影）" },
  { id: "F3", slug: "03-hover-light", title: "hover：background/color 转 accent-soft/accent，描边保持透明" },
  { id: "F4", slug: "04-press-and-resume", title: "按压：transform 追加 press-scale；点击后回 auto 并隐藏（不 seek）" },
  { id: "F5", slug: "05-manual-dark", title: "flyme 深色档 manual：card/text token 换深色值 + 暗面阴影档" },
  { id: "F6", slug: "06-manual-editorial-light", title: "editorial 浅色 manual：基表 1px 细边 + 书摘卡实底，零滤镜零玻璃" },
  { id: "F7", slug: "07-manual-editorial-dark", title: "editorial 深色 manual：暖炭黑书摘卡 + 细边，零滤镜零玻璃" }
];

// ===== 可提交 fixture（只读）=====
let BUNDLES;
let BODIES;
let META;
try {
  BUNDLES = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "bundles.json"), "utf8"));
  BODIES = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "bodies.json"), "utf8"));
  META = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "meta.json"), "utf8"));
} catch (error) {
  console.error(`读不到 committed fixture：${FIXTURE_DIR}\n  ${error.message}`);
  process.exit(1);
}

// ===== 断言 =====
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail).slice(0, 320)}`}`);
  return Boolean(ok);
}
function checkEquals(name, actual, expected) {
  return check(name, actual === expected, { actual, expected });
}

// ===== fixture 自检（--fixture-only 的离线底线）=====
function selfCheckFixture() {
  const tracks = BUNDLES[SAMPLE.bvid]?.data?.subtitle?.subtitles ?? [];
  checkEquals("fixture.sample-track-count", tracks.length, 8);
  checkEquals("fixture.zh-segments", (BODIES[`${SAMPLE.bvid}-zh`]?.body ?? []).length, 197);
  const loadable = tracks.filter((t) => t.subtitle_url).length;
  checkEquals("fixture.loadable-track-count", loadable, 8);
  const bodyKeyMissing = tracks
    .map((t) => String(t.subtitle_url).split("/").pop().replace(/\.json$/, ""))
    .filter((key) => !BODIES[key]);
  checkEquals("fixture.track-bodies-present", bodyKeyMissing.length, 0);
  return checks.every((c) => c.ok);
}

// ===== 页面内测量脚本 =====
// 一次 evaluate 取全：显隐依据属性、几何、computed style，以及同一节点上现求的
// token 探针（card 渐变/实色两路、text/accent/accent-soft/border 的计算值）——
// 按钮「底色与卡片一致」因此不是与硬编码色值比，而是与 token 现值比，明暗两档
// 与色板两档都成立（card 在 flyme 是渐变、在 editorial 是实色，故探两路）。
const JS = {
  probe: `(() => {
    const btn = document.getElementById('biliscript-reading-follow-btn');
    const view = document.getElementById('biliscript-reading-view');
    if (!btn || !view) return { error: btn ? 'view-missing' : 'follow-btn-missing' };
    const cs = getComputedStyle(btn);
    const r = btn.getBoundingClientRect();
    const probe = document.createElement('div');
    probe.style.display = 'none';
    view.appendChild(probe);
    const token = (name, prop) => { probe.style[prop] = 'var(' + name + ')'; return getComputedStyle(probe)[prop]; };
    const tokens = {
      cardBg: token('--biliscript-reader-card', 'backgroundImage'),
      cardColor: token('--biliscript-reader-card', 'backgroundColor'),
      textColor: token('--biliscript-reader-text', 'color'),
      accentColor: token('--biliscript-reader-accent', 'color'),
      accentSoftColor: token('--biliscript-reader-accent-soft', 'backgroundColor'),
      borderColor: token('--biliscript-reader-border', 'borderTopColor')
    };
    probe.remove();
    return {
      followAttr: view.getAttribute('data-biliscript-reader-follow'),
      theme: view.getAttribute('data-theme'),
      palette: view.getAttribute('data-palette'),
      text: btn.textContent,
      display: cs.display,
      rect: { w: +r.width.toFixed(2), h: +r.height.toFixed(2), cx: +(r.left + r.width / 2).toFixed(1), cy: +(r.top + r.height / 2).toFixed(1) },
      style: {
        position: cs.position,
        borderTopWidth: cs.borderTopWidth,
        borderTopStyle: cs.borderTopStyle,
        borderTopColor: cs.borderTopColor,
        backgroundImage: cs.backgroundImage,
        backgroundColor: cs.backgroundColor,
        color: cs.color,
        borderRadius: cs.borderRadius,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        boxShadow: cs.boxShadow,
        backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter,
        transform: cs.transform
      },
      tokens
    };
  })()`,
  listRect: `(() => {
    const list = document.getElementById('biliscript-reading-subtitle');
    if (!list) return null;
    const r = list.getBoundingClientRect();
    return { w: +r.width.toFixed(1), h: +r.height.toFixed(1), cx: +(r.left + r.width / 2).toFixed(1), cy: +(r.top + r.height / 2).toFixed(1), scrollable: list.scrollHeight > list.clientHeight + 1 };
  })()`,
  pauseMedia: `(() => {
    const media = [...document.querySelectorAll('video,audio')];
    const wasPlaying = media.filter(m => !m.paused).length;
    media.forEach(m => { try { m.pause(); } catch {} });
    return { wasPlaying };
  })()`,
  followAttr: `document.getElementById('biliscript-reading-view').getAttribute('data-biliscript-reader-follow')`,
  followIsManual: `document.getElementById('biliscript-reading-view').getAttribute('data-biliscript-reader-follow') === 'manual'`,
  followIsAuto: `document.getElementById('biliscript-reading-view').getAttribute('data-biliscript-reader-follow') === 'auto'`,
  isDark: `document.getElementById('biliscript-reading-view').getAttribute('data-theme') === 'dark'`,
  isLight: `document.getElementById('biliscript-reading-view').getAttribute('data-theme') !== 'dark'`,
  isEditorial: `document.getElementById('biliscript-reading-view').getAttribute('data-palette') === 'editorial'`,
  settingsPanelOpen: `(() => { const p = document.getElementById('biliscript-reading-settings-panel'); return !!p && !p.hidden; })()`,
  // 色板切换是设置抽屉里的 <select>（change 事件即时生效并持久化），此处设值即交给真实保存链路（save-settings → 状态 → apply 呈现）。
  setEditorialPalette: `(() => {
    const sel = document.getElementById('readerPalette');
    if (!sel) return { ok: false, reason: 'palette-select-missing' };
    sel.value = 'editorial';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: sel.value === 'editorial', value: sel.value };
  })()`
};

// ===== SW fetch 补丁（只换两个网络应答；无闸门无延迟，本场景不测在飞态）=====
function fixturePatchExpression() {
  return `(() => {
    const FIX = ${JSON.stringify({ bundles: BUNDLES, bodies: BODIES })};
    const g = globalThis;
    if (!g.__followBtnHarness) {
      g.__followBtnHarness = { bundles: FIX.bundles, bodies: FIX.bodies, hits: [] };
      const orig = g.fetch.bind(g);
      g.fetch = async (input, init) => {
        const st = g.__followBtnHarness;
        const url = typeof input === 'string' ? input : ((input && input.url) || String(input));
        if (/x\\/player\\/(?:wbi\\/)?v2/.test(url)) {
          const bvid = (url.match(/bvid=([A-Za-z0-9]+)/) || [])[1] || '';
          st.hits.push({ kind: 'bundle', bvid });
          return new Response(JSON.stringify(st.bundles[bvid] || { code: 0, data: { subtitle: { subtitles: [] } } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        const m = url.match(/walkthrough-fixture\\/([A-Za-z0-9\\-]+)\\.json/);
        if (m) {
          const payload = st.bodies[m[1]];
          st.hits.push({ kind: 'body', key: m[1] });
          if (payload === undefined) return new Response('{"body":[]}', { status: 404, headers: { 'content-type': 'application/json' } });
          return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return orig(input, init);
      };
    } else {
      g.__followBtnHarness.bundles = FIX.bundles;
      g.__followBtnHarness.bodies = FIX.bodies;
    }
    return 'fixture-ready';
  })()`;
}

// ===== 真机输入 =====
async function dispatchClick(pageCdp, x, y) {
  const px = Math.round(x);
  const py = Math.round(y);
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py, button: "none", clickCount: 0 });
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: px, y: py, button: "left", buttons: 1, clickCount: 1 });
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: px, y: py, button: "left", buttons: 0, clickCount: 1 });
  return { x: px, y: py };
}

// 点击一个「按表达式定位」的元素；目标必须当场有几何且 elementFromPoint 命中本身
// （README 硬约束：0×0 / 被盖住 / 出视口一律记 FAIL，不静默点空）。
async function clickElement(pageCdp, label, locateExpr) {
  const info = await pageCdp.evaluate(`(() => {
    const el = ${locateExpr};
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return {
      found: true,
      rect: { w: +r.width.toFixed(2), h: +r.height.toFixed(2) },
      center: { x: cx, y: cy },
      hitSelf: !!hit && (hit === el || el.contains(hit)),
      hitTag: hit ? hit.tagName + '.' + String(hit.className || '').slice(0, 40) : null,
      text: (el.textContent || '').slice(0, 60)
    };
  })()`);
  if (!info?.found) return { ok: false, label, reason: "not-found" };
  if (!(info.rect.w > 0) || !(info.rect.h > 0)) return { ok: false, label, reason: "not-hittable", rect: info.rect };
  if (info.center.x < 0 || info.center.y < 0 || info.center.x > VIEWPORT.width || info.center.y > VIEWPORT.height) {
    return { ok: false, label, reason: "out-of-viewport", rect: info.rect };
  }
  if (!info.hitSelf) return { ok: false, label, reason: "covered", rect: info.rect, hitTag: info.hitTag };
  await dispatchClick(pageCdp, info.center.x, info.center.y);
  return { ok: true, label, text: info.text, rect: info.rect };
}

async function mustClick(pageCdp, checkName, label, locateExpr) {
  const result = await clickElement(pageCdp, label, locateExpr);
  check(checkName, result.ok === true, result);
  return result;
}

async function pausePageMedia() {
  try {
    return await pageCdp.evaluate(JS.pauseMedia);
  } catch (error) {
    return { error: error.message };
  }
}

// manual 态由真滚轮触发；暂停窗口约 3s，窗口掉了就再滚一次（滚轮本身会重置窗口）。
async function wheelSubtitleList(label) {
  const rect = await pageCdp.evaluate(JS.listRect);
  if (!rect || !rect.scrollable) {
    check(`${label}.list-scrollable`, false, rect);
    return false;
  }
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: rect.cx, y: rect.cy, deltaX: 0, deltaY: 240 });
  return true;
}

// manual 态由真滚轮触发。注意：扩展自己的跟随滚动会留下 programmatic 窗口
// （setProgrammaticScrollUntil，smooth 档 800ms）——窗口内 wheel 的 scroll 事件
// 被 isProgrammaticScrolling() 判为程序化滚动而早退，翻不了 manual。故每次滚轮
// 前先晾 900ms 让窗口过期，失败则重试（每次滚轮本身也会重置 3s 暂停窗口）。
async function ensureManual(label) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const attr = await pageCdp.evaluate(JS.followAttr);
    if (attr === "manual") return true;
    await sleep(900);
    await wheelSubtitleList(label);
    try {
      await waitFor(`${label}：follow 态翻到 manual（第 ${attempt} 次）`, () => pageCdp.evaluate(JS.followIsManual), { timeoutMs: 2500, intervalMs: 100 });
      return true;
    } catch (error) {
      log(`${label}：第 ${attempt} 次滚轮未翻到 manual，重试`);
    }
  }
  check(`${label}.manual-reached`, false, { error: "3 次滚轮后仍未翻到 manual" });
  return false;
}

// ===== 主流程 =====
const evidence = {
  meta: {
    startedAt: new Date().toISOString(),
    scenario: NAME,
    dist: DEFAULT_DIST,
    viewport: VIEWPORT,
    sampleUrl: SAMPLE.url,
    headed,
    fixtureDir: path.relative(REPO_ROOT, FIXTURE_DIR),
    node: process.version
  },
  fixture: {},
  scenarios: {},
  timeline: [],
  screenshots: []
};

let browser = null;
let pageCdp = null;
let worker = null;
let patchKeepAlive = null;
let fixturePatchEnabled = false;

function record(id, payload) {
  evidence.scenarios[id] = { ...(evidence.scenarios[id] || {}), ...payload };
  evidence.timeline.push({ at: new Date().toISOString(), scenario: id, note: payload.note || "" });
}

async function shot(base, note) {
  try {
    const file = await screenshot(pageCdp, path.join(OUT_DIR, `${base}.png`));
    evidence.screenshots.push({ file: path.basename(file), note });
    return file;
  } catch (error) {
    log(`截图失败 ${base}：${error.message}`);
    return null;
  }
}

async function installFixturePatch() {
  if (!worker?.handle) throw new Error("SW 未连接，装不了 fixture 补丁");
  return worker.handle.cdp.evaluate(fixturePatchExpression(), { sessionId: worker.handle.sessionId, timeoutMs: 30000 });
}

function startFixtureKeepAlive() {
  if (patchKeepAlive) clearInterval(patchKeepAlive);
  // 补丁只会在 SW 被回收重启后丢；探到不在才重打整份。
  patchKeepAlive = setInterval(() => {
    void (async () => {
      try {
        const alive = await worker.evaluate(`(globalThis.__followBtnHarness ? 'alive' : 'gone')`, 8000);
        if (alive !== "alive") {
          await installFixturePatch();
          log("fixture 补丁已随 SW 重启重打");
        }
      } catch {}
    })();
  }, 1500);
  patchKeepAlive.unref?.();
}

async function main() {
  evidence.meta.dist = DEFAULT_DIST;
  const fixtureOk = selfCheckFixture();
  evidence.fixture.selfCheck = { ok: fixtureOk, checks: checks.length };
  if (!fixtureOk) log("fixture 自检未全过，继续跑但读数不可当验收证据");

  browser = await launchBrowser({ headless: !headed, viewport: VIEWPORT });
  evidence.meta.browser = browser.version?.Browser;
  evidence.meta.port = browser.port;
  evidence.meta.browserPid = browser.pid;
  evidence.meta.muted = browser.muted;
  evidence.meta.sync = browser.sync;

  const page = await attachPage(browser, { viewport: VIEWPORT });
  pageCdp = page.cdp;
  await pageCdp.send("Page.bringToFront").catch(() => {});
  const watched = watchPage(pageCdp);
  evidence.meta.consoleLog = watched.consoleLog;

  worker = createWorkerSession({
    pageCdp,
    browser,
    onReconnect: async (handle) => {
      if (!fixturePatchEnabled) return;
      try {
        await handle.cdp.evaluate(fixturePatchExpression(), { sessionId: handle.sessionId, timeoutMs: 30000 });
        log("SW 重连：fixture 补丁已重打");
      } catch (error) {
        log(`SW 重连后 fixture 补丁重打失败：${error.message}`);
      }
    }
  });
  const workerUp = await worker.ensureAlive();
  check("sw-attach", workerUp, { url: worker.handle?.url });

  // ===== 进阅读模式（fixture 数据 + 真实渲染路径）=====
  await pageCdp.send("Page.navigate", { url: SAMPLE.url });
  await waitFor("扩展按钮注入", async () => pageCdp.evaluate(`!!document.getElementById('biliscript-script-button')`), { timeoutMs: 30000, intervalMs: 300 });
  fixturePatchEnabled = true;
  evidence.meta.patchResult = await installFixturePatch();
  startFixtureKeepAlive();

  const scriptBtn = await clickElement(pageCdp, "进入阅读模式", `document.getElementById('biliscript-script-button')`);
  check("enter-reading-mode", scriptBtn.ok === true, scriptBtn);
  await waitFor("阅读视图打开", async () =>
    pageCdp.evaluate(`(() => { const v = document.getElementById('biliscript-reading-view'); return !!v && v.classList.contains('open') && v.getAttribute('data-biliscript-reader-ready') !== '0'; })()`), { timeoutMs: 30000, intervalMs: 250 });
  await waitFor("fixture 字幕上屏", async () =>
    pageCdp.evaluate(`document.querySelectorAll('#biliscript-reading-subtitle .biliscript-reading-item').length`), { timeoutMs: 45000, intervalMs: 400 });
  await pausePageMedia();
  evidence.meta.listReady = await pageCdp.evaluate(`(() => ({
    items: document.querySelectorAll('#biliscript-reading-subtitle .biliscript-reading-item').length,
    list: ${JS.listRect}
  }))()`);

  try {
    // ---------- F1 跟随中（auto）：隐藏 + 无「↓」字素 ----------
    {
      const f1 = {};
      f1.probe = await pageCdp.evaluate(JS.probe);
      check("F1.auto-hidden", f1.probe?.display === "none", { display: f1.probe?.display, followAttr: f1.probe?.followAttr });
      checkEquals("F1.follow-attr-auto", f1.probe?.followAttr, "auto");
      checkEquals("F1.copy-no-glyph", f1.probe?.text, "跟随播放");
      record("F1", { title: SCENARIOS[0].title, ...f1, note: "初始态：data-follow=auto ⇒ display:none；文案已是纯文字（无 ↓ 字符）" });
    }

    // ---------- F2 manual（flyme 浅色）：显形 + 液态玻璃胶囊契约 ----------
    {
      const f2 = {};
      check("F2.manual-reached", await ensureManual("F2"), null);
      f2.probe = await pageCdp.evaluate(JS.probe);
      const s = f2.probe?.style || {};
      const t = f2.probe?.tokens || {};
      checkEquals("F2.follow-attr-manual", f2.probe?.followAttr, "manual");
      // tab body 是 flex 容器，inline-flex 的计算值被块状化为 flex——判「可见」的
      // 语义是不为 none 且有几何，不断言关键字面。
      check("F2.visible", /^(inline-)?flex$/.test(f2.probe?.display || "") && (f2.probe?.rect?.w ?? 0) > 0 && (f2.probe?.rect?.h ?? 0) > 0, { display: f2.probe?.display, rect: f2.probe?.rect });
      checkEquals("F2.position-absolute", f2.probe?.style?.position, "absolute");
      checkEquals("F2.background-is-card-token", s.backgroundImage, t.cardBg);
      check("F2.card-token-is-gradient", /^linear-gradient/.test(t.cardBg || ""), { cardBg: t.cardBg });
      // 液态玻璃收敛：去 1px 灰框（border-color 透明；宽度/样式沿用基表 1px solid）
      check("F2.frameless-border", s.borderTopWidth === "1px" && s.borderTopStyle === "solid" && s.borderTopColor === "rgba(0, 0, 0, 0)", { border: s.borderTopWidth + " " + s.borderTopStyle + " " + s.borderTopColor });
      // computed backdrop-filter 把 saturate(180%) 归一成 saturate(1.8)
      checkEquals("F2.backdrop-blur", s.backdropFilter, "blur(20px) saturate(1.8)");
      checkEquals("F2.color-is-text-token", s.color, t.textColor);
      checkEquals("F2.radius-999", s.borderRadius, "999px");
      checkEquals("F2.font", s.fontSize + "/" + s.fontWeight, "14px/600");
      // 顶沿折射高光 + 漫射浮层阴影（浅档），与解释按钮/滚底钮同一份门控规则；
      // computed box-shadow 序列化是「色值在前、偏移在后」。
      check("F2.shadow-liquid-glass", /rgba\(255, 255, 255, 0\.92\) 0px 1px 0px 0px inset/.test(s.boxShadow || "") && s.boxShadow.includes("rgba(15, 23, 42, 0.16) 0px 10px 28px -4px") && s.boxShadow.includes("rgba(15, 23, 42, 0.06) 0px 2px 6px 0px"), { boxShadow: s.boxShadow });
      check("F2.no-accent-fill", !/rgb\(0, 140, 255\)|#008cff/i.test(s.backgroundImage || "") && s.backgroundImage === t.cardBg, { backgroundImage: s.backgroundImage });
      await shot("02-manual-light", "manual 态（flyme 浅色）：液态玻璃胶囊——无框 + card 渐变 + 磨砂 + 折射高光浮层阴影");
      record("F2", { title: SCENARIOS[1].title, ...f2, note: "滚轮触发 manual；computed style 与 token 探针对齐" });
    }

    // ---------- F3 hover：accent-soft 底 + accent 字，描边保持透明 ----------
    {
      const f3 = {};
      check("F3.manual-reached", await ensureManual("F3"), null);
      const p = await pageCdp.evaluate(JS.probe);
      await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.rect.cx, y: p.rect.cy, button: "none", clickCount: 0 });
      await sleep(150);
      f3.hover = await pageCdp.evaluate(JS.probe);
      const s = f3.hover?.style || {};
      const t = f3.hover?.tokens || {};
      // 无框语言不收悬停 accent 环：描边在 hover 态同样保持透明
      check("F3.hover-border-stays-transparent", s.borderTopColor === "rgba(0, 0, 0, 0)", { border: s.borderTopColor });
      checkEquals("F3.hover-background-accent-soft", s.backgroundColor, t.accentSoftColor);
      checkEquals("F3.hover-color-accent", s.color, t.accentColor);
      check("F3.hover-replaces-card-gradient", s.backgroundImage === "none", { backgroundImage: s.backgroundImage });
      checkEquals("F3.hover-backdrop-persists", s.backdropFilter, "blur(20px) saturate(1.8)");
      await shot("03-hover-light", "manual 态 hover：accent-soft 底 + accent 字，描边保持透明、磨砂不撤");
      record("F3", { title: SCENARIOS[2].title, ...f3, note: "真指针 mouseMoved 触发 :hover" });
    }

    // ---------- F4 按压 + 点击恢复 ----------
    {
      const f4 = {};
      check("F4.manual-reached", await ensureManual("F4"), null);
      const p = await pageCdp.evaluate(JS.probe);
      const pressScale = await pageCdp.evaluate(`(() => {
        const probe = document.createElement('div');
        probe.style.display = 'none';
        document.getElementById('biliscript-reading-view').appendChild(probe);
        probe.style.transform = 'var(--biliscript-reader-press-scale)';
        const v = getComputedStyle(probe).transform;
        probe.remove();
        return v;
      })()`);
      // 按下不抬起：按住期间用 rAF 连续采样 transform（100ms transition 的中间值
      // 也要看得到），采完立刻抬起——这次点击就是「恢复跟随」的真输入。
      await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.rect.cx, y: p.rect.cy, button: "none", clickCount: 0 });
      await pageCdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.rect.cx, y: p.rect.cy, button: "left", buttons: 1, clickCount: 1 });
      f4.active = await pageCdp.evaluate(`(() => new Promise((resolve) => {
        const btn = document.getElementById('biliscript-reading-follow-btn');
        const samples = [];
        const started = Date.now();
        const timer = setInterval(() => {
          samples.push(getComputedStyle(btn).transform);
          if (Date.now() - started >= 260) {
            clearInterval(timer);
            resolve(samples);
          }
        }, 16);
      }))()`);
      await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.rect.cx, y: p.rect.cy, button: "left", buttons: 0, clickCount: 1 });
      const scale = String(pressScale).match(/matrix\(([0-9.]+)/);
      const expected = scale ? scale[1] : "0.97";
      check("F4.press-transform-scale", (f4.active || []).some((t) => String(t).startsWith(`matrix(${expected}`)), { expected, samples: f4.active });
      await waitFor("F4：点击后 follow 回 auto", () => pageCdp.evaluate(JS.followIsAuto), { timeoutMs: 8000, intervalMs: 120 });
      f4.after = await pageCdp.evaluate(JS.probe);
      check("F4.resume-hides-button", f4.after?.display === "none" && f4.after?.followAttr === "auto", { display: f4.after?.display, followAttr: f4.after?.followAttr });
      record("F4", { title: SCENARIOS[3].title, ...f4, note: "按下读 :active transform；抬起即点击 ⇒ 回 auto 隐藏（语义不变，仍不 seek）" });
    }

    // ---------- F5 manual（flyme 深色）----------
    {
      const f5 = {};
      const themeBtn = await mustClick(pageCdp, "F5.theme-toggle-hittable", "主题切换", `document.getElementById('biliscript-reading-theme-select')`);
      f5.themeClick = themeBtn;
      try {
        await waitFor("F5：面板切到暗色档", () => pageCdp.evaluate(JS.isDark), { timeoutMs: 15000, intervalMs: 200 });
      } catch (error) {
        check("F5.dark-applied", false, { error: error.message });
      }
      check("F5.manual-reached", await ensureManual("F5"), null);
      f5.probe = await pageCdp.evaluate(JS.probe);
      const s = f5.probe?.style || {};
      const t = f5.probe?.tokens || {};
      checkEquals("F5.theme-dark", f5.probe?.theme, "dark");
      check("F5.visible", /^(inline-)?flex$/.test(f5.probe?.display || "") && (f5.probe?.rect?.w ?? 0) > 0, { display: f5.probe?.display, rect: f5.probe?.rect });
      checkEquals("F5.background-is-dark-card-token", s.backgroundImage, t.cardBg);
      checkEquals("F5.color-is-dark-text-token", s.color, t.textColor);
      check("F5.frameless-border", s.borderTopWidth === "1px" && s.borderTopColor === "rgba(0, 0, 0, 0)", { border: s.borderTopWidth + " " + s.borderTopColor });
      checkEquals("F5.backdrop-blur", s.backdropFilter, "blur(20px) saturate(1.8)");
      check("F5.shadow-liquid-glass-dark", /rgba\(255, 255, 255, 0\.18\) 0px 1px 0px 0px inset/.test(s.boxShadow || "") && s.boxShadow.includes("rgba(0, 0, 0, 0.5) 0px 10px 28px -4px") && s.boxShadow.includes("rgba(0, 0, 0, 0.3) 0px 2px 6px 0px"), { boxShadow: s.boxShadow });
      await shot("05-manual-dark", "manual 态（flyme 深色档）：card/text token 换深色值 + 暗面折射高光浮层阴影");
      record("F5", { title: SCENARIOS[4].title, ...f5, note: "主题经 header 主题键真指针切换；深色 manual 态同族" });
    }

    // ---------- F6 manual（editorial 浅色）：玻璃规则脱钩，回基表细边实底 ----------
    {
      const f6 = {};
      // 先切回浅色档（F5 留在深色）
      await mustClick(pageCdp, "F6.theme-toggle-hittable", "主题切换", `document.getElementById('biliscript-reading-theme-select')`);
      try {
        await waitFor("F6：面板切回浅色档", () => pageCdp.evaluate(JS.isLight), { timeoutMs: 15000, intervalMs: 200 });
      } catch (error) {
        check("F6.light-applied", false, { error: error.message });
      }
      // 开设置抽屉 → 色板选 editorial → 保存（真实 save-settings 链路）
      await mustClick(pageCdp, "F6.settings-open-hittable", "设置", `document.getElementById('biliscript-reading-settings-btn')`);
      try {
        await waitFor("F6：设置抽屉展开", () => pageCdp.evaluate(JS.settingsPanelOpen), { timeoutMs: 8000, intervalMs: 150 });
      } catch (error) {
        check("F6.settings-open", false, { error: error.message });
      }
      // 抽屉表单随展开异步装载（先读设置再渲染），等色板下拉真正挂载再设值
      try {
        await waitFor("F6：色板下拉挂载", () => pageCdp.evaluate(`!!document.getElementById('readerPalette')`), { timeoutMs: 10000, intervalMs: 200 });
      } catch (error) {
        check("F6.palette-select-mounted", false, { error: error.message });
      }
      f6.paletteSet = await pageCdp.evaluate(JS.setEditorialPalette);
      check("F6.palette-select-set", f6.paletteSet?.ok === true, f6.paletteSet);
      f6.saveVia = "auto-save";
      try {
        await waitFor("F6：视图切到 editorial", () => pageCdp.evaluate(JS.isEditorial), { timeoutMs: 15000, intervalMs: 200 });
      } catch (error) {
        check("F6.editorial-applied", false, { error: error.message });
      }
      // 关抽屉回字幕区
      await mustClick(pageCdp, "F6.settings-close-hittable", "设置", `document.getElementById('biliscript-reading-settings-btn')`);
      check("F6.manual-reached", await ensureManual("F6"), null);
      f6.probe = await pageCdp.evaluate(JS.probe);
      const s = f6.probe?.style || {};
      const t = f6.probe?.tokens || {};
      checkEquals("F6.palette-editorial", f6.probe?.palette, "editorial");
      checkEquals("F6.theme-light", f6.probe?.theme, "light");
      check("F6.visible", /^(inline-)?flex$/.test(f6.probe?.display || "") && (f6.probe?.rect?.w ?? 0) > 0, { display: f6.probe?.display, rect: f6.probe?.rect });
      check("F6.hairline-border", s.borderTopWidth === "1px" && s.borderTopStyle === "solid" && s.borderTopColor === t.borderColor, { border: s.borderTopWidth + " " + s.borderTopStyle + " " + s.borderTopColor, token: t.borderColor });
      checkEquals("F6.background-is-card-color", s.backgroundColor, t.cardColor);
      checkEquals("F6.no-card-gradient", s.backgroundImage, "none");
      checkEquals("F6.no-backdrop-filter", s.backdropFilter, "none");
      // 基表浮影原样保留（editorial 不去框不去影）
      check("F6.base-shadow-kept", (s.boxShadow || "").includes("rgba(0, 0, 0, 0.14) 0px 6px 22px 0px"), { boxShadow: s.boxShadow });
      await shot("06-manual-editorial-light", "manual 态（editorial 浅色）：1px 暖沙细边 + 书摘卡实底，零滤镜零玻璃");
      record("F6", { title: SCENARIOS[5].title, ...f6, note: "色板经设置抽屉真实保存链路切换；editorial 不受玻璃收敛影响" });
    }

    // ---------- F7 manual（editorial 深色）----------
    {
      const f7 = {};
      await mustClick(pageCdp, "F7.theme-toggle-hittable", "主题切换", `document.getElementById('biliscript-reading-theme-select')`);
      try {
        await waitFor("F7：面板切到暗色档", () => pageCdp.evaluate(JS.isDark), { timeoutMs: 15000, intervalMs: 200 });
      } catch (error) {
        check("F7.dark-applied", false, { error: error.message });
      }
      check("F7.manual-reached", await ensureManual("F7"), null);
      f7.probe = await pageCdp.evaluate(JS.probe);
      const s = f7.probe?.style || {};
      const t = f7.probe?.tokens || {};
      checkEquals("F7.palette-editorial", f7.probe?.palette, "editorial");
      checkEquals("F7.theme-dark", f7.probe?.theme, "dark");
      check("F7.visible", /^(inline-)?flex$/.test(f7.probe?.display || "") && (f7.probe?.rect?.w ?? 0) > 0, { display: f7.probe?.display, rect: f7.probe?.rect });
      check("F7.hairline-border", s.borderTopWidth === "1px" && s.borderTopStyle === "solid" && s.borderTopColor === t.borderColor, { border: s.borderTopWidth + " " + s.borderTopStyle + " " + s.borderTopColor, token: t.borderColor });
      checkEquals("F7.background-is-card-color", s.backgroundColor, t.cardColor);
      checkEquals("F7.no-card-gradient", s.backgroundImage, "none");
      checkEquals("F7.no-backdrop-filter", s.backdropFilter, "none");
      check("F7.base-shadow-kept", (s.boxShadow || "").includes("rgba(0, 0, 0, 0.14) 0px 6px 22px 0px"), { boxShadow: s.boxShadow });
      await shot("07-manual-editorial-dark", "manual 态（editorial 深色）：暖炭黑书摘卡 + 细边，零滤镜零玻璃");
      record("F7", { title: SCENARIOS[6].title, ...f7, note: "editorial 深色档同样走基表细边实底" });
    }
  } catch (error) {
    evidence.scenarios.__error = { message: error.message, stack: String(error.stack || "").slice(0, 1500) };
    check("scenario-completed", false, { message: error.message });
    log(`场景执行中断：${error.message}`);
  }
}

// ===== 现场诊断 =====
async function captureDiagnostics() {
  try {
    if (pageCdp) {
      evidence.diagnostics = evidence.diagnostics || {};
      evidence.diagnostics.pageState = await pageCdp.evaluate(`(() => {
        const view = document.getElementById('biliscript-reading-view');
        const btn = document.getElementById('biliscript-reading-follow-btn');
        return {
          url: location.href,
          viewOpen: view ? view.classList.contains('open') : null,
          theme: view ? view.getAttribute('data-theme') : null,
          followAttr: view ? view.getAttribute('data-biliscript-reader-follow') : null,
          btnText: btn ? btn.textContent : null,
          btnDisplay: btn ? getComputedStyle(btn).display : null
        };
      })()`);
    }
  } catch (error) {
    evidence.diagnostics = { pageError: error.message };
  }
}

// ===== 入口 =====
if (fixtureOnly) {
  const ok = (() => {
    selfCheckFixture();
    return checks.every((c) => c.ok);
  })();
  console.log(
    JSON.stringify(
      {
        mode: "fixture-only",
        fixtureDir: path.relative(REPO_ROOT, FIXTURE_DIR),
        checks: checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail })),
        failed: checks.filter((c) => !c.ok).map((c) => c.name)
      },
      null,
      2
    )
  );
  log(`fixture 自检：${checks.filter((c) => c.ok).length}/${checks.length} 通过`);
  if (!ok) process.exitCode = 1;
} else {
  try {
    await main();
  } catch (error) {
    evidence.__fatal = { message: error.message, stack: String(error.stack || "").slice(0, 2000) };
    check("no-fatal", false, { message: error.message });
    log(`致命错误：${error.message}`);
    await captureDiagnostics();
  } finally {
    if (patchKeepAlive) {
      clearInterval(patchKeepAlive);
      patchKeepAlive = null;
    }
    try {
      if (pageCdp) await pausePageMedia();
    } catch {}
    const profileDir = browser?.profileDir;
    await teardown({ browser, cdps: [pageCdp, worker?.handle?.cdp].filter(Boolean) });
    check("profile-removed", Boolean(browser?.profileRemoved), { profileDir });
    evidence.checks = checks;
    evidence.failed = checks.filter((c) => !c.ok).map((c) => c.name);
    await writeEvidence(OUT_DIR, evidence);
    const passed = checks.length - evidence.failed.length;
    log(`结果：${passed}/${checks.length} 通过`);
    if (evidence.failed.length) {
      log(`失败项：${evidence.failed.join(", ")}`);
      process.exitCode = 1;
    }
  }
}
