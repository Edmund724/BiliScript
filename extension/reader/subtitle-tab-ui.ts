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
// 卡片骨架是**节点身份不变量**（buildBilingualCard 一次建好）：组件每次换选项都整批
// 重写浮层子节点，骨架按引用搬回原位、子树原样保留，故副列壳/页脚开关/监听器都不
// 重建；渲染只改状态与文案。
// 形态度量照抄 01 号票原型 README §4/§7 的 A 变体（实测 300.22×315 卡片、右锚、
// 双列各 140.11、trigger 定宽 120px + 徽标、页脚固定在滚动区外、空态文案不参与
// 列宽、单轨态说明进列表区），规则在 entry/styles/bilingual-subtitles.css。
// 状态位（02 号票第 8 条）：全局偏好 = settings.bilingualSubtitles +
// settings.secondarySubtitleLang（进键面 ⇒ 跨设备同步 + 归一化）；per-video =
// clip.secondarySubtitle 槽（id/url/lang/body/state）。DOM 只投影 state，不反解。
//
// 与既有纪律的两处衔接（本叶子不新增机制）：
//   - 偏好落盘走 reader-bus 的 persistReaderSettingsThroughSeam（readerTheme 同款
//     「偏好改了立即落盘」的路径；reader 域不得静态 import core/runtime.js）；
//   - 跨上下文收敛自持一份 watchStorageKeys 订阅（entry/content.ts 播放器 AI 开关
//     的 { sync: [...] } 形）：两个双语键不在 READER_SETTINGS_WATCH_KEYS（那份清单
//     由 reader/presentation-fields.ts 派生，属另一处写面）里，订阅后才不会出现
//     「另一标签页开了双语、这边控件还停在旧态」。

