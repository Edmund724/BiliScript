#!/usr/bin/env node
// 双语字幕真机场景 —— `pnpm harness:scenario bilingual-subtitles`。
//
// 来源：票 bilingual-subtitles 的走查驱动器（.scratch/tickets/bilingual-subtitles/walkthrough/
// drive.mjs）。那份脚本把管道 + fixture + 场景焊在一起，是那次验收的记录；本文件只保留
// 场景层，管道全部 import 自 ../harness.mjs。
//
// 判据（为什么在真机上跑）：见 ../README.md「什么时候用它」。本场景钉住的都是 jsdom 够不着的
// 东西——真实 B 站页面上的样式级联（页面表 `[hidden]{display:none!important}` 压扩展的
// 副列浮层）、弹层两列各自的滚动位置、真实 listbox 的点击/焦点路径、MV3 SW 里的 fetch 补丁、
// 跨视频 SPA 换轨时的全局偏好。
//
// 两个模式：
//   node scenarios/bilingual-subtitles.mjs --fixture-only
//       不起浏览器：只自检 tests/fixtures/bilibili/bilingual-walkthrough/ 的形状不变量，
//       并按被测实现同一条配对规则独立复算搜索期望（秒级）。
//   node scenarios/bilingual-subtitles.mjs [--headed]
//       真机全流程（约 90–120s，需要能访问 bilibili.com）：
//       PHASE 1 真网真页面（扩展注入 / 阅读模式 / 匿名轨数三路证据）
//       PHASE 2 打 fixture 补丁（只换两个网络应答，其余走真实渲染路径）后跑 S1–S10
//
// 诚实口径：S1–S10 的读数全部建立在 fixture 的两个网络应答上（除 PHASE 1 那一格）。
// 本机匿名（无登录 cookie）时 `x/player/wbi/v2` 对任何视频都返回 0 轨，8 轨样本只能来自
// fixture；矩阵因此**总是**跑 fixture 补丁后的路径（不随真网轨数漂移），PHASE 1 的轨数只
// 作为环境事实记录。标注为「fixture 数据 + 真实渲染路径」，绝不冒充真网结果。
//
// 硬约束：只杀自己 spawn 的进程（harness 的 teardown）；工件落
// `.scratch/browser-harness/scenarios/bilingual-subtitles/`；不读 `.scratch/` 里的任何东西
// ——fixture 是可提交数据（tests/fixtures/）。

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

const NAME = "bilingual-subtitles";
const OUT_DIR = artifactDir(path.join("scenarios", NAME));
const FIXTURE_DIR = path.join(REPO_ROOT, "tests", "fixtures", "bilibili", "bilingual-walkthrough");
const FIXTURE_URL_RE = /walkthrough-fixture\/([A-Za-z0-9-]+)\.json/;

const SAMPLE = { bvid: "BV1mAam6tEL8", url: "https://www.bilibili.com/video/BV1mAam6tEL8/" };
const SINGLE = { bvid: "BV1FyHn6JE86", url: "https://www.bilibili.com/video/BV1FyHn6JE86/" };
const SECONDARY_TARGET_LANG = "ja"; // S4「换副轨」切到 日本語
const VIEWPORT = DEFAULT_VIEWPORT;
const headed = process.argv.includes("--headed");
const fixtureOnly = process.argv.includes("--fixture-only");

// ===== 场景清单（代码即清单）。id 同时是 evidence.json 里的键。=====
const SCENARIOS = [
  { id: "S1", slug: "01-bilingual-off-picker", title: "双语关：弹层形态 / 选项 / 列表单轨 / 搜索零行为差" },
  { id: "S2", slug: "02-bilingual-on-dual-list", title: "双语开：副列可点 / 双行渲染 / 合并段 / 双轨搜索" },
  { id: "S3", slug: "03-main-track-switched", title: "切主轨：副轨槽与副列选中态不被打乱" },
  { id: "S4", slug: "04-secondary-switch-loading", title: "换副轨：只禁副列、主列仍可用、loading 占位不参与搜索" },
  { id: "S5", slug: "05-secondary-switch-ready", title: "副轨到站：列表副行换成新译文" },
  { id: "S6", slug: "06-bilingual-off-single-track", title: "关闭双语：列表回单轨；副轨槽不被清（再打开不闪加载）" },
  { id: "S7", slug: "07-bilingual-reopened", title: "再打开双语：不重新抓副轨、不闪「译文加载中…」" },
  { id: "S7b", slug: "07b-picker-scroll", title: "弹层滚动：两列各自滚；选完副语言两处滚动位置都不动" },
  { id: "S8", slug: "08-video-change-single-track", title: "换视频：全局偏好保留、新视频缺该语言轨时静默退回单轨 + 开关禁用" },
  { id: "S9", slug: "09-explain-quote-main-only", title: "解释卡：引用句只含主行（readMainLineText）" },
  { id: "S10", slug: "10-collision-and-recover", title: "主副同轨：页脚说明行不顶掉语言列表（点错改得回来）；自动装载不把主轨抓成副轨" }
];

// ===== 可提交 fixture（fixture-only 与全流程共用同一批数据）=====
function readFixture(file) {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, file), "utf8"));
}

let BUNDLES;
let BODIES;
let SEARCH_EXPECTATIONS;
let META;
try {
  BUNDLES = readFixture("bundles.json");
  BODIES = readFixture("bodies.json");
  SEARCH_EXPECTATIONS = readFixture("search-expectations.json");
  META = readFixture("meta.json");
} catch (error) {
  console.error(`读不到 committed fixture：${FIXTURE_DIR}\n  ${error.message}`);
  process.exit(1);
}

const bodySegments = (key) => BODIES[key]?.body ?? [];
const expectation = (caseId, token) => {
  const hit = SEARCH_EXPECTATIONS.find((c) => c.id === caseId)?.hits.find((h) => h.token === token);
  if (!hit) throw new Error(`fixture 里没有搜索期望：${caseId} / ${token}`);
  return hit;
};

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

// ===== 页面内测量脚本 =====
// picker：选轨控件的几何 + 选项 + 副列状态。scrollRegions 是「滚动归属每一列」那条真机裁决
// 的判据面（两列各一条滚动条；跨两列的 .biliscript-bilingual-main 只做裁剪）。
const JS = {
  picker: `(() => {
    const wrapper = document.querySelector('.biliscript-reading-track-picker');
    if (!wrapper) return { error: 'wrapper-missing' };
    const mainSel = document.getElementById('biliscript-reading-subtitle-select');
    const subSel = document.getElementById('biliscript-reading-secondary-subtitle-select');
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: +r.width.toFixed(2), h: +r.height.toFixed(2), left: +r.left.toFixed(2), right: +r.right.toFixed(2), top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2) }; };
    const opts = (sel) => sel ? [...sel.options].map(o => ({ text: o.textContent, value: o.value, lang: o.dataset.lang || '', id: o.dataset.id || '', dir: o.dir, selected: o.selected })) : null;
    const trigger = wrapper.querySelector('.custom-select-trigger');
    const dropdown = wrapper.querySelector('.custom-select-dropdown');
    const card = dropdown ? dropdown.querySelector('.biliscript-bilingual-popover') : null;
    const mainColEl = dropdown ? dropdown.querySelector('.biliscript-bilingual-col[data-col="main"]') : null;
    const scrollArea = mainColEl || (dropdown ? dropdown.querySelector('.biliscript-bilingual-main') : null);
    const footer = dropdown ? dropdown.querySelector('.biliscript-bilingual-footer') : null;
    const cols = dropdown ? [...dropdown.querySelectorAll('.biliscript-bilingual-col')] : [];
    const colInfo = cols.map(c => {
      const rows = [...c.querySelectorAll('.custom-select-option')];
      return {
        col: c.dataset.col,
        hidden: c.hidden,
        rect: rect(c),
        rows: rows.length,
        visibleRows: rows.filter(o => o.getBoundingClientRect().width > 0).length,
        firstRowRect: rect(rows[0] || null),
        head: c.querySelector('.biliscript-bilingual-col-head')?.textContent || '',
        headHidden: c.querySelector('.biliscript-bilingual-col-head')?.hidden ?? null,
        truncatedRows: rows.filter(o => o.scrollWidth > o.clientWidth + 1).map(o => o.textContent)
      };
    });
    const empty = dropdown ? dropdown.querySelector('.biliscript-bilingual-col[data-col="sub"] .biliscript-bilingual-empty') : null;
    const hint = dropdown ? dropdown.querySelector('.biliscript-bilingual-hint') : null;
    const badge = wrapper.querySelector('#biliscript-reading-bilingual-badge');
    const sw = dropdown ? dropdown.querySelector('.biliscript-bilingual-switch') : null;
    const panel = document.getElementById('biliscript-reading-view');
    const tabBody = document.getElementById('biliscript-reading-tabbody-subtitle');
    const subCol = dropdown ? dropdown.querySelector('.biliscript-bilingual-col[data-col="sub"]') : null;
    const subDropdown = subCol ? subCol.querySelector('.custom-select-dropdown') : null;
    return {
      panelWidth: panel ? +panel.getBoundingClientRect().width.toFixed(2) : null,
      tabBodyWidth: tabBody ? +tabBody.getBoundingClientRect().width.toFixed(2) : null,
      wrapperWidth: rect(wrapper) ? rect(wrapper).w : null,
      trigger: trigger ? { rect: rect(trigger), text: trigger.querySelector('.custom-select-value')?.textContent || '', disabled: trigger.disabled, ariaBusy: trigger.getAttribute('aria-busy'), ariaExpanded: trigger.getAttribute('aria-expanded'), ariaDescribedby: trigger.getAttribute('aria-describedby') || '' } : null,
      dropdownHidden: dropdown ? dropdown.hidden : null,
      cardRect: rect(card),
      popoverDisplay: card ? getComputedStyle(card).display : null,
      cardEffectiveRect: rect(dropdown),
      dropdownRect: rect(dropdown),
      dropdownStyle: dropdown ? { position: getComputedStyle(dropdown).position, maxWidth: getComputedStyle(dropdown).maxWidth, display: getComputedStyle(dropdown).display, boxSizing: getComputedStyle(dropdown).boxSizing } : null,
      subDropdownDisplay: subDropdown ? getComputedStyle(subDropdown).display : null,
      subDropdownHiddenAttr: subDropdown ? subDropdown.getAttribute('hidden') : null,
      scrollArea: scrollArea ? { rect: rect(scrollArea), scrollHeight: scrollArea.scrollHeight, clientHeight: scrollArea.clientHeight, overflowing: scrollArea.scrollHeight > scrollArea.clientHeight + 1, scrollTop: scrollArea.scrollTop, isMainCol: !!(mainColEl && scrollArea === mainColEl) } : null,
      scrollRegions: (() => {
        const info = (el) => {
          if (!el) return null;
          const cs = getComputedStyle(el);
          return {
            cls: String(el.className),
            overflowY: cs.overflowY,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            offsetWidth: el.offsetWidth,
            clientWidth: el.clientWidth,
            scrollbarWidth: el.offsetWidth - el.clientWidth,
            scrollable: el.scrollHeight > el.clientHeight + 1,
            scrollTop: el.scrollTop
          };
        };
        if (!dropdown) return null;
        return {
          mid: info(dropdown.querySelector('.biliscript-bilingual-main')),
          main: info(dropdown.querySelector('.biliscript-bilingual-col[data-col="main"]')),
          sub: info(dropdown.querySelector('.biliscript-bilingual-col[data-col="sub"]'))
        };
      })(),
      footer: footer ? { rect: rect(footer), insideScrollArea: scrollArea ? scrollArea.contains(footer) : null, hidden: footer.hidden } : null,
      footerStableOnScroll: (() => {
        if (!scrollArea || !footer) return null;
        const before = footer.getBoundingClientRect().top;
        const prev = scrollArea.scrollTop;
        scrollArea.scrollTop = scrollArea.scrollHeight;
        const after = footer.getBoundingClientRect().top;
        scrollArea.scrollTop = prev;
        return { footerTopBefore: +before.toFixed(2), footerTopAfterScrollToBottom: +after.toFixed(2), moved: +(after - before).toFixed(2) };
      })(),
      cols: colInfo,
      subEmpty: empty ? { text: empty.textContent, hidden: empty.hidden, rect: rect(empty), maxWidth: getComputedStyle(empty).maxWidth, scrollW: empty.scrollWidth, clientW: empty.clientWidth, clipped: empty.scrollWidth > empty.clientWidth + 1 } : null,
      hint: hint ? { text: hint.textContent, hidden: hint.hidden } : null,
      footerNote: (() => {
        const n = dropdown ? dropdown.querySelector('.biliscript-bilingual-footer-note') : null;
        if (!n) return null;
        return { text: n.textContent, hidden: n.hidden, rect: rect(n) };
      })(),
      badge: badge ? { text: badge.textContent, id: badge.id, rect: rect(badge) } : null,
      switch: sw ? { rect: rect(sw), ariaChecked: sw.getAttribute('aria-checked'), dataOn: sw.dataset.on, disabled: sw.disabled, role: sw.getAttribute('role') } : null,
      mainOptions: opts(mainSel),
      subOptions: opts(subSel),
      bilingualRows: document.querySelectorAll('.biliscript-bilingual-col[data-col="main"] .custom-select-option').length,
      subRows: document.querySelectorAll('.biliscript-bilingual-col[data-col="sub"] .custom-select-option').length
    };
  })()`,

  // 列表形态：条目、副行、时间戳、行高、副行是否折行/截断。
  list: `(() => {
    const list = document.getElementById('biliscript-reading-subtitle');
    if (!list) return { error: 'list-missing' };
    const items = [...list.querySelectorAll('.biliscript-reading-item')];
    const first = items[0] || null;
    const sub = (node) => node ? node.querySelector('.biliscript-reading-subtext') : null;
    const subInfo = items.map((it, i) => {
      const s = sub(it);
      if (!s) return null;
      const cs = getComputedStyle(s);
      return {
        i,
        text: s.textContent,
        state: s.dataset.state,
        h: +s.getBoundingClientRect().height.toFixed(2),
        w: +s.getBoundingClientRect().width.toFixed(2),
        scrollW: s.scrollWidth,
        clientW: s.clientWidth,
        whiteSpace: cs.whiteSpace,
        textOverflow: cs.textOverflow,
        overflow: cs.overflow,
        fontSize: cs.fontSize,
        lineHeight: cs.lineHeight,
        color: cs.color,
        fontStyle: cs.fontStyle
      };
    }).filter(Boolean);
    const itemHeights = items.slice(0, 8).map(it => +it.getBoundingClientRect().height.toFixed(2));
    const textHeights = items.slice(0, 8).map(it => { const t = it.querySelector('.biliscript-reading-text'); return t ? +t.getBoundingClientRect().height.toFixed(2) : null; });
    const states = {};
    for (const s of subInfo) states[s.state] = (states[s.state] || 0) + 1;
    return {
      itemCount: items.length,
      emptyPlaceholder: list.querySelector('.biliscript-reading-empty')?.textContent ?? null,
      firstItemHtml: first ? first.outerHTML.replace(/\\s+/g, ' ').slice(0, 400) : null,
      firstItemSeconds: first ? first.dataset.seconds : null,
      firstItemIndex: first ? first.dataset.index : null,
      firstMainText: first ? (first.querySelector('.biliscript-reading-text')?.textContent || '') : null,
      firstSubText: first ? (sub(first)?.textContent ?? null) : null,
      subtextNodeCount: list.querySelectorAll('.biliscript-reading-subtext').length,
      subtextStates: states,
      subtextSample: subInfo.slice(0, 6),
      itemHeights,
      textHeights,
      hasAnySubtext: !!first && !!sub(first)
    };
  })()`,

  // 合并段：相邻主行显示同一句译文（主轨 2 段 ↔ 副轨 1 段）。
  mergedGroups: `(() => {
    const list = document.getElementById('biliscript-reading-subtitle');
    if (!list) return { error: 'list-missing' };
    const items = [...list.querySelectorAll('.biliscript-reading-item')];
    const groups = [];
    for (let i = 1; i < items.length; i += 1) {
      const a = items[i - 1].querySelector('.biliscript-reading-subtext');
      const b = items[i].querySelector('.biliscript-reading-subtext');
      if (!a || !b) continue;
      if (a.dataset.state !== 'ready') continue;
      if (a.textContent === b.textContent) {
        groups.push({
          mainIndexA: Number(items[i - 1].dataset.index),
          mainIndexB: Number(items[i].dataset.index),
          secondsA: items[i - 1].dataset.seconds,
          secondsB: items[i].dataset.seconds,
          mainA: items[i - 1].querySelector('.biliscript-reading-text')?.textContent || '',
          mainB: items[i].querySelector('.biliscript-reading-text')?.textContent || '',
          sub: a.textContent
        });
      }
    }
    return { duplicateSubtextPairCountRendered: groups.length, sample: groups.slice(0, 4) };
  })()`,

  // 搜索：写入输入框 → 派发 input → 等防抖 → 读计数与 mark（主行/副行分开数）。
  search: (token) => `(async () => {
    const input = document.getElementById('biliscript-reading-search-input');
    if (!input) return { error: 'input-missing' };
    input.value = ${JSON.stringify(token)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
    const list = document.getElementById('biliscript-reading-subtitle');
    const marks = [...list.querySelectorAll('mark.biliscript-reading-search-hit')];
    const inSub = marks.filter(m => m.closest('.biliscript-reading-subtext')).length;
    const curMark = list.querySelector('mark.search-current');
    return {
      token: ${JSON.stringify(token)},
      countText: document.getElementById('biliscript-reading-search-count')?.textContent ?? null,
      renderedMarkCount: marks.length,
      marksInMainLine: marks.length - inSub,
      marksInSecondaryLine: inSub,
      currentMarkInSecondary: curMark ? !!curMark.closest('.biliscript-reading-subtext') : null,
      matchedItemIndexes: [...new Set(marks.map(m => m.closest('.biliscript-reading-item')?.dataset.index))].slice(0, 8)
    };
  })()`,

  clearSearch: `(() => {
    const input = document.getElementById('biliscript-reading-search-input');
    if (input) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }
    return true;
  })()`,

  // 副行与主行逐条比对：「两份一样」就是这一列副行的文本 === 同一段主行文本。
  dupSample: `(() => {
    const list = document.getElementById('biliscript-reading-subtitle');
    if (!list) return { error: 'list-missing' };
    const items = [...list.querySelectorAll('.biliscript-reading-item')];
    let total = 0; let same = 0; const samples = [];
    for (const it of items) {
      const t = it.querySelector('.biliscript-reading-text');
      const s = it.querySelector('.biliscript-reading-subtext');
      if (!t || !s) continue;
      total += 1;
      const clone = t.cloneNode(true);
      clone.querySelectorAll('.biliscript-reading-subtext').forEach(n => n.remove());
      const mainOnly = (clone.textContent || '').trim();
      const subText = (s.textContent || '').trim();
      if (subText && subText === mainOnly) {
        same += 1;
        if (samples.length < 3) samples.push({ index: Number(it.dataset.index), mainOnly, subText, state: s.dataset.state });
      }
    }
    return { itemsWithSubtext: total, identicalMainSubPairs: same, samples };
  })()`,

  // 弹层（卡片 + 两列）与阅读列表的滚动位置一次读全。
  scrollSample: `(() => {
    const card = document.querySelector('.biliscript-reading-track-picker .custom-select-dropdown');
    const list = document.getElementById('biliscript-reading-subtitle');
    const out = {
      list: list ? { scrollTop: list.scrollTop, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight, itemCount: list.querySelectorAll('.biliscript-reading-item').length } : null
    };
    if (!card) { out.card = null; return out; }
    const mainCol = card.querySelector('.biliscript-bilingual-col[data-col="main"]');
    const subCol = card.querySelector('.biliscript-bilingual-col[data-col="sub"]');
    const mid = card.querySelector('.biliscript-bilingual-main');
    const box = (el) => el ? { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollable: el.scrollHeight > el.clientHeight + 1, offsetWidth: el.offsetWidth, clientWidth: el.clientWidth, scrollbarWidth: el.offsetWidth - el.clientWidth } : null;
    out.card = { hidden: card.hidden, mid: box(mid), main: box(mainCol), sub: box(subCol) };
    out.subRows = subCol ? subCol.querySelectorAll('.custom-select-option').length : null;
    out.subPlaceholder = (() => { const p = subCol && subCol.querySelector('.biliscript-bilingual-empty'); return p && !p.hidden ? p.textContent : null; })();
    out.subSelDisabled = (() => { const s = document.getElementById('biliscript-reading-secondary-subtitle-select'); return s ? s.disabled : null; })();
    return out;
  })()`,

  pauseMedia: `(() => {
    const nodes = [...document.querySelectorAll('video, audio')];
    for (const n of nodes) { try { n.pause(); } catch {} }
    return nodes.map(n => ({ tag: n.tagName, paused: n.paused, src: (n.currentSrc || n.src || '').slice(0, 80) }));
  })()`
};

