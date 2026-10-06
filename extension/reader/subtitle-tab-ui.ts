// 字幕 tab 的模板段 + 绑定段（arch-slim-2/06：自 ui/ui-renderer.ts 下放同居）。
//
// 覆盖字幕 tab body 的四段壳结构：工具条（句内搜索 + 复制/导出，PR3）、转写
// 中间态横幅（显隐由 reader/transcribe-banner.ts 驱动，「谁绑定谁拥有」裁定：
// 横幅无事件绑定、布局上属字幕 tab 排版序列，模板随字幕 tab 叶子走；驱动逻辑
// 不动）、字幕列表容器（分批渲染目标）、Follow playback 悬浮按钮。绑定段为对应
// 交互接线，handler 逻辑保持各域单源：
//   - 搜索输入/键盘 → reader/subtitle-search.ts（refresh/move 转发，重域经
//     ui/reader-gate.ts 的 withReader 动态装载）；
//   - 复制/导出 → 总结链 copySubtitleTranscript/downloadSubtitle（实现就在
//     subtitle/ui.ts，零转发）；
//   - Follow 按钮 / 列表 scroll/wheel/pointerdown/click → reader/sync.ts
//     （noteManualReaderInteraction/onReadingSubtitleClick/resumeReaderFollowPlayback）。
//
// 2026-10 用户决议（原「字幕语言」下拉整条删除）已被票 subtitle-track-picker
// 取代：选轨控件以 ui/custom-select 形态长回工具条（2026-10 图内裁定 Q13–Q20），
// 列表严格投影 state.clip.subtitles（ASR 伪轨由 07 号票的缓存命中路径补种），
// 形态裁定见 .scratch/tickets/subtitle-track-picker/prototypes/README.md §4/§7/§11。
// 回归锁在 tests/reader/subtitle-track-picker.test.ts。
//
// 本模块是壳可静态携带的轻叶子：不 import reader 重域与总结链重实现，动态
// 边全部在 ui/reader-gate.ts 与 subtitle/lazy.ts 内部（chunk 边不变形）。
// 绑定随壳构建（bindUiEvents）同步执行、forceRecreate 重建后随壳重绑。
//
// 选轨控件的分工：**本模块持有原生 select 与交互**（模板/建壳/选项投影/change
// 处理器/切轨状态机），渲染入口由 reader/lifecycle.ts 的 renderReadingView
// 调用（renderReadingSubtitleTrackPicker，水合不派发 change），失败通知走
// 调用方注入的回调（本叶子不 import reader-bus——通知面和 03 号票同款，落在
// lifecycle 的 reader-bus 接线里）。

import { byId } from "../shared/dom-utils.js";
import { logWarn } from "../shared/logging.js";
import { escapeHtml } from "../shared/string-utils.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { ensureSummarizeChain } from "../subtitle/lazy.js";
import { resolveSubtitleTrackLabel, shouldMarkAiSubtitleTracks } from "../subtitle/selection.js";
import type { SubtitleTrack } from "../bilibili/gateway.js";
import { isProgrammaticScrolling, ids } from "./state.js";
import { state } from "../core/state.js";
import { withReader } from "../ui/reader-gate.js";
import { initCustomSelect, rebuildCustomSelectOptions, setCustomSelectState, setCustomSelectValue } from "../ui/custom-select.js";
// 相位 → 横幅文案表的单源在 transcribe-banner.ts（驱动方与文案同居）；模板只
// 借用转写相位的两条串做初始内容（唯一可见相位见该模块注释）。转写中判定同源
//（core/reader-transcribing.js 的再导出），本模块的 transcribing 态用它。
import { TRANSCRIBE_BANNER_COPY, isReaderTranscribing } from "./transcribe-banner.js";
import { subscribeSubtitleStatusPhase } from "../shared/subtitle-status-bus.js";