import { byId } from "../shared/dom-utils.js";
import { logWarn } from "../shared/logging.js";
import { escapeHtml } from "../shared/string-utils.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { watchStorageKeys } from "../shared/watch-storage-keys.js";
import { ensureBilingualSubtitleStyles } from "../shared/style-injector.js";
import { ensureSummarizeChain } from "../subtitle/lazy.js";
import {
  findSecondaryTrackByPreferredLang,
  findTrackByPreferredLang,
  isMainSubtitleTrack,
  resolveSubtitleTrackLabel,
  shouldMarkAiSubtitleTracks
} from "../subtitle/selection.js";
import type { SubtitleTrack } from "../bilibili/gateway.js";
import type { Settings } from "../core/defaults.js";
import { isProgrammaticScrolling, ids } from "./state.js";
import { state } from "../core/state.js";
import { withReader } from "../ui/reader-gate.js";
import { initCustomSelect, rebuildCustomSelectOptions, setCustomSelectState, setCustomSelectValue } from "../ui/custom-select.js";
// 双语偏好的落盘 seam（readerTheme 同款）：reader 域不得静态 import core/runtime.js，
// 故经 reader-bus 的 persist 槽转发（content.ts 注册的 sendRuntimeMessage）。
import { notifyReaderPresenter, persistReaderSettingsThroughSeam } from "./reader-bus.js";
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
// 失败通知仍走调用方注入的回调（本叶子不经 reader-bus 的**通知面**）。
export function renderReadingSubtitleTrackPicker(): void {
  const select = document.getElementById(ids.readingSubtitleSelect) as HTMLSelectElement | null;
  if (!select) {
    return;
  }
  // 滚动位置要在**组件重铺选项之前**取：那一步（rebuildCustomSelectOptions 的
  // dropdown.replaceChildren）会把卡片摘下，届时两列的 scrollTop 已经不在了。
  const scrollSnapshot = capturePickerScroll();
  // 先把选项写进原生 select，再建壳：initCustomSelect 会按现值铺一次项集，
  // 顺序反过来（先建壳再写选项）会白铺一次空集。
  const tracks = (state.clip.subtitles || []) as unknown as SubtitleTrack[];
  const segmented = tracks.length > 0;
  // 双语量（02 号票第 8 条：状态位 → 投影，DOM 不反解）：
  //   bilingual   = 全局偏好的开关值（页脚开关的 data-on / aria-checked）；
  //   switchDisabled = 「本视频只有一条可装载轨」⇒ 开关禁用 + 说明进列表区（Q7）；
  //   dual        = 实际生效的双列布局（开关开着且本视频可配对）。
  const bilingual = state.settings.bilingualSubtitles === true;
  const switchDisabled = isBilingualSwitchDisabled(tracks);
  const dual = bilingual && !switchDisabled;
  // 三态（empty / transcribing / busy）共用同一条禁用判据；busy 另有 aria-busy。
  const transcribing = isReaderTranscribing();
  // 抓取中（切视频/刷新抓取的空窗）：判据是既有的 fetchState 相位，不新造信号。
  // 取值优先级 **转写中 > 抓取中 > 暂无字幕**，顺序不可换——ASR 转写期间
  // subtitleFetchState 仍是 "loading"（无字幕出口的逆事务 commitNoSubtitle 要等
  // maybeRunAsrFallback 走完才落 "empty"，见 subtitle/fetcher.ts 的 finishNoSubtitle），
  // 把 loading 判在转写之前，转写中态会被写成「抓取中…」，与面板横幅两说。
  const loading = state.clip.subtitleFetchState === "loading";
  const disabled = !segmented || transcribing;
  const marked = shouldMarkAiSubtitleTracks(tracks);

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

  // 双语卡片装配：上面那次 rebuild 已把主列选项行重铺进组件浮层，这里把它们连同
  // 副列与页脚开关装进同一张卡片（双语关时卡片 = 「单列 + 页脚开关」）。
  projectBilingualPicker(tracks, dual);

  // 值必须**无条件**写一次：上面整批重建选项会把原生选中态打回「重建后的 DOM
  // 决定的那一项」，漏掉这次写值，在飞期到达的重渲就会把 trigger 从乐观目标轨
  // 拉回旧轨（2026-10-06 实测：busy 期间 renderReadingView 一次 → trigger 回旧轨）。
  // 在飞期间写的值是乐观目标轨（Q13），其余时候按 state 的当前轨。
  setCustomSelectValue(select, switchInFlight ?? findTrackValueById(state.clip.selectedSubtitleId));

  // 状态机（六态里的 empty / transcribing / busy 三态都由这里收敛）：
  // 在飞期间 disabled + busy 都不动，避免重渲把乐观 trigger 与禁用解掉。
  // 双语开关不影响本列：主列的可点性只由主轨相位决定（02 号票 Q9：副轨在飞/失败
  // 不阻塞主轨；反之亦然）。
  if (switchInFlight === null) {
    setCustomSelectState(select, { disabled, busy: false });
  }
  // 卡片刚被摘下又装回（见 capturePickerScroll）：把两列的滚动位置写回。
  restorePickerScroll(scrollSnapshot);
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
      // Q8 反方向：主轨切到了副列当前指向的同一条轨 ⇒ 副列失去区分度（列表会出
      // 两行同样文字），副轨槽就此清空；目标 lan 保持不动，投影据此出第三套空态
      // 文案「主副字幕相同」。判据读**接受事务之后**的 state（失败
      // 路径 state 未变 ⇒ 这次清理对失败的切轨不成立，不会误伤副列）。
      clearSecondarySubtitleIfShadowedByMain();
      renderReadingSubtitleTrackPicker();
    }
  })();
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
//                                                                 hidden：列首说明行（三套空态）
//                                                                 + 重试行 + 语言列表）
//       div.biliscript-bilingual-footer                      ← 固定页脚：双语字幕 + 开关
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
// 副列的三套空态文案（02 号票第 5 条：用户下一步动作不同，不共用一句）。三套都只是
// 副列**列首的一行说明**，语言列表始终留在列里（2026-10-06 图外回访：说明行顶掉列表
// 就等于把用户锁死在这一态——点错一条副语言后再也改不回来）。
// 在飞**不**出说明行（2026-10-06 用户裁决，见 resolveSecondaryColumn）：装载中的
// 可见反馈由本列 disabled/aria-busy 与列表里副行的占位承担。
const SECONDARY_EMPTY_PICK_TEXT = "选择副字幕语言";
const SECONDARY_RETRY_TEXT = "加载失败 · 重试";
// 第三套文案只留「主副字幕相同」六个字（2026-10-06 用户第二轮裁决）：说明行 max-width
// 140px，原句「，已清空副字幕」在真机被省略号吃掉，用户看到的就是一句残句；这句说明
// 只是**列首提示**，清空与否由列表（副行 0）+ 副列值源共同表达，不必写进文案。
const SECONDARY_COLLISION_TEXT = "主副字幕相同";
const SINGLE_TRACK_HINT_TEXT = "本视频只有一条字幕轨";
const SECONDARY_MISSING_PREFIX = "本视频没有 ";
const SECONDARY_MISSING_SUFFIX = " 轨";