// ===== 真机输入：trusted click =====
// README 的硬约束：`element.click()` 是 isTrusted:false，扩展自己挂的 DOM 能吃，播放器控件 /
// 剪贴板 / autoplay 不一定。场景因此一律用 Input.dispatchMouseEvent 发真指针事件（按下 +
// 抬起），并且要求目标当场有几何（0×0 ⇒ 报 not-hittable，不静默点空）——副列浮层的真机
// 缺陷（页面表 `[hidden]{display:none!important}` 压掉副列 → 8 行 rect 全 0×0）正是靠这一点
// 变成红色断言，而不是「点了没反应」。
async function dispatchClick(pageCdp, x, y) {
  const px = Math.round(x);
  const py = Math.round(y);
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py, button: "none", clickCount: 0 });
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: px, y: py, button: "left", buttons: 1, clickCount: 1 });
  await pageCdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: px, y: py, button: "left", buttons: 0, clickCount: 1 });
  return { x: px, y: py };
}

// 点击一个「按表达式定位」的元素；可选 clipExpr 给出裁剪盒（滚动列），必要时把它滚进视野。
async function clickElement(pageCdp, label, locateExpr, { clipExpr = null } = {}) {
  const info = await pageCdp.evaluate(`(() => {
    const el = ${locateExpr};
    if (!el) return { found: false };
    const clip = ${clipExpr ?? "null"};
    const r = el.getBoundingClientRect();
    let scrolled = 0;
    if (clip) {
      const cr = clip.getBoundingClientRect();
      if (r.top < cr.top + 1 || r.bottom > cr.bottom - 1) {
        const delta = r.top - cr.top - (cr.height - r.height) / 2;
        clip.scrollTop += delta;
        scrolled = delta;
      }
    }
    const r2 = el.getBoundingClientRect();
    const cx = r2.left + r2.width / 2;
    const cy = r2.top + r2.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return {
      found: true,
      rect: { w: +r2.width.toFixed(2), h: +r2.height.toFixed(2), left: +r2.left.toFixed(2), top: +r2.top.toFixed(2) },
      scrolled: +scrolled.toFixed(2),
      center: { x: cx, y: cy },
      hitSelf: !!hit && (hit === el || el.contains(hit)),
      hitTag: hit ? hit.tagName + '.' + String(hit.className || '').slice(0, 40) : null,
      text: (el.textContent || '').slice(0, 60)
    };
  })()`);
  if (!info?.found) return { ok: false, label, reason: "not-found" };
  if (!(info.rect.w > 0) || !(info.rect.h > 0)) return { ok: false, label, reason: "not-hittable", rect: info.rect, text: info.text };
  const { x, y } = info.center;
  if (x < 0 || y < 0 || x > VIEWPORT.width || y > VIEWPORT.height) {
    return { ok: false, label, reason: "out-of-viewport", rect: info.rect };
  }
  if (!info.hitSelf) return { ok: false, label, reason: "covered", rect: info.rect, hitTag: info.hitTag };
  await dispatchClick(pageCdp, x, y);
  return { ok: true, label, text: info.text, rect: info.rect, scrolled: info.scrolled };
}

// 点击必须成功的输入：失败登记一条断言（红），调用方据 ok 决定后续步骤。
async function mustClick(pageCdp, checkName, label, locateExpr, opts) {
  const result = await clickElement(pageCdp, label, locateExpr, opts);
  check(checkName, result.ok === true, result);
  return result;
}

// ===== 主流程 =====
const evidence = {
  meta: {
    startedAt: new Date().toISOString(),
    scenario: NAME,
    dist: DEFAULT_DIST,
    viewport: VIEWPORT,
    sampleUrl: SAMPLE.url,
    singleTrackUrl: SINGLE.url,
    headed,
    fixtureDir: FIXTURE_DIR,
    node: process.version
  },
  fixture: { meta: META },
  phase1: {},
  matrix: {},
  scenarios: {},
  timeline: [],
  screenshots: []
};

let browser = null;
let pageCdp = null;
let worker = null;
let patchKeepAlive = null;
const swNetLog = [];

function record(id, payload) {
  evidence.scenarios[id] = { ...(evidence.scenarios[id] || {}), ...payload };
  evidence.timeline.push({ at: new Date().toISOString(), scenario: id, note: payload.note || "" });
}

function scenarioTitle(id) {
  return SCENARIOS.find((s) => s.id === id)?.title ?? id;
}

// 工件名沿用走查那一份（00–20 共 21 张）：同一批判据的截图可直接对照归档读数。
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

// ---- fixture 自检（--fixture-only 与全流程共用）----
function recomputeHits(mainKey, secondaryKey, token) {
  const countIn = (text) => {
    if (!text) return 0;
    const esc = String(token).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [...String(text).matchAll(new RegExp(esc, "gi"))].length;
  };
  const main = mainKey === "zh" ? bodySegments(`${SAMPLE.bvid}-zh`) : bodySegments(`${SAMPLE.bvid}-${mainKey}`);
  const secondary = secondaryKey ? bodySegments(`${SAMPLE.bvid}-${secondaryKey}`) : null;
  const froms = (secondary || []).map((s) => s.from);
  let sub = 0;
  let itemsWithSecondary = 0;
  for (let i = 0; i < main.length; i += 1) {
    if (!secondary) continue;
    let left = 0;
    let right = froms.length;
    while (left < right) {
      const mid = (left + right) >> 1;
      if (froms[mid] <= main[i].from) left = mid + 1;
      else right = mid;
    }
    const parts = [];
    for (let k = Math.max(0, left - 1); k < secondary.length && froms[k] < main[i].to; k += 1) {
      if (Math.min(secondary[k].to, main[i].to) > Math.max(secondary[k].from, main[i].from)) parts.push(secondary[k].content);
    }
    const text = parts.join(" ");
    if (text) itemsWithSecondary += 1;
    sub += countIn(text);
  }
  const mainHits = countIn(main.map((s) => s.content).join(" "));
  return { token, main: mainHits, sub, total: mainHits + sub, itemsWithSecondary };
}

