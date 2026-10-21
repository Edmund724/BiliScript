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
// 调用方注入的回调（本叶子不 import reader-bus 的**通知面**——03 号票同款，落在
// lifecycle 的 reader-bus 接线里）。
//
// ===== 双语字幕（票 bilingual-subtitles：01 形态 / 02 状态机 / 05 偏好与槽）=====
// 载体（建图期 Q10）：字幕工具条另造**专用弹层**——落地为选轨组件浮层
//（.custom-select-dropdown）里装配出来的「主/副两列 + 页脚开关 + trigger 徽标」，
// 通用 ui/custom-select 不为它长出新概念，面板里仍只有一族 affordance。两列各由
// 一枚原生 select + 组件壳承载（一列一个 select，组件不变式「显示 = 现值、恰一项
// 选中」逐列成立）：
//   - 主列 = 既有 readingSubtitleSelect 的组件浮层，六态与行为逐字不动；
//   - 副列 = 第二枚 select 的组件壳，常驻副列（宿主与壳 display: contents，自带
//     trigger 收起），只有列里的选项行可见。
// 卡片骨架是**节点身份不变量**（buildBilingualCard 一次建好），落位走组件的槽位声明
//（setCustomSelectSlots，2026-10 深化）：卡片根 + 选项行落点 + trigger 徽标各声明一次，
// 此后组件换整批选项只摘它自己产出的 <li>，骨架全程留在浮层里、子树原样保留，故副列壳/
// 页脚开关/监听器都不重建、列滚动位置也不被销毁；渲染只改状态与文案，不搬节点、
// 不快照滚动位置、不 poke 组件内部节点。
// 形态度量照抄 01 号票原型 README §4/§7 的 A 变体（实测 300.22×315 卡片、右锚、
// 双列各 140.11、trigger 定宽 120px + 徽标、页脚固定在滚动区外、空态文案不参与
// 列宽、单轨态说明进列表区），规则在 entry/styles/bilingual-subtitles.css。
// 状态位（02 号票第 8 条）：全局偏好 = settings.bilingualSubtitles +
// settings.secondarySubtitleLang（进键面 ⇒ 跨设备同步 + 归一化）；per-video =
// clip.secondarySubtitle 槽（id/url/body/state）。DOM 只投影 state，不反解。
//
// 与既有纪律的两处衔接（本叶子不新增机制）：
//   - 偏好落盘走 reader-bus 的 persistReaderSettingsThroughSeam（readerTheme 同款
//     「偏好改了立即落盘」的路径；reader 域不得静态 import core/runtime.js）；
//   - 跨上下文收敛自持一份 watchStorageKeys 订阅（entry/content.ts 播放器 AI 开关
//     的 { sync: [...] } 形）：键面取自 reader/presentation-fields.ts 的派生清单
//     （双语两键已登记进表），订阅后才不会出现
//     「另一标签页开了双语、这边控件还停在旧态」。

import { byId } from "../shared/dom-utils.js";
import { logWarn } from "../shared/logging.js";
import { escapeHtml } from "../shared/string-utils.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { watchStorageKeys } from "../shared/watch-storage-keys.js";
import { ensureBilingualSubtitleStyles } from "../shared/style-injector.js";
import { ensureSummarizeChain } from "../subtitle/lazy.js";
import {
  resolveSubtitleTrackLabel,
  shouldMarkAiSubtitleTracks
} from "../subtitle/labels.js";
import type { SubtitleTrack } from "../bilibili/gateway.js";
import type { Settings } from "../core/defaults.js";
import { isProgrammaticScrolling, ids } from "./state.js";
// 阅读域设置键面（主表派生）：双语两键的收敛订阅从它取，不手抄键数组。
import { READER_SETTINGS_WATCH_KEYS } from "./presentation-fields.js";
import { state } from "../core/state.js";
import { withReader } from "../ui/reader-gate.js";
import { initCustomSelect, rebuildCustomSelectOptions, setCustomSelectSlots, setCustomSelectState, setCustomSelectValue } from "../ui/custom-select.js";
import { READING_COPY_ICON, READING_DOWNLOAD_ICON } from "../ui/reading-icons.js";
// 副轨（双语第二路轨）的目标解析 + 六态列模型 + 装载事务（唯一落点）：本叶子只做
// DOM 投影与在飞禁用。
import {
  ensureSecondarySubtitleLoaded,
  isSecondarySubtitleLoadInFlight,
  resolveSecondaryColumnView,
  resolveSecondaryTarget
} from "./secondary-subtitle.js";
import type { SecondaryColumnView, SecondaryEnsureOutcome } from "./secondary-subtitle.js";
// 双语偏好的落盘 seam（readerTheme 同款）：reader 域不得静态 import core/runtime.js，
// 故经 reader-bus 的 persist 槽转发（content.ts 注册的 sendRuntimeMessage）。
import { notifyReaderPresenter, persistReaderSettingsThroughSeam } from "./reader-bus.js";
// 换轨进场动画的触发标记（零依赖叶子）：主列选轨/副列改选置位，列表属主
//（lifecycle 的列表投影）在整表重建时消费一次；残标清偿也归本叶子的两个
// change 处理器（主列 finally / 副列 settled 与同轨防呆的同步收尾）。
import { playTrackSwitchAnimation } from "./track-switch-animation.js";
// 相位 → 横幅文案表的单源在 transcribe-banner.ts（驱动方与文案同居）；模板只
// 借用转写相位的两条串做初始内容（唯一可见相位见该模块注释）。转写中判定同源
//（core/reader-transcribing.js 的再导出），本模块的 transcribing 态用它。
import { TRANSCRIBE_BANNER_COPY, isReaderTranscribing } from "./transcribe-banner.js";
import { subscribeSubtitleStatusPhase } from "../shared/subtitle-status-bus.js";

