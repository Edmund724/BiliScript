// 副轨（双语字幕的第二路轨）：目标解析、装载事务、Q8 同轨防呆与双语偏好控制的唯一落点。
//
// 领域口径（GLOSSARY.md「字幕」词条、ADR-0016）：
//   - 副轨目标不是独立状态位，而是（偏好语言 × 本视频轨列 × 主轨身份）的投影；
//     「还没选过 / 本视频没有该语言轨 / 主副指向同一条轨」三套空态由这一次投影的
//     reason 得出，不占新位（ADR-0016 决定 1）。
//   - 副轨槽 clip.secondarySubtitle 自带装载态（idle|loading|ready|error），装载链与
//     主轨**并列**：本模块只经 subtitle/lazy.js 的 loadSecondarySubtitle 触达
//     subtitle/fetcher 的副轨装载器（落点 acceptSecondarySubtitle）——不碰主轨
//     selected 三项、不碰 subtitleFetchState，也不动那两条接受事务本体。
//   - 「副轨的选中就是目标」：乐观写入、失败不回退（ADR-0016 决定 4）。失败只由装载器
//     写槽的 error 态，开关与目标都保持；重试入口唯一在弹层副列。
//   - 主副同轨防呆（Q8 正向副列选主轨 / 反向主轨切到副轨）与双语偏好变更（开关切换、
//     副列改选、跨上下文 storage 同步）均收口于本模块；弹层叶子只负责 DOM 与
//     custom-select 投影。
//
// 依赖方向：reader → subtitle 叶子（subtitle/selection 的目标投影与匹配叶子 +
// subtitle/slot 的副轨槽动词 + subtitle/lazy 的链装载器）；subtitle/* 不得反向 import 本模块。

import type { Settings } from "../core/defaults.js";
import { state } from "../core/state.js";
import type { SecondarySubtitleState } from "../core/state.js";
import { logWarn } from "../shared/logging.js";
import { ensureSummarizeChain } from "../subtitle/lazy.js";
import { resolveSubtitleLangLabel } from "../subtitle/labels.js";
import {
  findSecondaryTrackByPreferredLang,
  findTrackByPreferredLang,
  findTrackByRef,
  isMainSubtitleTrack,
  resolveTrackTarget,
  type SubtitleTrackRef,
  type SubtitleTrackTarget
} from "../subtitle/selection.js";
import { clearSecondary } from "../subtitle/slot.js";
import type { SubtitleTrack } from "../bilibili/gateway.js";
import { notifyReaderPresenter, persistReaderSettingsThroughSeam } from "./reader-bus.js";

// 目标轨投影：id/url 取自轨，lang 是目标轨语言（统一走 selection.ts 的规范投影
// `lanDoc || lan || "unknown"`，作为 per-track 缓存键的 source key 分量）。
export type SecondaryTarget = SubtitleTrackTarget;

// 没有目标的原因（副列 ①②③ 三套空态各自取一条；文案属弹层的 DOM 投影，不在本模块）。
export type SecondaryTargetMissReason = "no-preference" | "no-track" | "main-track";

export type SecondaryTargetResolution =
  | { kind: "target"; target: SecondaryTarget }
  | { kind: "none"; reason: SecondaryTargetMissReason };

// 副列改选时选项行给出的轨身份（value = 轨 URL、data-id = 轨 id、data-lang = 轨 lan）。
export type SecondaryTrackRef = SubtitleTrackRef;

// 事务没起步的原因：目标缺席的三态，加上事务独有的两个守卫（开关关 / 槽非 idle）。
export type SecondaryEnsureSkipReason = SecondaryTargetMissReason | "bilingual-off" | "slot-busy";

// 装载事务的落定句柄：**不 reject**——自动装载入口不 await 事务，reject 会变成未处理
// 拒绝；解析值 = 本次装载的异常（成功为 null）。弹层用它补状态行旁白并收敛本列 DOM。
export interface SecondaryLoadSettlement {
  error: unknown | null;
}

export type SecondaryEnsureOutcome =
  | { kind: "started"; target: SecondaryTarget; settled: Promise<SecondaryLoadSettlement> }
  | { kind: "skipped"; reason: SecondaryEnsureSkipReason };

