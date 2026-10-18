// 双语配对算法（bilingual-subtitles/04 号票的唯一实现）。
//
// 一条规则、两个方向共用（04 号票裁定）：
//   「副行 = 与主轨段**重叠时长 > 0** 的全部副轨段，按 `from` 升序、以空格拼接」。
//   主=原文时「2 主段 ↔ 1 副段」⇒ 相邻两行显示同一句译文（重复但诚实：折叠掉第二行
//   会让该段时间里屏幕上没有译文）；主=译文时「1 主段 ↔ 2 副段」⇒ 一行两句。
//
// 判据：半开区间 + 重叠时长**严格 > 0**——相邻段共享端点时零测度交集不算重叠，
// 因此**不需要容差窗口**（03 号票已证两轨端点无偏移：译文轨端点集合 ⊆ zh 端点集合）。
//
// 前置不变量：两轨 body 都按 `from` 升序（字幕接受事务统一经 sortSubtitleBodyByFrom
// 落 state）——本模块**只读、不做任何再排序**（04 号票）。副轨段的空/纯空白内容
// 不参与拼接（网络数据可能带空段）。
//
// 形态：`buildSecondaryAlignment(body)` 建一次索引，`query(main)` 每行 O(log m + k)，
// 供 1500+ 行的分批渲染逐行投影；**不要在每行重建索引**。带引用记忆的入口是
// `secondaryAlignmentFor(body)`（memo 核，见下方注释）；state 投影入口是
// `secondaryContentFor(main)`，渲染/搜索消费方自带 settings/slot 门控后经
// secondaryAlignmentFor 取同一份索引——配对索引全仓只有这一份。
//
// 双语关 / 副轨未就绪（loading / error / 空槽）⇒ 一律 `null`（渲染层据此折叠副行；
// 「译文加载中…」这类占位文案由渲染层出，**算法不出正文也不出占位**，06 号票）。
import { clipState, state } from "../core/state.js";
import type { SubtitleBodyItem } from "../core/state.js";

export interface AlignableMainSegment {
  from: number;
  to: number;
}

export interface SecondaryAlignment {
  query(main: AlignableMainSegment): string | null;
}

interface NormalizedSegment {
  from: number;
  to: number;
  content: string;
}

function normalizeSecondary(secondary: readonly SubtitleBodyItem[] | null | undefined): NormalizedSegment[] {
  const out: NormalizedSegment[] = [];
  for (const item of secondary || []) {
    const content = String(item?.content ?? "").trim();
    if (!content) {
      continue;
    }
    out.push({
      from: Number(item?.from ?? 0) || 0,
      to: Number(item?.to ?? 0) || 0,
      content
    });
  }
  return out;
}

export function buildSecondaryAlignment(secondary: readonly SubtitleBodyItem[] | null | undefined): SecondaryAlignment {
  const segments = normalizeSecondary(secondary);
  const froms = segments.map((segment) => segment.from);
  return {
    query(main: AlignableMainSegment): string | null {
      const mainFrom = Number(main?.from ?? 0) || 0;
      const mainTo = Number(main?.to ?? 0) || 0;
      // 脏数据（to <= from）不产生任何重叠
      if (!(mainTo > mainFrom)) {
        return null;
      }
      // 二分：最后一个 `from <= mainFrom` 的段（它可能从 main 起点之前就覆盖过来）。
      // 有序且互不重叠的假设下，更早的段必然在 mainFrom 之前就结束了。
      let left = 0;
      let right = froms.length;
      while (left < right) {
        const mid = (left + right) >> 1;
        if (froms[mid] <= mainFrom) {
          left = mid + 1;
        } else {
          right = mid;
        }
      }
      const parts: string[] = [];
      for (let index = Math.max(0, left - 1); index < segments.length && froms[index] < mainTo; index += 1) {
        const segment = segments[index];
        // 重叠时长严格 > 0：端点相接（零测度交集）不算重叠
        if (Math.min(segment.to, mainTo) > Math.max(segment.from, mainFrom)) {
          parts.push(segment.content);
        }
      }
      return parts.length ? parts.join(" ") : null;
    }
  };
}

// 配对索引的引用记忆（memo 核）：单槽，键 = 副轨 body 的**引用**——写路径经
// 事务整体替换引用（applySecondarySubtitle 整体落新数组），引用不变 ⇔ 内容不变。
// 同一引用复用同一份索引；交替传不同 body 会逐次重建（槽只有一个，旧引用的索引
// 不保留）。当前消费方（reader 渲染/搜索、下方投影、07 导出的派生内容）共读
// clipState.secondarySubtitle 的同一 slot.body 引用，无抖动。
let memoizedSecondaryBody: unknown = null;
let memoizedSecondaryAlignment: SecondaryAlignment | null = null;

// 自带引用记忆的取索引入口：消费方（reader/batched-render、reader/subtitle-search）
// 经它取索引，不各自抄一份缓存。
export function secondaryAlignmentFor(body: SubtitleBodyItem[]): SecondaryAlignment {
  if (memoizedSecondaryBody !== body || !memoizedSecondaryAlignment) {
    memoizedSecondaryAlignment = buildSecondaryAlignment(body);
    memoizedSecondaryBody = body;
  }
  return memoizedSecondaryAlignment;
}

// 读 state 的投影入口（06 号票的渲染/搜索、07 号票的导出都走它，不得另写一份配对）。
export function secondaryContentFor(main: AlignableMainSegment): string | null {
  if (!state.settings.bilingualSubtitles) {
    return null;
  }
  const slot = clipState.secondarySubtitle;
  if (!slot || slot.state !== "ready") {
    return null;
  }
  const body = slot.body;
  if (!Array.isArray(body) || body.length === 0) {
    return null;
  }
  return secondaryAlignmentFor(body).query(main);
}

// 渲染层入参形状（notes 域的宽松 item 形状的结构对偶，两边各声明、不互相 import——
// notes 叶子保持零 state 依赖是本注入的全部意义）。
export interface SecondaryLineSource {
  from?: unknown;
  to?: unknown;
}

export type SecondaryLineResolver = (item: SecondaryLineSource) => string | null;

// 给渲染层绑一个纯 `(item) => string | null`（07 号票：TXT / Markdown / SRT 的副行）。
// 消费点（派生内容重建 / 复制）构造一次传下去，配对口径仍是本模块唯一一份。
// **双语关 ⇒ 返回 undefined**：渲染层用 `secondaryFor?.(item)` 短路，单轨路径一次函数
// 调用都不多——这是 04 号票「双语关时算法零参与」的字面落地，也是「双语关输出与现状
// 逐字节相同」的零成本保证。副轨未就绪（loading / error / 空槽）由 secondaryContentFor
// 逐行判空 ⇒ 同样折叠，不会把占位文案写进导出。
export function createSecondaryLineResolver(): SecondaryLineResolver | undefined {
  if (!state.settings.bilingualSubtitles) {
    return undefined;
  }
  return (item) =>
    secondaryContentFor({
      from: Number(item?.from ?? 0) || 0,
      to: Number(item?.to ?? 0) || 0
    });
}