// 副列在飞值（与 switchInFlight 同款闭包：值 = 目标 option value = 副轨 URL）。
// 只用来（a）本列自己的早退与禁用、（b）乐观显示时间窗——槽里的 loading 相位由
// 装载器自己写（02 号票 Q2：不新造机制）。
let secondaryInFlight: string | null = null;
// 副列 select 的 change 绑定去重（同 boundTrackPickers 的节点身份口径）。
const boundSecondaryPickers = new WeakSet<HTMLSelectElement>();
let bilingualSettingsWatchBound = false;

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

function currentSubtitleTracks(): SubtitleTrack[] {
  return (state.clip.subtitles || []) as unknown as SubtitleTrack[];
}

interface SecondaryTarget {
  id: string;
  url: string;
  lang: string;
}

// 目标轨（全局偏好 lan × 本视频轨列表的投影）：匹配不到（②）、没选过（①）或命中
// 主轨（③）都返回 null，差别只在投影文案上（见 resolveSecondaryColumn）。
// 匹配与「排除主轨」共用 subtitle/selection 的共享叶子（两级：完整 lan 精确优先 →
// 主语言子标签兜底；只考虑有 subtitleUrl 的真轨）——与 reader/lifecycle.ts 的自动
// 装载同一条实现，两处各写一份会在混源视频上漂移成「装载一条、副列选中另一条」，
// 更会在偏好指向主轨时把主轨抓成副轨（用户实测的两份一样）。
function resolveSecondaryTarget(tracks: SubtitleTrack[]): SecondaryTarget | null {
  const track = findSecondaryTrackByPreferredLang(
    tracks,
    state.settings.secondarySubtitleLang,
    state.clip.selectedSubtitleId
  );
  if (!track) {
    return null;
  }
  return {
    id: String(track.id || ""),
    url: String(track.subtitleUrl || ""),
    // 载入器/槽用的语言标签取轨的 lan（与主列 change 处理器同口径：data-lang）；
    // 偏好里存的也是它——lanDoc（"English"）过不了「按主语言子标签匹配」那一关。
    lang: String(track.lan || "")
  };
}

interface SecondaryColumnModel {
  // 列首一行说明（三套空态文案 + 失败重试行之外的空态说明）；空串 = 不出说明行。
  // 说明行**不替代**语言列表（2026-10-06 图外回访）：用户的下一步动作永远是「换一条
  // 语言」，把列表撤掉就是把他锁死在这一态上。
  note: string;
  selectedUrl: string;
  // 失败态：列首那行「加载失败 · 重试」（02 号票 Q6：重试入口唯一在副列）。
  retry: boolean;
  // 本列在飞 / 副轨槽 loading ⇒ 本列禁用（只禁本列，主列不受牵连，Q9）。在飞不改写
  // 语言列表（列表恒在场）——列表换成占位会抽掉本列滚动高度，见下面的裁决注释。
  busy: boolean;
}