// 双语字幕表随本叶子走（ui/custom-select.ts 顶挂 ensureCustomSelectStyles 同款先例：
// 组件/样式与消费者同居，不依赖设置抽屉或阅读主表的装载时机）。求值顺序有要求：
// 上面的 import 已先求值（组件表已挂），本表因此排在它之后，同特异性规则靠后者胜。
ensureBilingualSubtitleStyles();

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
              <button id="${ids.readingCopySubtitleBtn}" type="button" class="biliscript-reading-icon-btn" title="复制字幕" aria-label="复制字幕">${READING_COPY_ICON}</button>
              <button id="${ids.readingExportSubtitleBtn}" type="button" class="biliscript-reading-icon-btn" title="导出字幕" aria-label="导出字幕">${READING_DOWNLOAD_ICON}</button>
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
                 （manual/auto）的 CSS 驱动，点击恢复跟随并跳回当前句；形态与
                 .biliscript-reading-explain-btn 同族（见 reader.css 段注） -->
            <button id="${ids.readingFollowBtn}" type="button" class="biliscript-reading-follow-btn">跟随播放</button>
  `;
}

// ===== 选轨控件（票 subtitle-track-picker/08）=====
//
// 原生 select 是唯一值源，ui/custom-select 是唯一可见 affordance（Q3：同一面板
// 内不出现两族 affordance）。四条外部入口用法（组件侧边界，05/10 号票 + 2026-10 深化）：
//   - 换整批选项 → 写原生 select.innerHTML 再 rebuildCustomSelectOptions（壳不
//     重建，写在 trigger 上的 disabled/aria-busy 状态不被抹）；
//   - 写当前值 → setCustomSelectValue（不派发 change，水合专用）；
//   - 禁用/忙碌 → setCustomSelectState（消费者不 poke trigger 节点）；
//   - 浮层槽位 → setCustomSelectSlots（卡片根 / 选项行落点 / trigger 徽标各声明一次，
//     组件换项时保留这些节点；消费者不搬节点、不快照滚动位置）。
//
// 六态（03 号票裁定，共用同一个控件状态机，不各写一套显示分支）：
//   default       有轨 → 选项 = clip.subtitles，trigger = 当前轨裸语言名；
//   open          展开浮层 = 同一批选项（组件自持，本模块不额外分支）；
//   empty         无轨且非转写 → 哨兵 + 禁用（哨兵文案按 fetchState 取值：
//                 "loading" → 「抓取中…」，否则 → 「暂无字幕」，见下方常量）；
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
// 抓取窗口的哨兵（2026-10-06 用户报告：切视频那一瞬间控件闪一下「暂无字幕」）：
// 抓取中 clip.subtitles 必然为空（切视频先 reset 清空、结果到手才写回），此时说
// 「暂无字幕」是断言了尚不知道的事。信号用既有的 subtitleFetchState === "loading"
// ——列表空态占位同一判据（subtitle/core.ts 的 getReadingSubtitlePlaceholderText
// 在同一相位出「正在加载字幕...」）。抓取全程都在 loading 态下（refreshClip 一次
// 抓取只有一个 loading 窗口），无需新事件。
const SUBTITLE_TRACK_LOADING_TEXT = "抓取中…";

// trigger 的可访问字段名（裸语言名的字段名走 aria-label，02 号票 Q19）：
// select 上的 aria-label 是组件拼 trigger 可访问名的第三条来路（4508233）。
const SUBTITLE_TRACK_FIELD_LABEL = "字幕轨";


function findTrackValueById(trackId: string): string {
  const select = document.getElementById(ids.readingSubtitleSelect) as HTMLSelectElement | null;
  if (!select) {
    return "";
  }
  const option = [...select.options].find((item) => item.dataset.id === trackId);
  return option?.value || "";
}

// 选项行 HTML 的唯一产地（主列 renderReadingSubtitleTrackPicker 与副列
// writeSecondaryOptions 共用）：value = 轨道 URL、data-id = 轨道身份、data-lang = lan、
// dir="auto" 随行方向解析（阿拉伯语行右对齐，LTR 行外观不变）、[AI] 后缀按「列表内
// 来源不唯一才标」的判据。marked 由调用侧按自己那份轨集算（副列先滤掉 ASR 伪轨，
// 两处的标记集合因此不同），selected 也由调用侧按各自判据给出：主列「第一项」
//（水合前的视图默认），副列「URL 相等」。
function buildSubtitleTrackOptionHtml(track: SubtitleTrack, marked: boolean, selected: boolean): string {
  const label = resolveSubtitleTrackLabel(track);
  const text = marked && String(track.lan || "").toLowerCase().startsWith("ai-") ? `${label} [AI]` : label;
  return `<option value="${escapeHtml(track.subtitleUrl || "")}" data-lang="${escapeHtml(
    track.lan || ""
  )}" data-id="${escapeHtml(track.id || "")}" dir="auto"${selected ? " selected" : ""}>${escapeHtml(text)}</option>`;
}

// 一次渲染要哪些事实：本投影的输入声明。取数（读 state 袋、模块内 switchInFlight、
// 副轨六态模型）全在 selectSubtitleToolbarFacts；投影体只消费事实，故可在无壳、无
// state 袋的情况下用一份假事实驱动（见 tests/reader/subtitle-toolbar-projection）。
export interface SubtitleToolbarFacts {
  // clip.subtitles 原引用（顺序即列表顺序）
  tracks: SubtitleTrack[];
  // 全局偏好：页脚开关的 on 态
  bilingual: boolean;
  // 本视频只有一条可装载轨 ⇒ 开关禁用 + 说明进列表区（Q7）
  switchDisabled: boolean;
  // 转写相位（三态里的 transcribing）
  transcribing: boolean;
  // clip.subtitleFetchState === "loading"（取值优先级低于转写中）
  loading: boolean;
  // 列表内来源不唯一时给 AI 轨挂 [AI] 标
  marked: boolean;
  // clip.selectedSubtitleId：非在飞时 trigger 显示它对应的轨道
  selectedTrackId: string;
  // 切轨在飞的乐观目标轨（本模块持有）
  switchInFlight: string | null;
  // 副列六态模型（secondary-subtitle.ts 的判定叶产出）
  secondaryColumn: SecondaryColumnView;
}

// 唯一取数点：主列三态与双语卡片所需的全部事实。
export function selectSubtitleToolbarFacts(switchInFlight: string | null = null): SubtitleToolbarFacts {
  const tracks = (state.clip.subtitles || []) as unknown as SubtitleTrack[];
  return {
    tracks,
    bilingual: state.settings.bilingualSubtitles === true,
    switchDisabled: isBilingualSwitchDisabled(tracks),
    transcribing: isReaderTranscribing(),
    loading: state.clip.subtitleFetchState === "loading",
    marked: shouldMarkAiSubtitleTracks(tracks),
    selectedTrackId: state.clip.selectedSubtitleId,
    switchInFlight,
    secondaryColumn: resolveSecondaryColumnView({
      resolution: resolveSecondaryTarget(),
      preferenceLang: state.settings.secondarySubtitleLang,
      slotState: state.clip.secondarySubtitle.state,
      loadInFlight: isSecondarySubtitleLoadInFlight()
    })
  };
}