export interface EnsureSecondaryOptions {
  // 已解析的目标（副列改选 / 重试）：用户已经点名了一条轨，跳过全部守卫与偏好解析。
  target?: SecondaryTarget;
  // 重试：绕过硬/软缓存直走网络（唯一传 true 的是弹层副列的重试入口）。
  forceRefresh?: boolean;
}

function currentTracks(): SubtitleTrack[] {
  return (state.clip.subtitles || []) as unknown as SubtitleTrack[];
}

// 解析当前副轨目标（纯判定：只读 state，不写状态、不渲染、不 I/O）。两级匹配 + 排除主轨
// + 只考虑真轨 + 规范目标投影（`lanDoc || lan || "unknown"`）都收在 subtitle/selection
// 的共享叶子里——自动装载、副列投影、改选/重试共用同一份实现。
//
// 不给 ref（自动装载 / 副列投影 / 重试）：按全局偏好解析。偏好为空（还没选过）⇒
//   no-preference；命中主轨 ⇒ main-track（**不顺位**退到同语言的另一条：那还是两份一样
//   的正文）；本视频没有该语言的轨 ⇒ no-track（留空、不替用户猜）。
// 给 ref（副列改选）：按轨身份辨认，不看偏好——用户已经点名了这一条；辨认不出（投影与
//   点击之间轨列被换过）时沿用选项行自己的身份与 lang 兜底。
export function resolveSecondaryTarget(ref?: SecondaryTrackRef): SecondaryTargetResolution {
  const tracks = currentTracks();
  if (ref) {
    const track = findTrackByRef(tracks, ref);
    if (isMainSubtitleTrack(track ?? ref, state.clip.selectedSubtitleId)) {
      return { kind: "none", reason: "main-track" };
    }
    if (!track && !String(ref.url || "")) {
      return { kind: "none", reason: "no-track" };
    }
    return { kind: "target", target: resolveTrackTarget(track ?? ref) };
  }

  const pick = String(state.settings.secondarySubtitleLang || "").trim();
  if (!pick) {
    return { kind: "none", reason: "no-preference" };
  }
  const mainId = state.clip.selectedSubtitleId;
  const track = findSecondaryTrackByPreferredLang(tracks, pick, mainId);
  if (track) {
    return { kind: "target", target: resolveTrackTarget(track) };
  }
  // 「没命中」要分两态（副列文案不同）：命中的是主轨 ⇒ main-track，本视频根本没有该语言
  // 的真轨 ⇒ no-track。用未排除主轨的基础匹配判据，与副列投影同一份实现。
  return { kind: "none", reason: findTrackByPreferredLang(tracks, pick) ? "main-track" : "no-track" };
}

// ===== 副列的列模型：六态判定 → 视图 =====
// 「这一列该长什么样」是（目标解析结论 × 偏好语言 × 槽相位 × 在飞）的纯判定，与 DOM
// 投影分离：本模块只出模型，reader/subtitle-tab-ui.ts 的叶子把模型落成节点与文案
//（模板 / 骨架 / 绑定仍归叶子）。四项事实全部显式传入——判定不读 state、不碰 DOM，
// 六态因此可以逐格断言，不必搭壳与几何。

// 副列的两套空态文案（02 号票第 5 条：用户下一步动作不同，不共用一句）。两套都只是
// 副列**列首的一行说明**，语言列表始终留在列里（2026-10-06 图外回访：说明行顶掉列表
// 就等于把用户锁死在这一态——点错一条副语言后再也改不回来）。
// 在飞**不**出说明行（2026-10-06 用户裁决）：装载中的可见反馈由副列 disabled/aria-busy
// 与列表里副行的占位承担。
const SECONDARY_EMPTY_PICK_TEXT = "选择副字幕语言";
// 第三套（主副同轨）**不进副列**：它说的是整列的状态，放页脚紧挨「双语字幕」四个字
//（2026-10-06 用户裁决：「主副字幕相同的提示放在双语字幕四个字的右边，不要放在副字幕
// 列表里」）。副列列表因此不再多占一行（那一行同时还是 140px 宽度预算的受害者）。
const SECONDARY_COLLISION_TEXT = "主副字幕相同";
// ② 的语言名走共享叶子 resolveSubtitleLangLabel（2026-10-06 用户裁决：文案里不出现机器码
// ——偏好存的是轨的 lan，原样拼就是「本视频没有 ai-ja 轨」，读不出是哪门语言，而同一列的
// 列表显示的是 B站 lanDoc「日本語」）。命中语言名表 ⇒ 中文名，未命中 ⇒ 回落机器码。
const SECONDARY_MISSING_PREFIX = "本视频没有";
const SECONDARY_MISSING_SUFFIX = "轨";

