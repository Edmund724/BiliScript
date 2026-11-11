// extension/reader/asr-translation.ts
// 伪轨视频（自配平台转写）的译文副轨：面板侧的启动/中止/续跑与列投影模型。
//
// 分工：真正的分片调度、缓存覆盖判定、逐片翻译与写槽在链层
//（subtitle/asr-translation.ts，经 subtitle/lazy 的 chain 暴露）；本模块是
// 轻叶子，只持有「在飞、进度、要不要用户点一下」这三件面板要看的事实，并负责
// 偏好写入与用户动作的翻译。放这里而不是链层，因为字幕工具条每次重渲都要同步读
// 这三个事实——不能为一个数字去 await 一条懒装载链。
//
// 领域口径（GLOSSARY「字幕」「双语」，票 asr-panel-translation 的裁定）：
//   - 伪轨视频的双语第二行是**同一原文段的 LLM 译文**，不是第二条轨；主轨恒为
//     原文，复制/导出/AI 上下文都不吃译文；
//   - 目标语言复用 `liveInterpretTargetLang`（与播放器「字幕」浮层同一个偏好、
//     同一份 `id_translate-<lang>` 缓存）——两处各设一个目标语言等于同一视频按
//     两种语言各翻一遍、各花一份钱；
//   - 显式动作才花钱：打开开关 / 点语言行 / 点按钮。缓存全命中不设门（零成本）。
//
// 换视频/换代次即收场：在飞翻译中止，进度清零，已落盘分片留在缓存里等下次命中。

import { state, clipState } from "../core/state.js";
import {
  LIVE_INTERPRET_TARGET_LANG_OPTIONS,
  type LiveInterpretTargetLang
} from "../live/interpret-subtitle-preferences.js";
import { ensureSummarizeChain } from "../subtitle/lazy.js";
import { logWarn } from "../shared/logging.js";
import { notifyReaderPresenter, persistReaderSettingsThroughSeam } from "./reader-bus.js";

// 伪轨判据（唯一判据，不按「可装载轨数 = 1」判）：自配平台转写的伪轨 id 恒为
// "asr"、subtitleUrl 为空（两个产地：asr/fallback 的 seedAsrPseudoTrack 与播放器
// 浮层的 seedAsrPseudoTrackIfNeeded，形状一致）。有 CC 但只有一条轨的视频不被
// 误判进译文场景。入参按结构取字段（clip.subtitles 是 SubtitleOption[]，两侧同形）。
export function hasAsrPseudoTrack(
  tracks: Array<{ id?: string; subtitleUrl?: string } | null | undefined> | null | undefined
): boolean {
  return (tracks || []).some(
    (track) => String(track?.id || "").trim() === "asr" && !String(track?.subtitleUrl || "").trim()
  );
}

const DEFAULT_TARGET_LANG: LiveInterpretTargetLang = "zh";

export function resolveAsrTranslationLang(): LiveInterpretTargetLang {
  const raw = String(state.settings.liveInterpretTargetLang || "").trim();
  const found = LIVE_INTERPRET_TARGET_LANG_OPTIONS.find((option) => option.value === raw);
  return (found?.value ?? DEFAULT_TARGET_LANG) as LiveInterpretTargetLang;
}

export function normalizeAsrTranslationLang(value: unknown): LiveInterpretTargetLang {
  const raw = String(value ?? "").trim();
  const found = LIVE_INTERPRET_TARGET_LANG_OPTIONS.find((option) => option.value === raw);
  return (found?.value ?? DEFAULT_TARGET_LANG) as LiveInterpretTargetLang;
}

// ===== 在飞与进度（本模块持有的唯一一份）=====
// 面板列投影要同步读它，故收在这里而不是链层；链层只经回调回报数字。
let activeAbort: AbortController | null = null;
let progress: { total: number; done: number; failed: number } = { total: 0, done: 0, failed: 0 };
// 字幕体未就绪时点开的「开始生成译文」：记住意图，等主轨到站后由自动入口兑现
// （显式动作不因主轨晚到而丢）。
let startRequested = false;
// 上下文身份（视频 + 抓取代次）：变了即在飞作废、进度清零，旧视频的译文不得落进新槽。
let contextKey = "";

function currentContextKey(): string {
  return `${state.clip.bvid}|${state.clip.cid}|${clipState.fetchRunId}`;
}

function syncContext(): void {
  const next = currentContextKey();
  if (next === contextKey) {
    return;
  }
  contextKey = next;
  activeAbort?.abort();
  activeAbort = null;
  progress = { total: 0, done: 0, failed: 0 };
  startRequested = false;
}

export interface AsrTranslationView {
  lang: LiveInterpretTargetLang;
  inFlight: boolean;
  // 副列列首说明行（进度 / 部分失败）。空串 = 不出说明行。
  note: string;
  // 副列那枚按钮（与 CC 副轨的重试按钮同一节点，文案按场景换）：null = 不显示。
  action: { label: string; kind: "start" | "retry" | "fill" } | null;
}