// 渲染入口（renderReadingView 调用，切轨收尾也复用）：把事实投影到控件。幂等：每次
// 重渲都整批换选项 + 按现值重派生显示（组件侧「显示 = 现值」不变式）；转写态与抓取
// 态由事实带入（优先级见下）。失败通知仍走调用方注入的回调（本叶子不经
// reader-bus 的**通知面**）。
export interface SubtitleToolbarContext {
  onTrackChange?: (select: HTMLSelectElement) => void;
  onNotice?: SubtitleTrackNotice;
  rerender?: () => void;
}

export function renderReadingSubtitleTrackPicker(
  selectFacts: () => SubtitleToolbarFacts = selectSubtitleToolbarFacts,
  context?: SubtitleToolbarContext
): void {
  const select = document.getElementById(ids.readingSubtitleSelect) as HTMLSelectElement | null;
  if (!select) {
    return;
  }
  // 取数在「工具条在场」之后：工具条缺席时（其它渲染路径）不读 state 袋。
  const facts = selectFacts();
  // 先把选项写进原生 select，再建壳：initCustomSelect 会按现值铺一次项集，
  // 顺序反过来（先建壳再写选项）会白铺一次空集。
  const tracks = facts.tracks;
  const segmented = tracks.length > 0;
  // 双语量（02 号票第 8 条：状态位 → 投影，DOM 不反解）：
  //   bilingual   = 全局偏好的开关值（页脚开关的 data-on / aria-checked）；
  //   switchDisabled = 「本视频只有一条可装载轨」⇒ 开关禁用 + 说明进列表区（Q7）；
  //   dual        = 实际生效的双列布局（开关开着且本视频可配对）。
  const dual = facts.bilingual && !facts.switchDisabled;
  // 三态（empty / transcribing / busy）共用同一条禁用判据；busy 另有 aria-busy。
  const transcribing = facts.transcribing;
  // 抓取中（切视频/刷新抓取的空窗）：判据是既有的 fetchState 相位，不新造信号。
  // 取值优先级 **转写中 > 抓取中 > 暂无字幕**，顺序不可换——ASR 转写期间
  // subtitleFetchState 仍是 "loading"（无字幕出口的逆事务 commitNoSubtitle 要等
  // maybeRunAsrFallback 走完才落 "empty"，见 subtitle/fetcher.ts 的 finishNoSubtitle），
  // 把 loading 判在转写之前，转写中态会被写成「抓取中…」，与面板横幅两说。
  const loading = facts.loading;
  const disabled = !segmented || transcribing;
  const marked = facts.marked;

  if (!segmented) {
    // 哨兵选项（10 号票 §9c）：组件在「没有选项」时 trigger 是空按钮，且
    // 「暂无字幕」「转写中…」「抓取中…」必须由调用侧塞成选项才显示得出来。
    const sentinel = transcribing
      ? SUBTITLE_TRACK_TRANSCRIBING_TEXT
      : loading
        ? SUBTITLE_TRACK_LOADING_TEXT
        : SUBTITLE_TRACK_EMPTY_TEXT;
    select.innerHTML = `<option value="${SUBTITLE_TRACK_SENTINEL_VALUE}">${escapeHtml(sentinel)}</option>`;
  } else {
    select.innerHTML = tracks
      .map((track, index) => buildSubtitleTrackOptionHtml(track, marked, index === 0))
      .join("");
  }

  // 建壳（首次渲染时执行；之后是 no-op）：模板初值只有原生 select（工具条的
  // 直接子节点），组件把 wrapper 插在 select 当前位置并把 select 移入壳内。
  // 判据是「有没有壳」而不是「没初始化过」——壳落在哪条路径都只有一个 owner。
  // change 接线随建壳走（组件的 onChange）：壳重建 = 新节点 + 新壳 + 新监听器。
  if (context?.onTrackChange) {
    (select as unknown as Record<string, unknown>).__biliscript_track_change = context.onTrackChange;
  }
  if (!select.parentElement?.classList.contains("custom-select-wrapper")) {
    initCustomSelect(select, "custom-select-wrapper biliscript-reading-track-picker", {
      onChange: (sel) => {
        const handler = (sel as unknown as Record<string, unknown>).__biliscript_track_change as
          | ((s: HTMLSelectElement) => void)
          | undefined;
        handler?.(sel);
      }
    });
  }

  rebuildCustomSelectOptions(select);

  // 双语卡片装配：主列选项行的落点由下面 projectBilingualPicker 的槽位声明给出
  //（双语关时卡片 = 「单列 + 页脚开关」）。
  projectBilingualPicker(facts, context);

  // 值必须**无条件**写一次：上面整批重建选项会把原生选中态打回「重建后的 DOM
  // 决定的那一项」，漏掉这次写值，在飞期到达的重渲就会把 trigger 从乐观目标轨
  // 拉回旧轨（2026-10-06 实测：busy 期间 renderReadingView 一次 → trigger 回旧轨）。
  // 在飞期间写的值是乐观目标轨（Q13），其余时候按 state 的当前轨。
  setCustomSelectValue(select, facts.switchInFlight ?? findTrackValueById(facts.selectedTrackId));

  // 状态机（六态里的 empty / transcribing / busy 三态都由这里收敛）：**无条件**写全
  // 一次，不手工绕开收敛——在飞折进判据，投影算出的正是切轨那一刻写的乐观态那一组值，
  // 故在飞期间的重渲解不掉乐观 trigger 与禁用（2026-10-06 实测：若不收敛，切成功后
  // trigger.disabled 恒 true）。
  // 双语开关不影响本列：主列的可点性只由主轨相位决定（02 号票 Q9：副轨在飞/失败
  // 不阻塞主轨；反之亦然）。
  setCustomSelectState(select, {
    disabled: disabled || facts.switchInFlight !== null,
    busy: facts.switchInFlight !== null
  });
}