function resolveSecondaryColumn(tracks: SubtitleTrack[]): SecondaryColumnModel {
  const slot = state.clip.secondarySubtitle;
  const busy = secondaryInFlight !== null || slot.state === "loading";
  const model: SecondaryColumnModel = { note: "", selectedUrl: "", retry: false, busy };
  const pick = String(state.settings.secondarySubtitleLang || "").trim();
  if (!pick) {
    // ① 还没选过副轨
    return { ...model, note: SECONDARY_EMPTY_PICK_TEXT };
  }
  // 与装载器共用的两级匹配（见 resolveSecondaryTarget 的注释）。这里判「没命中」与
  // 「命中的是主轨」必需分开：两态的说明文案不同（02 号票第 5 条），故用未排除的
  // 基础匹配 + 共享的主轨判据，而不是直接取 findSecondaryTrackByPreferredLang。
  const target = findTrackByPreferredLang(tracks, pick);
  if (!target) {
    // ② 本视频没有目标语言的轨（Q4：留空不猜，也不写 noSubtitleReason）
    return { ...model, note: `${SECONDARY_MISSING_PREFIX}${pick}${SECONDARY_MISSING_SUFFIX}` };
  }
  if (isMainSubtitleTrack(target, state.clip.selectedSubtitleId)) {
    // ③ 主副指向同一条轨（Q8）：副轨槽不装主轨（列表里会出两份一样的正文），列首出
    // 说明；语言列表照常在列，用户点另一条即可就地改选（2026-10-06 图外回访）。
    return { ...model, note: SECONDARY_COLLISION_TEXT };
  }
  const selectedUrl = String(target.subtitleUrl || "");
  // 在飞不改语言列表（2026-10-06 用户裁决「选完应该滚动条不动」）：把列表换成一行
  // 「译文加载中…」占位会当场抽掉本列的滚动高度 ⇒ 用户刚滚到列底选的那条语言，下一秒
  // 整列跳回列表顶部（真机走查 run13 的读数）。在飞的可见反馈由两处承担：本列
  // disabled + aria-busy（点不动，见 resolveSecondaryColumn.busy），以及列表里 188 行
  // 副行的「译文加载中…」占位。
  // 失败态同理：用户要能换一条，而不是被失败锁死；重试行在列首，且只重抓这一条副轨
  //（forceRefresh = true，02 号票 Q6）。
  return { ...model, selectedUrl, retry: slot.state === "error" };
}

// 卡片骨架（双语弹层的节点身份不变量）。组件每次换选项都整批重写浮层子节点
//（custom-select.ts 的 refreshOptionNodes = dropdown.replaceChildren()），卡片会被
// 一起摘掉；这里按引用把**同一个**骨架搬回原位——子树原样保留，副列壳、页脚开关、
// 监听器都不重建。骨架建立后只改状态与文案，不再造节点（Q10：组件侧零概念）。
interface BilingualCardNodes {
  pickerWrapper: HTMLElement;
  dropdown: HTMLElement;
  root: HTMLElement;
  mainHead: HTMLElement;
  hint: HTMLElement;
  mainList: HTMLElement;
  subCol: HTMLElement;
  retry: HTMLButtonElement;
  secondaryHost: HTMLElement;
  secondarySelect: HTMLSelectElement;
  empty: HTMLElement;
  toggle: HTMLButtonElement;
}

let bilingualCardNodes: BilingualCardNodes | null = null;

