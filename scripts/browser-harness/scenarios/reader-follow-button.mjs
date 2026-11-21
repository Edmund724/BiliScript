#!/usr/bin/env node

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

const SAMPLE = { bvid: "BV1mAam6tEL8", url: "https://www.bilibili.com/video/BV1mAam6tEL8/" };
const VIEWPORT = DEFAULT_VIEWPORT;
const headed = process.argv.includes("--headed");
const fixtureOnly = process.argv.includes("--fixture-only");

const SCENARIOS = [
  { id: "F1", slug: "01-auto-hidden", title: "跟随中（auto）：按钮隐藏；文案无「↓」字素" },
  { id: "F2", slug: "02-manual-light", title: "手动滚离（manual）flyme 浅色：液态玻璃胶囊（无框 + card 渐变 + 磨砂 + 折射高光浮层阴影）" },
  { id: "F3", slug: "03-hover-light", title: "hover：background/color 转 accent-soft/accent，描边保持透明" },
  { id: "F4", slug: "04-press-and-resume", title: "按压：transform 追加 press-scale；点击后回 auto 并隐藏（不 seek）" },
  { id: "F5", slug: "05-manual-dark", title: "flyme 深色档 manual：card/text token 换深色值 + 暗面阴影档" },
  { id: "F6", slug: "06-manual-editorial-light", title: "editorial 浅色 manual：基表 1px 细边 + 书摘卡实底，零滤镜零玻璃" },
  { id: "F7", slug: "07-manual-editorial-dark", title: "editorial 深色 manual：暖炭黑书摘卡 + 细边，零滤镜零玻璃" }
];

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

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail).slice(0, 320)}`}`);
  return Boolean(ok);
}
function checkEquals(name, actual, expected) {
  return check(name, actual === expected, { actual, expected });
}

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
  setEditorialPalette: `(() => {
    const sel = document.getElementById('readerPalette');
    if (!sel) return { ok: false, reason: 'palette-select-missing' };
    sel.value = 'editorial';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: sel.value === 'editorial', value: sel.value };
  })()`
};

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

async function dispatchClick(pageCdp, x, y) {
  const px = Math.round(x);
  const py = Math.round(y);
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py, button: "none", clickCount: 0 });
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: px, y: py, button: "left", buttons: 1, clickCount: 1 });
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: px, y: py, button: "left", buttons: 0, clickCount: 1 });
  return { x: px, y: py };
}

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