export function buildSubtitleTabBodyHtml(): string {
  return `
            <div class="biliscript-reading-sub-toolbar">
              <div class="biliscript-reading-search">
                <input
                  id="${ids.readingSearchInput}"
                  class="biliscript-reading-search-input"
                  type="text"
                  placeholder="搜索字幕…"
                  aria-label="搜索字幕"
                />
                <span id="${ids.readingSearchCount}" class="biliscript-reading-search-count" aria-live="polite"></span>
                <button
                  id="${ids.readingSearchPrevBtn}"
                  type="button"
                  class="biliscript-reading-search-nav"
                  title="上一条（Shift+Enter）"
                  aria-label="上一条搜索结果"
                  disabled
                >↑</button>
                <button
                  id="${ids.readingSearchNextBtn}"
                  type="button"
                  class="biliscript-reading-search-nav"
                  title="下一条（Enter）"
                  aria-label="下一条搜索结果"
                  disabled
                >↓</button>
              </div>
              <!-- 选轨控件（变体 A 一行内插入，02 号票裁定）：模板只给一个空的
                   原生 select（值源 + 组件建壳锚点），选项由
                   renderReadingSubtitleTrackPicker 投影 state.clip.subtitles，
                   不预置假选项。initCustomSelect 建壳时把 wrapper 插在 select
                   当前位置（= 搜索框与「复制」之间）并把 select 移入壳内；原生
                   select 是隐藏值源（组件置 display:none），可见 affordance
                   只有 custom-select 的 trigger。字段名走 aria-label（Q19：trigger
                   的可见文本是裸语言名，字段名只在可访问名里）。 -->
              <select
                id="${ids.readingSubtitleSelect}"
                class="biliscript-reading-track-select"
                aria-label="${SUBTITLE_TRACK_FIELD_LABEL}"
              ></select>
              <button id="${ids.readingCopySubtitleBtn}" type="button" class="biliscript-reading-mini-btn">复制</button>
              <button id="${ids.readingExportSubtitleBtn}" type="button" class="biliscript-reading-mini-btn">导出</button>
            </div>

            <!-- 转写中间态（PR3）：显隐与文案由 reader/transcribe-banner.ts 按
                 shared/subtitle-status-bus 的进程内相位驱动（标题/副文案按相位
                 取，见该模块的相位文案表）；进度为不确定样式（页面侧拿不到片
                 x/y），进度行实时显示状态栏文本。初始文案是转写中相位的同款，
                 供骨架先于首拍驱动的窗口期显示 -->
            <aside id="${ids.readingTranscribeBanner}" class="biliscript-reading-asr-banner" hidden>
              <div id="${ids.readingTranscribeBannerTitle}" class="biliscript-reading-asr-title">${TRANSCRIBE_BANNER_COPY["asr-transcribing"].title}</div>
              <p id="${ids.readingTranscribeBannerCopy}" class="biliscript-reading-asr-copy">${TRANSCRIBE_BANNER_COPY["asr-transcribing"].copy}</p>
              <div class="biliscript-reading-asr-track" aria-hidden="true"><div class="biliscript-reading-asr-fill"></div></div>
              <div id="${ids.readingTranscribeProgress}" class="biliscript-reading-asr-foot">正在准备转写…</div>
            </aside>

            <section class="biliscript-reading-main">
              <div id="${ids.readingSubtitleList}" class="biliscript-reading-subtitle"></div>
            </section>

            <!-- Follow playback 悬浮按钮：显隐只由 data-biliscript-reader-follow
                 （manual/auto）的 CSS 驱动，点击恢复跟随并跳回当前句 -->
            <button id="${ids.readingFollowBtn}" type="button" class="biliscript-reading-follow-btn">↓ 跟随播放</button>
  `;
}

// ===== 选轨控件（票 subtitle-track-picker/08）=====
//
// 原生 select 是唯一值源，ui/custom-select 是唯一可见 affordance（Q3：同一面板
// 内不出现两族 affordance）。三条外部入口用法（组件侧边界，05/10 号票已定）：
//   - 换整批选项 → 写原生 select.innerHTML 再 rebuildCustomSelectOptions（壳不
//     重建，写在 trigger 上的 disabled/aria-busy 状态不被抹）；
//   - 写当前值 → setCustomSelectValue（不派发 change，水合专用）；
//   - 禁用/忙碌 → setCustomSelectState（消费者不 poke trigger 节点）。
//
// 六态（03 号票裁定，共用同一个控件状态机，不各写一套显示分支）：
//   default       有轨 → 选项 = clip.subtitles，trigger = 当前轨裸语言名；
//   open          展开浮层 = 同一批选项（组件自持，本模块不额外分支）；
//   empty         无轨且非转写 → 哨兵「暂无字幕」+ 禁用；
//   transcribing  转写进行中 → 哨兵「转写中…」+ 禁用；
//   busy          切轨请求在飞 → trigger 乐观显示目标轨名，disabled + aria-busy，
//                 **列表保留旧轨**（正文也是旧轨，等接受事务的 subtitle-ready
//                 驱动整体重渲）；
//   revert        切轨失败 → trigger 回退到 state 里仍在的旧轨，经调用方注入的
//                 notice 回调报错（state 未变，控件不得自说自话）。
//
// 切轨代次/连点由「禁用」消解（Q13：不新造代次机制）：一次只有一个请求在飞。
const SUBTITLE_TRACK_SENTINEL_VALUE = "";
const SUBTITLE_TRACK_EMPTY_TEXT = "暂无字幕";
const SUBTITLE_TRACK_TRANSCRIBING_TEXT = "转写中…";