// 选轨结果通知回调（由 reader/lifecycle 经 createSubtitleToolbar 构造注入）：失败时经
// reader-bus 的 "status" 通道报错（Q14：与抓取同通道、同序收敛，不另开提示面）。
export type SubtitleTrackNotice = (text: string) => void;

export interface SubtitleToolbarDeps {
  onNotice?: SubtitleTrackNotice;
}

export interface SubtitleToolbar {
  render: (selectFacts?: () => SubtitleToolbarFacts) => void;
  bindEvents: () => void;
}

// 相位订阅（转写中间态的第三处消费点，与横幅同源同一订阅总线；绑一次）：只服务
// asr-* 三条转写相位——`subtitle-ready` 相位不驱动任何渲染（渲染归 reader-bus 的
// subtitle-ready 通知，见 shared/subtitle-status-bus.ts 的相位清单），订阅到它只会
// 与那一路通知重复重渲。asr-transcribing 期间不会再有任何渲染通知（fetcher.ts 的注释
// 已说明），只靠 renderReadingView 驱动的投影会一直停在发起转写前的那一态——面板横幅
// 写着「转写中」，控件却还写「暂无字幕」，两处两说。故控件自己订阅转写相位收敛；
// asr-done / asr-failed 是同一条转写链的收尾相位，投影据此从转写态退回常态。
const TRACK_PICKER_PHASES = new Set(["asr-transcribing", "asr-done", "asr-failed"]);

let activeSubtitleToolbar: SubtitleToolbar | null = null;