export interface SecondaryColumnView {
  // 列首一行说明：**只**服务「下一步动作就在这一列里做」的两套空态（① 还没选过 /
  // ② 本视频没有该语言）。空串 = 不出说明行。说明行**不替代**语言列表（2026-10-06
  // 图外回访）：用户的下一步动作永远是「换一条语言」，把列表撤掉就是把他锁死在这一态上。
  note: string;
  // 页脚状态提示（③ 主副同轨）：说的是**整列**为什么没有可对照的第二条轨，放页脚紧挨
  // 「双语字幕」（2026-10-06 用户裁决：不要放在副字幕列表里）。空串 = 不显示。
  footerNote: string;
  selectedUrl: string;
  // 失败态：列首那行「加载失败 · 重试」（02 号票 Q6：重试入口唯一在副列）。
  retry: boolean;
  // 本列在飞 / 副轨槽 loading ⇒ 本列禁用（只禁本列，主列不受牵连，Q9）。在飞不改写
  // 语言列表（列表恒在场）——列表换成占位会抽掉本列滚动高度，见下方注释。
  busy: boolean;
}

export interface SecondaryColumnInput {
  // resolveSecondaryTarget 的结论（三套空态各取一条 reason）。
  resolution: SecondaryTargetResolution;
  // 全局偏好语言（settings.secondarySubtitleLang）：② 的说明行据它查语言名。
  preferenceLang: string;
  // 副轨槽的相位（clip.secondarySubtitle.state）：loading 计入本列禁用，error 出重试行。
  slotState: SecondarySubtitleState;
  // 装载事务的在飞登记（isSecondarySubtitleLoadInFlight）。
  loadInFlight: boolean;
}

export function resolveSecondaryColumnView({
  resolution,
  preferenceLang,
  slotState,
  loadInFlight
}: SecondaryColumnInput): SecondaryColumnView {
  const busy = loadInFlight || slotState === "loading";
  const view: SecondaryColumnView = { note: "", footerNote: "", selectedUrl: "", retry: false, busy };
  // 三套空态各取一条 reason——「没命中」与「命中的是主轨」的文案不同（02 号票第 5 条），
  // 故分得开。
  if (resolution.kind === "none") {
    if (resolution.reason === "no-preference") {
      // ① 还没选过副轨
      return { ...view, note: SECONDARY_EMPTY_PICK_TEXT };
    }
    if (resolution.reason === "no-track") {
      // ② 本视频没有目标语言的轨（Q4：留空不猜，也不写 noSubtitleReason）。
      // 语言名查表：命中 ⇒ 中文名紧贴前后文；未命中 ⇒ 回落机器码，两侧留空格免得与
      // 三段汉字黏成一段。
      const pick = String(preferenceLang || "").trim();
      const label = resolveSubtitleLangLabel(pick);
      const name = label === pick ? ` ${label} ` : label;
      return { ...view, note: `${SECONDARY_MISSING_PREFIX}${name}${SECONDARY_MISSING_SUFFIX}` };
    }
    // ③ 主副指向同一条轨（Q8）：副轨槽不装主轨（列表里会出两份一样的正文）。状态提示
    // 进**页脚**（紧挨「双语字幕」）——它讲的是整列的状态，不占副列列表的位置；语言列表
    // 照常在列，用户点另一条即可就地改选（2026-10-06 图外回访 + 用户裁决）。
    return { ...view, footerNote: SECONDARY_COLLISION_TEXT };
  }
  // 在飞不改语言列表（2026-10-06 用户裁决「选完应该滚动条不动」）：把列表换成一行
  // 「译文加载中…」占位会当场抽掉本列的滚动高度 ⇒ 用户刚滚到列底选的那条语言，下一秒
  // 整列跳回列表顶部（真机走查 run13 的读数）。在飞的可见反馈由两处承担：本列
  // disabled + aria-busy（点不动，见 busy），以及列表里副行的「译文加载中…」占位。
  // 失败态同理：用户要能换一条，而不是被失败锁死；重试行在列首，且只重抓这一条副轨
  //（forceRefresh = true，02 号票 Q6）。
  return { ...view, selectedUrl: resolution.target.url, retry: slotState === "error" };
}