// trigger 的可访问字段名（裸语言名的字段名走 aria-label，02 号票 Q19）：
// select 上的 aria-label 是组件拼 trigger 可访问名的第三条来路（4508233）。
const SUBTITLE_TRACK_FIELD_LABEL = "字幕轨";

// 选轨请求在飞（busy/revert 两态的载体）：值是**目标轨的 option value**
//（= 轨道身份 id）；null = 无在飞请求。放在模块闭包，随壳 forceRecreate
// 重建自然重置（与 searchDebounceTimer 同款生命周期）。
let switchInFlight: string | null = null;

function findTrackValueById(trackId: string): string {
  const select = document.getElementById(ids.readingSubtitleSelect) as HTMLSelectElement | null;
  if (!select) {
    return "";
  }
  const option = [...select.options].find((item) => item.dataset.id === trackId);
  return option?.value || "";
}

// 渲染入口（renderReadingView 调用，切轨收尾也复用）：把 clip.subtitles 与三态
// 投影到控件。幂等：每次重渲都整批换选项 + 按现值重派生显示（组件侧
// 「显示 = 现值」不变式）。转写相位在本模块内自读——它既是 transcribing 态的
// 唯一信号，也是「转写期间不会有任何渲染通知」时唯一的收敛时机（见相位订阅）；
// 失败通知仍走调用方注入的回调（本叶子不 import reader-bus）。
export function renderReadingSubtitleTrackPicker(): void {
  const select = document.getElementById(ids.readingSubtitleSelect) as HTMLSelectElement | null;
  if (!select) {
    return;
  }
  // 先把选项写进原生 select，再建壳：initCustomSelect 会按现值铺一次项集，
  // 顺序反过来（先建壳再写选项）会白铺一次空集。
  const tracks = (state.clip.subtitles || []) as unknown as SubtitleTrack[];
  const segmented = tracks.length > 0;
  // 三态（empty / transcribing / busy）共用同一条禁用判据；busy 另有 aria-busy。
  const transcribing = isReaderTranscribing();
  const disabled = !segmented || transcribing;
  const marked = shouldMarkAiSubtitleTracks(tracks);

  if (!segmented) {
    // 哨兵选项（10 号票 §9c）：组件在「没有选项」时 trigger 是空按钮，且
    // 「暂无字幕」「转写中…」必须由调用侧塞成选项才显示得出来。
    const sentinel = transcribing ? SUBTITLE_TRACK_TRANSCRIBING_TEXT : SUBTITLE_TRACK_EMPTY_TEXT;
    select.innerHTML = `<option value="${SUBTITLE_TRACK_SENTINEL_VALUE}">${escapeHtml(sentinel)}</option>`;
  } else {
    select.innerHTML = tracks
      .map((track, index) => {
        const label = resolveSubtitleTrackLabel(track);
        const text = marked && String(track.lan || "").toLowerCase().startsWith("ai-") ? `${label} [AI]` : label;
        // dir="auto" 随行方向解析（10 号票把选项行对齐改成逻辑值 start 后生效）：
        // 阿拉伯语行右对齐，LTR 行外观不变。
        return `<option value="${escapeHtml(track.subtitleUrl || "")}" data-lang="${escapeHtml(
          track.lan || ""
        )}" data-id="${escapeHtml(track.id || "")}" dir="auto"${
          index === 0 ? " selected" : ""
        }>${escapeHtml(text)}</option>`;
      })
      .join("");
  }

  // 建壳（首次渲染时执行；之后是 no-op）：模板初值只有原生 select（工具条的
  // 直接子节点），组件把 wrapper 插在 select 当前位置并把 select 移入壳内。
  // 判据是「有没有壳」而不是「没初始化过」——壳落在哪条路径都只有一个 owner。
  if (!select.parentElement?.classList.contains("custom-select-wrapper")) {
    initCustomSelect(select, "custom-select-wrapper biliscript-reading-track-picker");
  }
  // change 绑定（按节点去重）：绑在这里而不是 bindUiEvents——模板建壳时 select
  // 还不存在于 DOM（bindUiEvents 跑在 innerHTML 之前），只有渲染入口拿得到它。
  if (!boundTrackPickers.has(select)) {
    boundTrackPickers.add(select);
    select.addEventListener("change", () => handleTrackPickerChange(select));
  }

  rebuildCustomSelectOptions(select);

  // 值必须**无条件**写一次：上面整批重建选项会把原生选中态打回「重建后的 DOM
  // 决定的那一项」，漏掉这次写值，在飞期到达的重渲就会把 trigger 从乐观目标轨
  // 拉回旧轨（2026-10-06 实测：busy 期间 renderReadingView 一次 → trigger 回旧轨）。
  // 在飞期间写的值是乐观目标轨（Q13），其余时候按 state 的当前轨。
  setCustomSelectValue(select, switchInFlight ?? findTrackValueById(state.clip.selectedSubtitleId));

  // 状态机（六态里的 empty / transcribing / busy 三态都由这里收敛）：
  // 在飞期间 disabled + busy 都不动，避免重渲把乐观 trigger 与禁用解掉。
  if (switchInFlight !== null) {
    return;
  }
  setCustomSelectState(select, { disabled, busy: false });
}