// ===== 弹层滚动位置的保命绳（2026-10-06 真机走查 run13）=====
// 组件重铺选项（rebuildCustomSelectOptions → refreshOptionNodes）走
// `dropdown.replaceChildren()`：卡片整块脱离文档、随后由 ensureBilingualCard 按引用
// 装回。**节点身份因此不变，但滚动位置不在节点身份里**——真机实测：子树脱离文档后
// 布局盒销毁，两列（各自一条滚动条，见 bilingual-subtitles.css）的 scrollTop 一起
// 归零，用户看到的就是「在副列底部选完一条语言，整列跳回列表顶部」。
// 故重铺之前把两列的位置存下来、投影结束后写回；只在快照节点仍在文档里时写回
//（整块重建 forceRecreate 的新列不该继承旧位置）。
type PickerScrollSnapshot = Array<readonly [HTMLElement, number]>;

function capturePickerScroll(): PickerScrollSnapshot {
  const root = bilingualCardNodes?.root;
  if (!root) {
    return [];
  }
  return [...root.querySelectorAll<HTMLElement>(".biliscript-bilingual-col")]
    .filter((node) => !node.hidden)
    .map((node) => [node, node.scrollTop] as const);
}

function restorePickerScroll(snapshot: PickerScrollSnapshot): void {
  for (const [node, top] of snapshot) {
    if (top > 0 && node.isConnected) {
      node.scrollTop = top;
    }
  }
}

function buildColumnHead(text: string): HTMLElement {
  const head = document.createElement("div");
  head.className = "biliscript-bilingual-col-head";
  head.textContent = text;
  return head;
}

// 认领卡片骨架。pickerWrapper 与 dropdown 的身份同时变 = 壳被整块重建过（reader 面板
// forceRecreate），旧骨架连同旧 select 一并作废，重建一份。
function ensureBilingualCard(): BilingualCardNodes | null {
  const mainSelect = document.getElementById(ids.readingSubtitleSelect) as HTMLSelectElement | null;
  const pickerWrapper = mainSelect?.closest<HTMLElement>(".biliscript-reading-track-picker") ?? null;
  const dropdown = pickerWrapper?.querySelector<HTMLElement>(".custom-select-dropdown") ?? null;
  if (!pickerWrapper || !dropdown) {
    return null;
  }
  const existing = bilingualCardNodes;
  if (existing && existing.pickerWrapper === pickerWrapper && existing.dropdown === dropdown) {
    if (existing.root.parentElement !== dropdown) {
      dropdown.appendChild(existing.root);
    }
    return existing;
  }
  bilingualCardNodes = buildBilingualCard(pickerWrapper, dropdown);
  return bilingualCardNodes;
}

function buildBilingualCard(pickerWrapper: HTMLElement, dropdown: HTMLElement): BilingualCardNodes {
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
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "biliscript-bilingual-switch";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-label", SUBTITLE_BILINGUAL_SWITCH_LABEL);
  toggle.addEventListener("click", handleBilingualSwitchClick);
  footer.append(label, toggle);

  root.append(main, footer);
  dropdown.appendChild(root);
  // 副列的值源：一枚原生 select + 组件壳（壳插在 select 当前位置并把 select 收进壳内，
  // 与主列同款）。壳常驻副列（display: contents），不随渲染搬动。
  initCustomSelect(secondarySelect, "custom-select-wrapper biliscript-bilingual-secondary-picker");
  if (!boundSecondaryPickers.has(secondarySelect)) {
    boundSecondaryPickers.add(secondarySelect);
    secondarySelect.addEventListener("change", () => handleSecondaryTrackPickerChange(secondarySelect));
  }
  return {
    pickerWrapper,
    dropdown,
    root,
    mainHead,
    hint,
    mainList,
    subCol,
    retry,
    secondaryHost,
    secondarySelect,
    empty,
    toggle
  };
}