// 在飞登记（本模块持有的唯一一份）：装载事务起步时同步登记、落定时清自己那一枚。弹层的
// 早退与「在飞禁用」读它；槽里的 loading 相位仍由装载器自己写——本模块不新造装载相位。
// 按枚登记（不是单一布尔）：自动装载与弹层的即时装载可能重叠（前者只按槽状态判别），
// 单值会被先落定的那条提前清空。
let loadToken = 0;
const inFlightLoads = new Set<number>();

export function isSecondarySubtitleLoadInFlight(): boolean {
  return inFlightLoads.size > 0;
}

// 装载事务：在飞登记 → ensureSummarizeChain → loadSecondarySubtitle。runId 取链装载
// **之后**的 fetchRunId（与重构前的两个入口同序：URL 变化已递增过代次时，事务门口的
// runId 自检才会让旧 run 让位——旧视频的副轨不得写进已重置的槽）。
function startSecondaryLoad(target: SecondaryTarget, forceRefresh: boolean): SecondaryEnsureOutcome {
  const token = ++loadToken;
  inFlightLoads.add(token);
  const settled = (async (): Promise<SecondaryLoadSettlement> => {
    let error: unknown = null;
    try {
      const chain = await ensureSummarizeChain();
      await chain.loadSecondarySubtitle(target.url, target.lang, state.clip.fetchRunId, target.id, forceRefresh);
    } catch (failure) {
      // 失败已由装载器写进副轨槽（error 态 + 弹层副列占位即重试入口），这里只记日志；
      // 异常不外抛：自动装载入口不 await 事务，抛出会成为未处理拒绝。
      error = failure;
      logWarn("[BILISCRIPT] failed to load secondary subtitle", failure);
    } finally {
      inFlightLoads.delete(token);
    }
    return { error };
  })();
  return { kind: "started", target, settled };
}

// 确保副轨已装载（四个入口的唯一落点）。
//   不给 target（自动装载 / 开关打开 / 跨上下文收敛）：守卫「开关关 / 无目标 / 槽非 idle
//   ⇒ 不动」——槽非 idle 覆盖在飞、已就绪、已失败三种（失败等用户在副列点重试，不自动重来）。
//   给 target（副列改选 / 重试）：用户已经表态，槽非 idle 也照装（改选发生在槽 ready/error
//   时是常态），不再解析偏好。
export function ensureSecondarySubtitleLoaded(options?: EnsureSecondaryOptions): SecondaryEnsureOutcome {
  const target = options?.target;
  const forceRefresh = options?.forceRefresh === true;
  if (target) {
    return startSecondaryLoad(target, forceRefresh);
  }
  if (state.settings.bilingualSubtitles !== true) {
    return { kind: "skipped", reason: "bilingual-off" };
  }
  const slot = state.clip.secondarySubtitle;
  if (!slot || slot.state !== "idle") {
    return { kind: "skipped", reason: "slot-busy" };
  }
  const resolution = resolveSecondaryTarget();
  if (resolution.kind === "none") {
    return { kind: "skipped", reason: resolution.reason };
  }
  return startSecondaryLoad(resolution.target, forceRefresh);
}

// ===== 双语同轨防呆（Q8）与偏好控制 =====

// 主轨切到了副轨槽当前装着的同一条轨 ⇒ 清副轨槽（Q8 反方向；全局偏好 secondarySubtitleLang
// 保持不动，投影据此出第三套空态文案「主副字幕相同」）。判据复用 isMainSubtitleTrack
//（两侧 id 非空且相等），读主轨接受事务之后的 state——切轨失败时 state 未变，不会误清。
export function clearSecondarySubtitleIfShadowedByMain(): boolean {
  const slot = state.clip.secondarySubtitle;
  if (!isMainSubtitleTrack(slot, state.clip.selectedSubtitleId)) {
    return false;
  }
  clearSecondary();
  return true;
}

export type SecondarySelectionOutcome =
  | { kind: "started"; target: SecondaryTarget; settled: Promise<SecondaryLoadSettlement> }
  | { kind: "main-track" }
  | { kind: "skipped"; reason: "in-flight" | "no-track" };