// 选轨结果通知回调（由 reader/lifecycle 注入）：失败时经 reader-bus 的 "status"
// 通道报错（Q14：与抓取同通道、同序收敛，不另开提示面）。声明在模块闭包而不是
// 随监听器捕获：change 监听器绑在原生 select 上，而 select 随壳 forceRecreate
// 重建（监听器只在渲染入口按节点去重补绑），回调必须跟着新节点一起可用。
export type SubtitleTrackNotice = (text: string) => void;

let subtitleTrackNotice: SubtitleTrackNotice | null = null;

export function setSubtitleTrackNoticeHandler(onNotice: SubtitleTrackNotice): void {
  subtitleTrackNotice = onNotice;
}

// 已绑 change 的原生 select（节点身份去重：壳重建后新节点补绑一次，同一节点不
// 重复绑——否则一次改选会走两遍装载）。
const boundTrackPickers = new WeakSet<HTMLSelectElement>();

// 相位订阅（转写中间态的第三处消费点，与横幅同源同一订阅总线；绑一次）：
// asr-transcribing 期间不会再有任何渲染通知（fetcher.ts 的注释已说明），只靠
// renderReadingView 驱动的投影会一直停在发起转写前的那一态——面板横幅写着
// 「转写中」，控件却还写「暂无字幕」，两处两说。故控件自己订阅相位收敛。
let trackPickerPhaseBound = false;

function bindSubtitleTrackPickerPhase(): void {
  if (trackPickerPhaseBound) {
    return;
  }
  trackPickerPhaseBound = true;
  subscribeSubtitleStatusPhase(() => {
    if (state.reader.readingViewOpen) {
      renderReadingSubtitleTrackPicker();
    }
  });
}

