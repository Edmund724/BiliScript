import { clipState } from "../core/state.js";
import type { NoSubtitleReason, SubtitleBodyItem } from "../core/state.js";

/**
 * 主轨身份元数据
 */
export interface SubtitleTrackIdentity {
  id: string;
  url: string;
  lang: string;
}

/**
 * 副轨身份元数据（副轨不记录 lang）
 */
export interface SecondarySubtitleTrackIdentity {
  id: string;
  url: string;
}

/**
 * 换片复位选项
 */
export interface ClearAllOptions {
  keepFetchState?: boolean;
}

/**
 * 主轨：安装字幕
 * 写入所选轨三元组身份、正文、并将 fetchState 置为 ready，同时清空 noSubtitle 原因与详情。
 * 遵循隔离不变量：绝不修改 secondarySubtitle。
 */
export function install(identity: SubtitleTrackIdentity, body: SubtitleBodyItem[]): void {
  clipState.setSelectedSubtitleId(identity.id);
  clipState.setSelectedSubtitleUrl(identity.url);
  clipState.setSelectedSubtitleLang(identity.lang);
  clipState.setSubtitleBody(body);
  clipState.setSubtitleFetchState("ready");
  clipState.setNoSubtitleReason(null);
  clipState.setNoSubtitleDetail("");
}

/**
 * 主轨：置为空字幕态
 * 清空主轨选中三元组与 body，将 fetchState 置为 empty。
 * 若提供了 reason（含 null），则写入 noSubtitleReason；若缺省（undefined）则保留原值。
 * 遵循 05 票不变量：仅重置主轨字段，绝对不清副轨槽（secondarySubtitle 保持原状）。
 */
export function clearToEmpty(reason?: NoSubtitleReason): void {
  clipState.setSelectedSubtitleId("");
  clipState.setSelectedSubtitleUrl("");
  clipState.setSelectedSubtitleLang("");
  clipState.setSubtitleBody([]);
  clipState.setSubtitleFetchState("empty");
  if (reason !== undefined) {
    clipState.setNoSubtitleReason(reason);
  }
}

/**
 * 副轨：安装双语副轨字幕
 * 写入副轨身份、已排序 body、并将副轨 state 置为 ready。
 * 遵循隔离不变量：副轨动词绝不触碰主轨 selected*、subtitleFetchState、noSubtitle*。
 */
export function installSecondary(identity: SecondarySubtitleTrackIdentity, body: SubtitleBodyItem[]): void {
  clipState.applySecondarySubtitle({
    id: identity.id,
    url: identity.url,
    body
  });
}

/**
 * 副轨：标记副轨为装载中
 * 乐观写入目标副轨身份，清空副轨正文，置副轨 state 为 loading。
 * 遵循隔离不变量：绝不触碰主轨状态。
 */
export function markSecondaryLoading(target: SecondarySubtitleTrackIdentity): void {
  clipState.markSecondarySubtitleLoading({
    id: target.id,
    url: target.url
  });
}

/**
 * 副轨：标记副轨装载失败
 * 保留已有目标轨身份（供界面显示哪条语言失败），清空副轨正文，置副轨 state 为 error。
 * 遵循隔离不变量：绝不触碰主轨状态。
 */
export function markSecondaryError(): void {
  clipState.markSecondarySubtitleError();
}

/**
 * 副轨：清空副轨槽
 * 将副轨复位为空槽（state: idle, id: "", url: "", body: []）。
 * 遵循隔离不变量：绝不触碰主轨状态。
 */
export function clearSecondary(): void {
  clipState.clearSecondarySubtitle();
}

/**
 * 统一：切视频全量清空字幕槽
 * 主副轨同清（清空 selected*、subtitleBody、secondarySubtitle、noSubtitleReason、noSubtitleDetail）。
 * 若 options.keepFetchState 为 true，保留现有 subtitleFetchState；否则重置为 idle。
 */
export function clearAllForVideoSwitch(options?: ClearAllOptions): void {
  clipState.setSelectedSubtitleId("");
  clipState.setSelectedSubtitleUrl("");
  clipState.setSelectedSubtitleLang("");
  clipState.setSubtitleBody([]);
  clearSecondary();
  if (!options?.keepFetchState) {
    clipState.setSubtitleFetchState("idle");
  }
  clipState.setNoSubtitleReason(null);
  clipState.setNoSubtitleDetail("");
}

export const slot = {
  install,
  clearToEmpty,
  installSecondary,
  markSecondaryLoading,
  markSecondaryError,
  clearSecondary,
  clearAllForVideoSwitch
};