function selfCheckFixture() {
  checkEquals("fixture.zh-segments", bodySegments(`${SAMPLE.bvid}-zh`).length, 197);
  for (const key of ["en", "ja", "es", "ar", "pt", "th", "id"]) {
    checkEquals(`fixture.${key}-segments`, bodySegments(`${SAMPLE.bvid}-${key}`).length, 188);
  }
  checkEquals("fixture.merged-pair-count", META.mergedPairCount, 9);
  checkEquals("fixture.single-track-segments", bodySegments(`${SINGLE.bvid}-single-zh`).length, 120);

  const zhBodies = BODIES[`${SAMPLE.bvid}-zh`];
  check("fixture.zh-payload-shape", zhBodies?.type === 0 && zhBodies?.lang === "zh" && zhBodies?.version === "v1", {
    type: zhBodies?.type,
    lang: zhBodies?.lang
  });
  const enBody = bodySegments(`${SAMPLE.bvid}-en`);
  const zhEndpoints = new Set(bodySegments(`${SAMPLE.bvid}-zh`).flatMap((s) => [s.from, s.to]));
  const outsideEndpoints = enBody.flatMap((s) => [s.from, s.to]).filter((t) => !zhEndpoints.has(t));
  checkEquals("fixture.translation-endpoints-subset-of-main", outsideEndpoints.length, 0);
  const sortedByFrom = enBody.every((s, i) => i === 0 || s.from >= enBody[i - 1].from);
  check("fixture.translation-sorted-by-from", sortedByFrom, { first: enBody[0]?.from, last: enBody.at(-1)?.from });
  const zhSegs = bodySegments(`${SAMPLE.bvid}-zh`);
  const degenerate = zhSegs.filter((s) => !(s.to > s.from)).length;
  checkEquals("fixture.main-segments-non-degenerate", degenerate, 0);
  const mergePairsAdjacent = META.mergedPairs.every((p) => p.zhIndices[1] - p.zhIndices[0] === 1);
  check("fixture.merged-pairs-adjacent", mergePairsAdjacent, { pairs: META.mergedPairs.map((p) => p.zhIndices) });

  // bundle 形状：8 条 ai-* 真轨 + 单轨视频 1 条；每条轨的 subtitle_url 都能在 bodies 里找到。
  const sampleTracks = BUNDLES[SAMPLE.bvid]?.data?.subtitle?.subtitles ?? [];
  checkEquals("fixture.sample-track-count", sampleTracks.length, 8);
  checkEquals("fixture.single-track-count", (BUNDLES[SINGLE.bvid]?.data?.subtitle?.subtitles ?? []).length, 1);
  const lanMismatch = sampleTracks
    .map((t) => t.lan)
    .filter((lan, i) => lan !== META.trackLans[i]);
  checkEquals("fixture.track-lans", lanMismatch.length, 0);
  const shapeBad = sampleTracks.filter(
    (t) =>
      !t.subtitle_url ||
      !t.subtitle_url_v2 ||
      !t.id_str ||
      typeof t.ai_type !== "number" ||
      t.is_lock !== false ||
      t.ai_status !== 2
  );
  checkEquals("fixture.track-entry-shape", shapeBad.length, 0);
  const missingBodies = [...sampleTracks, ...(BUNDLES[SINGLE.bvid]?.data?.subtitle?.subtitles ?? [])]
    .map((t) => String(t.subtitle_url).split("/").pop().replace(/\.json$/, ""))
    .filter((key) => !BODIES[key]);
  checkEquals("fixture.every-track-url-has-body", missingBodies.length, 0);
  check(
    "fixture.subtitle-urls-point-at-fixture-host",
    [...sampleTracks, ...(BUNDLES[SINGLE.bvid]?.data?.subtitle?.subtitles ?? [])].every((t) =>
      FIXTURE_URL_RE.test(String(t.subtitle_url))
    ),
    { first: sampleTracks[0]?.subtitle_url }
  );
  checkEquals("fixture.sample-bundle-identity", `${BUNDLES[SAMPLE.bvid]?.data?.bvid}/${BUNDLES[SAMPLE.bvid]?.data?.aid}/${BUNDLES[SAMPLE.bvid]?.data?.cid}`, `${SAMPLE.bvid}/${META.sampleAid}/${META.sampleCid}`);

  // 搜索期望：独立复算（同一条配对规则的第二份实现）与 committed 值逐项相等。
  const mismatches = [];
  for (const c of SEARCH_EXPECTATIONS) {
    for (const h of c.hits) {
      const got = recomputeHits(c.main, c.secondary, h.token);
      if (got.main !== h.main || got.sub !== h.sub || got.total !== h.total) {
        mismatches.push({ case: c.id, token: h.token, committed: h, recomputed: got });
      }
    }
  }
  checkEquals("fixture.search-expectations-recomputed", mismatches.length, 0);
  if (mismatches.length) evidence.fixture.searchMismatches = mismatches;
  return checks.every((c) => c.ok);
}

function fixturePatchExpression() {
  return `(() => {
    const FIX = ${JSON.stringify({ bundles: BUNDLES, bodies: BODIES })};
    const g = globalThis;
    if (!g.__biliHarness) {
      g.__biliHarness = { bundles: FIX.bundles, bodies: FIX.bodies, hits: [], gates: {}, storageChanges: [], stamp: Date.now() };
      const orig = g.fetch.bind(g);
      g.__biliHarness.orig = orig;
      try {
        chrome.storage.onChanged.addListener((changes, area) => {
          const st = g.__biliHarness;
          if (!st || st.storageChanges.length > 200) return;
          const entry = { area, t: Date.now(), keys: Object.keys(changes) };
          for (const k of Object.keys(changes)) entry[k] = { old: changes[k].oldValue, new: changes[k].newValue };
          st.storageChanges.push(entry);
        });
      } catch {}
      g.fetch = async (input, init) => {
        const st = g.__biliHarness;
        const url = typeof input === 'string' ? input : ((input && input.url) || String(input));
        if (/x\\/player\\/(?:wbi\\/)?v2/.test(url)) {
          const bvid = (url.match(/bvid=([A-Za-z0-9]+)/) || [])[1] || '';
          st.hits.push({ url, kind: 'bundle', bvid, t: Date.now() });
          const delay = (st.delays && st.delays.bundle) || 0;
          if (delay) await new Promise(r => setTimeout(r, delay));
          return new Response(JSON.stringify(st.bundles[bvid] || { code: 0, data: { subtitle: { subtitles: [] } } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        const m = url.match(/walkthrough-fixture\\/([A-Za-z0-9\\-]+)\\.json/);
        if (m) {
          const key = m[1];
          st.hits.push({ url, kind: 'body', key, t: Date.now() });
          const payload = st.bodies[key];
          const gate = st.gates && st.gates[key];
          // 闸门流水：证明「这一拍到底有没有挂上闸」，并留下 SW 实例戳（实例被回收重启会换戳）。
          try { (st.gateLog = st.gateLog || []).push({ op: 'body', key, gated: !!gate, stamp: st.stamp, t: Date.now() }); } catch {}
          if (gate) {
            st.gateHit = key;
            await new Promise((res) => { st.waiters = st.waiters || {}; (st.waiters[key] = st.waiters[key] || []).push(res); });
          }
          if (payload === undefined) return new Response('{"body":[]}', { status: 404, headers: { 'content-type': 'application/json' } });
          const delay = (st.delays && st.delays.keys && st.delays.keys[key]) || 0;
          if (delay) await new Promise(r => setTimeout(r, delay));
          return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (/api\\.bilibili\\.com|aisubtitle|hdslb/.test(url)) {
          if (st.hits.length < 400) st.hits.push({ url, kind: 'passthrough', t: Date.now() });
        }
        return orig(input, init);
      };
    } else {
      g.__biliHarness.bundles = FIX.bundles;
      g.__biliHarness.bodies = FIX.bodies;
    }
    return 'fixture-ready';
  })()`;
}

// 补丁只在 PHASE 2 生效：PHASE 1 要看的是真接口的真应答，装上补丁就看不到了。
let fixturePatchEnabled = false;

// 走**裸 evaluate**（不经 session.evaluate 的重连重试）：session 的重试在补丁表达式本身
// 报错时会「失败 → 重连 → onReconnect → 再装 → 再失败」，把进程拖进无界递归/连接泄漏。
async function patchOnHandle(handle) {
  return handle.cdp.evaluate(fixturePatchExpression(), { sessionId: handle.sessionId, timeoutMs: 30000 });
}

async function installFixturePatch() {
  if (!worker?.handle) throw new Error("SW 未连接，装不了 fixture 补丁");
  return patchOnHandle(worker.handle);
}

function startFixtureKeepAlive() {
  if (patchKeepAlive) clearInterval(patchKeepAlive);
  // 轻量看护：补丁只会在 SW 被回收重启后丢；每 1.5s 探一次存活标记，不在才重打整份
  // （每拍重打会把 SW 压到 Runtime.evaluate 超时，反而制造噪声）。
  patchKeepAlive = setInterval(() => {
    void (async () => {
      try {
        const alive = await worker.evaluate(`(globalThis.__biliHarness ? 'alive' : 'gone')`, 8000);
        if (alive !== "alive") {
          await installFixturePatch();
          log("fixture 补丁已随 SW 重启重打");
        }
      } catch {}
    })();
  }, 1500);
  patchKeepAlive.unref?.();
}

async function swHits() {
  try {
    return await worker.evaluate(`JSON.parse(JSON.stringify((globalThis.__biliHarness || {}).hits || []))`);
  } catch (error) {
    return { error: error.message };
  }
}

async function clearHits() {
  try {
    await worker.evaluate(`(() => { if (globalThis.__biliHarness) globalThis.__biliHarness.hits.length = 0; return true; })()`);
  } catch {}
}

async function setGate(key, on) {
  try {
    return await worker.evaluate(`(() => { const s = globalThis.__biliHarness; if (!s) return { error: 'no-fixture' }; s.gates = s.gates || {}; s.gates[${JSON.stringify(key)}] = ${on ? "true" : "false"}; (s.gateLog = s.gateLog || []).push({ op: 'set', key: ${JSON.stringify(key)}, on: ${on ? "true" : "false"}, stamp: s.stamp, t: Date.now() }); return { key: ${JSON.stringify(key)}, armed: s.gates[${JSON.stringify(key)}] === true, stamp: s.stamp, gates: Object.keys(s.gates).filter((k) => s.gates[k]) }; })()`);
  } catch (error) {
    return { error: error.message };
  }
}

async function releaseGate(key) {
  try {
    return await worker.evaluate(`(() => { const s = globalThis.__biliHarness; if (!s) return { error: 'no-fixture' }; s.gates = s.gates || {}; s.gates[${JSON.stringify(key)}] = false; const list = (s.waiters && s.waiters[${JSON.stringify(key)}]) || []; const count = list.length; list.splice(0).forEach(f => f()); (s.gateLog = s.gateLog || []).push({ op: 'release', key: ${JSON.stringify(key)}, waiters: count, stamp: s.stamp, t: Date.now() }); return { released: count, stamp: s.stamp }; })()`);
  } catch (error) {
    return { error: error.message };
  }
}

async function swGateLog() {
  try {
    return await worker.evaluate(`JSON.parse(JSON.stringify({ stamp: (globalThis.__biliHarness || {}).stamp ?? null, gateLog: (globalThis.__biliHarness || {}).gateLog ?? [] }))`);
  } catch (error) {
    return { error: error.message };
  }
}

async function storageProbe() {
  try {
    return await worker.evaluate(`(async () => {
      const sync = await chrome.storage.sync.get(['bilingualSubtitles', 'secondarySubtitleLang']);
      const local = await chrome.storage.local.get(['bilingualSubtitles', 'secondarySubtitleLang']);
      return { sync, local, syncHasBilingual: Object.prototype.hasOwnProperty.call(sync, 'bilingualSubtitles'), syncHasSecondaryLang: Object.prototype.hasOwnProperty.call(sync, 'secondarySubtitleLang') };
    })()`);
  } catch (error) {
    return { error: error.message };
  }
}

async function setStoredSecondaryLang(lang) {
  try {
    return await worker.evaluate(`(async () => { await chrome.storage.sync.set({ secondarySubtitleLang: ${JSON.stringify(lang)} }); return true; })()`);
  } catch (error) {
    return { error: error.message };
  }
}

async function waitStorageQuiet(quietMs = 3000, timeoutMs = 20000) {
  const size = async () => {
    try {
      return await worker.evaluate(`(globalThis.__biliHarness && globalThis.__biliHarness.storageChanges || []).length`, 8000);
    } catch {
      return -1;
    }
  };
  const started = Date.now();
  let last = await size();
  let quiet = 0;
  while (Date.now() - started < timeoutMs && quiet < quietMs) {
    await sleep(300);
    const count = await size();
    if (count === last) quiet += 300;
    else {
      quiet = 0;
      last = count;
    }
  }
  return { waitedMs: Date.now() - started, quietMs: quiet, entries: last };
}

// ---- 页面交互（全部走真指针事件；元素必须先在场且有几何）----
const SEL = {
  scriptButton: `document.getElementById('biliscript-script-button')`,
  pickerTrigger: `document.querySelector('.biliscript-reading-track-picker .custom-select-trigger')`,
  pickerDropdown: `document.querySelector('.biliscript-reading-track-picker .custom-select-dropdown')`,
  bilingualSwitch: `document.querySelector('.biliscript-bilingual-switch')`,
  mainColumn: `document.querySelector('.biliscript-bilingual-col[data-col="main"]')`,
  subColumn: `document.querySelector('.biliscript-bilingual-col[data-col="sub"]')`,
  mainOptionRowIsCurrent: `(() => {
    const card = document.querySelector('.biliscript-reading-track-picker .custom-select-dropdown');
    const sel = document.getElementById('biliscript-reading-subtitle-select');
    if (!card || !sel) return null;
    return [...card.querySelectorAll('.biliscript-bilingual-col[data-col="main"] .custom-select-option')].find(r => (r.dataset.value || '') === sel.value) || null;
  })()`
};