// change 处理器：只装载，不直调渲染。重渲/同步由接受事务的 subtitle-ready 通知
// 驱动（唯一 emit 点，见 subtitle/commit.ts）——这里补调 renderReadingView 即
// 双渲染（被删测试锁过的既有约束，09 号票重新钉住）。收尾只收敛本控件
// （renderReadingSubtitleTrackPicker 只碰工具条这一处 DOM，不是整体重渲）。
function handleTrackPickerChange(select: HTMLSelectElement): void {
  // 禁用期（空态 / 转写中 / 在飞）的 change 一律忽略：控件本就不可用。
  if (select.disabled) {
    return;
  }
  const option = select.options[select.selectedIndex];
  const target = select.value;
  // 哨兵项与「不可装载的行」不发起切换。本仓唯一的空值轨是 ASR 伪轨（subtitleUrl
  // 为空，而链的 loadSubtitle 对空 URL 直接抛「字幕 URL 为空。」）；它的正文缓存键
  // 是 provider/model/language 复合键，只有 asr 域能重建，故本控件不做「切回 ASR
  // 轨」。此时组件已经写值并派发了 change，必须立刻按 state 收敛回当前轨——否则
  // trigger 停在用户点的那一行、正文却还是旧轨，正是本次要消灭的「控件与 state
  // 两说」。
  // 生产可达性：ASR 回退只从「无轨出口」进入（fetcher 的 finishNoSubtitle），而每轮
  // 抓取都会 setSubtitles(全量轨)，故伪轨只在自己是当前轨时出现在列表里——混源列表
  // 目前不可达（见票 08 的 resolution：真出现时另立票做「重建 ASR 轨」）。
  if (!target) {
    logWarn("[BILISCRIPT] subtitle track is not switchable (no url)", {
      id: String(option?.dataset.id || "")
    });
    renderReadingSubtitleTrackPicker();
    return;
  }
  // 乐观显示目标轨（trigger 立即反映用户选择），随后置 busy + 禁用。
  switchInFlight = target;
  setCustomSelectValue(select, target);
  setCustomSelectState(select, { disabled: true, busy: true });
  void (async () => {
    try {
      const chain = await ensureSummarizeChain();
      await chain.loadSubtitle(
        String(option?.value || ""),
        String(option?.dataset.lang || "unknown"),
        state.clip.fetchRunId,
        String(option?.dataset.id || "")
      );
      // 成功路径不改控件：接受事务的 subtitle-ready 通知驱动 renderReadingView，
      // 那一轮渲染会在 switchInFlight 仍置位时保留乐观 trigger（正文与列表已换），
      // 随后的 finally 收尾收敛控件。
    } catch (error) {
      // 失败回退（Q14）：state 未变，控件必须反映 state。回退动作不在这里手写
      // ——统一交给 finally 的那次收敛（按 state 投影），一个收尾入口。
      subtitleTrackNotice?.(`字幕切换失败：${getErrorMessage(error)}`);
      logWarn("[BILISCRIPT] failed to switch subtitle track", error);
    } finally {
      // 收尾收敛：一次只有这一个请求在飞，它必须自己结束忙碌态。成功路径的
      // subtitle-ready 渲染发生在 await 期间（那时开关仍置位、渲染有意跳过状态
      // 收敛），之后不会再有第二轮渲染——不在这里收敛，控件就永久停在
      // 「禁用 + 忙碌」，用户再也点不动（2026-10-06 实测：切成功后 trigger.disabled
      // 恒 true）。失败路径同此：state 未变，收敛即回退到旧轨。
      switchInFlight = null;
      renderReadingSubtitleTrackPicker();
    }
  })();
}