// 投影（每次渲染收口一次，幂等）：主列选项行搬进主列，副列按 resolveSecondaryColumn
// 出语言列表/占位/重试行，页脚开关按 settings 投影。
function projectBilingualPicker(tracks: SubtitleTrack[], dual: boolean): void {
  const nodes = ensureBilingualCard();
  if (!nodes) {
    return;
  }
  const model = resolveSecondaryColumn(tracks);
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // 组件那批 <li> 原样搬进主列（optionNodes / markSelected / 键盘漫游都按节点身份工作）。
  const rows = [...nodes.dropdown.children].filter(
    (node): node is HTMLElement => node instanceof HTMLElement && node.classList.contains("custom-select-option")
  );
  // 主列列表整批换行：旧行是组件上一批 optionNodes（已被它自己放弃），先清掉再搬新的。
  nodes.mainList.replaceChildren();
  rows.forEach((row) => nodes.mainList.appendChild(row));

  nodes.pickerWrapper.dataset.bilingual = dual ? "true" : "false";
  nodes.mainHead.hidden = !dual;
  nodes.hint.hidden = dual || tracks.length === 0 || !isBilingualSwitchDisabled(tracks);
  nodes.subCol.hidden = !dual;
  nodes.retry.hidden = !(dual && model.retry);
  // 说明行与语言列表**同时**在场（2026-10-06 图外回访）：说明行只在三套空态出现，
  // 它解释「为什么没有装载中的副轨」，不顶掉用户改选的那份列表。
  nodes.empty.hidden = !dual || !model.note;
  if (dual && model.note) {
    nodes.empty.textContent = model.note;
  }
  nodes.secondaryHost.hidden = !dual;

  // 值源：双语态恒 = 目标轨 URL（乐观目标即投影）；否则清空并整体禁用。
  // 三套空态（① 没选过 / ② 本视频没有该语言 / ③ 主副同轨）没有目标轨 ⇒ 值空、列表里
  // 没有选中行，而语言行照铺——副列的语言行数因此不再等于「列表在场」这一事实，
  // 跨列断言改按选项集读。
  if (dual) {
    writeSecondaryOptions(nodes.secondarySelect, tracks, model.selectedUrl);
    setCustomSelectValue(nodes.secondarySelect, model.selectedUrl);
    // 在飞期间不动本列状态（与主列早退同款，避免重渲把乐观禁用解掉）。
    if (secondaryInFlight === null) {
      setCustomSelectState(nodes.secondarySelect, { disabled: model.busy, busy: model.busy });
    }
  } else {
    writeSecondaryOptions(nodes.secondarySelect, [], "");
    setCustomSelectState(nodes.secondarySelect, { disabled: true, busy: false });
  }

  const on = state.settings.bilingualSubtitles === true;
  nodes.toggle.setAttribute("aria-checked", on ? "true" : "false");
  nodes.toggle.dataset.on = on ? "true" : "false";
  nodes.toggle.disabled = isBilingualSwitchDisabled(tracks);

  projectTriggerBadge(nodes.pickerWrapper, dual);

  // 搬动选项行会摘掉旧父节点：若焦点正停在其中一行（展开态键盘漫游），按原节点还原
  // 焦点，一次重渲不该打掉用户的键盘位置。
  if (previousFocus && previousFocus.isConnected && !nodes.dropdown.hidden && rows.includes(previousFocus)) {
    previousFocus.focus();
  }
}

// 副列选项行的原生投影（与主列同形状：value = URL、data-id = 身份、data-lang = lan、
// dir="auto" 随行方向；[AI] 标沿用主列那套「列表内来源不唯一才标」的判据）。
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
        const label = resolveSubtitleTrackLabel(track);
        const text = marked && String(track.lan || "").toLowerCase().startsWith("ai-") ? `${label} [AI]` : label;
        const url = String(track.subtitleUrl || "");
        return `<option value="${escapeHtml(url)}" data-lang="${escapeHtml(String(track.lan || ""))}" data-id="${escapeHtml(
          String(track.id || "")
        )}" dir="auto"${url && url === selectedUrl ? " selected" : ""}>${escapeHtml(text)}</option>`;
      })
      .join("");
  }
  rebuildCustomSelectOptions(select);
}

