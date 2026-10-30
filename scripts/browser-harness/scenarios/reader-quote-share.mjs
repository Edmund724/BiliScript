#!/usr/bin/env node
// 分享金句卡片弹窗真机场景 —— `pnpm harness:scenario reader-quote-share`。
//
// 判据（为什么在真机上跑）：弹窗形态是「与阅读面板同一套 token」的产物——
// 容器 28px 圆角/superellipse(1.25)/面板阴影/mask 纱、关闭键 34×34 幽灵键（hover 与
// focus-visible 同吃 fill-hover）、操作钮 32px 高 999px 圆角（复制透明次要、
// 保存 accent 实底 on-fill 字、主钮 hover brightness(1.05)）、preset/pattern
// 12px 圆角。分享卡本体是「白边相纸 + 16:9 内卡」：20px 连续圆角、卡内只有引号与正文、
// 相纸底栏品牌角标与左侧双段标记、卡面不再出现视频标题与时间戳，字号由共享布局按卡宽落值（非固定 clamp），
// 导出画布固定 1261×806（不随窗口宽度变化）。四象限（flyme/editorial × light/dark）
// 下这些值全部来自 --biliscript-reader-* token，computed style、真 hover/:active
// 伪类、focus-visible、busy 禁用态、真实下载与剪贴板写入全都够不着 jsdom。
// 柔光/视差/导出的像素逻辑本场景不改不判，只验「弹窗长得和面板一致、交互状态诚实」。
//
// 数据口径（诚实标注）：字幕 fixture 与 reader-follow-button 同一份 committed
// 数据（SW fetch 补丁换两个网络应答）；金句文本直接取 fixture 首句正文，经
// 扩展内容脚本上下文动态 import dist 的 reader.mjs 调真实 renderReadingOverview 渲染
// 概览 DOM，再用真指针点 .biliscript-reading-ov-quote-share 走扩展自己的事件
// 委托打开弹窗——不新增任何生产 debug API。页面本身是真 bilibili.com 视频页。
//
// 交互口径：hover/按压/点击走 Input.dispatchMouseEvent；focus-visible 走真
// Tab 键（真指针先点 preset 落焦，再 Tab 移到下一枚）；Escape 走真键击；
// 剪贴板与下载先经浏览器级 CDP 授权/指定落盘目录，再验真实写入结果
// （读回剪贴板 image/png 项 / 落盘 PNG 魔数与体积）。
//
// 硬约束：只杀自己 spawn 的进程（harness 的 teardown）；工件落
// `.scratch/browser-harness/scenarios/reader-quote-share/`；fixture 只读
// tests/fixtures/（可提交数据），场景代码里不出现 .scratch/ 路径。