async function wheelSubtitleList(label) {
  const rect = await pageCdp.evaluate(JS.listRect);
  if (!rect || !rect.scrollable) {
    check(`${label}.list-scrollable`, false, rect);
    return false;
  }
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: rect.cx, y: rect.cy, deltaX: 0, deltaY: 240 });
  return true;
}

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
    {
      const f1 = {};
      f1.probe = await pageCdp.evaluate(JS.probe);
      check("F1.auto-hidden", f1.probe?.display === "none", { display: f1.probe?.display, followAttr: f1.probe?.followAttr });
      checkEquals("F1.follow-attr-auto", f1.probe?.followAttr, "auto");
      checkEquals("F1.copy-no-glyph", f1.probe?.text, "跟随播放");
      record("F1", { title: SCENARIOS[0].title, ...f1, note: "初始态：data-follow=auto ⇒ display:none；文案已是纯文字（无 ↓ 字符）" });
    }

    {
      const f2 = {};
      check("F2.manual-reached", await ensureManual("F2"), null);
      f2.probe = await pageCdp.evaluate(JS.probe);
      const s = f2.probe?.style || {};
      const t = f2.probe?.tokens || {};
      checkEquals("F2.follow-attr-manual", f2.probe?.followAttr, "manual");
      check("F2.visible", /^(inline-)?flex$/.test(f2.probe?.display || "") && (f2.probe?.rect?.w ?? 0) > 0 && (f2.probe?.rect?.h ?? 0) > 0, { display: f2.probe?.display, rect: f2.probe?.rect });
      checkEquals("F2.position-absolute", f2.probe?.style?.position, "absolute");
      checkEquals("F2.background-is-card-token", s.backgroundImage, t.cardBg);
      check("F2.card-token-is-gradient", /^linear-gradient/.test(t.cardBg || ""), { cardBg: t.cardBg });
      check("F2.frameless-border", s.borderTopWidth === "1px" && s.borderTopStyle === "solid" && s.borderTopColor === "rgba(0, 0, 0, 0)", { border: s.borderTopWidth + " " + s.borderTopStyle + " " + s.borderTopColor });
      checkEquals("F2.backdrop-blur", s.backdropFilter, "blur(20px) saturate(1.8)");
      checkEquals("F2.color-is-text-token", s.color, t.textColor);
      checkEquals("F2.radius-999", s.borderRadius, "999px");
      checkEquals("F2.font", s.fontSize + "/" + s.fontWeight, "14px/600");
      check("F2.shadow-liquid-glass", /rgba\(255, 255, 255, 0\.92\) 0px 1px 0px 0px inset/.test(s.boxShadow || "") && s.boxShadow.includes("rgba(15, 23, 42, 0.16) 0px 10px 28px -4px") && s.boxShadow.includes("rgba(15, 23, 42, 0.06) 0px 2px 6px 0px"), { boxShadow: s.boxShadow });
      check("F2.no-accent-fill", !/rgb\(0, 140, 255\)|#008cff/i.test(s.backgroundImage || "") && s.backgroundImage === t.cardBg, { backgroundImage: s.backgroundImage });
      await shot("02-manual-light", "manual 态（flyme 浅色）：液态玻璃胶囊——无框 + card 渐变 + 磨砂 + 折射高光浮层阴影");
      record("F2", { title: SCENARIOS[1].title, ...f2, note: "滚轮触发 manual；computed style 与 token 探针对齐" });
    }

    {
      const f3 = {};
      check("F3.manual-reached", await ensureManual("F3"), null);
      const p = await pageCdp.evaluate(JS.probe);
      await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.rect.cx, y: p.rect.cy, button: "none", clickCount: 0 });
      await sleep(150);
      f3.hover = await pageCdp.evaluate(JS.probe);
      const s = f3.hover?.style || {};
      const t = f3.hover?.tokens || {};
      check("F3.hover-border-stays-transparent", s.borderTopColor === "rgba(0, 0, 0, 0)", { border: s.borderTopColor });
      checkEquals("F3.hover-background-accent-soft", s.backgroundColor, t.accentSoftColor);
      checkEquals("F3.hover-color-accent", s.color, t.accentColor);
      check("F3.hover-replaces-card-gradient", s.backgroundImage === "none", { backgroundImage: s.backgroundImage });
      checkEquals("F3.hover-backdrop-persists", s.backdropFilter, "blur(20px) saturate(1.8)");
      await shot("03-hover-light", "manual 态 hover：accent-soft 底 + accent 字，描边保持透明、磨砂不撤");
      record("F3", { title: SCENARIOS[2].title, ...f3, note: "真指针 mouseMoved 触发 :hover" });
    }

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

    {
      const f6 = {};
      await mustClick(pageCdp, "F6.theme-toggle-hittable", "主题切换", `document.getElementById('biliscript-reading-theme-select')`);
      try {
        await waitFor("F6：面板切回浅色档", () => pageCdp.evaluate(JS.isLight), { timeoutMs: 15000, intervalMs: 200 });
      } catch (error) {
        check("F6.light-applied", false, { error: error.message });
      }
      await mustClick(pageCdp, "F6.settings-open-hittable", "设置", `document.getElementById('biliscript-reading-settings-btn')`);
      try {
        await waitFor("F6：设置抽屉展开", () => pageCdp.evaluate(JS.settingsPanelOpen), { timeoutMs: 8000, intervalMs: 150 });
      } catch (error) {
        check("F6.settings-open", false, { error: error.message });
      }
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
      check("F6.base-shadow-kept", (s.boxShadow || "").includes("rgba(0, 0, 0, 0.14) 0px 6px 22px 0px"), { boxShadow: s.boxShadow });
      await shot("06-manual-editorial-light", "manual 态（editorial 浅色）：1px 暖沙细边 + 书摘卡实底，零滤镜零玻璃");
      record("F6", { title: SCENARIOS[5].title, ...f6, note: "色板经设置抽屉真实保存链路切换；editorial 不受玻璃收敛影响" });
    }

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