// trigger 徽标（双语态 = 主轨名 + 「双语」小徽标，trigger 定宽 120px 不动）。
// 徽标是 trigger 的直接子节点而不是 .custom-select-value 的内容：组件的值投影
//（syncDisplayFromValue）每次整块重写那个 span，放里面会被下一次写值抹掉。可访问名
// 由组件从「字段名 + 现值」派生（本叶子不跟它抢 aria-label），双语信号走
// aria-describedby 指到徽标上。
function projectTriggerBadge(pickerWrapper: HTMLElement, on: boolean): void {
  const trigger = pickerWrapper.querySelector<HTMLButtonElement>(".custom-select-trigger");
  if (!trigger) {
    return;
  }
  let badge = trigger.querySelector<HTMLElement>(".biliscript-bilingual-badge");
  if (!on) {
    badge?.remove();
    trigger.removeAttribute("aria-describedby");
    return;
  }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "biliscript-bilingual-badge";
    badge.id = SUBTITLE_BILINGUAL_BADGE_ID;
    badge.textContent = SUBTITLE_BILINGUAL_BADGE_TEXT;
    // 值区之后、箭头之前（值 + 徽标贴 start 端，箭头仍贴 end 端）
    trigger.insertBefore(badge, trigger.querySelector(".custom-select-arrow"));
  }
  trigger.setAttribute("aria-describedby", SUBTITLE_BILINGUAL_BADGE_ID);
}

// 副轨装载（开关打开 / 换副轨语言 / 重试共用一条入口）：乐观目标 + 只禁本列，
// 失败不回退目标（02 号票 Q3；错误态由装载器写进槽，本列据此出重试行）。
function startSecondaryLoad(target: SecondaryTarget, forceRefresh: boolean): void {
  if (!target.url) {
    return;
  }
  secondaryInFlight = target.url;
  const select = ensureBilingualCard()?.secondarySelect ?? null;
  if (select) {
    setCustomSelectValue(select, target.url);
    setCustomSelectState(select, { disabled: true, busy: true });
  }
  renderReadingSubtitleTrackPicker();
  void (async () => {
    try {
      const chain = await ensureSummarizeChain();
      await chain.loadSecondarySubtitle(target.url, target.lang, state.clip.fetchRunId, target.id, forceRefresh);
      // 成功路径不收敛控件：副轨到站的 "secondary-subtitle-ready" 通知驱动
      // renderReadingView 重渲（05 号票的新 kind，不带主轨那串副作用）。
    } catch (error) {
      // 失败：槽已置 error（弹层副列占位即重试入口），这里只补一句状态行旁白
      //（与主列失败同一条 notice 通道；仓内无 toast）。
      subtitleTrackNotice?.(`副字幕加载失败：${getErrorMessage(error)}`);
      logWarn("[BILISCRIPT] failed to load secondary subtitle", error);
    } finally {
      secondaryInFlight = null;
      renderReadingSubtitleTrackPicker();
    }
  })();
}

// 开关打开 / 跨上下文同步后按全局偏好把目标轨抓起来（Q1：打开那一刻立即抓、
// forceRefresh = false 优先命中 per-track 缓存；不做面板可见判定、不做滚动懒加载）。
// 三重守卫与 reader/lifecycle.ts 的自动装载同款：槽非 idle 不重来（在飞/已就绪/
// 已失败都不重来，失败等用户在副列点重试）。
function activateSecondaryTarget(): void {
  if (state.settings.bilingualSubtitles !== true) {
    return;
  }
  if (secondaryInFlight !== null || state.clip.secondarySubtitle.state !== "idle") {
    return;
  }
  const target = resolveSecondaryTarget(currentSubtitleTracks());
  if (!target) {
    return;
  }
  startSecondaryLoad(target, false);
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
  renderReadingSubtitleTrackPicker();
  notifyReaderPresenter("rerender");
}