// 副列改选：
//   - 本列在飞或 URL 为空 ⇒ 忽略（skipped）；
//   - 写全局偏好 secondarySubtitleLang 并立即落盘；
//   - 命中主轨（Q8 同轨防呆）⇒ 清副轨槽并通知列表属主重渲，返回 main-track；
//   - 否则按轨身份解析目标并发起副轨装载事务（槽非 idle 也照装）。
export function selectSecondarySubtitleTrack(ref: SecondaryTrackRef): SecondarySelectionOutcome {
  if (isSecondarySubtitleLoadInFlight()) {
    return { kind: "skipped", reason: "in-flight" };
  }
  const url = String(ref.url || "");
  if (!url) {
    return { kind: "skipped", reason: "no-track" };
  }
  const lang = String(ref.lang || "");
  state.setSettings({ ...state.settings, secondarySubtitleLang: lang });
  persistReaderSettingsThroughSeam();
  const resolution = resolveSecondaryTarget(ref);
  if (resolution.kind === "none") {
    if (resolution.reason === "main-track") {
      clearSecondary();
      notifyReaderPresenter({ kind: "rerender" });
      return { kind: "main-track" };
    }
    return { kind: "skipped", reason: "no-track" };
  }
  const outcome = ensureSecondarySubtitleLoaded({ target: resolution.target });
  if (outcome.kind !== "started") {
    return { kind: "skipped", reason: "no-track" };
  }
  return outcome;
}

function activatePreferredSecondaryTarget(): SecondaryEnsureOutcome {
  if (isSecondarySubtitleLoadInFlight()) {
    return { kind: "skipped", reason: "slot-busy" };
  }
  return ensureSecondarySubtitleLoaded();
}

// 页脚双语开关切换：写全局偏好并立即落盘，打开时按偏好激活目标轨（关闭只停显示、
// 不清副轨槽），并通知列表属主重渲。
export function toggleBilingualSubtitles(
  enabled: boolean = state.settings.bilingualSubtitles !== true
): SecondaryEnsureOutcome {
  state.setSettings({ ...state.settings, bilingualSubtitles: enabled });
  persistReaderSettingsThroughSeam();
  const outcome: SecondaryEnsureOutcome = enabled
    ? activatePreferredSecondaryTarget()
    : { kind: "skipped", reason: "bilingual-off" };
  notifyReaderPresenter({ kind: "rerender" });
  return outcome;
}

// 副列重试（02 号票 Q6）：非在飞且当前偏好可解析出目标轨时，以 forceRefresh=true 重抓该副轨。
export function retrySecondarySubtitleLoad(): SecondaryEnsureOutcome {
  if (isSecondarySubtitleLoadInFlight()) {
    return { kind: "skipped", reason: "slot-busy" };
  }
  const resolution = resolveSecondaryTarget();
  if (resolution.kind === "none") {
    return { kind: "skipped", reason: resolution.reason };
  }
  return ensureSecondarySubtitleLoaded({ target: resolution.target, forceRefresh: true });
}

export interface BilingualStorageSyncResult {
  changed: boolean;
  loadOutcome: SecondaryEnsureOutcome;
}

// 跨上下文双语偏好同步（watchStorageKeys 回调）：合并 bilingualSubtitles /
// secondarySubtitleLang 变更到 state.settings，若双语处于开启态则按偏好激活目标轨。
export function syncBilingualSettingsFromStorage(
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>
): BilingualStorageSyncResult {
  const bilingual = changes["bilingualSubtitles"];
  const lang = changes["secondarySubtitleLang"];
  if (!bilingual && !lang) {
    return {
      changed: false,
      loadOutcome: { kind: "skipped", reason: "bilingual-off" }
    };
  }
  const updates: Partial<Settings> = {};
  if (bilingual) {
    updates.bilingualSubtitles = bilingual.newValue === true;
  }
  if (lang && typeof lang.newValue === "string") {
    updates.secondarySubtitleLang = lang.newValue;
  }
  state.setSettings({ ...state.settings, ...updates });
  const loadOutcome: SecondaryEnsureOutcome =
    state.settings.bilingualSubtitles === true
      ? activatePreferredSecondaryTarget()
      : { kind: "skipped", reason: "bilingual-off" };
  return { changed: true, loadOutcome };
}