export function bindSubtitleTabEvents(): void {
  // 转写相位订阅（选轨控件的 transcribing 态）：与其余绑定同生命周期、只绑一次。
  bindSubtitleTrackPickerPhase();
  const readingSearchInput = byId(ids.readingSearchInput) as HTMLInputElement;
  // ===== PR3 句内搜索（输入/键盘/上下条）：搜索状态与高亮逻辑在
  // reader/subtitle-search.ts（重域：补渲染走分批渲染状态机），交互回调经
  // ui/reader-gate 的 withReader 装载后转发（首次输入多一次本地动态 import，
  // 其后命中缓存 promise，与滚动/点击回调同款）。
  //
  // input 路径 180ms trailing 防抖：逐键的全量流水线（清高亮→matchAll→逐命中
  // DOM 重建→smooth scroll）聚簇为停顿后一次。防抖状态挂本函数闭包（随壳
  // forceRecreate 重建自然重置，与 handleReaderManualScroll 先例同款）。防抖只
  // 包 input 事件；Enter/Escape/prev/next 先冲刷未兑现的防抖再动作——
  // moveReadingSubtitleSearch 读模块闭包 matches（不读输入框），不冲刷就会在
  // 旧词的匹配上导航。重渲重放路径（lifecycle 渲染尾部 refresh({scroll:false})）
  // 不走防抖，高亮即时恢复。
  const SEARCH_DEBOUNCE_MS = 180;
  let searchDebounceTimer: number | null = null;
  const searchRefresh = () => {
    withReader("subtitle search refresh", (reader) => reader.refreshReadingSubtitleSearch());
  };
  const flushSearchDebounce = () => {
    if (searchDebounceTimer === null) {
      return;
    }
    window.clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
    searchRefresh();
  };
  readingSearchInput.addEventListener("input", () => {
    if (searchDebounceTimer !== null) {
      window.clearTimeout(searchDebounceTimer);
    }
    searchDebounceTimer = window.setTimeout(() => {
      searchDebounceTimer = null;
      searchRefresh();
    }, SEARCH_DEBOUNCE_MS);
  });
  readingSearchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    flushSearchDebounce();
    withReader("subtitle search keydown", (reader) => {
      if (event.key === "Enter") {
        reader.moveReadingSubtitleSearch(event.shiftKey ? -1 : 1);
        return;
      }
      // Escape：清输入恢复原文本（焦点留在输入框便于再次输入）
      readingSearchInput.value = "";
      reader.refreshReadingSubtitleSearch({ scroll: false });
      readingSearchInput.focus();
    });
  });
  byId(ids.readingSearchPrevBtn).addEventListener("click", () => {
    flushSearchDebounce();
    withReader("subtitle search prev", (reader) => reader.moveReadingSubtitleSearch(-1));
  });
  byId(ids.readingSearchNextBtn).addEventListener("click", () => {
    flushSearchDebounce();
    withReader("subtitle search next", (reader) => reader.moveReadingSubtitleSearch(1));
  });

  // ===== PR3 复制 / 导出（纯接线，逻辑在总结链 subtitle/ui.ts） =====
  // 复制 = 字幕纯文本（copySubtitleTranscript，buildTxt 管线，transcript 语义）；
  // 导出 = SRT/TXT（downloadSubtitle，按 downloadFormat 设置）。
  byId(ids.readingCopySubtitleBtn).addEventListener("click", async () => {
    try {
      const chain = await ensureSummarizeChain();
      await chain.copySubtitleTranscript();
    } catch (error) {
      logWarn("[BILISCRIPT] copy subtitle transcript failed", error);
    }
  });
  byId(ids.readingExportSubtitleBtn).addEventListener("click", async () => {
    try {
      const chain = await ensureSummarizeChain();
      await chain.downloadSubtitle();
    } catch (error) {
      logWarn("[BILISCRIPT] download subtitle failed", error);
    }
  });

  // ===== PR3 Follow playback 悬浮按钮 =====
  // 显隐由 data-biliscript-reader-follow 的 CSS 驱动；点击恢复跟随并跳回当前句
  //（resumeReaderFollowPlayback，不改播放进度）。
  byId(ids.readingFollowBtn).addEventListener("click", () => {
    withReader("resume reader follow", (reader) => reader.resumeReaderFollowPlayback());
  });

  // ===== 字幕列表交互（手动滚动暂停 + 点句跳转；实现在 reader/sync.ts） =====
  const subtitleList = byId(ids.readingSubtitleList);
  // scroll/wheel 是高频路径，每事件一次 withReader 都要分配 promise：250ms
  // 节流（与 sync tick 同档）首发立即透传、窗口内丢弃。节流间隔远小于手动
  // 暂停窗口（noteManualReaderInteraction 默认 durationMs=3000），滚动期间
  // 自动同步照样保持暂停。
  const MANUAL_SCROLL_THROTTLE_MS = 250;
  let lastManualScrollAt = 0;
  const handleReaderManualScroll = () => {
    if (isProgrammaticScrolling()) {
      return;
    }
    const now = Date.now();
    if (now - lastManualScrollAt < MANUAL_SCROLL_THROTTLE_MS) {
      return;
    }
    lastManualScrollAt = now;
    // 高频路径：首次交互装载 reader 域，其后命中缓存 promise；装载失败静默
    //（下次交互自然重试，避免滚动期间刷日志）。
    withReader(null, (reader) => reader.noteManualReaderInteraction());
  };
  subtitleList.addEventListener("scroll", handleReaderManualScroll);
  subtitleList.addEventListener("wheel", handleReaderManualScroll, { passive: true });
  subtitleList.addEventListener("pointerdown", () => {
    withReader(null, (reader) => reader.noteManualReaderInteraction(3500));
  });
  subtitleList.addEventListener("click", (event) => {
    withReader(null, (reader) => reader.onReadingSubtitleClick(event));
  });
}
