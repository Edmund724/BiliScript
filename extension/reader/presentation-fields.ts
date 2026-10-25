// Reader 呈现属性单一事实源（候选06 属性表半边）。
//
// 「阅读模式开着 + 排版设置」由一组 data-biliscript-reader-* / data-biliscript-reading-* 页面
// 属性表达。本表是这些清单的唯一声明处，五个消费方一律从表派生；「真实差异」用字段标志
// （clearOnClose / clearOnGuard / watchedByGuard）显式化，不再靠各处手抄对齐。
//
// 纯常量模块：零运行时 import（仅 type-only import），readValue 是注入 reader 状态
// 对象的纯函数。content / pages / reader 任意侧都可安全 import，无循环依赖。

import type { KnownSettingKey } from "../core/defaults.js";
import type { ReaderState } from "../core/state.js";

export type ReaderPresentationFieldKind =
  | "presentation"
  | "enter-flag"
  | "view-flag";

export interface ReaderPresentationTargets {
  html: string | null;
  body: string | null;
  readingView: string | null;
}

export interface ReaderPresentationField {
  id: string;
  kind: ReaderPresentationFieldKind;
  targets: ReaderPresentationTargets;
  datasetKeys: ReaderPresentationTargets;
  storageKey: KnownSettingKey | null;
  legacyStorageKey: KnownSettingKey | null;
  watchedByGuard: boolean;
  clearOnGuard: boolean;
  clearOnClose: boolean;
  clearViewOnClose: boolean;
  writtenByApply: boolean;
  readValue: ((reader: ReaderState) => string) | null;
}