async function openPicker() {
  const hidden = await pageCdp.evaluate(`(() => { const d = ${SEL.pickerDropdown}; return d ? d.hidden : null; })()`);
  if (hidden) await clickElement(pageCdp, "打开选轨弹层", SEL.pickerTrigger);
  await sleep(250);
}

async function closePicker() {
  const hidden = await pageCdp.evaluate(`(() => { const d = ${SEL.pickerDropdown}; return d ? d.hidden : null; })()`);
  if (hidden === false) await clickElement(pageCdp, "收起选轨弹层", SEL.pickerTrigger);
  await sleep(200);
}

async function clickOptionRow(pageCdp, checkName, label, column, matchExpr) {
  const locate = `(() => {
    const card = document.querySelector('.biliscript-reading-track-picker .custom-select-dropdown');
    if (!card) return null;
    const rows = [...card.querySelectorAll('.biliscript-bilingual-col[data-col="${column}"] .custom-select-option')];
    return rows.find(r => ${matchExpr}) || null;
  })()`;
  const clip = `(() => { const card = document.querySelector('.biliscript-reading-track-picker .custom-select-dropdown'); return card ? card.querySelector('.biliscript-bilingual-col[data-col="${column}"]') : null; })()`;
  return mustClick(pageCdp, checkName, label, locate, { clipExpr: clip });
}

async function toggleBilingual(checkName) {
  // 真指针点击要求开关在场：重渲可能把弹层重新收起，故每次先确保弹出（幂等）。
  await openPicker();
  const result = await mustClick(pageCdp, checkName, "双语开关", SEL.bilingualSwitch);
  await sleep(300);
  return result;
}

async function pausePageMedia() {
  try {
    const nodes = await pageCdp.evaluate(JS.pauseMedia);
    evidence.meta.mediaPaused = nodes;
    return nodes;
  } catch (error) {
    evidence.meta.mediaPaused = `error: ${error.message}`;
    return null;
  }
}

async function waitScriptButton(label) {
  await waitFor(`${label}：扩展按钮注入`, async () => pageCdp.evaluate(`!!document.getElementById('biliscript-script-button')`), { timeoutMs: 30000, intervalMs: 300 });
}

async function waitReadingViewOpen(label) {
  await waitFor(`${label}：阅读视图打开`, async () =>
    pageCdp.evaluate(`(() => { const v = document.getElementById('biliscript-reading-view'); return !!v && v.classList.contains('open') && v.getAttribute('data-biliscript-reader-ready') !== '0'; })()`), { timeoutMs: 30000, intervalMs: 250 });
}

async function enterReadingMode(label) {
  await waitScriptButton(label);
  const clicked = await clickElement(pageCdp, "进入阅读模式", SEL.scriptButton);
  if (!clicked.ok) log(`进入阅读模式的真指针点击未成功：${JSON.stringify(clicked)}`);
  await waitReadingViewOpen(label);
}

async function waitSubtextState(state, timeoutMs = 20000) {
  return waitFor(`副行 data-state=${state}`, async () =>
    pageCdp.evaluate(`document.querySelectorAll('#biliscript-reading-subtitle .biliscript-reading-subtext[data-state="${state}"]').length`), { timeoutMs, intervalMs: 150 });
}

async function assertSearch(id, caseId, token) {
  const res = await pageCdp.evaluate(JS.search(token));
  const exp = expectation(caseId, token);
  check(
    `${id}.search.${caseId}.${token}`,
    res?.renderedMarkCount === exp.total && res?.marksInMainLine === exp.main && res?.marksInSecondaryLine === exp.sub,
    { actual: { total: res?.renderedMarkCount, main: res?.marksInMainLine, sub: res?.marksInSecondaryLine }, expected: { total: exp.total, main: exp.main, sub: exp.sub }, countText: res?.countText }
  );
  return res;
}