// 副列语言改选（组件浮层里点一行 → 组件写值并派发 change）：
//   - 本列在飞时的 change 一律忽略（组件浮层的点击处理器不查 disabled，禁用只是
//     视觉/键盘守卫，这里必须自己早退）并收敛回 state 的现值；
//   - 选中主轨那一条 ⇒ Q8 同轨防呆：清副轨槽（列表退回单轨），目标 lan 不动；
//   - 否则写全局偏好（副轨目标 lan）+ 乐观目标 + loading（装载器自己写槽），
//     只禁本列，`forceRefresh = false`（切轨语义）。
function handleSecondaryTrackPickerChange(select: HTMLSelectElement): void {
  if (secondaryInFlight !== null) {
    renderReadingSubtitleTrackPicker();
    return;
  }
  const option = select.options[select.selectedIndex];
  const url = select.value;
  const id = String(option?.dataset.id || "");
  const lang = String(option?.dataset.lang || "");
  if (!url) {
    renderReadingSubtitleTrackPicker();
    return;
  }
  // Q8 同轨防呆：副列选了主轨那一条 ⇒ 副列清空（列表退回单轨）。目标 lan 记成用户
  // 刚点的那条轨的 lan（= 主轨的 lan）——这是「副列指向主轨」的唯一可投影信号，
  // 第三套空态文案「主副字幕相同」由此推出（02 号票第 5/8 条：
  // 三套空态不占新位、由（目标 lan × 轨列表 × 主轨选择 × 副轨 body）投影推导）。
  if (id && id === state.clip.selectedSubtitleId) {
    state.setSettings({ ...state.settings, secondarySubtitleLang: lang });
    persistReaderSettingsThroughSeam();
    state.clip.clearSecondarySubtitle();
    renderReadingSubtitleTrackPicker();
    // 同轨防呆清的是**副轨槽**，副行随之从列表消失 ⇒ 与开关同款：必须请列表属主重渲，
    // 否则列表还挂着已被清空的译文（弹层侧已经收起、两处两说）。
    notifyReaderPresenter("rerender");
    return;
  }
  // 全局偏好：副轨目标 lan（Q4 记忆粒度）；立即落盘（与主题偏好同一条 persist seam）。
  state.setSettings({ ...state.settings, secondarySubtitleLang: lang });
  persistReaderSettingsThroughSeam();
  startSecondaryLoad({ id, url, lang }, false);
}

// 副列占位行里的重试（02 号票 Q6：重抓**这一条**副轨，forceRefresh = true）。
function handleSecondaryRetryClick(): void {
  if (secondaryInFlight !== null) {
    return;
  }
  const target = resolveSecondaryTarget(currentSubtitleTracks());
  if (!target) {
    return;
  }
  startSecondaryLoad(target, true);
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

// 跨上下文收敛（05 号票的追加口径）：别的标签页 / 另一台设备改了这两个键，本页也要
// 收敛——否则「那边开了双语，这边开关还停在旧态」。两个键不在
// READER_SETTINGS_WATCH_KEYS（那份清单由 reader/presentation-fields.ts 派生，属另一
// 处写面），故按 entry/content.ts 播放器 AI 开关的 { sync: [...] } 形自持一份订阅：
// 就地把新值合进 state.settings（与那份清单的回读语义等价、少一次全量往返），再重渲
// 选轨弹层；开关被远端打开时同样走 Q1 的「立即抓目标轨」。
function bindBilingualSettingsWatch(): void {
  if (bilingualSettingsWatchBound) {
    return;
  }
  bilingualSettingsWatchBound = true;
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
      renderReadingSubtitleTrackPicker();
    },
    { sync: ["bilingualSubtitles", "secondarySubtitleLang"] }
  );
}

export function bindSubtitleTabEvents(): void {
  // 转写相位订阅（选轨控件的 transcribing 态）：与其余绑定同生命周期、只绑一次。
  bindSubtitleTrackPickerPhase();
  // 双语偏好的跨上下文订阅（别的标签页/设备改了开关或目标语言 → 本页收敛）。
  bindBilingualSettingsWatch();
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