import path from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";
import {
  CDP,
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

const NAME = "reader-quote-share";
const OUT_DIR = artifactDir(path.join("scenarios", NAME));
const FIXTURE_DIR = path.join(REPO_ROOT, "tests", "fixtures", "bilibili", "bilingual-walkthrough");

// 与 reader-follow-button 同一份 committed fixture（8 轨 + 197 句正文）。
const SAMPLE = { bvid: "BV1mAam6tEL8", url: "https://www.bilibili.com/video/BV1mAam6tEL8/" };
const VIEWPORT = DEFAULT_VIEWPORT;
const NARROW_VIEWPORT = { width: 420, height: 800, deviceScaleFactor: 1, mobile: false };
const headed = process.argv.includes("--headed");
const fixtureOnly = process.argv.includes("--fixture-only");

// ===== 场景清单（代码即清单）。id 同时是 evidence.json 里的键。=====
const SCENARIOS = [
  { id: "Q1", slug: "01-baseline-flyme-light", title: "flyme 浅色基线：容器 28px/superellipse(1.25)/面板阴影/mask、关闭键 34×34、操作钮 32/999、相纸 16:9 卡 20px/品牌/双段标记" },
  { id: "Q2", slug: "02-pointer", title: "真指针：close hover=fill-hover 字色不变、active scale(.91)；操作钮 hover/active" },
  { id: "Q3", slug: "03-keyboard", title: "真 Tab 键：focus-visible 底=fill-hover 字=text" },
  { id: "Q4", slug: "04-copy", title: "复制：busy 禁用 .45、is-success 字色=accent 不铺底、剪贴板真回读到 image/png" },
  { id: "Q5", slug: "05-save-png", title: "保存 PNG：真实下载落盘非空 PNG、is-success 主钮字色仍 on-fill" },
  { id: "Q6", slug: "06-close-paths", title: "三条关闭路径（关闭键/遮罩/Escape），每条后可重开" },
  { id: "Q7", slug: "07-theme-dark", title: "flyme 深色档：token 换值后弹窗同契约" },
  { id: "Q8", slug: "08-editorial-light", title: "editorial 浅色档（设置抽屉真实保存链路）：同契约" },
  { id: "Q9", slug: "09-editorial-dark", title: "editorial 深色档：同契约" },
  { id: "Q10", slug: "10-narrow-viewport", title: "窄视口：不横向溢出、全部操作可到达，恢复后几何还原" },
  { id: "Q11", slug: "11-reduced-motion", title: "prefers-reduced-motion：host/close transition none、close active transform none" }
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

// 金句数据口径：直接取 committed fixture 的首句（{from, content} 字段自带），
// 场景不另造文本；渲染进概览后再与弹窗卡片正文独立比对（复算一致）。
function pickFixtureQuote() {
  const segs = BODIES[`${SAMPLE.bvid}-zh`]?.body ?? [];
  const seg = segs.find((s) => typeof s?.from === "number" && typeof s?.content === "string" && s.content.trim()) || null;
  return seg ? { from: seg.from, content: seg.content } : null;
}
const QUOTE = pickFixtureQuote();

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
  checkEquals("fixture.meta-sample-bvid", META.sampleBvid, SAMPLE.bvid);
  check("fixture.quote-pickable", QUOTE !== null && QUOTE.content.length > 0, QUOTE);
  return checks.every((c) => c.ok);
}

// ===== 页面内测量脚本 =====
// 一次 evaluate 取全：弹窗各节点几何 + computed style + 同一棵子树上现求的
// token 探针。所有「等于当前 token」的断言都与 token 现值比，四象限都成立。
const JS = {
  // 基线全契约。corner-shape 引擎可探才断言（探针读不到时记 supported:false）。
  probe: `(() => {
    const host = document.querySelector('.biliscript-quote-share-host');
    if (!host) return { error: 'modal-not-open' };
    const dialog = host.querySelector('.biliscript-quote-share-dialog');
    const mask = host.querySelector('.biliscript-quote-share-mask');
    const close = host.querySelector('.biliscript-quote-share-close');
    const copy = host.querySelector('.biliscript-quote-copy-btn');
    const save = host.querySelector('.biliscript-quote-download-btn');
    const card = host.querySelector('.biliscript-quote-card');
    const cardText = host.querySelector('.biliscript-quote-card-text');
    const sheet = host.querySelector('.biliscript-quote-card-sheet');
    const brand = host.querySelector('.biliscript-quote-card-brand');
    const motifBars = Array.from(host.querySelectorAll('.biliscript-quote-card-motif-bar'));
    const scrim = host.querySelector('.biliscript-quote-card-scrim');
    const source = host.querySelector('.biliscript-quote-card-source');
    if (!dialog || !mask || !close || !copy || !save || !card || !cardText || !sheet || !brand) {
      return { error: 'modal-node-missing' };
    }
    const probe = document.createElement('div');
    probe.style.display = 'none';
    dialog.appendChild(probe);
    const token = (name, prop) => { probe.style[prop] = 'var(' + name + ')'; return getComputedStyle(probe)[prop]; };
    const tokens = {
      surface: token('--biliscript-reader-surface', 'backgroundColor'),
      border: token('--biliscript-reader-border', 'borderTopColor'),
      shadow: token('--biliscript-reader-shadow', 'boxShadow'),
      maskBg: token('--biliscript-reader-mask-bg', 'backgroundColor'),
      text: token('--biliscript-reader-text', 'color'),
      muted: token('--biliscript-reader-muted', 'color'),
      accent: token('--biliscript-reader-accent', 'backgroundColor'),
      accentSoft: token('--biliscript-reader-accent-soft', 'backgroundColor'),
      onFill: token('--biliscript-reader-on-fill', 'color'),
      fillHover: token('--biliscript-reader-fill-hover', 'backgroundColor'),
      surface2: token('--biliscript-reader-surface-2', 'backgroundColor'),
      fineBorder: token('--biliscript-reader-fine-border', 'boxShadow')
    };
    // 淡入过渡期望值：同一探针吃上 duration/ease 两个 token 后的计算值
    probe.style.transition = 'opacity var(--biliscript-reader-duration-base) var(--biliscript-reader-ease-out)';
    tokens.hostTransition = getComputedStyle(probe).transition;
    probe.remove();
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { w: +r.width.toFixed(2), h: +r.height.toFixed(2), left: +r.left.toFixed(2), right: +r.right.toFixed(2), top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2), cx: +(r.left + r.width / 2).toFixed(1), cy: +(r.top + r.height / 2).toFixed(1) };
    };
    const csDialog = getComputedStyle(dialog);
    const csClose = getComputedStyle(close);
    const csCopy = getComputedStyle(copy);
    const csSave = getComputedStyle(save);
    const csCard = getComputedStyle(card);
    const csCardText = getComputedStyle(cardText);
    const csMask = getComputedStyle(mask);
    const csSheet = getComputedStyle(sheet);
    const csBrand = getComputedStyle(brand);
    const csScrim = scrim ? getComputedStyle(scrim) : null;
    const presetBtn = host.querySelector('.biliscript-quote-preset-btn.is-active');
    const patternBtn = host.querySelector('.biliscript-quote-pattern-btn.is-active');
    const cornerShape = csDialog.cornerShape || csDialog.getPropertyValue('corner-shape') || '';
    return {
      view: (() => { const v = document.getElementById('biliscript-reading-view'); return v ? { theme: v.getAttribute('data-theme'), palette: v.getAttribute('data-palette') } : null; })(),
      rects: { dialog: rect(dialog), close: rect(close), copy: rect(copy), save: rect(save), card: rect(card), text: rect(cardText), sheet: rect(sheet), brand: rect(brand), preset: presetBtn ? rect(presetBtn) : null, pattern: patternBtn ? rect(patternBtn) : null },
      sheet: { backgroundColor: csSheet.backgroundColor },
      brand: { text: brand.textContent.trim(), color: csBrand.color, fontWeight: csBrand.fontWeight, fontSize: csBrand.fontSize },
      scrim: scrim ? { backgroundColor: csScrim.backgroundColor } : null,
      motif: motifBars.length ? {
        count: motifBars.length,
        bars: motifBars.map((el) => ({
          ...rect(el),
          color: getComputedStyle(el).backgroundColor,
          radius: getComputedStyle(el).borderRadius
        }))
      } : null,
      hasSourceTitle: !!source,
      hasTimestamp: !!host.querySelector('.biliscript-quote-card-timestamp'),
      dialog: {
        backgroundColor: csDialog.backgroundColor,
        borderTopColor: csDialog.borderTopColor,
        borderRadius: csDialog.borderRadius,
        boxShadow: csDialog.boxShadow,
        cornerShape: String(cornerShape).trim(),
        transition: getComputedStyle(host).transition
      },
      mask: { backgroundColor: csMask.backgroundColor },
      close: {
        width: csClose.width, height: csClose.height, borderRadius: csClose.borderRadius,
        backgroundColor: csClose.backgroundColor, color: csClose.color, transform: csClose.transform,
        transition: csClose.transition,
        svgW: close.querySelector('svg') ? getComputedStyle(close.querySelector('svg')).width : null
      },
      copy: { height: csCopy.height, borderRadius: csCopy.borderRadius, backgroundColor: csCopy.backgroundColor, color: csCopy.color, opacity: csCopy.opacity },
      save: { height: csSave.height, borderRadius: csSave.borderRadius, backgroundColor: csSave.backgroundColor, color: csSave.color, filter: csSave.filter, fontWeight: csSave.fontWeight },
      card: {
        borderRadius: csCard.borderRadius,
        fontSize: csCardText.fontSize,
        fitSize: card.style.getPropertyValue('--quote-fit-size').trim(),
        fontFamily: csCardText.fontFamily,
        fontVariantNumeric: csCardText.fontVariantNumeric,
        textAlign: csCardText.textAlign,
        text: cardText.textContent,
        preset: card.dataset.preset,
        pattern: card.dataset.pattern,
        boxShadow: csCard.boxShadow
      },
      preset: presetBtn ? (() => { const cs = getComputedStyle(presetBtn); return { borderRadius: cs.borderRadius, backgroundColor: cs.backgroundColor, color: cs.color, fontWeight: cs.fontWeight, borderTopWidth: cs.borderTopWidth, boxShadow: cs.boxShadow, count: host.querySelectorAll('.biliscript-quote-preset-btn').length }; })() : null,
      pattern: patternBtn ? (() => { const cs = getComputedStyle(patternBtn); return { borderRadius: cs.borderRadius, backgroundColor: cs.backgroundColor, color: cs.color, fontWeight: cs.fontWeight, borderTopWidth: cs.borderTopWidth, boxShadow: cs.boxShadow, count: host.querySelectorAll('.biliscript-quote-pattern-btn').length }; })() : null,
      tokens
    };
  })()`,
  modalOpen: `!!document.querySelector('.biliscript-quote-share-host')`,
  pauseMedia: `(() => {
    const media = [...document.querySelectorAll('video,audio')];
    const wasPlaying = media.filter(m => !m.paused).length;
    media.forEach(m => { try { m.pause(); } catch {} });
    return { wasPlaying };
  })()`,
  isDark: `document.getElementById('biliscript-reading-view').getAttribute('data-theme') === 'dark'`,
  isLight: `document.getElementById('biliscript-reading-view').getAttribute('data-theme') !== 'dark'`,
  isEditorial: `document.getElementById('biliscript-reading-view').getAttribute('data-palette') === 'editorial'`,
  settingsPanelOpen: `(() => { const p = document.getElementById('biliscript-reading-settings-panel'); return !!p && !p.hidden; })()`,
  overviewBodyActive: `(() => { const b = document.getElementById('biliscript-reading-tabbody-overview'); return !!b && b.classList.contains('is-active') && !b.hidden; })()`,
  setEditorialPalette: `(() => {
    const sel = document.getElementById('readerPalette');
    if (!sel) return { ok: false, reason: 'palette-select-missing' };
    sel.value = 'editorial';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: sel.value === 'editorial', value: sel.value };
  })()`
};

// 经 reader.mjs 的 renderReadingOverview 渲染一条真实概览（quotes 取 fixture 首句），
// 并确认分享钮已上屏。overview 宿主 id 是 shared/dom-ids 的契约。READER_URL 在
// 扩展 ID 推导后于 Node 侧拼好再嵌进表达式（页面全局量经不起 SPA 导航，不用）。
let READER_URL = null;
const contentScriptContexts = new Set();
let readerContextId = null;

async function evaluateInContentScript(expression, contextId = readerContextId) {
  const result = await pageCdp.send("Runtime.evaluate", {
    expression,
    contextId,
    awaitPromise: true,
    returnByValue: true
  });
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result?.result?.value;
}

async function findContentScriptContext() {
  for (const contextId of contentScriptContexts) {
    try {
      const available = await evaluateInContentScript(
        `typeof chrome === 'object' && typeof chrome.runtime?.getURL === 'function'`,
        contextId
      );
      if (available) {
        readerContextId = contextId;
        return contextId;
      }
    } catch {}
  }
  return null;
}

function renderOverviewExpression(quote) {
  return `(() => {
    const body = document.getElementById('biliscript-reading-overview-body');
    if (!body) return { ok: false, reason: 'overview-body-missing' };
    const apply = (mod) => {
      mod.renderReadingOverview({
        phase: 'ready',
        analysis: { chapters: [], quotes: [${JSON.stringify(quote)}] },
        aiChapters: false,
        chapterSourceKind: 'auto',
        progressText: '',
        errorText: '',
        stripText: '',
        generatedFor: ''
      });
      return !!body.querySelector('.biliscript-reading-ov-quote-share');
    };
    if (globalThis.__biliscriptReaderMod) {
      return { ok: apply(globalThis.__biliscriptReaderMod), via: 'cache' };
    }
    return import(${JSON.stringify(READER_URL)})
      .then((mod) => { globalThis.__biliscriptReaderMod = mod; return { ok: apply(mod), via: 'import' }; })
      .catch((err) => ({ ok: false, reason: String(err && err.message || err) }));
  })()`;
}

// ===== SW fetch 补丁（与 reader-follow-button 同口径，只换两个网络应答）=====
function fixturePatchExpression() {
  return `(() => {
    const FIX = ${JSON.stringify({ bundles: BUNDLES, bodies: BODIES })};
    const g = globalThis;
    if (!g.__quoteShareHarness) {
      g.__quoteShareHarness = { bundles: FIX.bundles, bodies: FIX.bodies, hits: [] };
      const orig = g.fetch.bind(g);
      g.fetch = async (input, init) => {
        const st = g.__quoteShareHarness;
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
      g.__quoteShareHarness.bundles = FIX.bundles;
      g.__quoteShareHarness.bodies = FIX.bodies;
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

async function movePointer(pageCdp, x, y) {
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x), y: Math.round(y), button: "none", clickCount: 0 });
}

// 命中体检（不点击）：目标当场有几何、在视口内、elementFromPoint 命中本身。
async function hitTestElement(pageCdp, label, locateExpr, viewport) {
  const vw = viewport?.width ?? VIEWPORT.width;
  const vh = viewport?.height ?? VIEWPORT.height;
  return pageCdp.evaluate(`(() => {
    const el = ${locateExpr};
    if (!el) return { ok: false, label: ${JSON.stringify(label)}, reason: 'not-found' };
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return {
      ok: r.width > 0 && r.height > 0 && cx >= 0 && cy >= 0 && cx <= ${vw} && cy <= ${vh} && !!hit && (hit === el || el.contains(hit)),
      label: ${JSON.stringify(label)},
      rect: { w: +r.width.toFixed(2), h: +r.height.toFixed(2) },
      center: { x: +cx.toFixed(1), y: +cy.toFixed(1) },
      hitTag: hit ? hit.tagName + '.' + String(hit.className || '').slice(0, 40) : null
    };
  })()`);
}

// 点击一个「按表达式定位」的元素；点击前先做命中体检，不合格记 FAIL 不点空。
async function clickElement(pageCdp, label, locateExpr, viewport) {
  const info = await hitTestElement(pageCdp, label, locateExpr, viewport);
  if (!info?.ok) return { ok: false, label, ...info };
  await dispatchClick(pageCdp, info.center.x, info.center.y);
  return { ok: true, label, rect: info.rect };
}

async function mustClick(pageCdp, checkName, label, locateExpr, viewport) {
  const result = await clickElement(pageCdp, label, locateExpr, viewport);
  check(checkName, result.ok === true, result.ok ? { label } : result);
  return result;
}

// 按下不抬起期间用 rAF 连续采样某节点的 computed 属性，采完把指针移到 neutral
// 再抬起（落在非目标点，click 不触发）——用于 :active 读数而不触发真实点击。
async function sampleWhilePressed(pageCdp, x, y, sampleExpr, durationMs = 200) {
  await movePointer(pageCdp, x, y);
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x), y: Math.round(y), button: "left", buttons: 1, clickCount: 1 });
  const samples = await pageCdp.evaluate(`(() => new Promise((resolve) => {
    const sample = () => ${sampleExpr};
    const samples = [];
    const started = Date.now();
    const timer = setInterval(() => {
      samples.push(sample());
      if (Date.now() - started >= ${durationMs}) {
        clearInterval(timer);
        resolve(samples);
      }
    }, 16);
  }))()`);
  await movePointer(pageCdp, 8, 8);
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 8, y: 8, button: "left", buttons: 0, clickCount: 1 });
  return samples;
}

async function pressKey(pageCdp, key, code, vk, modifiers = 0) {
  await pageCdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code, key, modifiers });
  await pageCdp.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code, key, modifiers });
}

// 弹窗开着就走真 Escape 关闭（顺手也是关闭路径的一致性维护），保持扩展内部
// modal 状态与 DOM 一致——后续 openQuoteShareModal 的「先关后开」才干净。
async function closeModalIfOpen(label) {
  if (!(await pageCdp.evaluate(JS.modalOpen))) return;
  await pressKey(pageCdp, "Escape", "Escape", 27);
  await expectModalClosed(label);
}

async function pausePageMedia() {
  try {
    return await pageCdp.evaluate(JS.pauseMedia);
  } catch (error) {
    return { error: error.message };
  }
}

// ===== 主流程状态 =====
const evidence = {
  meta: {
    startedAt: new Date().toISOString(),
    scenario: NAME,
    dist: DEFAULT_DIST,
    viewport: VIEWPORT,
    narrowViewport: NARROW_VIEWPORT,
    sampleUrl: SAMPLE.url,
    quote: QUOTE,
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
let browserCdp = null;
let pageCdp = null;
let worker = null;
let patchKeepAlive = null;
let fixturePatchEnabled = false;
let extensionId = null;

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
        const alive = await worker.evaluate(`(globalThis.__quoteShareHarness ? 'alive' : 'gone')`, 8000);
        if (alive !== "alive") {
          await installFixturePatch();
          log("fixture 补丁已随 SW 重启重打");
        }
      } catch {}
    })();
  }, 1500);
  patchKeepAlive.unref?.();
}

// 打开弹窗的唯一入口：渲染真实概览（fixture 金句）→ 真指针点分享钮。
// 概览 tab 被激活后协调器可能自己去跑真实 AI 生成，失败/落位都会整块重渲染
// 盖掉我们注入的快照——所以渲染与点击之间只隔一瞬，没开成就连渲染带点击重试，
// 尝试次数如实进 evidence。
async function openModalViaQuote(label) {
  const attempts = [];
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const rendered = await evaluateInContentScript(renderOverviewExpression(QUOTE));
    attempts.push({ attempt, rendered });
    if (!rendered?.ok) {
      await sleep(400);
      continue;
    }
    try {
      await waitFor(`${label}：分享钮上屏`, async () =>
        pageCdp.evaluate(`!!document.querySelector('#biliscript-reading-overview-body .biliscript-reading-ov-quote-share')`),
        { timeoutMs: 2500, intervalMs: 100 });
    } catch {
      continue;
    }
    // 窄视口下分享钮可能落在概览滚动区可视区外：先滚到中间（等同用户滚动），再体检点击
    await pageCdp.evaluate(`(() => { const el = document.querySelector('#biliscript-reading-overview-body .biliscript-reading-ov-quote-share'); if (el) el.scrollIntoView({ block: 'center' }); })()`);
    const hit = await clickElement(pageCdp, "分享金句卡片", `document.querySelector('#biliscript-reading-overview-body .biliscript-reading-ov-quote-share')`);
    attempts[attempts.length - 1].click = hit;
    if (!hit.ok) continue;
    try {
      await waitFor(`${label}：弹窗打开`, () => pageCdp.evaluate(JS.modalOpen), { timeoutMs: 3000, intervalMs: 120 });
      return { ok: true, attempts };
    } catch {
      // 点击没落上（快照被协调器重渲染替换）→ 下一轮重试
    }
  }
  return { ok: false, attempts };
}

async function expectModalOpen(label) {
  const opened = await openModalViaQuote(label);
  check(`${label}.modal-opened`, opened.ok === true, opened.ok ? { attempts: opened.attempts.length } : opened);
  return opened.ok;
}

async function expectModalClosed(label) {
  let closed = false;
  try {
    await waitFor(`${label}：弹窗关闭`, async () => !(await pageCdp.evaluate(JS.modalOpen)), { timeoutMs: 4000, intervalMs: 120 });
    closed = true;
  } catch {}
  check(`${label}.modal-closed`, closed, null);
  return closed;
}

// 主题/色板切换（与 reader-follow-button 同链路：header 主题键真指针 +
// 设置抽屉色板 select 走真实保存链路）。
async function switchTheme(label, target /* 'dark' | 'light' */) {
  const probe = target === "dark" ? JS.isDark : JS.isLight;
  await mustClick(pageCdp, `${label}.theme-toggle-hittable`, "主题切换", `document.getElementById('biliscript-reading-theme-select')`);
  try {
    await waitFor(`${label}：主题切到 ${target}`, () => pageCdp.evaluate(probe), { timeoutMs: 15000, intervalMs: 200 });
    return true;
  } catch (error) {
    check(`${label}.theme-${target}-applied`, false, { error: error.message });
    return false;
  }
}

async function switchPaletteEditorial(label) {
  await mustClick(pageCdp, `${label}.settings-open-hittable`, "设置", `document.getElementById('biliscript-reading-settings-btn')`);
  try {
    await waitFor(`${label}：设置抽屉展开`, () => pageCdp.evaluate(JS.settingsPanelOpen), { timeoutMs: 8000, intervalMs: 150 });
  } catch (error) {
    check(`${label}.settings-open`, false, { error: error.message });
    return false;
  }
  try {
    await waitFor(`${label}：色板下拉挂载`, () => pageCdp.evaluate(`!!document.getElementById('readerPalette')`), { timeoutMs: 10000, intervalMs: 200 });
  } catch (error) {
    check(`${label}.palette-select-mounted`, false, { error: error.message });
    return false;
  }
  const set = await pageCdp.evaluate(JS.setEditorialPalette);
  check(`${label}.palette-select-set`, set?.ok === true, set);
  try {
    await waitFor(`${label}：视图切到 editorial`, () => pageCdp.evaluate(JS.isEditorial), { timeoutMs: 15000, intervalMs: 200 });
  } catch (error) {
    check(`${label}.editorial-applied`, false, { error: error.message });
    return false;
  }
  await mustClick(pageCdp, `${label}.settings-close-hittable`, "设置", `document.getElementById('biliscript-reading-settings-btn')`);
  return true;
}

// 某一主题档下的弹窗契约探针（token 对齐子集；Q1 已覆盖完整几何档）。
async function probeThemedModal(label) {
  const p = await pageCdp.evaluate(JS.probe);
  const s = p?.dialog || {};
  const t = p?.tokens || {};
  const borderless = p?.view?.palette !== "editorial";
  check(`${label}.dialog-radius-28`, s.borderRadius === "28px", { borderRadius: s.borderRadius });
  check(`${label}.dialog-bg-is-surface-token`, p && s.backgroundColor === t.surface, { bg: s.backgroundColor, token: t.surface });
  check(
    `${label}.dialog-border-${borderless ? "transparent" : "is-token"}`,
    p && s.borderTopColor === (borderless ? "rgba(0, 0, 0, 0)" : t.border),
    { border: s.borderTopColor, token: borderless ? null : t.border }
  );
  check(`${label}.dialog-shadow-is-token`, p && s.boxShadow === t.shadow, { shadow: s.boxShadow, token: t.shadow });
  check(`${label}.mask-is-token`, p && p.mask?.backgroundColor === t.maskBg, { mask: p?.mask?.backgroundColor, token: t.maskBg });
  check(`${label}.close-color-is-text-token`, p && p.close?.color === t.text, { color: p?.close?.color, token: t.text });
  check(`${label}.save-bg-is-accent`, p && p.save?.backgroundColor === t.accent, { bg: p?.save?.backgroundColor, token: t.accent });
  check(`${label}.save-color-is-on-fill`, p && p.save?.color === t.onFill, { color: p?.save?.color, token: t.onFill });
  check(`${label}.card-radius-20`, p && p.card?.borderRadius === "20px", { borderRadius: p?.card?.borderRadius });
  return p;
}

// ===== 主流程 =====
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

  // 浏览器级 CDP 会话（/json/version 的 ws）：剪贴板授权与下载落盘目录。
  // CDP 客户端类是 harness 的导出，这是复用不是第二份实现。
  try {
    const version = await (await fetch(`http://127.0.0.1:${browser.port}/json/version`)).json();
    browserCdp = await CDP.connect(version.webSocketDebuggerUrl);
    evidence.meta.browserWs = true;
  } catch (error) {
    evidence.meta.browserWs = false;
    evidence.meta.browserWsError = error.message;
    log(`浏览器级 CDP 连不上：${error.message}（剪贴板/下载授权将不可用）`);
  }

  const page = await attachPage(browser, { viewport: VIEWPORT });
  pageCdp = page.cdp;
  pageCdp.on("Runtime.executionContextCreated", ({ context }) => {
    if (context.auxData?.isDefault === false) contentScriptContexts.add(context.id);
  });
  pageCdp.on("Runtime.executionContextDestroyed", ({ executionContextId }) => {
    contentScriptContexts.delete(executionContextId);
    if (readerContextId === executionContextId) readerContextId = null;
  });
  pageCdp.on("Runtime.executionContextsCleared", () => {
    contentScriptContexts.clear();
    readerContextId = null;
  });
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

  // 扩展 ID 从 SW URL 推导（chrome-extension://<id>/entry/background.js）
  const swUrl = worker.handle?.url || "";
  const idMatch = swUrl.match(/chrome-extension:\/\/([a-z]+)\//);
  extensionId = idMatch ? idMatch[1] : null;
  check("extension-id-derived", extensionId !== null, { swUrl });
  READER_URL = `chrome-extension://${extensionId}/entry/chunks/reader.mjs`;

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

  // 先切到概览 tab 确保分享钮几何可见（真指针点 tab）
  await mustClick(pageCdp, "overview-tab-hittable", "概览 tab", `document.getElementById('biliscript-reading-tab-overview')`);
  try {
    await waitFor("概览 tab 激活", () => pageCdp.evaluate(JS.overviewBodyActive), { timeoutMs: 8000, intervalMs: 150 });
  } catch (error) {
    check("overview-tab-active", false, { error: error.message });
  }
  await pausePageMedia();

  await waitFor("扩展内容脚本执行上下文", findContentScriptContext, { timeoutMs: 15000, intervalMs: 200 });
  evidence.meta.readerContextId = readerContextId;
  const importProbe = await evaluateInContentScript(`import(${JSON.stringify(READER_URL)}).then(m => ({ ok: typeof m.renderReadingOverview === 'function' })).catch(e => ({ ok: false, reason: String(e && e.message || e) }))`);
  check("reader-module-importable", importProbe?.ok === true, importProbe);

  try {
    // ---------- Q1 flyme 浅色基线 ----------
    {
      const q1 = {};
      await expectModalOpen("Q1");
      await movePointer(pageCdp, 2, 2);
      await sleep(120);
      q1.probe = await pageCdp.evaluate(JS.probe);
      const s = q1.probe?.dialog || {};
      const t = q1.probe?.tokens || {};
      checkEquals("Q1.view-theme-light", q1.probe?.view?.theme, "light");
      checkEquals("Q1.view-palette-flyme", q1.probe?.view?.palette ?? "flyme", "flyme");
      checkEquals("Q1.dialog-radius-28", s.borderRadius, "28px");
      if (s.cornerShape) {
        check("Q1.dialog-corner-shape-continuous", s.cornerShape === "superellipse(1.25)", { actual: s.cornerShape, expected: "superellipse(1.25)" });
      } else {
        q1.cornerShape = "unsupported（引擎不返回 corner-shape 计算值，按需求不硬断言）";
        log("corner-shape 计算值探不到，Q1.corner-shape 记为边界不判");
      }
      check("Q1.dialog-bg-is-surface-token", s.backgroundColor === t.surface, { bg: s.backgroundColor, token: t.surface });
      check("Q1.dialog-border-transparent", s.borderTopColor === "rgba(0, 0, 0, 0)", { border: s.borderTopColor });
      check("Q1.dialog-shadow-is-token", s.boxShadow === t.shadow, { shadow: s.boxShadow, token: t.shadow });
      check("Q1.mask-is-token", q1.probe?.mask?.backgroundColor === t.maskBg, { mask: q1.probe?.mask?.backgroundColor, token: t.maskBg });
      check("Q1.host-transition-uses-panel-tokens", s.transition === t.hostTransition, { transition: s.transition, token: t.hostTransition });
      // 关闭键
      check("Q1.close-size-34x34", q1.probe?.close?.width === "34px" && q1.probe?.close?.height === "34px", { w: q1.probe?.close?.width, h: q1.probe?.close?.height });
      checkEquals("Q1.close-svg-18", q1.probe?.close?.svgW, "18px");
      checkEquals("Q1.close-radius-28", q1.probe?.close?.borderRadius, "28px");
      checkEquals("Q1.close-color-is-text-token", q1.probe?.close?.color, t.text);
      check("Q1.close-bg-transparent", q1.probe?.close?.backgroundColor === "rgba(0, 0, 0, 0)", { bg: q1.probe?.close?.backgroundColor });
      // 操作钮
      checkEquals("Q1.copy-height-32", q1.probe?.copy?.height, "32px");
      checkEquals("Q1.copy-radius-999", q1.probe?.copy?.borderRadius, "999px");
      check("Q1.copy-transparent-secondary", q1.probe?.copy?.backgroundColor === "rgba(0, 0, 0, 0)" && q1.probe?.copy?.color === t.muted, { bg: q1.probe?.copy?.backgroundColor, color: q1.probe?.copy?.color, token: t.muted });
      checkEquals("Q1.save-height-32", q1.probe?.save?.height, "32px");
      checkEquals("Q1.save-radius-999", q1.probe?.save?.borderRadius, "999px");
      check("Q1.save-accent-primary", q1.probe?.save?.backgroundColor === t.accent && q1.probe?.save?.color === t.onFill, { bg: q1.probe?.save?.backgroundColor, color: q1.probe?.save?.color, accent: t.accent, onFill: t.onFill });
      checkEquals("Q1.save-font-weight-600", q1.probe?.save?.fontWeight, "600");
      // preset / pattern
      checkEquals("Q1.preset-radius-12", q1.probe?.preset?.borderRadius, "12px");
      checkEquals("Q1.preset-count-6", q1.probe?.preset?.count, 6);
      checkEquals("Q1.pattern-radius-12", q1.probe?.pattern?.borderRadius, "12px");
      check("Q1.pattern-count-positive", (q1.probe?.pattern?.count ?? 0) > 0, { count: q1.probe?.pattern?.count });
      for (const kind of ["preset", "pattern"]) {
        const pill = q1.probe?.[kind];
        check(`Q1.${kind}-active-colors-use-tokens`, pill?.backgroundColor === t.accentSoft && pill?.color === t.accent, { bg: pill?.backgroundColor, color: pill?.color, accentSoft: t.accentSoft, accent: t.accent });
        checkEquals(`Q1.${kind}-active-font-weight-600`, pill?.fontWeight, "600");
        check(`Q1.${kind}-active-has-no-border-or-shadow`, pill?.borderTopWidth === "0px" && pill?.boxShadow === "none", { borderTopWidth: pill?.borderTopWidth, boxShadow: pill?.boxShadow });
      }
      // 卡片本体：白边相纸 + 16:9 卡 + 底栏品牌，卡面不带视频标题与时间戳
      checkEquals("Q1.card-radius-20", q1.probe?.card?.borderRadius, "20px");
      const cardRect = q1.probe?.rects?.card;
      const sheetRect = q1.probe?.rects?.sheet;
      const textRect = q1.probe?.rects?.text;
      const brandRect = q1.probe?.rects?.brand;
      check("Q1.card-ratio-16x9", !!cardRect && Math.abs(cardRect.h / cardRect.w - 9 / 16) < 0.01, { cardRect });
      checkEquals("Q1.sheet-white", q1.probe?.sheet?.backgroundColor, "rgb(255, 255, 255)");
      check("Q1.sheet-ratio", !!sheetRect && Math.abs(sheetRect.h / sheetRect.w - 0.6395) < 0.01, { sheetRect });
      check("Q1.sheet-wraps-card", !!sheetRect && !!cardRect && sheetRect.left <= cardRect.left + 0.5 && sheetRect.top <= cardRect.top + 0.5 && sheetRect.bottom >= cardRect.bottom - 0.5, { sheetRect, cardRect });
      const fitSize = parseFloat(q1.probe?.card?.fitSize || "0");
      const fontSize = parseFloat(q1.probe?.card?.fontSize || "0");
      check("Q1.card-font-fitted", fitSize > 0 && Math.abs(fitSize - fontSize) < 0.06 && fontSize <= 21.1, { fontSize, fitSize });
      check("Q1.card-system-serif-lining-nums", q1.probe?.card?.fontFamily?.startsWith("Georgia") && q1.probe?.card?.fontVariantNumeric === "lining-nums", { family: q1.probe?.card?.fontFamily, numeric: q1.probe?.card?.fontVariantNumeric });
      checkEquals("Q1.card-text-left", q1.probe?.card?.textAlign, "left");
      check("Q1.card-text-inside-card", !!textRect && !!cardRect && textRect.top >= cardRect.top && textRect.bottom <= cardRect.bottom, { textRect, cardRect });
      check("Q1.card-text-matches-fixture-quote", q1.probe?.card?.text === QUOTE?.content, { cardText: q1.probe?.card?.text, fixture: QUOTE?.content });
      check("Q1.card-has-no-video-title", q1.probe?.hasSourceTitle === false, { hasSourceTitle: q1.probe?.hasSourceTitle });
      check("Q1.card-has-no-timestamp", q1.probe?.hasTimestamp === false, { hasTimestamp: q1.probe?.hasTimestamp });
      checkEquals("Q1.brand-wordmark", q1.probe?.brand?.text, "BiliScript");
      check("Q1.brand-ink-and-weight", q1.probe?.brand?.color === "rgb(23, 24, 26)" && q1.probe?.brand?.fontWeight === "600", { color: q1.probe?.brand?.color, weight: q1.probe?.brand?.fontWeight });
      check("Q1.brand-in-bottom-band", !!brandRect && !!cardRect && !!sheetRect && brandRect.top >= cardRect.bottom - 0.5 && brandRect.bottom <= sheetRect.bottom + 0.5, { brandRect, cardRect, sheetRect });
      const bars = q1.probe?.motif?.bars ?? [];
      const [lead, track] = bars;
      checkEquals("Q1.motif-two-bars", q1.probe?.motif?.count, 2);
      checkEquals("Q1.motif-lead-rose", lead?.color, "rgb(224, 74, 117)");
      checkEquals("Q1.motif-track-gray", track?.color, "rgb(233, 235, 239)");
      check("Q1.motif-pill-radius", !!lead && !!track && lead.radius === track.radius && parseFloat(lead.radius) >= lead.h / 2 - 0.01, { lead: lead?.radius, track: track?.radius });
      check("Q1.motif-aligns-card-left", !!lead && !!cardRect && Math.abs(lead.left - cardRect.left) <= 1, { leadLeft: lead?.left, cardLeft: cardRect?.left });
      check("Q1.motif-bar-proportions", !!lead && !!track && !!cardRect &&
        Math.abs(lead.h / cardRect.w - 5 / 408) < 0.002 &&
        Math.abs(lead.w / cardRect.w - 16 / 408) < 0.003 &&
        Math.abs(track.w / cardRect.w - 36 / 408) < 0.003, { lead, track, cardW: cardRect?.w });
      check("Q1.motif-on-band-centerline", !!lead && !!track && !!cardRect && !!sheetRect &&
        Math.abs((lead.top + lead.h / 2) - (cardRect.bottom + (sheetRect.bottom - cardRect.bottom) / 2)) <= 1 &&
        Math.abs(track.top - lead.top) <= 0.5, { lead, track, cardRect, sheetRect });
      checkEquals("Q1.scrim-16", q1.probe?.scrim?.backgroundColor, "rgba(0, 0, 0, 0.16)");
      await shot("01-baseline-flyme-light", "flyme 浅色基线：弹窗与面板同 token（28px/superellipse(1.25)/面板阴影/mask）");
      record("Q1", { title: SCENARIOS[0].title, ...q1, note: "基线全契约；金句文本与 fixture 独立比对一致" });
    }

    // ---------- Q2 真指针 hover / active ----------
    {
      const q2 = {};
      const close = await pageCdp.evaluate(`(() => { const el = document.querySelector('.biliscript-quote-share-close'); const r = el.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
      // close hover：底=fill-hover 且字色不变
      await movePointer(pageCdp, close.cx, close.cy);
      await sleep(150);
      q2.closeHover = await pageCdp.evaluate(`(() => { const b = document.querySelector('.biliscript-quote-share-close'); const cs = getComputedStyle(b); return { bg: cs.backgroundColor, color: cs.color }; })()`);
      const tHover = (await pageCdp.evaluate(JS.probe))?.tokens || {};
      check("Q2.close-hover-bg-fill-hover", q2.closeHover?.bg === tHover.fillHover, { bg: q2.closeHover?.bg, token: tHover.fillHover });
      check("Q2.close-hover-color-unchanged", q2.closeHover?.color === tHover.text, { color: q2.closeHover?.color, token: tHover.text });
      // close active scale(.91)：按下采样，抬在空处（不触发关闭）
      q2.closeActive = await sampleWhilePressed(pageCdp, close.cx, close.cy, `getComputedStyle(document.querySelector('.biliscript-quote-share-close')).transform`, 200);
      check("Q2.close-active-scale-91", (q2.closeActive || []).some((v) => String(v).startsWith("matrix(0.91")), { samples: q2.closeActive });
      check("Q2.modal-stays-open-after-sampled-press", await pageCdp.evaluate(JS.modalOpen), null);
      // 操作钮 hover
      const centers = await pageCdp.evaluate(`(() => {
        const r = (sel) => { const el = document.querySelector(sel); const b = el.getBoundingClientRect(); return { cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; };
        return { copy: r('.biliscript-quote-copy-btn'), save: r('.biliscript-quote-download-btn') };
      })()`);
      await movePointer(pageCdp, centers.copy.cx, centers.copy.cy);
      await sleep(150);
      q2.copyHover = await pageCdp.evaluate(`(() => { const cs = getComputedStyle(document.querySelector('.biliscript-quote-copy-btn')); return { bg: cs.backgroundColor, color: cs.color }; })()`);
      const tCopy = (await pageCdp.evaluate(JS.probe))?.tokens || {};
      check("Q2.copy-hover-bg-fill-hover", q2.copyHover?.bg === tCopy.fillHover, { bg: q2.copyHover?.bg, token: tCopy.fillHover });
      check("Q2.copy-hover-color-text", q2.copyHover?.color === tCopy.text, { color: q2.copyHover?.color, token: tCopy.text });
      await movePointer(pageCdp, centers.save.cx, centers.save.cy);
      await sleep(150);
      q2.saveHover = await pageCdp.evaluate(`(() => { const cs = getComputedStyle(document.querySelector('.biliscript-quote-download-btn')); return { filter: cs.filter, color: cs.color }; })()`);
      checkEquals("Q2.save-hover-filter-brightness", q2.saveHover?.filter, "brightness(1.05)");
      checkEquals("Q2.save-hover-color-on-fill", q2.saveHover?.color, tCopy.onFill);
      // 操作钮 active：次要钮底=surface-2；主钮按压字色仍 on-fill（无破坏性变化）
      q2.copyActive = await sampleWhilePressed(pageCdp, centers.copy.cx, centers.copy.cy, `(() => { const cs = getComputedStyle(document.querySelector('.biliscript-quote-copy-btn')); return cs.backgroundColor; })()`, 160);
      const tActive = (await pageCdp.evaluate(JS.probe))?.tokens || {};
      check("Q2.copy-active-bg-surface-2", (q2.copyActive || []).some((v) => v === tActive.surface2), { samples: q2.copyActive, token: tActive.surface2 });
      q2.saveActive = await sampleWhilePressed(pageCdp, centers.save.cx, centers.save.cy, `(() => { const cs = getComputedStyle(document.querySelector('.biliscript-quote-download-btn')); return cs.color; })()`, 160);
      check("Q2.save-active-color-on-fill", (q2.saveActive || []).every((v) => v === tActive.onFill), { samples: q2.saveActive, token: tActive.onFill });
      check("Q2.modal-stays-open-after-action-presses", await pageCdp.evaluate(JS.modalOpen), null);
      await movePointer(pageCdp, 2, 2);
      await shot("02-pointer", "真指针 hover/active 读数");
      record("Q2", { title: SCENARIOS[1].title, ...q2, note: "按下采样、抬在空处，active 读数不触发真实点击" });
    }

    // ---------- Q3 真键盘 focus-visible ----------
    {
      const q3 = {};
      // 真指针点 preset（也是 preset 交互本身）：focus 落进弹窗，再真 Tab 走键盘导航
      const presetBefore = await pageCdp.evaluate(`(() => { const c = document.querySelector('.biliscript-quote-card'); return c ? c.dataset.preset : null; })()`);
      const presetHit = await clickElement(pageCdp, "preset 按钮", `document.querySelector('.biliscript-quote-preset-btn:not(.is-active)')`);
      check("Q3.preset-clickable", presetHit.ok === true, presetHit);
      const afterPreset = await pageCdp.evaluate(`(() => {
        const card = document.querySelector('.biliscript-quote-card');
        return { active: card ? card.dataset.preset : null, before: ${JSON.stringify(presetBefore)}, focused: document.activeElement ? String(document.activeElement.className) : null };
      })()`);
      q3.afterPreset = afterPreset;
      check("Q3.preset-switches-card", typeof afterPreset?.active === "string" && afterPreset.active.length > 0 && afterPreset.active !== afterPreset.before, afterPreset);
      // Tab 移到下一枚可聚焦元素：必须是键盘焦点（focus-visible）且底=fill-hover
      await pressKey(pageCdp, "Tab", "Tab", 9);
      await sleep(200);
      q3.tabFocus = await pageCdp.evaluate(`(() => {
        const el = document.activeElement;
        if (!el || !el.closest || !el.closest('.biliscript-quote-share-host')) return { inModal: false, cls: el ? String(el.className) : null };
        const cs = getComputedStyle(el);
        return { inModal: true, cls: String(el.className), matchesFocusVisible: el.matches(':focus-visible'), bg: cs.backgroundColor, color: cs.color };
      })()`);
      const tQ3 = (await pageCdp.evaluate(JS.probe))?.tokens || {};
      check("Q3.tab-moves-focus-into-modal", q3.tabFocus?.inModal === true, q3.tabFocus);
      check("Q3.tab-focus-visible-matches", q3.tabFocus?.matchesFocusVisible === true, q3.tabFocus);
      check("Q3.tab-focus-bg-fill-hover", q3.tabFocus?.bg === tQ3.fillHover, { bg: q3.tabFocus?.bg, token: tQ3.fillHover });
      check("Q3.tab-focus-color-text", q3.tabFocus?.color === tQ3.text, { color: q3.tabFocus?.color, token: tQ3.text });
      // 关闭键（DOM 序在 preset 之前，从 preset 往后 Tab 到不了，用 Shift+Tab 找）
      const closeFocus = await (async () => {
        for (let i = 0; i < 4; i += 1) {
          await pressKey(pageCdp, "Tab", "Tab", 9, 8);
          await sleep(120);
          const cur = await pageCdp.evaluate(`(() => {
            const el = document.activeElement;
            if (!el || !el.classList) return null;
            if (!el.classList.contains('biliscript-quote-share-close')) return { cls: String(el.className).slice(0, 60) };
            const cs = getComputedStyle(el);
            return { isClose: true, matchesFocusVisible: el.matches(':focus-visible'), bg: cs.backgroundColor, color: cs.color };
          })()`);
          if (cur?.isClose) return cur;
        }
        return null;
      })();
      q3.closeFocus = closeFocus;
      check("Q3.close-reachable-by-tab", closeFocus !== null, { scanned: true });
      if (closeFocus) {
        check("Q3.close-focus-visible-matches", closeFocus.matchesFocusVisible === true, closeFocus);
        check("Q3.close-focus-bg-fill-hover", closeFocus.bg === tQ3.fillHover, { bg: closeFocus.bg, token: tQ3.fillHover });
        check("Q3.close-focus-color-text", closeFocus.color === tQ3.text, { color: closeFocus.color, token: tQ3.text });
      }
      await shot("03-keyboard", "真 Tab 键 focus-visible");
      record("Q3", { title: SCENARIOS[2].title, ...q3, note: "真指针点 preset 落焦，真 Tab 键走键盘导航" });
    }

    // ---------- Q4 复制（busy 禁用 + 成功态 + 剪贴板回读）----------
    {
      const q4 = { grant: null };
      if (browserCdp) {
        try {
          await browserCdp.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin: "https://www.bilibili.com" });
          q4.grant = { ok: true };
        } catch (error) {
          q4.grant = { ok: false, error: error.message };
        }
      } else {
        q4.grant = { ok: false, error: "browser-ws-unavailable" };
      }
      check("Q4.clipboard-granted", q4.grant?.ok === true, q4.grant);

      const hit = await clickElement(pageCdp, "复制图片", `document.querySelector('.biliscript-quote-copy-btn')`);
      check("Q4.copy-click-hittable", hit.ok === true, hit);
      // 25ms 粒度盯 busy/成功全程：disabled 相位带 opacity 读数
      const ticks = [];
      const start = Date.now();
      while (Date.now() - start < 8000) {
        const tick = await pageCdp.evaluate(`(() => {
          const b = document.querySelector('.biliscript-quote-copy-btn');
          if (!b) return null;
          const cs = getComputedStyle(b);
          return {
            disabled: b.disabled,
            opacity: cs.opacity,
            text: b.querySelector('.biliscript-quote-action-text')?.textContent || '',
            success: b.classList.contains('is-success'),
            bg: cs.backgroundColor,
            color: cs.color
          };
        })()`);
        if (!tick) break;
        ticks.push(tick);
        if (tick.success) break;
        await sleep(25);
      }
      q4.ticksTail = ticks.slice(-4);
      const busyTicks = ticks.filter((t) => t.disabled && !t.success);
      q4.busyObserved = busyTicks.length > 0;
      if (busyTicks.length > 0) {
        q4.busySample = busyTicks[0];
        checkEquals("Q4.busy-disabled-opacity-45", busyTicks[0].opacity, "0.45");
      } else {
        // busy 窗口太短没捕到：受控 DOM 状态补验禁用样式（需求允许的可控态），如实标注
        const controlled = await pageCdp.evaluate(`(() => {
          const b = document.querySelector('.biliscript-quote-copy-btn');
          if (!b) return null;
          const prev = b.disabled;
          b.disabled = true;
          const opacity = getComputedStyle(b).opacity;
          b.disabled = prev;
          return { opacity, note: 'controlled-dom-state' };
        })()`);
        q4.busySample = { ...controlled, note: "busy 窗口未捕到，受控 disabled 态补验" };
        checkEquals("Q4.busy-disabled-opacity-45", controlled?.opacity, "0.45");
      }
      const successTick = [...ticks].reverse().find((t) => t.success);
      q4.successTick = successTick || null;
      check("Q4.copy-success-reached", !!successTick, { lastText: ticks.length ? ticks[ticks.length - 1].text : null, grant: q4.grant });
      if (successTick) {
        const tQ4 = (await pageCdp.evaluate(JS.probe))?.tokens || {};
        // 成功态：字色=accent token（不是绿色），且不铺底（透明背景保留）
        checkEquals("Q4.success-color-is-accent", successTick.color, tQ4.accent);
        check("Q4.success-no-green-fill", successTick.bg === "rgba(0, 0, 0, 0)", { bg: successTick.bg });
        // 剪贴板真回读：image/png 项（授权已先行；读不到就是诚实红）
        try {
          q4.clipboard = await pageCdp.evaluate(`(async () => {
            const items = await navigator.clipboard.read();
            return items.map((it) => ({ types: [...it.types] }));
          })()`);
          check("Q4.clipboard-has-image-png", Array.isArray(q4.clipboard) && q4.clipboard.some((it) => (it.types || []).includes("image/png")), q4.clipboard);
        } catch (error) {
          q4.clipboard = { error: error.message };
          check("Q4.clipboard-has-image-png", false, q4.clipboard);
        }
      }
      await sleep(2200); // 等成功态复位（successDuration 2000ms），不干扰后续读数
      await shot("04-copy", "复制成功态（accent 字、无铺底）");
      record("Q4", { title: SCENARIOS[3].title, ...q4, note: "CDP 授权 + 真点击；剪贴板 image/png 真回读" });
    }

    // ---------- Q5 保存 PNG（真实下载）----------
    {
      const q5 = { download: null };
      if (browserCdp) {
        try {
          await browserCdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: OUT_DIR, eventsEnabled: true });
          q5.download = { ok: true, dir: path.relative(REPO_ROOT, OUT_DIR) };
        } catch (error) {
          q5.download = { ok: false, error: error.message };
        }
      }
      // 导出成图覆盖纹样层：默认是「无纹样」，先切到「射线」再保存
      const patternHit = await clickElement(pageCdp, "射线纹样", `document.querySelector("[data-pattern='rays']")`);
      check("Q5.pattern-selected-for-export", patternHit.ok === true, patternHit);
      const patternNow = await pageCdp.evaluate(`document.querySelector('.biliscript-quote-card')?.dataset.pattern || null`);
      checkEquals("Q5.pattern-for-export", patternNow, "rays");
      const hit = await clickElement(pageCdp, "保存 PNG", `document.querySelector('.biliscript-quote-download-btn')`);
      check("Q5.save-click-hittable", hit.ok === true, hit);
      // 目录里可能留着上一次运行的导出图：只认本次点击之后落盘的文件。
      const saveStartedAt = Date.now();
      // 成功态约 1500ms 即复位，不能先等文件——文件落盘与成功态同一轮询循环里盯：
      const deadline = Date.now() + 20000;
      const dirs = [OUT_DIR, path.join(browser.profileDir, "Downloads")];
      let file = null;
      let saveSuccess = null;
      while (Date.now() < deadline && (!file || !saveSuccess)) {
        if (!saveSuccess) {
          saveSuccess = await pageCdp.evaluate(`(() => {
            const b = document.querySelector('.biliscript-quote-download-btn');
            if (!b || !b.classList.contains('is-success')) return null;
            const cs = getComputedStyle(b);
            return { text: b.querySelector('.biliscript-quote-action-text')?.textContent || '', bg: cs.backgroundColor, color: cs.color };
          })()`);
        }
        if (!file) {
          for (const dir of dirs) {
            try {
              const found = readdirSync(dir)
                .filter((f) => /^biliscript-quote-.*\.png$/i.test(f))
                .map((f) => ({ name: f, mtime: statSync(path.join(dir, f)).mtimeMs }))
                .filter((entry) => entry.mtime >= saveStartedAt - 2000)
                .sort((a, b) => a.mtime - b.mtime)
                .at(-1)?.name;
              if (found) { file = path.join(dir, found); break; }
            } catch {}
          }
        }
        if (!file || !saveSuccess) await sleep(100);
      }
      q5.successTick = saveSuccess;
      check("Q5.save-success-reached", saveSuccess !== null, null);
      if (saveSuccess) {
        const tQ5 = (await pageCdp.evaluate(JS.probe))?.tokens || {};
        checkEquals("Q5.success-color-still-on-fill", saveSuccess.color, tQ5.onFill);
        check("Q5.success-bg-still-accent", saveSuccess.bg === tQ5.accent, { bg: saveSuccess.bg, token: tQ5.accent });
      }
      q5.downloadedFile = file ? path.relative(REPO_ROOT, file) : null;
      check("Q5.png-downloaded", file !== null, { downloadBehavior: q5.download, searched: dirs.map((d) => path.relative(REPO_ROOT, d)) });
      if (file) {
        const buf = readFileSync(file);
        const pngMagic = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
        const dimensions = { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
        q5.pngDimensions = dimensions;
        check("Q5.png-nonempty", buf.length > 200, { bytes: buf.length });
        check("Q5.png-magic", pngMagic, { head: buf.subarray(0, 8).toString("hex") });
        check("Q5.png-fixed-design-dimensions", dimensions.width === 1261 && dimensions.height === 806, { dimensions, expected: { width: 1261, height: 806 } });
      }
      await sleep(1800);
      await shot("05-save-png", "保存 PNG 真实下载");
      record("Q5", { title: SCENARIOS[4].title, ...q5, note: "Browser.setDownloadBehavior 指定落盘；校验最新 PNG 的魔数、体积与固定设计尺寸（1261×806）" });
    }

    // ---------- Q6 三条关闭路径，每条后可重开 ----------
    {
      const q6 = {};
      await closeModalIfOpen("Q6.before-close-paths");
      // 路径 1：关闭键
      await expectModalOpen("Q6.close-btn");
      await mustClick(pageCdp, "Q6.close-btn-click", "关闭键", `document.querySelector('.biliscript-quote-share-close')`);
      await expectModalClosed("Q6.close-btn");
      // 路径 2：遮罩（点在 dialog 之外的 mask 区域，先体检命中）
      await expectModalOpen("Q6.mask");
      const maskPoint = await pageCdp.evaluate(`(() => {
        const host = document.querySelector('.biliscript-quote-share-host');
        const dialog = host.querySelector('.biliscript-quote-share-dialog');
        const hr = host.getBoundingClientRect();
        const dr = dialog.getBoundingClientRect();
        // 取 dialog 左侧之外的 host 区域中点
        const x = (hr.left + dr.left) / 2;
        const y = (hr.top + hr.bottom) / 2;
        const hit = document.elementFromPoint(x, y);
        return { x, y, hitsMask: !!(hit && hit.classList && hit.classList.contains('biliscript-quote-share-mask')) };
      })()`);
      check("Q6.mask-point-hittable", maskPoint?.hitsMask === true, maskPoint);
      if (maskPoint?.hitsMask) {
        await dispatchClick(pageCdp, maskPoint.x, maskPoint.y);
        await expectModalClosed("Q6.mask");
      }
      // 路径 3：Escape 真键击
      await expectModalOpen("Q6.escape");
      await pressKey(pageCdp, "Escape", "Escape", 27);
      await expectModalClosed("Q6.escape");
      // 收尾：确认还能再开（重开性已随每条路径验证，最后再开一次给后续截图态）
      await expectModalOpen("Q6.reopen");
      record("Q6", { title: SCENARIOS[5].title, ...q6, note: "关闭键/遮罩/Escape 三条路径，各自随后重开" });
    }

    // ---------- Q7 flyme 深色 ----------
    {
      await closeModalIfOpen("Q7.before-theme");
      await switchTheme("Q7", "dark");
      await expectModalOpen("Q7");
      await movePointer(pageCdp, 2, 2);
      await sleep(120);
      const p = await probeThemedModal("Q7");
      checkEquals("Q7.view-theme-dark", p?.view?.theme, "dark");
      await shot("07-theme-flyme-dark", "flyme 深色档：token 换值后同契约");
      record("Q7", { title: SCENARIOS[6].title, probe: p, note: "header 主题键真指针切换" });
    }

    // ---------- Q8 editorial 浅色（设置抽屉真实保存链路）----------
    {
      await closeModalIfOpen("Q8.before-theme");
      await switchTheme("Q8", "light");
      await switchPaletteEditorial("Q8");
      await expectModalOpen("Q8");
      await movePointer(pageCdp, 2, 2);
      await sleep(120);
      const p = await probeThemedModal("Q8");
      checkEquals("Q8.view-palette-editorial", p?.view?.palette, "editorial");
      checkEquals("Q8.view-theme-light", p?.view?.theme, "light");
      await shot("08-editorial-light", "editorial 浅色档：同契约");
      record("Q8", { title: SCENARIOS[7].title, probe: p, note: "色板经设置抽屉 select 真实保存链路切换" });
    }

    // ---------- Q9 editorial 深色 ----------
    {
      await closeModalIfOpen("Q9.before-theme");
      await switchTheme("Q9", "dark");
      await expectModalOpen("Q9");
      await movePointer(pageCdp, 2, 2);
      await sleep(120);
      const p = await probeThemedModal("Q9");
      checkEquals("Q9.view-palette-editorial", p?.view?.palette, "editorial");
      checkEquals("Q9.view-theme-dark", p?.view?.theme, "dark");
      await shot("09-editorial-dark", "editorial 深色档：同契约");
      record("Q9", { title: SCENARIOS[8].title, probe: p, note: "editorial 深色档" });
    }

    // ---------- Q10 窄视口 ----------
    {
      const q10 = {};
      await closeModalIfOpen("Q10.before-narrow");
      await pageCdp.send("Emulation.setDeviceMetricsOverride", NARROW_VIEWPORT);
      await expectModalOpen("Q10");
      q10.rect = await pageCdp.evaluate(`(() => {
        const d = document.querySelector('.biliscript-quote-share-dialog');
        const r = d.getBoundingClientRect();
        return { left: +r.left.toFixed(1), right: +r.right.toFixed(1), top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
      })()`);
      check("Q10.no-horizontal-overflow", q10.rect && q10.rect.left >= -0.5 && q10.rect.right <= NARROW_VIEWPORT.width + 0.5, { rect: q10.rect, viewport: NARROW_VIEWPORT.width });
      const targets = [
        ["关闭键", `document.querySelector('.biliscript-quote-share-close')`],
        ["复制图片", `document.querySelector('.biliscript-quote-copy-btn')`],
        ["保存 PNG", `document.querySelector('.biliscript-quote-download-btn')`],
        ["preset", `document.querySelector('.biliscript-quote-preset-btn')`],
        ["pattern", `document.querySelector('.biliscript-quote-pattern-btn')`]
      ];
      q10.hitTests = [];
      for (const [label, expr] of targets) {
        const ht = await hitTestElement(pageCdp, label, expr, NARROW_VIEWPORT);
        q10.hitTests.push(ht);
        check(`Q10.reachable.${label}`, ht?.ok === true, ht);
      }
      await sleep(300);
      await shot("10-narrow-viewport", "窄视口（420px）：不横向溢出、操作可达");
      // 关闭键在窄屏也可真点（可操作性收尾），随后恢复视口
      await mustClick(pageCdp, "Q10.close-hittable", "关闭键", `document.querySelector('.biliscript-quote-share-close')`, NARROW_VIEWPORT);
      await expectModalClosed("Q10");
      await pageCdp.send("Emulation.setDeviceMetricsOverride", VIEWPORT);
      await expectModalOpen("Q10.restore");
      const restored = await hitTestElement(pageCdp, "保存 PNG", `document.querySelector('.biliscript-quote-download-btn')`, VIEWPORT);
      check("Q10.geometry-restored", restored?.ok === true, restored);
      record("Q10", { title: SCENARIOS[9].title, ...q10, note: "真实视口调整 → 断言 → 恢复" });
    }

    // ---------- Q11 prefers-reduced-motion ----------
    {
      const q11 = {};
      await closeModalIfOpen("Q11.before-rm");
      await pageCdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await expectModalOpen("Q11");
      q11.styles = await pageCdp.evaluate(`(() => {
        const host = document.querySelector('.biliscript-quote-share-host');
        const close = host.querySelector('.biliscript-quote-share-close');
        const blobs = host.querySelector('.biliscript-quote-card-blobs');
        return {
          hostTransition: getComputedStyle(host).transition,
          closeTransition: getComputedStyle(close).transition,
          blobsAnimation: getComputedStyle(blobs).animationName
        };
      })()`);
      checkEquals("Q11.host-transition-none", q11.styles?.hostTransition, "none");
      checkEquals("Q11.close-transition-none", q11.styles?.closeTransition, "none");
      checkEquals("Q11.blobs-animation-none", q11.styles?.blobsAnimation, "none");
      // close active transform none：按下采样（真 pointer），松手即真关闭
      const close = await pageCdp.evaluate(`(() => { const el = document.querySelector('.biliscript-quote-share-close'); const r = el.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
      await movePointer(pageCdp, close.cx, close.cy);
      await pageCdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(close.cx), y: Math.round(close.cy), button: "left", buttons: 1, clickCount: 1 });
      q11.closeActive = await pageCdp.evaluate(`(() => new Promise((resolve) => {
        const close = document.querySelector('.biliscript-quote-share-close');
        const samples = [];
        const started = Date.now();
        const timer = setInterval(() => {
          samples.push(getComputedStyle(close).transform);
          if (Date.now() - started >= 200) { clearInterval(timer); resolve(samples); }
        }, 16);
      }))()`);
      await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(close.cx), y: Math.round(close.cy), button: "left", buttons: 0, clickCount: 1 });
      check("Q11.close-active-transform-none", (q11.closeActive || []).every((v) => v === "none"), { samples: q11.closeActive });
      await expectModalClosed("Q11.close-active-release");
      await shot("11-reduced-motion", "reduced-motion：transition/animation/active transform 全 none");
      await pageCdp.send("Emulation.setEmulatedMedia", { features: [] });
      record("Q11", { title: SCENARIOS[10].title, ...q11, note: "Emulation.setEmulatedMedia；卡片柔光/视差/导出逻辑不判" });
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
        return {
          url: location.href,
          viewOpen: view ? view.classList.contains('open') : null,
          theme: view ? view.getAttribute('data-theme') : null,
          palette: view ? view.getAttribute('data-palette') : null,
          modalOpen: !!document.querySelector('.biliscript-quote-share-host'),
          overviewActive: (() => { const b = document.getElementById('biliscript-reading-tabbody-overview'); return !!b && b.classList.contains('is-active'); })()
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
        quote: QUOTE,
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
      await pageCdp.send("Emulation.setEmulatedMedia", { features: [] }).catch(() => {});
      if (pageCdp) await pausePageMedia();
    } catch {}
    const profileDir = browser?.profileDir;
    await teardown({ browser, cdps: [pageCdp, browserCdp, worker?.handle?.cdp].filter(Boolean) });
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