// 副列语言行必须真的铺在场上、有几何、能点（真机 run11 的反向发现：页面表
// `[hidden]{display:none!important}` 会把副列压成 0×0，用户根本换不了副语言）。
function checkSubColumnHittable(id, picker) {
  const sub = (picker?.cols || []).find((c) => c.col === "sub");
  check(
    `${id}.sub-column-laid-out`,
    sub?.hidden === false && (sub?.rows ?? 0) === 8 && (sub?.visibleRows ?? 0) === 8 && (sub?.rect?.w ?? 0) >= 140,
    { hidden: sub?.hidden, rows: sub?.rows, visibleRows: sub?.visibleRows, colWidth: sub?.rect?.w, subDropdownDisplay: picker?.subDropdownDisplay }
  );
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

  const page = await attachPage(browser, { viewport: VIEWPORT });
  pageCdp = page.cdp;
  await pageCdp.send("Page.bringToFront").catch(() => {});
  const watched = watchPage(pageCdp);
  evidence.phase1.consoleLog = watched.consoleLog;

  worker = createWorkerSession({
    pageCdp,
    browser,
    onReconnect: async (handle) => {
      if (!fixturePatchEnabled) return;
      try {
        await patchOnHandle(handle);
        log("SW 重连：fixture 补丁已重打");
      } catch (error) {
        log(`SW 重连后 fixture 补丁重打失败：${error.message}`);
      }
    }
  });
  const workerUp = await worker.ensureAlive();
  check("sw-attach", workerUp, { url: worker.handle?.url, via: worker.handle?.via });
  if (workerUp) {
    const suffixOk = worker.handle.url.endsWith(worker.handle.suffix);
    check("sw-target-by-manifest-suffix", suffixOk, { url: worker.handle.url, suffix: worker.handle.suffix });
    // SW 侧网络观察（PHASE 1：证明扩展自己发的 player/wbi/v2 请求真的发生过）
    try {
      const cdp = worker.handle.cdp;
      const sid = worker.handle.sessionId;
      await cdp.send("Network.enable", {}, sid, 15000);
      cdp.on("Network.requestWillBeSent", (params) => {
        const url = params.request?.url || "";
        if (/api\.bilibili\.com|x\/player/.test(url) && swNetLog.length < 200) swNetLog.push({ phase: "request", url });
      });
      cdp.on("Network.responseReceived", (params) => {
        const url = params.response?.url || "";
        if (/api\.bilibili\.com|x\/player/.test(url) && swNetLog.length < 200) swNetLog.push({ phase: "response", url, status: params.response.status });
      });
    } catch (error) {
      log(`SW 网络观察未挂上：${error.message}`);
    }
  }

  // ===== PHASE 1：真网真页面 =====
  log("PHASE 1：真机 + 真扩展 + 真接口（未打 fixture 补丁）");
  await pageCdp.send("Page.navigate", { url: SAMPLE.url });
  // 注入证据必须在**点按钮之前**读：点下去进阅读模式后那枚按钮就从 DOM 里摘掉了。
  await waitScriptButton("PHASE 1");
  evidence.phase1.injection = await pageCdp.evaluate(`({
    button: !!document.getElementById('biliscript-script-button'),
    style: !!document.getElementById('biliscript-style'),
    root: !!document.getElementById('biliscript-root')
  })`);
  check("phase1-extension-injected", evidence.phase1.injection.button === true, evidence.phase1.injection);
  await enterReadingMode("phase1");

  await waitFor("PHASE 1：字幕抓取落定", async () =>
    pageCdp.evaluate(`(() => {
      const list = document.getElementById('biliscript-reading-subtitle');
      if (!list) return false;
      const items = list.querySelectorAll('.biliscript-reading-item').length;
      const empty = list.querySelector('.biliscript-reading-empty');
      const trigger = document.querySelector('.biliscript-reading-track-picker .custom-select-trigger');
      if (items > 0) return { kind: 'items', items };
      if (empty && !/正在加载字幕/.test(empty.textContent)) return { kind: 'empty', text: empty.textContent };
      if (trigger && !trigger.getAttribute('aria-busy')?.includes('true') && trigger.textContent && !/抓取中/.test(trigger.textContent)) return { kind: 'trigger', trigger: trigger.textContent };
      return false;
    })()`), { timeoutMs: 45000, intervalMs: 500 });

  evidence.phase1.afterFetch = await pageCdp.evaluate(`(() => {
    const list = document.getElementById('biliscript-reading-subtitle');
    const trigger = document.querySelector('.biliscript-reading-track-picker .custom-select-trigger');
    return {
      itemCount: list ? list.querySelectorAll('.biliscript-reading-item').length : null,
      emptyText: list?.querySelector('.biliscript-reading-empty')?.textContent ?? null,
      triggerText: trigger?.querySelector('.custom-select-value')?.textContent ?? null,
      triggerDisabled: trigger?.disabled ?? null,
      statusLine: document.getElementById('biliscript-reading-status')?.textContent ?? null
    };
  })()`);
  log(`PHASE 1 抓取落定：${JSON.stringify(evidence.phase1.afterFetch)}`);
  await pausePageMedia();

  await openPicker();
  evidence.phase1.picker = await pageCdp.evaluate(JS.picker);
  evidence.phase1.list = await pageCdp.evaluate(JS.list);
  await shot("00-phase1-anonymous-picker", "PHASE 1：匿名未登录下字幕 tab 的选轨弹层（双语关）");
  const realTracks = (evidence.phase1.picker?.mainOptions || []).filter((o) => o.value);
  const realTrackCount = realTracks.length;
  evidence.phase1.realTrackCount = realTrackCount;
  log(`PHASE 1 真网可装载轨数 = ${realTrackCount}`);
  await closePicker();

  if (workerUp) {
    try {
      const probeUrl = `https://api.bilibili.com/x/player/wbi/v2?aid=${META.sampleAid}&cid=${META.sampleCid}&bvid=${SAMPLE.bvid}`;
      evidence.phase1.workerProbe = await worker.evaluate(`(async () => {
        try {
          const res = await fetch(${JSON.stringify(probeUrl)}, { credentials: 'include', headers: { Accept: 'application/json, text/plain, */*' } });
          const json = await res.json();
          const subs = (json && json.data && json.data.subtitle && json.data.subtitle.subtitles) || [];
          return { httpStatus: res.status, code: json && json.code, message: json && json.message, trackCount: Array.isArray(subs) ? subs.length : -1, lans: subs.map(s => s.lan), subtitleKeys: Object.keys((json && json.data && json.data.subtitle) || {}) };
        } catch (e) { return { error: String(e && e.message || e) }; }
      })()`, 20000);
    } catch (error) {
      evidence.phase1.workerProbe = { error: error.message };
    }
  }
  evidence.phase1.workerNetLog = swNetLog.slice(0, 120);

  // ===== PHASE 2：fixture 数据 + 真实渲染路径（矩阵的确定性输入）=====
  log("PHASE 2：重新导航 + fixture 补丁（只换两个网络应答，其余走真实渲染路径）");
  await pageCdp.send("Page.navigate", { url: SAMPLE.url });
  await waitFor("PHASE 2：扩展按钮注入", async () => pageCdp.evaluate(`!!document.getElementById('biliscript-script-button')`), { timeoutMs: 30000, intervalMs: 300 });
  fixturePatchEnabled = true;
  evidence.matrix.patchResult = await installFixturePatch();
  startFixtureKeepAlive();
  log(`fixture 补丁：${evidence.matrix.patchResult}`);
  await enterReadingMode("phase2");
  await waitFor("fixture 字幕上屏", async () => pageCdp.evaluate(`document.querySelectorAll('#biliscript-reading-subtitle .biliscript-reading-item').length > 0`), { timeoutMs: 45000, intervalMs: 400 });
  await pausePageMedia();
  evidence.matrix.usesFixture = true;
  evidence.matrix.note = "S1–S10 的读数全部建立在 fixture 的两个网络应答上（真实扩展代码 + 真实渲染路径）";
  evidence.matrix.tracksReady = await pageCdp.evaluate(`(() => {
    const main = document.getElementById('biliscript-reading-subtitle-select');
    return { main: main ? [...main.options].map(o => o.value).filter(Boolean).length : 0, items: document.querySelectorAll('#biliscript-reading-subtitle .biliscript-reading-item').length };
  })()`);
  checkEquals("phase2-track-count", evidence.matrix.tracksReady.main, 8);
  checkEquals("phase2-list-items", evidence.matrix.tracksReady.items, 197);

  try {
    // ---------- S1 双语关 ----------
    {
      const s1 = {};
      await closePicker();
      await clearHits();
      s1.listBilingualOff = await pageCdp.evaluate(JS.list);
      checkEquals("S1.subtext-node-count", s1.listBilingualOff.subtextNodeCount, 0);
      check("S1.no-subtext-in-first-item", s1.listBilingualOff.hasAnySubtext === false && !/biliscript-reading-subtext/.test(s1.listBilingualOff.firstItemHtml || ""), {
        firstItemHtml: s1.listBilingualOff.firstItemHtml
      });
      checkEquals("S1.item-count", s1.listBilingualOff.itemCount, 197);
      checkEquals("S1.first-item-seconds-unchanged", s1.listBilingualOff.firstItemSeconds, "0.18");
      checkEquals("S1.first-item-index-unchanged", s1.listBilingualOff.firstItemIndex, "0");
      s1.searchMainOnlyOff = await assertSearch("S1", "off-zh", "中文第1段");
      s1.searchBothOff = await assertSearch("S1", "off-zh", "AI");
      s1.searchSecondaryOnlyOff = await assertSearch("S1", "off-zh", "hallucination");
      await pageCdp.evaluate(JS.clearSearch);
      await sleep(300);
      await openPicker();
      s1.pickerBilingualOff = await pageCdp.evaluate(JS.picker);
      check("S1.picker-single-column", s1.pickerBilingualOff.cols?.find((c) => c.col === "sub")?.hidden === true && s1.pickerBilingualOff.subRows === 0, {
        subHidden: s1.pickerBilingualOff.cols?.find((c) => c.col === "sub")?.hidden,
        subRows: s1.pickerBilingualOff.subRows,
        mainRows: s1.pickerBilingualOff.bilingualRows
      });
      checkEquals("S1.switch-off", s1.pickerBilingualOff.switch?.ariaChecked, "false");
      check("S1.switch-enabled-with-8-tracks", s1.pickerBilingualOff.switch?.disabled === false, { disabled: s1.pickerBilingualOff.switch?.disabled });
      check("S1.trigger-fixed-width", s1.pickerBilingualOff.trigger?.rect?.w === 120, { w: s1.pickerBilingualOff.trigger?.rect?.w });
      check("S1.footer-not-inside-scroll-area", s1.pickerBilingualOff.footer?.insideScrollArea === false, { footer: s1.pickerBilingualOff.footer });
      checkEquals("S1.footer-fixed-on-scroll", s1.pickerBilingualOff.footerStableOnScroll?.moved, 0);
      check("S1.no-bilingual-badge", !s1.pickerBilingualOff.badge, { badge: s1.pickerBilingualOff.badge });
      await shot("01-bilingual-off-picker", "双语关：选轨弹层（主列 + 页脚开关）");
      s1.swHitsBeforeSwitchOn = await swHits();
      record("S1", { title: scenarioTitle("S1"), ...s1, note: "双语关：列表无副行节点；搜索零行为差" });
      log(`S1 完成：副行节点=${s1.listBilingualOff.subtextNodeCount}，AI=${s1.searchBothOff.countText}，hallucination=${s1.searchSecondaryOnlyOff.countText}`);
    }

    // ---------- S2 打开双语 ----------
    {
      const s2 = {};
      s2.switchBefore = (await pageCdp.evaluate(JS.picker)).switch;
      s2.storageBeforeToggle = await storageProbe();
      const toggle = await clickElement(pageCdp, "双语开关", SEL.bilingualSwitch);
      check("S2.switch-click-hittable", toggle.ok === true, toggle);
      s2.toggleClick = toggle;
      await sleep(120);
      s2.loadingSample = await pageCdp.evaluate(`(() => {
        const s = document.querySelector('#biliscript-reading-subtitle .biliscript-reading-subtext[data-state="loading"]');
        return { loadingRows: document.querySelectorAll('#biliscript-reading-subtitle .biliscript-reading-subtext[data-state="loading"]').length, sample: s ? s.textContent : null, fontStyle: s ? getComputedStyle(s).fontStyle : null };
      })()`);
      s2.pickerWhileLoading = await pageCdp.evaluate(JS.picker);
      if (s2.loadingSample.loadingRows > 0) {
        s2.searchPlaceholderDuringLoading = await assertSearch("S2.loading", "dual-zh-en", "译文加载中");
        await pageCdp.evaluate(JS.clearSearch);
        await sleep(300);
      }
      s2.storageAfterToggle = await storageProbe();
      await waitSubtextState("ready", 30000);
      await sleep(600);
      s2.pickerBilingualOn = await pageCdp.evaluate(JS.picker);
      checkEquals("S2.switch-on", s2.pickerBilingualOn.switch?.ariaChecked, "true");
      check("S2.badge-present", s2.pickerBilingualOn.badge?.text === "双语", { badge: s2.pickerBilingualOn.badge });
      check("S2.sub-options-8", s2.pickerBilingualOn.subOptions?.length === 8, { subOptions: s2.pickerBilingualOn.subOptions?.length });
      checkSubColumnHittable("S2", s2.pickerBilingualOn);
      // CDP CSS 域交叉取证：副列浮层的 computed display（页面表的 !important 重置若压过扩展，
      // 这里会是 none，行列几何同时塌掉）。
      try {
        await pageCdp.send("DOM.enable");
        await pageCdp.send("CSS.enable");
        const sheetUrls = new Map();
        pageCdp.on("CSS.styleSheetAdded", (params) => {
          sheetUrls.set(params.header.styleSheetId, params.header.sourceURL || `inline:${params.header.origin}`);
        });
        const doc = await pageCdp.send("DOM.getDocument", { depth: 1 });
        const found = await pageCdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: '#biliscript-reading-view .biliscript-bilingual-col[data-col="sub"] .custom-select-dropdown' });
        const matched = found?.nodeId ? await pageCdp.send("CSS.getMatchedStylesForNode", { nodeId: found.nodeId }) : null;
        const computed = found?.nodeId ? await pageCdp.send("CSS.getComputedStyleForNode", { nodeId: found.nodeId }) : null;
        s2.cssProbe = {
          nodeId: found?.nodeId ?? null,
          computedDisplay: (computed?.computedStyle || []).filter((p) => p.name === "display"),
          matchedDisplayRules: (matched?.matchedCSSRules || [])
            .map((m) => ({
              origin: m.rule.origin,
              selector: m.rule.selectorList.text.slice(0, 140),
              display: ((m.rule.style && m.rule.style.cssProperties) || []).filter((p) => p.name === "display").map((p) => ({ value: p.value, important: !!p.important })),
              styleSheetId: m.rule.styleSheetId
            }))
            .filter((m) => m.display.length || /hidden/.test(m.selector))
        };
        await sleep(300);
        s2.cssProbe.ruleSheets = s2.cssProbe.matchedDisplayRules.map((r) => ({
          selector: r.selector,
          display: r.display.map((d) => d.value),
          important: r.display.map((d) => d.important),
          sheet: sheetUrls.get(r.styleSheetId) || "unknown"
        }));
        // 副列浮层属于「hidden 属性在、display 由扩展的 !important 覆盖」这一态；页面表的
        // `[hidden]{display:none!important}` 若赢回来（或扩展那条丢了 !important），这里当场变
        // none、副列 8 行 rect 全 0×0 —— 与 S2.sub-column-laid-out 是同一条判据的两面。
        check(
          "S2.sub-dropdown-display-block",
          s2.cssProbe.computedDisplay?.[0]?.value === "block" && s2.pickerBilingualOn.subDropdownHiddenAttr !== null,
          { computedDisplay: s2.cssProbe.computedDisplay, hiddenAttr: s2.pickerBilingualOn.subDropdownHiddenAttr, rules: s2.cssProbe.ruleSheets }
        );
      } catch (error) {
        s2.cssProbe = { error: error.message };
        check("S2.sub-dropdown-display-block", false, s2.cssProbe);
      }
      await shot("02-bilingual-on-picker", "双语开：弹层两列 + 页脚开关 + trigger 徽标");
      s2.listBilingualOn = await pageCdp.evaluate(JS.list);
      checkEquals("S2.subtext-node-count", s2.listBilingualOn.subtextNodeCount, 197);
      checkEquals("S2.subtext-all-ready", s2.listBilingualOn.subtextStates.ready ?? 0, 197);
      check("S2.dual-row-metrics", s2.listBilingualOn.itemHeights?.[0] === 64 && s2.listBilingualOn.textHeights?.[0] === 44, {
        itemHeight: s2.listBilingualOn.itemHeights?.[0],
        textHeight: s2.listBilingualOn.textHeights?.[0]
      });
      const sub0 = s2.listBilingualOn.subtextSample?.[0];
      check("S2.subtext-style-wraps-not-truncates", sub0?.fontSize === "13px" && sub0?.lineHeight === "19px" && sub0?.whiteSpace === "normal" && (sub0?.textOverflow === "clip" || !sub0?.textOverflow), sub0);
      s2.mergedGroups = await pageCdp.evaluate(JS.mergedGroups);
      checkEquals("S2.merged-adjacent-pairs", s2.mergedGroups.duplicateSubtextPairCountRendered, 9);
      s2.searchBoth = await assertSearch("S2", "dual-zh-en", "AI");
      s2.searchSecondaryOnly = await assertSearch("S2", "dual-zh-en", "hallucination");
      s2.searchMainOnly = await assertSearch("S2", "dual-zh-en", "中文第1段");
      await pageCdp.evaluate(JS.clearSearch);
      await sleep(250);
      await closePicker();
      s2.listScreenshotState = await pageCdp.evaluate(JS.list);
      await shot("03-bilingual-on-dual-list", "双语开：字幕列表两行渲染（主行 + 译行）");
      s2.swHitsAfterSwitchOn = await swHits();
      record("S2", { title: scenarioTitle("S2"), ...s2, note: "双语开：双行渲染 + 合并段 + 双轨搜索" });
      log(`S2 完成：副行=${s2.listBilingualOn.subtextNodeCount}（ready=${s2.listBilingualOn.subtextStates.ready || 0}），合并相邻对=${s2.mergedGroups.duplicateSubtextPairCountRendered}`);
    }

    // ---------- S3 切主轨（Español）----------
    {
      const s3 = {};
      await clearHits();
      await openPicker();
      s3.secondaryBefore = await pageCdp.evaluate(`(() => {
        const sel = document.getElementById('biliscript-reading-secondary-subtitle-select');
        const o = sel ? sel.options[sel.selectedIndex] : null;
        return { value: sel ? sel.value : null, lang: o?.dataset.lang || null, text: o?.textContent || null, options: sel ? [...sel.options].map(x => ({ t: x.textContent, lang: x.dataset.lang })) : null };
      })()`);
      s3.mainRowClick = await clickOptionRow(pageCdp, "S3.main-row-click-hittable", "主列 Español", "main", `(r.dataset.value || '').endsWith('-es.json')`);
      await sleep(400);
      s3.duringSwitch = await pageCdp.evaluate(`(() => {
        const m = document.querySelector('.biliscript-reading-track-picker .custom-select-trigger');
        const sub = document.querySelector('.biliscript-bilingual-secondary-picker .custom-select-trigger');
        return { mainTriggerDisabled: m ? m.disabled : null, mainTriggerText: m?.querySelector('.custom-select-value')?.textContent ?? null, mainBusy: m?.getAttribute('aria-busy') ?? null, subTriggerDisabled: sub ? sub.disabled : null, subBusy: sub?.getAttribute('aria-busy') ?? null };
      })()`);
      check("S3.main-switch-keeps-main-usable", s3.duringSwitch.mainTriggerDisabled === false, s3.duringSwitch);
      s3.searchDuringMainSwitch = await assertSearch("S3", "dual-es-en", "hallucination");
      await pageCdp.evaluate(JS.clearSearch);
      await sleep(2500);
      s3.secondaryAfterMainSwitch = await pageCdp.evaluate(`(() => {
        const sel = document.getElementById('biliscript-reading-secondary-subtitle-select');
        const o = sel ? sel.options[sel.selectedIndex] : null;
        return { value: sel ? sel.value : null, lang: o?.dataset.lang || null, text: o?.textContent || null, options: sel ? [...sel.options].map(x => ({ t: x.textContent, lang: x.dataset.lang })) : null };
      })()`);
      check("S3.secondary-selection-untouched", s3.secondaryAfterMainSwitch.value === s3.secondaryBefore.value && s3.secondaryAfterMainSwitch.text === s3.secondaryBefore.text, {
        before: s3.secondaryBefore.text,
        after: s3.secondaryAfterMainSwitch.text
      });
      checkEquals("S3.secondary-options-unchanged", s3.secondaryAfterMainSwitch.options?.length, 8);
      s3.listAfterMainSwitch = await pageCdp.evaluate(JS.list);
      checkEquals("S3.list-follows-main-track", s3.listAfterMainSwitch.itemCount, 188);
      s3.swHits = await swHits();
      const bodyKeys = (s3.swHits || []).filter((h) => h.kind === "body").map((h) => h.key);
      check("S3.only-new-main-body-refetched", bodyKeys.every((k) => k.endsWith("-es")), { bodyKeys });
      s3.refetchedBodyKeys = bodyKeys;
      await shot("04-main-track-switched", "切主轨（Español）后：主列/正文换轨，副列与副行不被牵连");
      record("S3", { title: scenarioTitle("S3"), ...s3, note: "切主轨：副轨槽/副列选中态不被打乱" });
      log(`S3 完成：主轨切到 es；副列选中=${s3.secondaryAfterMainSwitch.text}（切前 ${s3.secondaryBefore.text}）`);
    }

    // ---------- S4 换副轨到 日本語（挂闸，确定性 loading 态）----------
    {
      const s4 = {};
      await clearHits();
      s4.gateArmed = await setGate(`${SAMPLE.bvid}-${SECONDARY_TARGET_LANG}`, true);
      check("S4.gate-armed", s4.gateArmed?.armed === true, s4.gateArmed);
      await openPicker();
      s4.gateStateBeforeClick = await swGateLog();
      s4.subRowClick = await clickOptionRow(pageCdp, "S4.sub-row-click-hittable", "副列 日本語", "sub", `(r.dataset.value || '').endsWith('-ja.json')`);
      try {
        await waitFor("副列 loading 占位（换副轨）", async () =>
          pageCdp.evaluate(`document.querySelectorAll('#biliscript-reading-subtitle .biliscript-reading-subtext[data-state="loading"]').length > 0`), { timeoutMs: 8000, intervalMs: 100 });
      } catch (error) {
        s4.loadingWaitError = error.message;
        check("S4.loading-state-appears", false, { error: error.message });
      }
      if (!s4.loadingWaitError) check("S4.loading-state-appears", true, null);
      await sleep(200);
      s4.pickerDuringLoading = await pageCdp.evaluate(`(() => {
        const m = document.querySelector('.biliscript-reading-track-picker .custom-select-trigger');
        const sub = document.querySelector('.biliscript-bilingual-secondary-picker .custom-select-trigger');
        const empty = document.querySelector('.biliscript-bilingual-col[data-col="sub"] .biliscript-bilingual-empty');
        return {
          mainTriggerDisabled: m ? m.disabled : null,
          mainBusy: m?.getAttribute('aria-busy') ?? null,
          subTriggerDisabled: sub ? sub.disabled : null,
          subBusy: sub?.getAttribute('aria-busy') ?? null,
          subEmptyText: empty && !empty.hidden ? empty.textContent : null,
          subRows: document.querySelectorAll('.biliscript-bilingual-col[data-col="sub"] .custom-select-option').length,
          mainOptionRowsClickable: document.querySelectorAll('.biliscript-bilingual-col[data-col="main"] .custom-select-option').length
        };
      })()`);
      check("S4.only-secondary-disabled", s4.pickerDuringLoading.subTriggerDisabled === true && s4.pickerDuringLoading.subBusy === "true" && s4.pickerDuringLoading.mainTriggerDisabled === false, s4.pickerDuringLoading);
      check("S4.main-column-still-clickable", s4.pickerDuringLoading.mainOptionRowsClickable === 8, { rows: s4.pickerDuringLoading.mainOptionRowsClickable });
      // 用户裁决（run14）：在飞不改副列语言列表，列表留在原地（不换成一行占位）。
      check("S4.secondary-list-stays-in-place", s4.pickerDuringLoading.subRows === 8 && s4.pickerDuringLoading.subEmptyText === null, {
        subRows: s4.pickerDuringLoading.subRows,
        subEmptyText: s4.pickerDuringLoading.subEmptyText
      });
      s4.listLoading = await pageCdp.evaluate(JS.list);
      check("S4.every-row-loading", (s4.listLoading.subtextStates.loading ?? 0) === s4.listLoading.itemCount && s4.listLoading.itemCount === 188 && !s4.listLoading.subtextStates.ready, s4.listLoading.subtextStates);
      check("S4.loading-placeholder-italic", s4.listLoading.subtextSample?.[0]?.fontStyle === "italic", { fontStyle: s4.listLoading.subtextSample?.[0]?.fontStyle });
      s4.searchPlaceholder = await assertSearch("S4", "dual-es-ja", "译文加载中");
      await pageCdp.evaluate(JS.clearSearch);
      await sleep(200);
      await shot("05-secondary-switch-loading", "换副轨（日本語）在飞：副列禁用 + 每行副行占位「译文加载中…」");
      s4.gateLogInFlight = await swGateLog();
      s4.gateReleased = await releaseGate(`${SAMPLE.bvid}-${SECONDARY_TARGET_LANG}`);
      check("S4.gate-released", (s4.gateReleased?.released ?? 0) >= 1, s4.gateReleased);
      await waitSubtextState("ready", 25000);
      await sleep(800);
      s4.listAfterReady = await pageCdp.evaluate(JS.list);
      s4.pickerAfterReady = await pageCdp.evaluate(JS.picker);
      check("S4.secondary-column-reenabled", s4.pickerAfterReady.cols?.find((c) => c.col === "sub")?.visibleRows === 8, { visibleRows: s4.pickerAfterReady.cols?.find((c) => c.col === "sub")?.visibleRows });
      record("S4", { title: scenarioTitle("S4"), ...s4, note: "换副轨：只禁副列；loading 占位不产生搜索命中；语言列表留在原地" });
      log(`S4 完成：副行占位命中=${s4.searchPlaceholder.countText}，副列禁用=${s4.pickerDuringLoading.subTriggerDisabled}，主列禁用=${s4.pickerDuringLoading.mainTriggerDisabled}`);
    }

    // ---------- S5 副轨到站 ----------
    {
      const s5 = {};
      s5.subtextAfterReady = (await pageCdp.evaluate(JS.list)).subtextSample;
      checkEquals("S5.first-secondary-line-is-ja", s5.subtextAfterReady?.[0]?.text, "JA-1 hallucination AI");
      s5.searchJaToken = await assertSearch("S5", "dual-es-ja", "JA-1");
      check("S5.ja-hit-navigates-in-secondary", s5.searchJaToken?.currentMarkInSecondary === true && s5.searchJaToken?.marksInMainLine === 0, {
        currentMarkInSecondary: s5.searchJaToken?.currentMarkInSecondary,
        marksInMainLine: s5.searchJaToken?.marksInMainLine
      });
      await pageCdp.evaluate(JS.clearSearch);
      await sleep(200);
      await closePicker();
      await shot("06-secondary-ja-ready", "副轨（日本語）到站：列表副行换成日文译文");
      s5.swHits = await swHits();
      record("S5", { title: scenarioTitle("S5"), ...s5, note: "副轨到站：列表副行换成新译文" });
      log(`S5 完成：首行副行=${s5.subtextAfterReady?.[0]?.text}`);
    }

    // ---------- S6 关闭双语 ----------
    {
      const s6 = {};
      await openPicker();
      s6.toggle = await toggleBilingual("S6.toggle-click-hittable");
      await sleep(500);
      s6.immediatelyAfterOff = { list: await pageCdp.evaluate(JS.list), picker: await pageCdp.evaluate(JS.picker) };
      checkEquals("S6.list-returns-to-single-track-500ms", s6.immediatelyAfterOff.list.subtextNodeCount, 0);
      check("S6.picker-collapses", s6.immediatelyAfterOff.picker.cols?.find((c) => c.col === "sub")?.hidden === true && s6.immediatelyAfterOff.picker.switch?.ariaChecked === "false", {
        subHidden: s6.immediatelyAfterOff.picker.cols?.find((c) => c.col === "sub")?.hidden,
        ariaChecked: s6.immediatelyAfterOff.picker.switch?.ariaChecked
      });
      await shot("07-bilingual-off-after-toggle", "关闭双语后（点击后 500ms）：列表已退回单轨，弹层收起副列");
      await sleep(1500);
      s6.after1500ms = { list: await pageCdp.evaluate(JS.list) };
      checkEquals("S6.list-still-single-track-1500ms", s6.after1500ms.list.subtextNodeCount, 0);
      s6.storageAfterOff = await storageProbe();
      checkEquals("S6.pref-persisted-off", s6.storageAfterOff?.sync?.bilingualSubtitles, false);
      s6.subSelAfterOff = await pageCdp.evaluate(`(() => { const s = document.getElementById('biliscript-reading-secondary-subtitle-select'); return { exists: !!s, options: s ? s.options.length : null, value: s ? s.value : null, disabled: s ? s.disabled : null }; })()`);
      check("S6.secondary-slot-not-cleared", s6.subSelAfterOff.exists === true && s6.subSelAfterOff.options === 0 && s6.subSelAfterOff.disabled === true, s6.subSelAfterOff);
      record("S6", { title: scenarioTitle("S6"), ...s6, note: "关闭双语：列表回单轨；副轨槽不清" });
      log(`S6 完成：关闭后 500ms 副行节点=${s6.immediatelyAfterOff.list.subtextNodeCount}；1.5s 后=${s6.after1500ms.list.subtextNodeCount}`);
    }

    // ---------- S7 再打开（不重抓、不闪 loading）----------
    {
      const s7 = {};
      await clearHits();
      const samples = [];
      const poll = (async () => {
        for (let i = 0; i < 40; i += 1) {
          try {
            samples.push(await pageCdp.evaluate(`(() => ({
              t: Date.now(),
              loading: document.querySelectorAll('#biliscript-reading-subtitle .biliscript-reading-subtext[data-state="loading"]').length,
              ready: document.querySelectorAll('#biliscript-reading-subtitle .biliscript-reading-subtext[data-state="ready"]').length,
              subRows: document.querySelectorAll('.biliscript-bilingual-col[data-col="sub"] .custom-select-option').length
            }))()`));
          } catch {}
          await sleep(50);
        }
      })();
      await openPicker();
      s7.toggle = await toggleBilingual("S7.toggle-click-hittable");
      await poll;
      s7.samples = samples;
      s7.loadingEverSeen = samples.some((s) => s.loading > 0);
      check("S7.no-loading-flicker", s7.loadingEverSeen === false, { samplesWithLoading: samples.filter((s) => s.loading > 0).length });
      s7.subtextAfterReopen = await pageCdp.evaluate(JS.list);
      checkEquals("S7.secondary-lines-ready-again", s7.subtextAfterReopen.subtextStates.ready ?? 0, 188);
      s7.storageAfterReopen = await storageProbe();
      checkEquals("S7.pref-persisted-on", s7.storageAfterReopen?.sync?.bilingualSubtitles, true);
      await sleep(400);
      await shot("08-bilingual-reopened", "重新打开双语：副行直接是译文（无加载占位闪烁）");
      s7.swHits = await swHits();
      s7.refetchedSecondaryBody = (s7.swHits || []).filter((h) => h.kind === "body").map((h) => h.key);
      checkEquals("S7.no-refetch-on-reopen", s7.refetchedSecondaryBody.length, 0);
      record("S7", { title: scenarioTitle("S7"), ...s7, note: "再打开：不重新抓副轨、不闪加载占位" });
      log(`S7 完成：重开期间出现 loading 占位=${s7.loadingEverSeen}，重抓的 body=${JSON.stringify(s7.refetchedSecondaryBody)}`);
    }

    // ---------- S7b 弹层滚动 ----------
    {
      const s7b = {};
      const scrollSample = () => pageCdp.evaluate(JS.scrollSample);
      await clearHits();
      await openPicker();
      const pickerAtBottom = await pageCdp.evaluate(JS.picker);
      s7b.pickerScrollRegions = pickerAtBottom.scrollRegions;
      s7b.cardRect = pickerAtBottom.cardEffectiveRect;
      const scrollbars = [s7b.pickerScrollRegions?.mid, s7b.pickerScrollRegions?.main, s7b.pickerScrollRegions?.sub].filter((r) => r && r.scrollbarWidth > 0).length;
      checkEquals("S7b-two-scroll-regions", scrollbars, 2);
      check("S7b-mid-is-clip-only", s7b.pickerScrollRegions?.mid?.scrollable === false, s7b.pickerScrollRegions?.mid);
      check("S7b-columns-scroll-independently", s7b.pickerScrollRegions?.main?.scrollable === true && s7b.pickerScrollRegions?.sub?.scrollable === true, {
        main: s7b.pickerScrollRegions?.main,
        sub: s7b.pickerScrollRegions?.sub
      });
      checkEquals("S7b-footer-fixed-on-scroll", pickerAtBottom.footerStableOnScroll?.moved, 0);
      s7b.beforeClick = await pageCdp.evaluate(`(() => {
        const card = document.querySelector('.biliscript-reading-track-picker .custom-select-dropdown');
        const mainCol = card.querySelector('.biliscript-bilingual-col[data-col="main"]');
        const subCol = card.querySelector('.biliscript-bilingual-col[data-col="sub"]');
        const list = document.getElementById('biliscript-reading-subtitle');
        const mid = card.querySelector('.biliscript-bilingual-main');
        mainCol.scrollTop = mainCol.scrollHeight;
        subCol.scrollTop = subCol.scrollHeight;
        mid.scrollTop = mid.scrollHeight;
        list.scrollTop = Math.min(3000, list.scrollHeight - list.clientHeight);
        const rows = [...subCol.querySelectorAll('.custom-select-option')];
        const last = rows[rows.length - 1];
        const cr = subCol.getBoundingClientRect();
        const lr = last ? last.getBoundingClientRect() : null;
        return {
          midScrollTop: mid.scrollTop,
          mainScrollTop: mainCol.scrollTop,
          subScrollTop: subCol.scrollTop,
          listScrollTop: list.scrollTop,
          subRows: rows.length,
          lastRowText: last ? last.textContent : null,
          lastRowValue: last ? (last.dataset.value || '') : null,
          lastRowFullyVisible: !!(lr && lr.top >= cr.top - 1 && lr.bottom <= cr.bottom + 1)
        };
      })()`);
      check("S7b-sub-column-scrollable-to-bottom", s7b.beforeClick.subScrollTop > 0, { subScrollTop: s7b.beforeClick.subScrollTop });
      check("S7b-last-row-visible-after-scroll", s7b.beforeClick.lastRowFullyVisible === true, { lastRowText: s7b.beforeClick.lastRowText });
      s7b.afterScrollSample = await scrollSample();
      await shot("13-picker-scrolled-to-bottom", "弹层两列各自滚到底（分开两条滚动条）；阅读列表滚到中段");
      s7b.gateArmed = await setGate(`${SAMPLE.bvid}-id`, true);
      check("S7b.gate-armed", s7b.gateArmed?.armed === true, s7b.gateArmed);
      s7b.subRowClick = await clickOptionRow(pageCdp, "S7b-last-sub-row-hittable", "副列最后一条语言", "sub", `r === rows.at(-1)`);
      s7b.afterClickSync = await scrollSample();
      await sleep(150);
      s7b.inFlight = await scrollSample();
      await shot("14-picker-inflight-list-stays", "换副轨在飞：语言列表留在原地，两处滚动位置未动");
      s7b.gateLogInFlight = await swGateLog();
      s7b.gateReleased = await releaseGate(`${SAMPLE.bvid}-id`);
      await waitSubtextState("ready", 25000);
      await sleep(700);
      s7b.afterReady = await scrollSample();
      await shot("15-picker-after-ready", "副轨到站：弹层与阅读列表的滚动位置都还在原处（选完滚动条不动）");
      const base = s7b.beforeClick.subScrollTop;
      // 承重读数（三轮修复的共同判据）：选完副语言，副列滚动位置不动。
      checkEquals("S7b-sub-scroll-survives-click", s7b.afterClickSync.card?.sub?.scrollTop, base);
      checkEquals("S7b-sub-scroll-survives-inflight", s7b.inFlight.card?.sub?.scrollTop, base);
      checkEquals("S7b-sub-scroll-survives-ready", s7b.afterReady.card?.sub?.scrollTop, base);
      checkEquals("S7b-secondary-list-stays-during-inflight", s7b.inFlight.subRows, 8);
      check("S7b-no-truncated-language-names", (s7b.pickerScrollRegions?.main?.scrollbarWidth || 0) > 0 && (pickerAtBottom.cols || []).every((c) => (c.truncatedRows || []).length === 0), {
        truncated: (pickerAtBottom.cols || []).map((c) => ({ col: c.col, rows: c.truncatedRows }))
      });
      // 复位副轨到 ja（per-track 缓存命中，瞬时），S8/S9 的偏好读数与走查同口径。
      await clickOptionRow(pageCdp, "S7b-reset-sub-to-ja-hittable", "副列 日本語（复位）", "sub", `(r.dataset.value || '').endsWith('-ja.json')`);
      await sleep(600);
      // 阅读列表的滚动位置跨一次纯 rerender（只关/开双语开关）。这一格是**受播放位置影响的
      // bonus 探针**：三轮跑动给出三个值（3000→3000 / 3000→552 / 3000→600），波动与本轮修复
      // 无关（同一份 dist 已经给出过不同值）。故只记录、不断言。
      await pageCdp.evaluate(`(() => { const l = document.getElementById('biliscript-reading-subtitle'); l.scrollTop = Math.min(3000, l.scrollHeight - l.clientHeight); return l.scrollTop; })()`);
      s7b.listBeforeRerender = await scrollSample();
      // 真指针点击要求开关在场：上一次改选把列表收起了，按用户真实路径重新展开。
      await openPicker();
      await toggleBilingual("S7b-rerender-off-hittable");
      await sleep(500);
      s7b.listAfterRerender = await scrollSample();
      await toggleBilingual("S7b-rerender-on-hittable");
      await sleep(800);
      s7b.listAfterReopen = await scrollSample();
      await shot("16-list-scroll-after-rerender", "阅读列表的滚动位置跨 rerender（只关/开双语开关）");
      s7b.swHits = await swHits();
      s7b.narrowTier = await pageCdp.evaluate(`(() => {
        const panel = document.getElementById('biliscript-reading-view');
        const card = document.querySelector('.biliscript-reading-track-picker .custom-select-dropdown');
        panel.style.setProperty('--biliscript-script-width', '380px');
        const r = card.getBoundingClientRect();
        const cols = [...card.querySelectorAll('.biliscript-bilingual-col')];
        const out = { cardW: +r.width.toFixed(2), maxWidth: getComputedStyle(card).maxWidth, cols: cols.map(c => ({ col: c.dataset.col, w: +c.getBoundingClientRect().width.toFixed(2), truncatedRows: [...c.querySelectorAll('.custom-select-option')].filter(o => o.scrollWidth > o.clientWidth + 1).map(o => o.textContent) })) };
        panel.style.removeProperty('--biliscript-script-width');
        return out;
      })()`);
      record("S7b", { title: scenarioTitle("S7b"), ...s7b, note: "两列各自滚；选完副语言滚动位置不动" });
      log(`S7b 完成：滚动条数=${scrollbars}；副列 scrollTop 点前=${base} 同步=${s7b.afterClickSync.card?.sub?.scrollTop} 在飞=${s7b.inFlight.card?.sub?.scrollTop} 到站=${s7b.afterReady.card?.sub?.scrollTop}；列表重渲前=${s7b.listBeforeRerender.list?.scrollTop} 重渲后=${s7b.listAfterRerender.list?.scrollTop}（受播放位置影响，仅记录）`);
      await closePicker();
      await pageCdp.evaluate(`(() => { const l = document.getElementById('biliscript-reading-subtitle'); l.scrollTop = 0; return true; })()`);
    }

    // ---------- S8 换视频（SPA 导航到单轨视频）----------
    {
      const s8 = {};
      await closePicker();
      await clearHits();
      await pageCdp.evaluate(`(() => { history.pushState({}, '', ${JSON.stringify(SINGLE.url)}); return location.href; })()`);
      await sleep(500);
      s8.urlAfterPushState = await pageCdp.evaluate(`location.href`);
      let navOk = false;
      try {
        await waitFor("换视频后重抓（单轨）", async () =>
          pageCdp.evaluate(`(() => {
            const list = document.getElementById('biliscript-reading-subtitle');
            const trigger = document.querySelector('.biliscript-reading-track-picker .custom-select-trigger');
            const notBusy = trigger ? trigger.getAttribute('aria-busy') !== 'true' : false;
            const hasSingle = /单轨中文第1段/.test(list ? list.textContent : '');
            return notBusy && hasSingle;
          })()`), { timeoutMs: 6000, intervalMs: 300 });
        navOk = true;
      } catch {
        navOk = false;
      }
      if (!navOk) {
        log("SPA 换视频未在 6s 内重抓到单轨 fixture ⇒ 回退为整页导航（已记录）");
        await pageCdp.send("Page.navigate", { url: SINGLE.url });
        // 整页导航会重新走抓取：先把补丁确认在位（SW 若被回收，这次调用会重连并重打）。
        await installFixturePatch();
        await enterReadingMode("s8-full-navigation");
      }
      await waitFor("单轨视频字幕上屏", async () => pageCdp.evaluate(`document.querySelectorAll('#biliscript-reading-subtitle .biliscript-reading-item').length > 0`), { timeoutMs: 45000, intervalMs: 400 });
      await pausePageMedia();
      await sleep(800);
      s8.navMode = navOk ? "spa-pushState" : "full-navigation";
      s8.listSingleTrackVideo = await pageCdp.evaluate(JS.list);
      checkEquals("S8.single-track-items", s8.listSingleTrackVideo.itemCount, 120);
      checkEquals("S8.single-track-no-secondary-lines", s8.listSingleTrackVideo.subtextNodeCount, 0);
      s8.storageSingleTrackVideo = await storageProbe();
      check("S8.pref-survives-video-change", s8.storageSingleTrackVideo?.sync?.bilingualSubtitles === true && typeof s8.storageSingleTrackVideo?.sync?.secondarySubtitleLang === "string", {
        bilingual: s8.storageSingleTrackVideo?.sync?.bilingualSubtitles,
        lang: s8.storageSingleTrackVideo?.sync?.secondarySubtitleLang
      });
      await openPicker();
      s8.pickerSingleTrackVideo = await pageCdp.evaluate(JS.picker);
      check("S8.switch-disabled-on-single-track", s8.pickerSingleTrackVideo.switch?.disabled === true && s8.pickerSingleTrackVideo.switch?.ariaChecked === "true", s8.pickerSingleTrackVideo.switch);
      check("S8.single-track-hint-visible", s8.pickerSingleTrackVideo.hint?.hidden === false && s8.pickerSingleTrackVideo.hint?.text?.includes("只有一条字幕轨"), s8.pickerSingleTrackVideo.hint);
      await shot("09-video-change-single-track", "换视频后（单轨视频）：开关禁用 + 列表静默退回单轨");
      await closePicker();
      s8.swHits = await swHits();
      record("S8", { title: scenarioTitle("S8"), ...s8, note: "换视频：全局偏好保留、新视频缺轨时静默单轨 + 开关禁用" });
      log(`S8 完成：navMode=${s8.navMode}，开关禁用=${s8.pickerSingleTrackVideo.switch?.disabled}，副行节点=${s8.listSingleTrackVideo.subtextNodeCount}`);
    }

    // ---------- S9 解释卡引用只含主行 ----------
    {
      const s9 = {};
      await pageCdp.send("Page.navigate", { url: SAMPLE.url });
      await enterReadingMode("s9");
      await installFixturePatch();
      await waitFor("回样本视频字幕上屏", async () => pageCdp.evaluate(`document.querySelectorAll('#biliscript-reading-subtitle .biliscript-reading-item').length > 0`), { timeoutMs: 45000, intervalMs: 300 });
      await pausePageMedia();
      s9.storageAfterReturn = await storageProbe();
      try {
        await waitSubtextState("ready", 15000);
        s9.dualReadyWithoutUserAction = true;
      } catch (error) {
        s9.subtextWaitError = error.message;
        s9.dualReadyWithoutUserAction = false;
        await openPicker();
        s9.switchStateAtS9 = await pageCdp.evaluate(`(() => { const s = document.querySelector('.biliscript-bilingual-switch'); return s ? { disabled: s.disabled, ariaChecked: s.getAttribute('aria-checked') } : null; })()`);
        await toggleBilingual("S9.toggle-hittable");
        try {
          await waitSubtextState("ready", 15000);
          s9.dualReadyAfterManualToggle = true;
        } catch (error2) {
          s9.dualReadyAfterManualToggle = false;
          s9.subtextWaitErrorAfterToggle = error2.message;
        }
      }
      check("S9.dual-state-ready", s9.dualReadyWithoutUserAction === true || s9.dualReadyAfterManualToggle === true, {
        dualReadyWithoutUserAction: s9.dualReadyWithoutUserAction,
        dualReadyAfterManualToggle: s9.dualReadyAfterManualToggle
      });
      s9.preState = await pageCdp.evaluate(JS.list);
      // 在**副行**文字上建立选区（选区只能程序化构造：真指针拖选需要真实鼠标轨迹，
      // 这里用的是 Range + selectionchange，与被测实现消费的同一条路径）。
      const selectSubLine = () => pageCdp.evaluate(`(() => {
        const sub = document.querySelector('#biliscript-reading-subtitle .biliscript-reading-item .biliscript-reading-subtext[data-state="ready"]');
        if (!sub) return { error: 'no-ready-subtext' };
        const node = sub.firstChild;
        const range = document.createRange();
        range.selectNodeContents(node && node.nodeType === 3 ? node : sub);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
        const pop = document.getElementById('biliscript-reading-explain-pop');
        const item = sub.closest('.biliscript-reading-item');
        return {
          selectedText: sel.toString(),
          selectedInSubtext: !!sub.contains(sel.anchorNode),
          popHidden: pop ? pop.hidden : null,
          itemIndex: item?.dataset.index ?? null,
          mainLine: item?.querySelector('.biliscript-reading-text')?.firstChild?.textContent ?? null,
          fullTextSpan: item?.querySelector('.biliscript-reading-text')?.textContent ?? null,
          subText: sub.textContent
        };
      })()`);
      s9.selection = await selectSubLine();
      check("S9.selection-in-secondary-line", s9.selection?.selectedInSubtext === true && !s9.selection?.error, s9.selection);
      await sleep(600);
      s9.popAfterFrame = await pageCdp.evaluate(`(() => { const p = document.getElementById('biliscript-reading-explain-pop'); return { hidden: p?.hidden, itemIndex: p?.dataset.itemIndex ?? null, text: p?.textContent ?? null }; })()`);
      await shot("10-explain-pop", "在副行文字上选中：选区「解释」浮层出现");
      s9.selectionBeforeClick = await selectSubLine();
      await sleep(400);
      s9.cardOpen = await mustClick(pageCdp, "S9.explain-pop-button-hittable", "解释浮层按钮", `document.querySelector('#biliscript-reading-explain-pop button')`);
      try {
        await waitFor("解释卡片打开", async () => pageCdp.evaluate(`(() => { const c = document.getElementById('biliscript-reading-explain-card'); return !!c && !c.hidden; })()`), { timeoutMs: 10000, intervalMs: 250 });
        check("S9.explain-card-opens", true, null);
      } catch (error) {
        s9.cardWaitError = error.message;
        check("S9.explain-card-opens", false, { error: error.message });
      }
      await sleep(400);
      s9.card = await pageCdp.evaluate(`(() => {
        const card = document.getElementById('biliscript-reading-explain-card');
        return {
          quote: card?.querySelector('.biliscript-reading-explain-card-quote')?.textContent ?? null,
          stateText: card?.textContent?.slice(0, 400) ?? null,
          hasRetry: !!card?.querySelector('[data-explain-card-action="retry"]'),
          askChat: !!card?.querySelector('[data-explain-card-action="ask-chat"]')
        };
      })()`);
      await shot("11-explain-card", "解释卡片（无 AI key 时的诚实失败态）");
      s9.askChat = await mustClick(pageCdp, "S9.ask-chat-hittable", "去对话追问", `document.querySelector('[data-explain-card-action="ask-chat"]')`);
      await sleep(1200);
      s9.intentCard = await pageCdp.evaluate(`(() => {
        const card = document.getElementById('biliscript-reading-chat-intent');
        return {
          hidden: card?.hidden ?? null,
          quote: card?.querySelector('.biliscript-reading-chat-intent-quote')?.textContent ?? null,
          time: card?.querySelector('.biliscript-reading-chat-intent-time')?.textContent ?? null,
          activeTab: document.querySelector('.biliscript-reading-tab.is-active')?.textContent?.trim() ?? null
        };
      })()`);
      // 判据：引用卡里的**字幕句** = 那次取值收到的 card.line（解释卡的 line），只含主行。
      // 引用卡把选中片段与字幕句一起渲染（`「选中片段」｜字幕句`，见 chat-tab.ts
      // renderExplainIntentCard）——片段正是用户在副行上选中的那段译文，故按这个结构逐字比对：
      // 后半段必须等于主行，且主行本身不等于副行译文。
      const selectedFragment = s9.selectionBeforeClick?.selectedText ?? s9.selection?.selectedText ?? "";
      const mainLine = s9.selectionBeforeClick?.mainLine ?? s9.selection?.mainLine ?? "";
      const subText = s9.selectionBeforeClick?.subText ?? s9.selection?.subText ?? "";
      const expectedQuote = selectedFragment ? `「${selectedFragment}」｜${mainLine}` : `「${mainLine}」`;
      check(
        "S9.intent-quote-is-main-line-only",
        !!mainLine && mainLine !== subText && s9.intentCard?.quote === expectedQuote,
        { quote: s9.intentCard?.quote, expectedQuote, mainLine, subText }
      );
      await shot("12-explain-intent-quote", "「去对话追问」的引用卡：content = card.line（解释卡引用句）");
      record("S9", { title: scenarioTitle("S9"), ...s9, note: "解释卡引用句只含主行" });
      log(`S9 完成：引用卡=${JSON.stringify(s9.intentCard?.quote)}`);
    }

    // ---------- S10 主副同轨 ----------
    {
      const s10 = {};
      await mustClick(pageCdp, "S10.back-to-subtitle-tab-hittable", "字幕 tab", `document.getElementById('biliscript-reading-tab-subtitle')`);
      await sleep(400);
      await clearHits();
      try {
        await waitSubtextState("ready", 8000);
      } catch (error) {
        s10.subtextWaitError = error.message;
      }
      await openPicker();
      s10.beforeCollision = await pageCdp.evaluate(JS.picker);
      s10.listBeforeCollision = await pageCdp.evaluate(JS.list);
      s10.prefBeforeCollision = await storageProbe();
      // ① 副列点主轨那一条 ⇒ 同轨防呆：清副轨槽、偏好记成主轨语言
      s10.collisionClick = await clickOptionRow(pageCdp, "S10.collision-row-hittable", "副列里的主轨那一条（中文）", "sub",
        `(r.dataset.value || '') === document.getElementById('biliscript-reading-subtitle-select')?.value`);
      await sleep(600);
      s10.afterCollision = await pageCdp.evaluate(JS.picker);
      s10.listAfterCollision = await pageCdp.evaluate(JS.list);
      s10.dupAfterCollision = await pageCdp.evaluate(JS.dupSample);
      checkEquals("S10.collision-clears-primary-duplicate", s10.dupAfterCollision.itemsWithSubtext, 0);
      // 用户裁决（第五轮）：同轨提示在**页脚**，副列语言列表照常在列（点错改得回来）。
      check(
        "S10.footer-note-and-list-coexist",
        s10.afterCollision.footerNote?.hidden === false &&
          s10.afterCollision.footerNote?.text === "主副字幕相同" &&
          s10.afterCollision.cols?.find((c) => c.col === "sub")?.hidden === false &&
          (s10.afterCollision.cols?.find((c) => c.col === "sub")?.visibleRows ?? 0) === 8,
        { footerNote: s10.afterCollision.footerNote, subCol: s10.afterCollision.cols?.find((c) => c.col === "sub") }
      );
      await shot("17-collision-note-and-list", "主副同轨：页脚说明行 + 语言列表仍在场（点错也改得回来）");
      s10.prefAtCollision = await storageProbe();
      s10.subChangeLogArmed = await pageCdp.evaluate(`(() => {
        const s = document.getElementById('biliscript-reading-secondary-subtitle-select');
        window.__subChangeLog = [];
        if (!s) return false;
        s.addEventListener('change', () => {
          const o = s.options[s.selectedIndex];
          window.__subChangeLog.push({ value: s.value, idx: s.selectedIndex, text: o ? o.textContent : null, lang: o ? (o.dataset.lang || null) : null, t: Math.round(performance.now()) });
        }, true);
        return true;
      })()`);
      s10.storageQuietBeforeCollision = await waitStorageQuiet();
      // ② 自动装载路径：主列重选同一条轨 ⇒ subtitle-ready ⇒ 按偏好重匹配。
      //   修复前：主轨那份被当副轨装进槽 ⇒ 列表出两份一样的正文；修复后：副行仍是 0。
      //   （真指针点击要求列表在场：上一步的改选把列表收起了，这里按用户真实路径重新展开。）
      await openPicker();
      s10.mainRePick = await clickOptionRow(pageCdp, "S10.main-repick-hittable", "主列重选当前主轨", "main",
        `(r.dataset.value || '') === document.getElementById('biliscript-reading-subtitle-select')?.value`);
      let autoSample = null;
      for (let i = 0; i < 24; i += 1) {
        autoSample = await pageCdp.evaluate(JS.dupSample);
        if (autoSample.itemsWithSubtext > 0) break;
        await sleep(300);
      }
      await sleep(600);
      s10.dupAfterMainRepickFirstSeen = autoSample;
      s10.dupAfterMainRepick = await pageCdp.evaluate(JS.dupSample);
      s10.listAfterMainRepick = await pageCdp.evaluate(JS.list);
      s10.pickerAfterMainRepick = await pageCdp.evaluate(JS.picker);
      s10.prefAfterMainRepick = await storageProbe();
      s10.subChangeLog = await pageCdp.evaluate(`window.__subChangeLog || null`);
      s10.subSelAfterMainRepick = await pageCdp.evaluate(`(() => {
        const s = document.getElementById('biliscript-reading-secondary-subtitle-select');
        if (!s) return null;
        return { value: s.value, selectedText: s.options[s.selectedIndex]?.textContent ?? null, selectedLang: s.options[s.selectedIndex]?.dataset.lang ?? null };
      })()`);
      checkEquals("S10.main-repick-does-not-install-main-as-secondary", s10.dupAfterMainRepick.itemsWithSubtext, 0);
      checkEquals("S10.main-repick-no-identical-pairs", s10.dupAfterMainRepick.identicalMainSubPairs, 0);
      checkEquals("S10.pref-records-main-track", s10.prefAfterMainRepick?.sync?.secondarySubtitleLang, "ai-zh");
      checkEquals("S10.no-component-dispatched-change", (s10.subChangeLog ?? []).length, 0);
      await shot("18-collision-after-main-repick", "主列重选同一条轨后：副行仍为 0（自动装载没把主轨抓成副轨）");
      try {
        await waitFor("副列在飞落定", async () => pageCdp.evaluate(`(() => { const s = document.getElementById('biliscript-reading-secondary-subtitle-select'); return !!s && s.disabled === false; })()`), { timeoutMs: 12000, intervalMs: 200 });
      } catch (error) {
        s10.settleWaitError = error.message;
      }
      // ③ 改选得回来：同轨态点「日本語」⇒ 副轨装载、提示消失、副行换译文
      await openPicker();
      s10.recoveryClick = await clickOptionRow(pageCdp, "S10.recovery-row-hittable", "副列 日本語（改回来）", "sub", `(r.dataset.value || '').endsWith('-ja.json')`);
      try {
        await waitSubtextState("ready", 25000);
      } catch (error) {
        s10.recoveryWaitError = error.message;
      }
      await sleep(700);
      s10.afterRecovery = await pageCdp.evaluate(JS.picker);
      s10.dupAfterRecovery = await pageCdp.evaluate(JS.dupSample);
      s10.listAfterRecovery = await pageCdp.evaluate(JS.list);
      s10.storageAfterRecovery = await storageProbe();
      check("S10.recovery-installs-other-language", s10.dupAfterRecovery.itemsWithSubtext > 0 && s10.dupAfterRecovery.identicalMainSubPairs === 0, s10.dupAfterRecovery);
      check("S10.recovery-note-hidden", s10.afterRecovery.footerNote?.hidden === true || !s10.afterRecovery.footerNote?.text, { footerNote: s10.afterRecovery.footerNote });
      await shot("19-collision-recovered", "同轨说明态就地改选日语：副行换成日语译文、提示消失");
      s10.swHits = await swHits();
      // 污染判定：本机的 chrome.storage.sync 整包回放会落在场景中途，把副列按同步来的偏好
      // 换成别的语言 ⇒ 「主列重选后副行 0」这条读数不再成立。默认 --disable-sync 已从根上
      // 关掉这条回放，故污染即失败（读数为假的绿色最危险）。
      s10.tainted = [];
      if ((s10.prefAfterMainRepick?.sync?.secondarySubtitleLang ?? null) !== "ai-zh") s10.tainted.push(`prefAfterMainRepick=${s10.prefAfterMainRepick?.sync?.secondarySubtitleLang}`);
      if ((s10.dupAfterMainRepick?.itemsWithSubtext ?? -1) !== 0) s10.tainted.push(`dupAfterMainRepick.itemsWithSubtext=${s10.dupAfterMainRepick?.itemsWithSubtext}`);
      if ((s10.subChangeLog ?? []).length !== 0) s10.tainted.push(`subChangeLog=${(s10.subChangeLog ?? []).length}`);
      checkEquals("S10.not-tainted-by-sync-replay", s10.tainted.length, 0);
      // 说明行的宽度预算（诊断型 DOM 探针，放在全部读数之后：它会改写那一行的文本）。
      // 真指针点击把列表收起了，这里重新展开，宽度读数才有几何。
      await openPicker();
      s10.noteWidthBudget = await pageCdp.evaluate(`(() => {
        const card = document.querySelector('.biliscript-reading-track-picker .custom-select-dropdown');
        const empty = card && card.querySelector('.biliscript-bilingual-col[data-col="sub"] .biliscript-bilingual-empty');
        if (!empty) return { error: 'no-empty-row' };
        const keepText = empty.textContent;
        const keepHidden = empty.hidden;
        empty.hidden = false;
        const samples = [];
        for (const t of ['主副字幕相同', '选择副字幕语言', '本视频没有日语轨', '本视频没有 ja-JP 轨', '本视频没有 en-US 轨']) {
          empty.textContent = t;
          samples.push({ text: t, scrollW: empty.scrollWidth, clientW: empty.clientWidth, clipped: empty.scrollWidth > empty.clientWidth + 1 });
        }
        empty.textContent = keepText;
        empty.hidden = keepHidden;
        return { samples };
      })()`);
      // ② 空态的真机一次：偏好写成 fixture 里没有的语言（ai-ko），让 ② 由真代码路径渲染出来
      //（走扩展 SW 写 sync ⇒ reader 的跨上下文收敛照写偏好并重渲），量完还原原值。
      const prefKeep = (await storageProbe())?.sync?.secondarySubtitleLang ?? null;
      await setStoredSecondaryLang("ai-ko");
      await sleep(1500);
      s10.missingLangNote = await pageCdp.evaluate(`(() => {
        const card = document.querySelector('.biliscript-reading-track-picker .custom-select-dropdown');
        const empty = card && card.querySelector('.biliscript-bilingual-col[data-col="sub"] .biliscript-bilingual-empty');
        if (!empty) return { error: 'no-empty-row' };
        return { pref: 'ai-ko', text: empty.textContent, hidden: empty.hidden, scrollW: empty.scrollWidth, clientW: empty.clientWidth, clipped: empty.scrollWidth > empty.clientWidth + 1, rows: card.querySelectorAll('.biliscript-bilingual-col[data-col="sub"] .custom-select-option').length };
      })()`);
      check("S10.missing-language-note-uses-label", s10.missingLangNote?.text === "本视频没有韩语轨" && s10.missingLangNote?.clipped === false && s10.missingLangNote?.rows === 8, s10.missingLangNote);
      await shot("20-missing-language-note", "② 本视频没有该语言：偏好 ai-ko ⇒ 文案出中文名（韩语），不出机器码");
      if (prefKeep) {
        await setStoredSecondaryLang(prefKeep);
        await sleep(600);
        s10.prefRestored = (await storageProbe())?.sync?.secondarySubtitleLang ?? null;
        checkEquals("S10.pref-restored-after-probe", s10.prefRestored, prefKeep);
      }
      await closePicker();
      record("S10", { title: scenarioTitle("S10"), ...s10, note: "主副同轨：页脚说明行与语言列表同时在列（点错改得回来）；自动装载按轨身份排除主轨" });
      log(`S10 完成：同轨态副列行数 ${s10.afterCollision?.cols?.find((c) => c.col === "sub")?.visibleRows}（页脚提示=${JSON.stringify(s10.afterCollision?.footerNote?.text ?? null)}）；主列重选后副行 ${s10.dupAfterMainRepick?.itemsWithSubtext}（与主行同文 ${s10.dupAfterMainRepick?.identicalMainSubPairs}）；改选日语 ⇒ 副行 ${s10.dupAfterRecovery?.itemsWithSubtext}（与主行同文 ${s10.dupAfterRecovery?.identicalMainSubPairs}）；②文案=${JSON.stringify(s10.missingLangNote?.text ?? null)}`);
    }
  } catch (error) {
    evidence.scenarios.__error = { message: error.message, stack: String(error.stack || "").slice(0, 1500) };
    check("scenario-matrix-completed", false, { message: error.message });
    log(`场景执行中断：${error.message}`);
  }

  evidence.finalWorkerHits = await swHits();
  evidence.meta.finishedAt = new Date().toISOString();
}