// ===== 字段条目各键的含义 =====
//   id              逻辑名（表内唯一），也是 readValue/派生清单的关联键。
//   kind            字段归属：
//                     "presentation" 排版设置属性（storage 设置驱动，
//                                    applyReadingViewPresentation 写入）；
//                     "enter-flag"   进入标记（mode / reading-active，由组合根
//                                    content.js、message-handler.js 与
//                                    enterReaderMode 写入，apply 不负责）；
//                     "view-flag"    视图内同步标志（follow / ready）。
//   targets         作用目标 → 该目标上的连字符属性名；不在该目标落位为 null。
//                     html = documentElement，body = document.body，
//                     readingView = #biliscript-reading-view（短名属性）。
//   datasetKeys     与 targets 同序的 dataset 驼峰键（attr 去掉 "data-" 转驼峰；
//                   不变量测试会校验两者一致，防手抄漂移）。
//   storageKey      对应 chrome.storage 设置键（无则 null）。
//   legacyStorageKey 旧版设置键：settings-store 仍会归一化/落盘它（兼容旧存
//                   储数据），storage 监听需继续覆盖（无则 null）。
//   watchedByGuard  守卫 observer（page-state.bindNormalPageStateGuard）是否把
//                   该属性列入 attributeFilter（守卫只 observe html/body）。
//   clearOnGuard    守卫清理（clearReaderModePageState，含启动时非阅读页收敛）
//                   是否移除该属性。
//   clearOnClose    closeReadingView 是否移除该属性的页面级落位（html/body）。
//                   close 与守卫清理的范围差由本标志与 clearOnGuard 的组合
//                   显式声明。
//   clearViewOnClose  readingView 上的短名镜像是否随 close 清除。排版字段的
//                   短名镜像不清：#biliscript-reading-view 是常驻模板壳，close 只把
//                   它复位到关闭基线（class/aria/ready），短名属性由下次 open
//                   的 apply 全量重写，且无任何
//                   close→open 窗口期消费方；视图内标志 follow 则必须清。
//   writtenByApply  applyReadingViewPresentation 是否写入；为 true 时必须提供
//                   readValue，为 false 时 readValue 必须为 null。
//   readValue       (reader) => DOM 值：state.reader → 属性值的换算。只在
//                   writtenByApply 字段上存在，属「值怎么算」的呈现逻辑，
//                   随字段声明进表以免写入方再抄一份取值清单。
export const READER_PRESENTATION_FIELDS: ReaderPresentationField[] = [
  // —— 排版设置标量（顺序即 apply 的写入顺序）——
  {
    id: "theme",
    kind: "presentation",
    targets: { html: "data-biliscript-reader-theme", body: "data-biliscript-reader-theme", readingView: "data-theme" },
    datasetKeys: { html: "biliscriptReaderTheme", body: "biliscriptReaderTheme", readingView: "theme" },
    storageKey: "readerTheme",
    legacyStorageKey: null,
    watchedByGuard: true,
    clearOnGuard: true,
    clearOnClose: true,
    clearViewOnClose: false,
    writtenByApply: true,
    readValue: (reader) => reader.readingTheme
  },
  // —— 排版设置标量：外观色板（与明暗正交；flyme 蓝雾玻璃 | editorial 数字刊物）——
  {
    id: "palette",
    kind: "presentation",
    targets: { html: "data-biliscript-reader-palette", body: "data-biliscript-reader-palette", readingView: "data-palette" },
    datasetKeys: { html: "biliscriptReaderPalette", body: "biliscriptReaderPalette", readingView: "palette" },
    storageKey: "readerPalette",
    legacyStorageKey: null,
    watchedByGuard: true,
    clearOnGuard: true,
    clearOnClose: true,
    clearViewOnClose: false,
    writtenByApply: true,
    readValue: (reader) => reader.readingPalette
  },
  // —— 进入标记：apply 不写（组合根/enterReaderMode 写 "1"），close/守卫都清 ——
  {
    id: "mode",
    kind: "enter-flag",
    targets: { html: "data-biliscript-reader-mode", body: "data-biliscript-reader-mode", readingView: null },
    datasetKeys: { html: "biliscriptReaderMode", body: "biliscriptReaderMode", readingView: null },
    storageKey: null,
    legacyStorageKey: null,
    watchedByGuard: true,
    clearOnGuard: true,
    clearOnClose: true,
    clearViewOnClose: false,
    writtenByApply: false,
    readValue: null
  },
  {
    id: "readingActive",
    kind: "enter-flag",
    // 变体前缀 data-biliscript-reading-*（非 reader-*），只在 body 上（CSS 隐藏
    // 播放器原生字幕层依赖它）。
    targets: { html: null, body: "data-biliscript-reading-active", readingView: null },
    datasetKeys: { html: null, body: "biliscriptReadingActive", readingView: null },
    storageKey: null,
    legacyStorageKey: null,
    watchedByGuard: true,
    clearOnGuard: true,
    clearOnClose: true,
    clearViewOnClose: false,
    writtenByApply: false,
    readValue: null
  },
  // —— 视图内同步标志：守卫不感知（非页面级状态），仅 close 时清 ——
  {
    id: "follow",
    kind: "view-flag",
    targets: { html: null, body: null, readingView: "data-biliscript-reader-follow" },
    datasetKeys: { html: null, body: null, readingView: "biliscriptReaderFollow" },
    storageKey: null,
    legacyStorageKey: null,
    watchedByGuard: false,
    clearOnGuard: false,
    clearOnClose: true,
    // readingView 短名镜像随 close 清除
    clearViewOnClose: true,
    // 写入方是 sync.updateReaderFollowState（auto/off/manual）。
    writtenByApply: false,
    readValue: null
  },
  // —— 视图就绪态：常驻模板壳基线标志（模板初值 "0"，enter 时置 "1"，close 时复位 "0"）——
  // 目标 readingView，写：ui-renderer 模板初值 "0" + lifecycle.ts（openReaderViewShell /
  // setReadingViewReady 写 "1"、closeReadingView 复位 "0"）；读：shell.ts 完好性判据 +
  // reader.css / reader-gate.css 门控。清理责任：close 复位基线值 "0" 而非 removeAttribute
  //（clearViewOnClose 为 false）。
  {
    id: "ready",
    kind: "view-flag",
    targets: { html: null, body: null, readingView: "data-biliscript-reader-ready" },
    datasetKeys: { html: null, body: null, readingView: "biliscriptReaderReady" },
    storageKey: null,
    legacyStorageKey: null,
    watchedByGuard: false,
    clearOnGuard: false,
    clearOnClose: false,
    clearViewOnClose: false,
    writtenByApply: false,
    readValue: null
  }
];