// 列投影（纯读）：不许在这里发起装载——重渲每拍都会调用它。
export function resolveAsrTranslationView(): AsrTranslationView {
  syncContext();
  const lang = resolveAsrTranslationLang();
  const inFlight = activeAbort !== null;
  const slotState = state.clip.secondarySubtitle.state;
  const hasBody = (state.clip.subtitleBody || []).length > 0;
  if (inFlight) {
    const note =
      progress.total > 0 ? `正在生成译文 ${progress.done}/${progress.total} 片` : "";
    return { lang, inFlight, note, action: null };
  }
  if (slotState === "error") {
    return { lang, inFlight, note: "", action: { label: "重试", kind: "retry" } };
  }
  if (slotState === "ready") {
    if (progress.failed > 0) {
      return {
        lang,
        inFlight,
        note: "译文已生成，部分分片失败",
        action: { label: `补齐失败的 ${progress.failed} 片`, kind: "fill" }
      };
    }
    return { lang, inFlight, note: "", action: null };
  }
  if (!hasBody) {
    // 主轨还没到（转写中/抓取中）：不摆一个现在点不动的按钮。
    return { lang, inFlight, note: "", action: null };
  }
  return { lang, inFlight, note: "", action: { label: "开始生成译文", kind: "start" } };
}

export type AsrTranslationEnsureMode = "cache-only" | "translate";

export interface AsrTranslationEnsureResult {
  // done：全片有译文（或已挂载缓存）；pending：还缺分片（cache-only 下的常态）；
  // skipped：不在本场景 / 主轨未就绪 / 已有在飞。
  kind: "done" | "pending" | "skipped";
}

// 唯一装载入口（自动缓存挂载与显式启动共用）：
//   - cache-only：零请求，命中即挂载；缺片只回报 pending，不自动花钱；
//   - translate：补齐缺片。用户动作显式动作才走到这里，字幕体未就绪时记住意图。
export async function ensureAsrTranslation(
  mode: AsrTranslationEnsureMode = "cache-only"
): Promise<AsrTranslationEnsureResult> {
  syncContext();
  if (!hasAsrPseudoTrack(state.clip.subtitles)) {
    return { kind: "skipped" };
  }
  if (mode === "translate") {
    startRequested = true;
  }
  if (activeAbort) {
    return { kind: "skipped" };
  }
  if ((state.clip.subtitleBody || []).length === 0) {
    return { kind: "skipped" };
  }
  const effectiveMode: AsrTranslationEnsureMode = startRequested ? "translate" : mode;
  startRequested = false;
  const lang = resolveAsrTranslationLang();
  const abort = new AbortController();
  activeAbort = abort;
  progress = { total: 0, done: 0, failed: 0 };
  notifyReaderPresenter({ kind: "rerender" });
  try {
    const chain = await ensureSummarizeChain();
    if (abort.signal.aborted) {
      return { kind: "skipped" };
    }
    const result = await chain.ensureAsrTranslation({
      mode: effectiveMode,
      targetLang: lang,
      runId: clipState.fetchRunId,
      signal: abort.signal,
      // 改选语言后旧一轮立刻失效（它可能正停在一个分片请求上）
      isStale: () => resolveAsrTranslationLang() !== lang,
      onProgress: (next) => {
        if (activeAbort !== abort) {
          return;
        }
        progress = { total: next.total, done: next.done, failed: next.failed };
        notifyReaderPresenter({ kind: "rerender" });
      }
    });
    return { kind: result.kind === "pending" ? "pending" : "done" };
  } catch (error) {
    logWarn("[BILISCRIPT] asr translation failed", error);
    return { kind: "skipped" };
  } finally {
    if (activeAbort === abort) {
      activeAbort = null;
    }
    notifyReaderPresenter({ kind: "rerender" });
  }
}

// 中止在飞翻译（关开关 / 换视频 / 关闭面板）：已发出的分片不追回，已落盘分片保留。
export function cancelAsrTranslation(): void {
  startRequested = false;
  activeAbort?.abort();
  activeAbort = null;
  progress = { total: 0, done: 0, failed: 0 };
  notifyReaderPresenter({ kind: "rerender" });
}

// 副列改选（译文场景）：写全局目标语言并立即落盘，清掉旧语言的副轨槽（旧正文不能
// 挂在新目标下面），然后按新语言补齐。
export function selectAsrTranslationLanguage(value: unknown): void {
  const lang = normalizeAsrTranslationLang(value);
  state.setSettings({ ...state.settings, liveInterpretTargetLang: lang });
  persistReaderSettingsThroughSeam();
  cancelAsrTranslation();
  clipState.clearSecondarySubtitle();
  notifyReaderPresenter({ kind: "rerender" });
  void ensureAsrTranslation("translate");
}