// ===== 现场诊断 =====
async function captureDiagnostics() {
  try {
    if (worker) {
      evidence.diagnostics = evidence.diagnostics || {};
      evidence.diagnostics.workerHits = await swHits();
    }
  } catch (error) {
    evidence.diagnostics = { ...(evidence.diagnostics || {}), workerError: error.message };
  }
  try {
    if (pageCdp) {
      evidence.diagnostics = evidence.diagnostics || {};
      evidence.diagnostics.pageState = await pageCdp.evaluate(`(() => {
        const list = document.getElementById('biliscript-reading-subtitle');
        const view = document.getElementById('biliscript-reading-view');
        return {
          url: location.href,
          viewOpen: view ? view.classList.contains('open') : null,
          itemCount: list ? list.querySelectorAll('.biliscript-reading-item').length : null,
          statusLine: document.getElementById('biliscript-reading-status')?.textContent ?? null,
          subDropdownDisplay: (() => { const d = document.querySelector('#biliscript-reading-view .biliscript-bilingual-col[data-col="sub"] .custom-select-dropdown'); return d ? getComputedStyle(d).display : null; })()
        };
      })()`);
    }
  } catch (error) {
    evidence.diagnostics = { ...(evidence.diagnostics || {}), pageError: error.message };
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
        fixtureDir: FIXTURE_DIR,
        meta: { zhSegments: META.zhSegments, translationSegments: META.translationSegments, mergedPairCount: META.mergedPairCount, trackLans: META.trackLans, singleTrackSegments: META.singleTrackVideo?.segments },
        searchExpectations: SEARCH_EXPECTATIONS,
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