// 无 DOM 属性落位、但需经阅读域 storage 监听触发跨上下文同步的设置键。
export const READER_SYNCED_SETTING_KEYS: readonly KnownSettingKey[] = Object.freeze([
  "enablePlayerAiQuickAction",
  "playerAiQuickPrompt",
  "bilingualSubtitles",
  "secondarySubtitleLang",
  "readerFontSizeScale",
  "chatLineHeight",
  "chatParagraphSpacing",
  "chatInputGlow"
]);

// 按标志 × 作用目标派生连字符属性名清单（模块顶层计算一次的常量）。
// readingView 列额外要求 clearViewOnClose：clearOnGuard/clearOnClose 表达的是
// 页面级（html/body）清理职责，readingView 短名镜像是否随清理删除由
// clearViewOnClose 单独把关（守卫永不触碰视图，其 readingView 列因此恒空）。
// flag 省略时返回主表各目标的全部声明属性。
export type AttrFlag = "clearOnClose" | "clearOnGuard" | "watchedByGuard";
export type AttrTarget = "html" | "body" | "readingView";

export function collectAttrsByTarget(flag?: AttrFlag): Record<AttrTarget, string[]> {
  const result: Record<AttrTarget, string[]> = { html: [], body: [], readingView: [] };
  for (const field of READER_PRESENTATION_FIELDS) {
    for (const target of ["html", "body", "readingView"] as AttrTarget[]) {
      if (!field.targets[target]) {
        continue;
      }
      if (flag) {
        if (!field[flag]) {
          continue;
        }
        if (target === "readingView" && !field.clearViewOnClose) {
          continue;
        }
      }
      result[target].push(field.targets[target]!);
    }
  }
  return result;
}

// closeReadingView 的移除清单（lifecycle.js 从此派生，不再手抄）。
export const READER_CLOSE_ATTRS = collectAttrsByTarget("clearOnClose");

// 守卫清理（clearReaderModePageState）的移除清单（page-state.js 从此派生）。
export const READER_GUARD_CLEAR_ATTRS = collectAttrsByTarget("clearOnGuard");

// 守卫 observer 的 attributeFilter（page-state.js 从此派生）。
export const READER_GUARD_FILTER = collectAttrsByTarget("watchedByGuard");

// 视图就绪态属性名（由主表 ready 字段派生，shell.ts 完好性判据等消费）。
export const READER_READY_ATTR: string =
  READER_PRESENTATION_FIELDS.find((field) => field.id === "ready")?.targets.readingView ??
  "data-biliscript-reader-ready";

// applyReadingViewPresentation 的写入字段子表（presentation.js 从此派生）。
export const READER_APPLY_FIELDS = READER_PRESENTATION_FIELDS.filter(
  (field) => field.writtenByApply
);

// storage 变更监听键全集：呈现字段的 storageKey/legacyStorageKey ∪ READER_SYNCED_SETTING_KEYS。
export const READER_SETTINGS_WATCH_KEYS: string[] = [
  ...new Set([
    ...READER_PRESENTATION_FIELDS.flatMap(
      (field): (string | null)[] => [field.storageKey, field.legacyStorageKey]
    ).filter((key): key is string => Boolean(key)),
    ...READER_SYNCED_SETTING_KEYS
  ])
];

// 有意不入主表的同前缀局部标志：不参与呈现属性契约的临时/局部标记，由本清单
// 统一登记防漂移。
// 源码扫描测试据此放行；新增 data-biliscript-* 属性字面量必须要么进主表、要么进本清单。
export const LOCAL_FLAG_ATTRIBUTES = new Set([
  "data-biliscript-reader-hide-sending-bar"  // close 时瞬时隐藏 B 站发送条（写入/清除同在 lifecycle）
]);