// 票 04：字幕工具条深 module 工厂。
// notice 回调、在飞轨 switchInFlight 与相位/偏好订阅全部收进实例闭包；
// 实例生命周期由 reader 域装载（lifecycle.ts）保证跨壳重建存活。
export function createSubtitleToolbar(deps: SubtitleToolbarDeps = {}): SubtitleToolbar {
  let switchInFlight: string | null = null;
  const onNotice = deps.onNotice;

  function render(selectFacts?: () => SubtitleToolbarFacts): void {
    const factsGetter = selectFacts ?? (() => selectSubtitleToolbarFacts(switchInFlight));
    renderReadingSubtitleTrackPicker(factsGetter, {
      onTrackChange: handleTrackPickerChange,
      onNotice,
      rerender: () => render()
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
      render();
      return;
    }
    // 乐观显示目标轨（trigger 立即反映用户选择），随后置 busy + 禁用。
    switchInFlight = target;
    setCustomSelectValue(select, target);
    setCustomSelectState(select, { disabled: true, busy: true });
    let switched = false;
    void (async () => {
      try {
        const chain = await ensureSummarizeChain();
        await chain.loadSubtitle(
          String(option?.value || ""),
          String(option?.dataset.lang || "unknown"),
          state.clip.fetchRunId,
          String(option?.dataset.id || "")
        );
        switched = true;
        // 成功路径不改控件：接受事务的 subtitle-ready 通知驱动 renderReadingView，
        // 那一轮渲染会在 switchInFlight 仍置位时保留乐观 trigger（正文与列表已换），
        // 随后的 finally 收尾收敛控件并补一次进场动画。
      } catch (error) {
        // 失败回退（Q14）：state 未变，控件必须反映 state。回退动作不在这里手写
        // ——统一交给 finally 的那次收敛（按 state 投影），一个收尾入口。
        onNotice?.(`字幕切换失败：${getErrorMessage(error)}`);
        logWarn("[BILISCRIPT] failed to switch subtitle track", error);
      } finally {
        // 收尾收敛：一次只有这一个请求在飞，它必须自己结束忙碌态。成功路径的
        // subtitle-ready 渲染发生在 await 期间（那时开关仍置位、渲染有意跳过状态
        // 收敛），之后不会再有第二轮渲染——不在这里收敛，控件就永久停在
        // 「禁用 + 忙碌」，用户再也点不动（2026-10-06 实测：切成功后 trigger.disabled
        // 恒 true）。失败路径同此：state 未变，收敛即回退到旧轨。
        switchInFlight = null;
        // Q8 反方向：主轨切到了副列当前指向的同一条轨 ⇒ 副列失去区分度（列表会出
        // 两行同样文字），副轨槽就此清空；目标 lan 保持不动，投影据此出第三套空态
        // 文案「主副字幕相同」。判据读**接受事务之后**的 state（失败
        // 路径 state 未变 ⇒ 这次清理对失败的切轨不成立，不会误伤副列）。
        clearSecondarySubtitleIfShadowedByMain();
        render();
        // 装载成功且视图开着：接受事务的 notify 之后到这里的 continuation 之间没有
        // await，整表重建已在同一事件循环内完成，此处补一次进场不会先绘制再起播。
        if (switched && state.reader.readingViewOpen) {
          playTrackSwitchAnimation(byId(ids.readingSubtitleList));
        }
      }
    })();
  }

  let bound = false;

  function bindEvents(): void {
    if (bound) {
      return;
    }
    bound = true;
    subscribeSubtitleStatusPhase((phase) => {
      if (!TRACK_PICKER_PHASES.has(phase)) {
        return;
      }
      if (state.reader.readingViewOpen) {
        render();
      }
    });

    watchStorageKeys(
      (changes) => {
        const bilingual = changes["bilingualSubtitles"];
        const lang = changes["secondarySubtitleLang"];
        if (!bilingual && !lang) {
          return;
        }
        const updates: Partial<Settings> = {};
        if (bilingual) {
          // 关双语只停显示、不清副轨槽（02 号票第 7(d) 条）：这里只投影偏好值，
          // 槽的清理归清场路径（resetClipState）与 Q8 的同轨防呆。
          updates.bilingualSubtitles = bilingual.newValue === true;
        }
        if (lang && typeof lang.newValue === "string") {
          updates.secondarySubtitleLang = lang.newValue;
        }
        state.setSettings({ ...state.settings, ...updates });
        if (state.settings.bilingualSubtitles === true) {
          activateSecondaryTarget();
        }
        render();
      },
      { sync: READER_SETTINGS_WATCH_KEYS }
    );
  }

  const toolbar: SubtitleToolbar = {
    render,
    bindEvents
  };
  activeSubtitleToolbar = toolbar;
  return toolbar;
}

// ===== 双语字幕：页脚开关 + 主/副两列（票 bilingual-subtitles/06；形态 01 / 状态机 02 / 槽与偏好 05）=====
//
// 卡片结构（类名与度量见 entry/styles/bilingual-subtitles.css）：
//   ul.custom-select-dropdown                              ← 组件浮层本体 = 卡片容器
//                                                             （收起态由它的 hidden 属性管）
//     li.biliscript-bilingual-popover                      ← 卡片根（display: contents）
//       div.biliscript-bilingual-main                       ← 滚动区（硬约束 §5.2）
//         div.biliscript-bilingual-cols
//           div.biliscript-bilingual-col[data-col="main"]    ← 主列（+ 单轨态说明行）
//           div.biliscript-bilingual-col[data-col="sub"]      ← 副列（双语态才在场；收起走
//                                                                 hidden：列首说明行（①② 两套
//                                                                 空态）+ 重试行 + 语言列表）
//       div.biliscript-bilingual-footer                      ← 固定页脚：双语字幕 + 状态提示
//                                                                 （③ 主副同轨）+ 开关
//
// 组件不变式逐列成立：一列一枚原生 select，值 = 该列的轨道 URL（与主列既有口径一致），
// data-id = 轨道身份、data-lang = lan；显示由组件按现值派生。副列那枚组件壳常驻副列
//（宿主与壳 display: contents，自带 trigger 收起），组件侧零概念（Q10）。

const SUBTITLE_BILINGUAL_SWITCH_LABEL = "双语字幕";
const SUBTITLE_BILINGUAL_BADGE_TEXT = "双语";
const SUBTITLE_BILINGUAL_BADGE_ID = "biliscript-reading-bilingual-badge";
// 副列值源的原生 select：id 表（shared/dom-ids.ts）不在本次改动面内，故本叶子自持
// 一个常量 id（诊断与用例按 id 取副列值源；骨架重建时新 select 仍用它）。
const SECONDARY_SUBTITLE_SELECT_ID = "biliscript-reading-secondary-subtitle-select";
const SECONDARY_SUBTITLE_FIELD_LABEL = "副字幕轨";
// 副列的两套空态文案、页脚提示与语言名拼法随六态判定住在
// reader/secondary-subtitle.ts 的 resolveSecondaryColumnView（文案与产生点同居）。
// 本叶子只出这两条自己的 DOM 文案：重试行与单轨提示。
const SECONDARY_RETRY_TEXT = "加载失败 · 重试";
const SINGLE_TRACK_HINT_TEXT = "本视频只有一条字幕轨";

// 副列在飞值不再自持：装载事务的登记在 reader/secondary-subtitle.ts（唯一一份），
// 本叶子只经 isSecondarySubtitleLoadInFlight() 读它——见
// resolveSecondaryColumnView.busy 与 projectSecondaryLoad。


// 副列可列的真轨：**只列有 subtitleUrl 的轨**（02 号票第 4 条）。ASR 伪轨
//（lan: asr-*、subtitleUrl: ""）是「主轨的兜底」，不是可对照的第二语言，从入口
// 消除；主列一字不动（仍含伪轨，六态与列表投影不变）。
function loadableSecondaryTracks(tracks: SubtitleTrack[]): SubtitleTrack[] {
  return tracks.filter((track) => String(track.subtitleUrl || "").trim().length > 0);
}

// 本视频能不能配对（Q7）：可装载轨 < 2 ⇒ 开关禁用。零轨（抓取前 / 空态）同样禁用，
// 此时列表区由主列的哨兵说明，不再叠一行说明。
function isBilingualSwitchDisabled(tracks: SubtitleTrack[]): boolean {
  return loadableSecondaryTracks(tracks).length < 2;
}

// 目标轨与「为什么没有目标」都由 reader/secondary-subtitle.ts 的 resolveSecondaryTarget
// 投影（两级匹配 + 排除主轨 + 只考虑真轨，与自动装载/改选/重试同一份实现），六态文案由
// 同模块的 resolveSecondaryColumnView 出模型——本叶子不自己匹配、也不自己判态。

// 卡片骨架（双语弹层的节点身份不变量）。骨架的落位与选项行落点都交给组件的槽位声明
//（setCustomSelectSlots，2026-10 深化）：组件换整批选项只摘它自己产出的 <li>，骨架
// 全程留在浮层里——子树原样保留，副列壳、页脚开关、监听器都不重建，列滚动位置也不被
// 销毁。骨架建立后只改状态与文案，不再造节点（Q10：组件侧零概念）。
interface BilingualCardNodes {
  mainSelect: HTMLSelectElement;
  pickerWrapper: HTMLElement;
  root: HTMLElement;
  mainHead: HTMLElement;
  hint: HTMLElement;
  mainList: HTMLElement;
  subCol: HTMLElement;
  retry: HTMLButtonElement;
  secondaryHost: HTMLElement;
  secondarySelect: HTMLSelectElement;
  empty: HTMLElement;
  // 页脚状态提示位（③ 主副同轨；2026-10-06 用户裁决：放「双语字幕」右边，不进副列列表）
  footerNote: HTMLElement;
  toggle: HTMLButtonElement;
  // trigger 插位（双语徽标）：建卡时建好，双语态经槽位声明交给组件落位
  badge: HTMLElement;
  context?: SubtitleToolbarContext;
}

let bilingualCardNodes: BilingualCardNodes | null = null;

function buildColumnHead(text: string): HTMLElement {
  const head = document.createElement("div");
  head.className = "biliscript-bilingual-col-head";
  head.textContent = text;
  return head;
}

// 认领卡片骨架。pickerWrapper 身份变了 = 壳被整块重建过（reader 面板 forceRecreate），
// 旧骨架连同旧 select 一并作废，重建一份。骨架的**落位**不在这里做（也不需要在换项
// 时做）：它是槽位声明的事（见 projectBilingualPicker 的 setCustomSelectSlots），组件
// 换项时同样保留——本叶子不再按引用搬卡片。
function ensureBilingualCard(): BilingualCardNodes | null {
  const mainSelect = document.getElementById(ids.readingSubtitleSelect) as HTMLSelectElement | null;
  const pickerWrapper = mainSelect?.closest<HTMLElement>(".biliscript-reading-track-picker") ?? null;
  if (!mainSelect || !pickerWrapper) {
    return null;
  }
  const existing = bilingualCardNodes;
  if (existing && existing.pickerWrapper === pickerWrapper) {
    return existing;
  }
  bilingualCardNodes = buildBilingualCard(mainSelect, pickerWrapper);
  return bilingualCardNodes;
}

function buildBilingualCard(mainSelect: HTMLSelectElement, pickerWrapper: HTMLElement): BilingualCardNodes {
  const root = document.createElement("li");
  root.className = "biliscript-bilingual-popover";
  root.setAttribute("role", "presentation");

  const main = document.createElement("div");
  main.className = "biliscript-bilingual-main";
  const cols = document.createElement("div");
  cols.className = "biliscript-bilingual-cols";

  const mainCol = document.createElement("div");
  mainCol.className = "biliscript-bilingual-col";
  mainCol.dataset.col = "main";
  const mainHead = buildColumnHead("主字幕");
  mainHead.hidden = true;
  // 单轨态（开关禁用）的说明进**列表区**、不进页脚（硬约束 §5.4：页脚只容纳
  //「双语字幕 + 开关」，说明文案长度不可控；零轨时不叠这行，主列哨兵已说明）。
  const hint = document.createElement("div");
  hint.className = "biliscript-bilingual-hint";
  hint.textContent = SINGLE_TRACK_HINT_TEXT;
  hint.hidden = true;
  const mainList = document.createElement("ul");
  mainList.className = "biliscript-bilingual-list";
  mainList.setAttribute("role", "presentation");
  mainCol.append(mainHead, hint, mainList);

  const subCol = document.createElement("div");
  subCol.className = "biliscript-bilingual-col";
  subCol.dataset.col = "sub";
  const subHead = buildColumnHead("副字幕");
  // 失败态的重试行（02 号票 Q6：重试入口唯一在副列，只重抓这一条副轨）。
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "biliscript-bilingual-retry";
  retry.textContent = SECONDARY_RETRY_TEXT;
  retry.hidden = true;
  retry.addEventListener("click", handleSecondaryRetryClick);
  const secondaryHost = document.createElement("div");
  secondaryHost.className = "biliscript-bilingual-secondary";
  const secondarySelect = document.createElement("select");
  secondarySelect.id = SECONDARY_SUBTITLE_SELECT_ID;
  secondarySelect.className = "biliscript-reading-track-select";
  secondarySelect.setAttribute("aria-label", SECONDARY_SUBTITLE_FIELD_LABEL);
  secondaryHost.appendChild(secondarySelect);
  const empty = document.createElement("div");
  empty.className = "biliscript-bilingual-empty";
  // 顺序有意：说明行在语言列表**之上**（列表由宿主里的组件浮层承载），读起来是
  // 「列首一行说明 + 下面可点的一组语言」。
  subCol.append(subHead, retry, empty, secondaryHost);
  cols.append(mainCol, subCol);
  main.appendChild(cols);

  const footer = document.createElement("div");
  footer.className = "biliscript-bilingual-footer";
  const label = document.createElement("span");
  label.className = "biliscript-bilingual-footer-label";
  label.textContent = SUBTITLE_BILINGUAL_SWITCH_LABEL;
  // 页脚状态提示位（③ 主副同轨）：紧挨「双语字幕」四个字，开关仍在最右（度量见 CSS）。
  const footerNote = document.createElement("span");
  footerNote.className = "biliscript-bilingual-footer-note";
  footerNote.hidden = true;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "biliscript-bilingual-switch";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-label", SUBTITLE_BILINGUAL_SWITCH_LABEL);
  toggle.addEventListener("click", handleBilingualSwitchClick);
  footer.append(label, footerNote, toggle);

  const badge = document.createElement("span");
  badge.className = "biliscript-bilingual-badge";
  badge.id = SUBTITLE_BILINGUAL_BADGE_ID;
  badge.textContent = SUBTITLE_BILINGUAL_BADGE_TEXT;

  root.append(main, footer);
  // 卡片根的落位不在这里：它是槽位声明里的 extras（见 projectBilingualPicker 的
  // setCustomSelectSlots），由组件按声明装进浮层本体（[hidden] 收起态与
  // `:has(> .biliscript-bilingual-popover)` 的度量规则都按它直接挂在浮层本体下写）。
  // 副列的值源：一枚原生 select + 组件壳（壳插在 select 当前位置并把 select 收进壳内，
  // 与主列同款）。壳常驻副列（display: contents），不随渲染搬动；change 接线随建壳走。
  initCustomSelect(secondarySelect, "custom-select-wrapper biliscript-bilingual-secondary-picker", {
    onChange: handleSecondaryTrackPickerChange
  });
  return {
    mainSelect,
    pickerWrapper,
    root,
    mainHead,
    hint,
    mainList,
    subCol,
    retry,
    secondaryHost,
    secondarySelect,
    empty,
    footerNote,
    toggle,
    badge
  };
}

// 投影（每次渲染收口一次，幂等）：主列选项行按槽位落进主列，副列按事实里的六态
// 模型落语言列表/占位/重试行，页脚开关按偏好事实投影。
function projectBilingualPicker(facts: SubtitleToolbarFacts, context?: SubtitleToolbarContext): void {
  const nodes = ensureBilingualCard();
  if (!nodes) {
    return;
  }
  if (context) {
    nodes.context = context;
  }
  const tracks = facts.tracks;
  const dual = facts.bilingual && !facts.switchDisabled;
  const model = facts.secondaryColumn;
  // 槽位声明（第四条外部入口，2026-10 深化）：卡片根、选项行落点与 trigger 徽标一次
  // 声明给组件——组件换整批选项只摘它自己产出的 <li>，卡片骨架全程留在浮层里（列滚动
  // 位置因此不被销毁），徽标在 trigger 里的落点（值区之后、箭头之前）与它接的
  // aria-describedby 也由组件负责。本叶子不再按引用搬卡片、不再读组件内部节点。
  setCustomSelectSlots(nodes.mainSelect, {
    extras: [nodes.root],
    optionsHost: nodes.mainList,
    triggerExtra: dual ? nodes.badge : null
  });

  nodes.pickerWrapper.dataset.bilingual = dual ? "true" : "false";
  nodes.mainHead.hidden = !dual;
  nodes.hint.hidden = dual || tracks.length === 0 || !facts.switchDisabled;
  nodes.subCol.hidden = !dual;
  nodes.retry.hidden = !(dual && model.retry);
  // 说明行与语言列表**同时**在场（2026-10-06 图外回访）：说明行只服务 ①② 两套空态，
  // 它解释「为什么这一列现在没有装载中的副轨」，不顶掉用户改选的那份列表。
  nodes.empty.hidden = !dual || !model.note;
  if (dual && model.note) {
    nodes.empty.textContent = model.note;
  }
  // 页脚状态提示（③ 主副同轨）：同一次投影收口——双语关（收起态）一律清空并隐藏，
  // 免得旧文案留在收起态里，也免得「页脚只有双语字幕 + 开关」这条硬约束被残文破坏。
  const footerNoteText = dual ? model.footerNote : "";
  nodes.footerNote.hidden = !footerNoteText;
  nodes.footerNote.textContent = footerNoteText;
  nodes.secondaryHost.hidden = !dual;

  // 值源：双语态恒 = 目标轨 URL（乐观目标即投影）；否则清空并整体禁用。
  // 三套空态（① 没选过 / ② 本视频没有该语言 / ③ 主副同轨）没有目标轨 ⇒ 值空、列表里
  // 没有选中行，而语言行照铺——副列的语言行数因此不再等于「列表在场」这一事实，
  // 跨列断言改按选项集读。
  if (dual) {
    writeSecondaryOptions(nodes.secondarySelect, tracks, model.selectedUrl);
    setCustomSelectValue(nodes.secondarySelect, model.selectedUrl);
    // 状态一律无条件写全一次：在飞折进 model.busy（在飞登记 + 槽 loading 两条信号），
    // 投影算出的正是装载起步那一刻写的乐观态那一组值，故在飞期间的重渲解不掉乐观禁用。
    setCustomSelectState(nodes.secondarySelect, { disabled: model.busy, busy: model.busy });
  } else {
    writeSecondaryOptions(nodes.secondarySelect, [], "");
    setCustomSelectState(nodes.secondarySelect, { disabled: true, busy: false });
  }

  const on = facts.bilingual;
  nodes.toggle.setAttribute("aria-checked", on ? "true" : "false");
  nodes.toggle.dataset.on = on ? "true" : "false";
  nodes.toggle.disabled = facts.switchDisabled;
}

// 副列选项行的原生投影（与主列同一个产地 buildSubtitleTrackOptionHtml：value = URL、
// data-id = 轨道身份、data-lang = lan、dir="auto"，选中判据是「URL 相等」）。
function writeSecondaryOptions(select: HTMLSelectElement | null, tracks: SubtitleTrack[], selectedUrl: string): void {
  if (!select) {
    return;
  }
  const secondaryTracks = loadableSecondaryTracks(tracks);
  if (secondaryTracks.length === 0) {
    // 无真轨可列（双语关 / 本视频只有一条轨，此时副列整块 hidden）：值源留空，
    // 列首的说明行（不出双列时那条单轨说明）承担文案，不铺一行假选项。
    select.innerHTML = "";
  } else {
    const marked = shouldMarkAiSubtitleTracks(secondaryTracks);
    select.innerHTML = secondaryTracks
      .map((track) => {
        const url = String(track.subtitleUrl || "");
        return buildSubtitleTrackOptionHtml(track, marked, Boolean(url) && url === selectedUrl);
      })
      .join("");
  }
  rebuildCustomSelectOptions(select);
}

// 副轨装载事务的 DOM 投影（开关打开 / 副列改选 / 重试共用一条入口）。判定与装载全在
// reader/secondary-subtitle.ts（目标解析、三重守卫、在飞登记、ensureSummarizeChain →
// loadSecondarySubtitle）；本叶子只管两拍投影：
//   - 起步：本列当场写乐观目标值 + 禁用（「副轨的选中就是目标」，失败不回退目标——
//     02 号票 Q3；错误态由装载器写进槽，本列据此出重试行）；
//   - 落定：清在飞后必须由这里再收敛一次——副轨到站的 "secondary-subtitle-ready" 重渲
//     发生在事务落定**之前**（那时在飞仍置位，投影有意不动本列状态），不在这里收，
//     本列就永久停在「禁用 + 忙碌」。成功路径的正文/选中行由那条通知负责，本拍不碰。
//   - 失败：槽已置 error（弹层副列占位即重试入口），这里只补一句状态行旁白
//（与主列失败同一条 notice 通道；仓内无 toast）。
function projectSecondaryLoad(outcome: SecondaryEnsureOutcome): void {
  if (outcome.kind !== "started") {
    return;
  }
  const nodes = ensureBilingualCard();
  const select = nodes?.secondarySelect ?? null;
  if (select) {
    setCustomSelectValue(select, outcome.target.url);
    setCustomSelectState(select, { disabled: true, busy: true });
  }
  const rerender = nodes?.context?.rerender ?? renderReadingSubtitleTrackPicker;
  rerender();
  void outcome.settled.then(({ error }) => {
    if (error) {
      nodes?.context?.onNotice?.(`副字幕加载失败：${getErrorMessage(error)}`);
    }
    rerender();
  });
}

// 开关打开 / 跨上下文同步后按全局偏好把目标轨抓起来（Q1：打开那一刻立即抓、
// forceRefresh = false 优先命中 per-track 缓存；不做面板可见判定、不做滚动懒加载）。
// 三重守卫（开关关 / 槽非 idle / 无目标不猜）在事务里；本列自己的在飞早退留在这里。
function activateSecondaryTarget(): void {
  if (isSecondarySubtitleLoadInFlight()) {
    return;
  }
  projectSecondaryLoad(ensureSecondarySubtitleLoaded());
}

// 页脚开关（唯一入口是这里 + 跨上下文订阅）：
//   - 偏好立即落盘（readerTheme 同款 persist seam；进键面 ⇒ sync 跨设备）；
//   - 打开即抓目标轨；关闭**只停显示、不清副轨槽**（02 号票第 7(d) 条：反复开关
//     不该每次都闪一次加载中）；
//   - 控件状态只由 settings 投影，本处理器不额外写 DOM（随后一次重渲收口）；
//   - **两处都要重渲列表**（弹层自己的投影 + 列表）：开关本身改的是 settings，而副行
//     出现在列表里 —— 只重投影弹层的话，关闭后 188 行副行会一直挂在列表上（真机走查
//     实测的反向发现）。列表属主是 reader/lifecycle，本叶子不自绘（结构锁：
//     `renderReadingView()` 的调用点全仓唯一在 lifecycle），只发 `rerender` 通知。
function handleBilingualSwitchClick(event: Event): void {
  const toggle = event.currentTarget as HTMLButtonElement | null;
  if (toggle?.disabled) {
    return;
  }
  const next = state.settings.bilingualSubtitles !== true;
  state.setSettings({ ...state.settings, bilingualSubtitles: next });
  persistReaderSettingsThroughSeam();
  if (next) {
    activateSecondaryTarget();
  }
  const nodes = ensureBilingualCard();
  const rerender = nodes?.context?.rerender ?? renderReadingSubtitleTrackPicker;
  rerender();
  notifyReaderPresenter({ kind: "rerender" });
}

// 副列语言改选（组件浮层里点一行 → 组件写值并派发 change）：
//   - 本列在飞时的 change 一律忽略（组件浮层的点击处理器不查 disabled，禁用只是
//     视觉/键盘守卫，这里必须自己早退）并收敛回 state 的现值；
//   - 选中主轨那一条 ⇒ Q8 同轨防呆：清副轨槽（列表退回单轨），目标 lan 不动；
//   - 否则写全局偏好（副轨目标 lan），再按**轨身份**解析目标交给装载事务
//（槽非 idle 也照装：改选发生在槽 ready/error 时是常态），只禁本列。
function handleSecondaryTrackPickerChange(select: HTMLSelectElement): void {
  const nodes = ensureBilingualCard();
  const rerender = nodes?.context?.rerender ?? renderReadingSubtitleTrackPicker;
  if (isSecondarySubtitleLoadInFlight()) {
    rerender();
    return;
  }
  const option = select.options[select.selectedIndex];
  const url = select.value;
  const id = String(option?.dataset.id || "");
  const lang = String(option?.dataset.lang || "");
  if (!url) {
    rerender();
    return;
  }
  // 副列改选同属「用户主动换轨」：装载落定后由本控件起播一次进场动画。
  // 同轨防呆走同步重建、目标解析失败不发起装载——后者不播。
  // Q8 同轨防呆：副列选了主轨那一条 ⇒ 副列清空（列表退回单轨）。目标 lan 记成用户
  // 刚点的那条轨的 lan（= 主轨的 lan）——这是「副列指向主轨」的唯一可投影信号，
  // 第三套空态文案「主副字幕相同」由此推出（02 号票第 5/8 条：
  // 三套空态不占新位、由（目标 lan × 轨列表 × 主轨选择 × 副轨 body）投影推导）。
  if (id && id === state.clip.selectedSubtitleId) {
    state.setSettings({ ...state.settings, secondarySubtitleLang: lang });
    persistReaderSettingsThroughSeam();
    state.clip.clearSecondarySubtitle();
    rerender();
    // 同轨防呆清的是**副轨槽**，副行随之从列表消失 ⇒ 与开关同款：必须请列表属主重渲，
    // 否则列表还挂着已被清空的译文（弹层侧已经收起、两处两说）。
    notifyReaderPresenter({ kind: "rerender" });
    // 同步通知当场完成列表重建（视图开着时）；重建后在同一事件循环内起播进场。
    if (state.reader.readingViewOpen) {
      playTrackSwitchAnimation(byId(ids.readingSubtitleList));
    }
    return;
  }
  // 全局偏好：副轨目标 lan（Q4 记忆粒度）；立即落盘（与主题偏好同一条 persist seam）。
  state.setSettings({ ...state.settings, secondarySubtitleLang: lang });
  persistReaderSettingsThroughSeam();
  // 目标按**轨身份**解析（不是刚写的偏好再匹配一次）：用户点的是哪一条就装哪一条。
  const resolution = resolveSecondaryTarget({ id, url, lang });
  if (resolution.kind !== "target") {
    rerender();
    return;
  }
  const outcome = ensureSecondarySubtitleLoaded({ target: resolution.target });
  projectSecondaryLoad(outcome);
  // 副轨到站的 secondary-subtitle-ready 重建发生在事务落定之前；settled 落定时若
  // 装载成功且视图开着，补一次进场动画（失败/视图未开不播）。
  if (outcome.kind === "started") {
    void outcome.settled.then((settlement) => {
      if (!settlement.error && state.reader.readingViewOpen) {
        playTrackSwitchAnimation(byId(ids.readingSubtitleList));
      }
    });
  }
}

// 副列占位行里的重试（02 号票 Q6：重抓**这一条**副轨，forceRefresh = true）。
// 目标仍按全局偏好解析（与自动装载同一份实现）；槽在 error 态也要照装——事务的
// 「槽非 idle 不动」守卫只服务自动路径，显式目标不走它。
function handleSecondaryRetryClick(): void {
  if (isSecondarySubtitleLoadInFlight()) {
    return;
  }
  const resolution = resolveSecondaryTarget();
  if (resolution.kind !== "target") {
    return;
  }
  projectSecondaryLoad(ensureSecondarySubtitleLoaded({ target: resolution.target, forceRefresh: true }));
}

// 主轨切到了副列当前指向的同一条轨 ⇒ 清副轨槽（Q8 反方向；目标 lan 保持不动，
// 投影据此出「主副字幕相同」）。**不碰** settings——偏好是全局记忆。
function clearSecondarySubtitleIfShadowedByMain(): void {
  const slot = state.clip.secondarySubtitle;
  if (!slot.id || slot.id !== state.clip.selectedSubtitleId) {
    return;
  }
  state.clip.clearSecondarySubtitle();
}

export function bindSubtitleTabEvents(toolbarOrDeps?: SubtitleToolbar | { toolbar?: SubtitleToolbar }): void {
  // 转写相位订阅与双语偏好订阅并入工具条实例事件绑定（深 module 实例持有）
  const toolbar =
    (toolbarOrDeps && "bindEvents" in toolbarOrDeps ? toolbarOrDeps : toolbarOrDeps?.toolbar) ?? activeSubtitleToolbar;
  toolbar?.bindEvents();
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
  // moveReadingSubtitleSearch 读实例闭包 matches（不读输入框），不冲刷就会在
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
  // 节流（与 sync tick 同档）首发立即透传、窗口内丢弃。滚动期间记录手动交互，
  // 保持手动浏览态。
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
    withReader(null, (reader) => reader.noteManualReaderInteraction());
  });
  subtitleList.addEventListener("click", (event) => {
    withReader(null, (reader) => reader.onReadingSubtitleClick(event));
  });
}
