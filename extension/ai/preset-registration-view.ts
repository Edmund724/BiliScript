// ai/preset-registration-view.ts — 预设登记覆盖视图（**只读派生**，消费者 = 测试与
// 「新增平台」自查；不进请求执行路径）。
//
// 回答一个问题：**这个 presetId（或全部平台）在各登记面还欠哪些登记**。
//
// 现状摩擦（本视图要消灭的）：新增一个 AI 平台要登记 6 处——PRESETS 一行、
// NO_CATALOG_PRESETS 白名单、构建期 UPSTREAM_PRESET_ORDER（scripts/）、三张
// Messages 逐格出口表、PLATFORM_QUIRKS、以及测试里的手抄 id 清单；三套键空间
// （presetId / catalogProvider / 平台身份）各有注册表，没有任何一处答得出「这个
// 预设还欠哪些登记」——齐不齐只有测试期逐表对账知道，漏登记表现为运行期行为退化
// （走表外兜底：裸 effort / 原生开关）而不是装配失败。
// **候选 6 之后**：出口表这一面已由类型接管——四张平台键表都以 `Record<PlatformKey, …>`
// 索引，新增预设漏配平台身份（本视图 messagesExits 面报出的那一笔）在**装配期**就是 tsc 红，
// 不再落到运行期兜底。本视图从此只投影现状（含假设新增平台的自查），不再承担键集判据。
//
// **只读派生，不搬事实主人**：事实仍在各表自己那里，本模块只查、不复制、不改写——
//   - 目录身份：core/presets.ts 的 PRESETS[].catalogProvider 与 NO_CATALOG_PRESETS；
//   - 协议端点：PRESETS[].protocolBaseUrls（+ 默认协议的 baseUrl 回落）；
//   - 怪癖：compat-vocab 的 PLATFORM_QUIRKS（稀疏声明面）；
//   - 出口表格子：thinking-wire-map 的 MESSAGES_TIER_EXIT / MESSAGES_OFF_EXIT /
//     MESSAGES_ON_EXIT（含各格 kind 与 provenance，逐格原样带出）；
//   - 平台身份键空间：词表叶 ai/platform-identity-vocab.ts 的键——PROVIDERS 与三张出口表
//     都以 `Record<PlatformKey, …>` 索引（架构评审候选 6），本视图读 `Object.keys(PROVIDERS)`
//     拿到的就是同一键集（键集不再靠运行期对账）；
//   - 构建期序位：scripts/models-dev-upstream-providers.mjs 的 UPSTREAM_PRESET_ORDER
//     ——本模块**不 import scripts/**（构建期脚本不进 extension 依赖图），由调用方注入；
//     未注入 = 该面 `unchecked`，不许被 falsy 默认吞成「已登记」。
//
// **键空间不合并**（混用即误报）：三张出口表按 **平台身份键空间**判（表键由 `Record<PlatformKey, …>`
// 编译期封闭 = PROVIDERS 键集），PLATFORM_QUIRKS 按**自有键**判（稀疏面，PROVIDERS ⊋ PLATFORM_QUIRKS——
// 反例 siliconflow：有思考档位、无怪癖声明），目录身份按**预设 id**判。三套键空间各有
// 差集（PRESETS ∌ siliconflow / PROVIDERS ∌ custom），逐一在视图里如实呈现。
//
// **候选 6 之后本视图只投影、不再承担键集判据**：真实四张表的键集由类型封闭（缺一格 / 孤儿键
// 都是 tsc 红），故「真实表缺格」这一支已不可达；这里保留的缺格 / 孤儿判据只服务**注入源**——
// 「假设新增一个平台」的自查（注入 presets/platformKeys）与过期形状用例，仍必须如实报出。
//
// **不进请求链、不拉进 SW 静态图**：本模块无人静态引用（用例钉住）；它引用的
// thinking-profiles / thinking-wire-map 本来就在 scripts/build.js 的
// BACKGROUND_FORBIDDEN_STATIC_SOURCES 里，任何把本模块拉进 SW 静态图的 import
// 都会在那里 fail fast（别引用它）。
//
// **红线（ADR-0013 / 0014）**：不让 protocol 参与任何事实查表——协议只出现在
// 「端点登记面」的现状列举里；不按协议拆档位事实（三张出口表原样带出，不做第二套
// 推导）；不把构建期产物/目录接进请求链。视图本身零缓存（每次调用现查），不持有
// 任何快照——它不可能是第二份事实。

import { AI_PROTOCOLS, type AiProtocol } from "./protocol-vocab.js";
import { NO_CATALOG_PRESETS, PRESETS, type AiProviderPreset } from "../core/presets.js";
import { PLATFORM_QUIRKS, type CompatQuirk } from "./compat-vocab.js";
import { PROVIDERS } from "./thinking-profiles.js";
import {
  MESSAGES_OFF_EXIT,
  MESSAGES_ON_EXIT,
  MESSAGES_TIER_EXIT,
  type MessagesExitProvenance,
  type MessagesOffExitCell,
  type MessagesOffExitKind,
  type MessagesOnExitCell,
  type MessagesOnExitKind,
  type MessagesTierExitCell,
  type MessagesTierExitKind
} from "./thinking-wire-map.js";

// ===== 面 / 格 / 状态词汇（封闭清单，视图自己的键空间）=====

/** 六个登记面（顺序即报告里的稳定序）。新增一个事实表 = 在此登记一面。 */
export const REGISTRATION_FACES = [
  "preset",
  "catalog",
  "protocolEndpoints",
  "quirks",
  "messagesExits",
  "buildOrder"
] as const;
export type RegistrationFace = (typeof REGISTRATION_FACES)[number];

/** messagesExits 面内的三张出口表（键集：`Record<PlatformKey, …>` 封闭 = 平台身份键空间）。 */
export const MESSAGES_EXIT_CELLS = ["tier", "off", "on"] as const;
export type MessagesExitCellId = (typeof MESSAGES_EXIT_CELLS)[number];

// 面 / 格状态四态 + 未对账，语义**互不吞并**（不许用 falsy 默认把「未研究过」读成
// 「已声明」，与三张出口表自己的四态纪律同款）：
//   registered       = 已登记（事实表里有这一格 / 这一面有确定答案）；
//   intentional-gap  = 有意缺口：本面存在，但本平台按既有设计在表外（表外兜底 /
//                      用户自填端点），**不是欠账**；
//   missing          = 欠账：本面要求本平台有登记，事实表里没有；
//   not-applicable   = 该面对本行无要求（非预设平台无目录身份；无 catalogProvider
//                      不进上游产物序位）；
//   unchecked        = 事实源未注入，本面未对账（构建期序位）——不是欠账，但**绝不
//                      等于已登记**。
export type RegistrationStatus =
  | "registered"
  | "intentional-gap"
  | "missing"
  | "not-applicable"
  | "unchecked";

// 协议缺省（AiProviderPreset.protocol 缺省即 openai，resolveAdapter 同样兜底）：
// 只有默认协议的端点来自 baseUrl；其余协议须由 protocolBaseUrls 显式登记端点。
const DEFAULT_PROTOCOL: AiProtocol = "openai";

// ===== 出参形状 =====

/** 逐协议端点现状（端点组装约定见 adapters/anthropic.ts：`${baseUrl}/v1/messages`）。 */
export interface ProtocolEndpointState {
  protocol: AiProtocol;
  /** explicit = protocolBaseUrls 显式登记；base-url = 默认协议直接吃 baseUrl；none = 无端点。 */
  source: "explicit" | "base-url" | "none";
  /** 有效端点（source="none" 时为空串）。 */
  endpoint: string;
  /**
   * 回落 baseUrl 会不会把路径拼重（baseUrl 以 `/v1` 结尾且该协议未显式登记时，
   * 按端点约定会拼出 `/v1/v1/messages`）。只判 `/v1` 重复这一类——不重造适配器的
   * 端点组装实现（那件事的主人仍是 adapters/）。
   */
  fallbackRepeatsV1: boolean;
}

/** 一张出口表里的一格。 */
export interface MessagesExitCellState {
  cell: MessagesExitCellId;
  status: RegistrationStatus;
  /** 格里的出口形态（表内格才有；表外兜底与欠账格没有）。 */
  kind?: MessagesTierExitKind | MessagesOffExitKind | MessagesOnExitKind;
  /** 该格的出处（表内格才有；原样带出，不重算）。 */
  provenance?: MessagesExitProvenance;
  detail: string;
}

export interface RegistrationFaceState {
  face: RegistrationFace;
  status: RegistrationStatus;
  /** 人读现状：已登记时指出登了什么，欠账时指出缺什么、为什么算缺。 */
  detail: string;
  /** catalog 面：登记的上游 provider id。 */
  catalogProvider?: string;
  /** protocolEndpoints 面：逐协议现状。 */
  endpoints?: readonly ProtocolEndpointState[];
  /** quirks 面：本平台声明的怪癖键（空数组 = 合法地不声明）。 */
  quirks?: readonly CompatQuirk[];
  /** messagesExits 面：三张出口表的逐格状态。 */
  cells?: readonly MessagesExitCellState[];
  /** buildOrder 面：在构建期序位里的下标（0 起；已登记才有）。 */
  buildOrderIndex?: number;
}

export interface RegistrationDebt {
  face: RegistrationFace;
  /** messagesExits 的欠账定位到具体哪张表。 */
  cell?: MessagesExitCellId;
  detail: string;
}

export interface PresetRegistrationView {
  /** 平台 id：预设 id，或只作为平台身份存在的键（如 siliconflow）。 */
  platformId: string;
  /** PRESETS 行里的展示名；非预设为空串。 */
  name: string;
  isPreset: boolean;
  /** 恰好 REGISTRATION_FACES 条、按该顺序。 */
  faces: readonly RegistrationFaceState[];
  /** 欠账清单（status="missing" 的面 / 格）；空 = 登记齐全。 */
  debts: readonly RegistrationDebt[];
  /** debts 为空。unchecked / intentional-gap / not-applicable 都不算欠账。 */
  ok: boolean;
}

/** 登记表里有、但不属于任何已知平台键的键（手滑打错 / 平台被删后的死格）。 */
export interface RegistrationOrphan {
  face: RegistrationFace;
  key: string;
  detail: string;
}

export interface RegistrationCoverageReport {
  /** 逐平台行：PRESETS 序 + 追加非预设的平台身份键（稳定序）。 */
  rows: readonly PresetRegistrationView[];
  orphans: readonly RegistrationOrphan[];
}

// ===== 事实源（默认 = 各表真身；注入只为测试与「假设新增一个平台」的自查）=====
// 每个字段缺省即读该事实表的真身；注入副本不改任何事实主人。
export interface RegistrationViewSources {
  presets?: readonly AiProviderPreset[];
  noCatalogPresets?: readonly string[];
  platformQuirks?: Readonly<Record<string, readonly CompatQuirk[]>>;
  messagesTierExit?: Readonly<Record<string, MessagesTierExitCell>>;
  messagesOffExit?: Readonly<Record<string, MessagesOffExitCell>>;
  messagesOnExit?: Readonly<Record<string, MessagesOnExitCell>>;
  /**
   * 平台身份键空间（默认 = PROVIDERS 的键；三张出口表的键集判据源 = 词表叶 PlatformKey）。
   * 只用于**注入源**的对账（假设新增平台 / 过期形状用例）；真实表的键集由类型封闭。
   */
  platformKeys?: readonly string[];
  /** 构建期序位（默认未注入 → buildOrder 面 unchecked）。 */
  buildOrder?: readonly string[];
}

interface ResolvedSources {
  presets: readonly AiProviderPreset[];
  noCatalogPresets: readonly string[];
  platformQuirks: Readonly<Record<string, readonly CompatQuirk[]>>;
  messagesTierExit: Readonly<Record<string, MessagesTierExitCell>>;
  messagesOffExit: Readonly<Record<string, MessagesOffExitCell>>;
  messagesOnExit: Readonly<Record<string, MessagesOnExitCell>>;
  platformKeys: readonly string[];
  buildOrder: readonly string[] | undefined;
}

// 每次调用现解析（视图零缓存：事实表改了，下一次查询必须跟着变——读到过期形状的
// 唯一来源就是在这里存快照，所以这里不存）。
function resolveSources(sources: RegistrationViewSources): ResolvedSources {
  return {
    presets: sources.presets ?? PRESETS,
    noCatalogPresets: sources.noCatalogPresets ?? NO_CATALOG_PRESETS,
    platformQuirks: sources.platformQuirks ?? PLATFORM_QUIRKS,
    messagesTierExit: sources.messagesTierExit ?? MESSAGES_TIER_EXIT,
    messagesOffExit: sources.messagesOffExit ?? MESSAGES_OFF_EXIT,
    messagesOnExit: sources.messagesOnExit ?? MESSAGES_ON_EXIT,
    platformKeys: sources.platformKeys ?? Object.keys(PROVIDERS),
    buildOrder: sources.buildOrder
  };
}

// 原型链上的键不算表内格（与 messagesOffExitCell / isQuirkPlatform 同款判据）。
function hasOwn(table: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, key);
}

function repeatsV1(baseUrl: string): boolean {
  return /\/v1$/.test(baseUrl);
}

// ===== 六个面 =====

function presetFace(preset: AiProviderPreset | undefined): RegistrationFaceState {
  if (!preset) {
    return {
      face: "preset",
      status: "not-applicable",
      detail: "非 PRESETS 预设：本键只作为平台身份存在（host 兜底识别用，用户不能选中它）"
    };
  }
  return {
    face: "preset",
    status: "registered",
    detail: `PRESETS 已登记（name=${preset.name}；baseUrl=${preset.baseUrl || "（空，用户自填）"}）`
  };
}

function catalogFace(
  preset: AiProviderPreset | undefined,
  sources: ResolvedSources
): RegistrationFaceState {
  if (!preset) {
    return { face: "catalog", status: "not-applicable", detail: "非预设无目录身份" };
  }
  const provider = preset.catalogProvider;
  const whitelisted = sources.noCatalogPresets.includes(preset.id);
  if (provider && whitelisted) {
    return {
      face: "catalog",
      status: "missing",
      catalogProvider: provider,
      detail: `既登记 catalogProvider=${provider} 又在 NO_CATALOG_PRESETS 白名单：两个登记面互相矛盾（白名单 = 有意无目录）`
    };
  }
  if (provider) {
    return {
      face: "catalog",
      status: "registered",
      catalogProvider: provider,
      detail: `catalogProvider=${provider}（preset → 上游 provider 的单源登记）`
    };
  }
  if (whitelisted) {
    return {
      face: "catalog",
      status: "registered",
      detail: "在无上游身份白名单 NO_CATALOG_PRESETS（有意无目录：查表静默降级，不回落猜测值）"
    };
  }
  return {
    face: "catalog",
    status: "missing",
    detail: "既无 catalogProvider 又不在 NO_CATALOG_PRESETS 白名单：新增预设漏配目录身份"
  };
}

function endpointsFace(preset: AiProviderPreset | undefined): RegistrationFaceState {
  if (!preset) {
    return {
      face: "protocolEndpoints",
      status: "not-applicable",
      detail: "非预设无端点登记面（端点由用户记录提供）"
    };
  }
  const explicit = preset.protocolBaseUrls ?? {};
  const endpoints: ProtocolEndpointState[] = AI_PROTOCOLS.map((protocol) => {
    const registered = explicit[protocol];
    if (registered) {
      return { protocol, source: "explicit", endpoint: registered, fallbackRepeatsV1: false };
    }
    if (!preset.baseUrl) {
      return { protocol, source: "none", endpoint: "", fallbackRepeatsV1: false };
    }
    return {
      protocol,
      source: "base-url",
      endpoint: preset.baseUrl,
      fallbackRepeatsV1: protocol === DEFAULT_PROTOCOL ? false : repeatsV1(preset.baseUrl)
    };
  });

  // baseUrl 为空 = 用户自填端点预设（本仓只有 custom）：端点登记面本就无从登记，
  // 是有意缺口而不是欠账。
  if (!preset.baseUrl && Object.keys(explicit).length === 0) {
    return {
      face: "protocolEndpoints",
      status: "intentional-gap",
      endpoints,
      detail: "baseUrl 为空（用户自填端点预设）：协议端点无从登记，按有意缺口处理"
    };
  }

  const hazardous = endpoints.filter(
    (state) => state.source === "none" || state.fallbackRepeatsV1
  );
  if (hazardous.length === 0) {
    return {
      face: "protocolEndpoints",
      status: "registered",
      endpoints,
      detail: `端点已登记：${endpoints.map((state) => `${state.protocol}=${state.endpoint}（${state.source}）`).join("；")}`
    };
  }
  return {
    face: "protocolEndpoints",
    status: "missing",
    endpoints,
    detail:
      "端点欠登记：" +
      hazardous
        .map((state) =>
          state.source === "none"
            ? `${state.protocol} 无端点（baseUrl 为空且未显式登记）`
            : `${state.protocol} 未登记 protocolBaseUrls.${state.protocol}，回落 baseUrl（以 /v1 结尾）会拼出 /v1/v1/messages`
        )
        .join("；")
  };
}

function quirksFace(
  platformId: string,
  preset: AiProviderPreset | undefined,
  sources: ResolvedSources
): RegistrationFaceState {
  const declared = hasOwn(sources.platformQuirks, platformId)
    ? sources.platformQuirks[platformId]
    : undefined;
  if (declared && declared.length > 0) {
    return {
      face: "quirks",
      status: "registered",
      quirks: [...declared],
      detail: `PLATFORM_QUIRKS 已声明 ${declared.length} 条：${declared.join(" / ")}`
    };
  }
  // 稀疏声明面：未列出的平台一律不开怪癖（词表的既有语义），空声明是合法答案。
  return {
    face: "quirks",
    status: "registered",
    quirks: [],
    detail: preset
      ? "未声明任何怪癖（合法：PLATFORM_QUIRKS 是稀疏声明面，未列出的平台一律不开）"
      : "未声明任何怪癖（合法；本键是非预设平台身份）"
  };
}

function messagesExitsFace(
  platformId: string,
  preset: AiProviderPreset | undefined,
  sources: ResolvedSources
): RegistrationFaceState {
  if (!sources.platformKeys.includes(platformId)) {
    // 不在平台身份键空间 = 三张表按表外兜底（裸 effort / 原生开关）。是欠账还是
    // 有意缺口，判据取自既有事实：无上游身份白名单成员（本仓只有 custom，它的
    // 注释写明「presetId 不携带平台身份，查表走 baseUrl host 兜底」）= 有意缺口。
    // 这一支只对**注入的假设新平台**可达：真实四张表的键集由 `Record<PlatformKey, …>` 封闭。
    const intentional = Boolean(preset) && sources.noCatalogPresets.includes(platformId);
    const cells: MessagesExitCellState[] = MESSAGES_EXIT_CELLS.map((cell) => ({
      cell,
      status: intentional ? "intentional-gap" : "missing",
      detail: intentional
        ? "表外兜底（无平台身份：平台 id 由 baseUrl host 决定），不是欠账"
        : "平台身份未登记：出口表键集 = PROVIDERS 键空间（类型封闭），本平台不在其中 → 运行期走表外兜底"
    }));
    return {
      face: "messagesExits",
      status: intentional ? "intentional-gap" : "missing",
      cells,
      detail: intentional
        ? "不在平台身份键空间（无上游身份白名单成员）：三张出口表按表外兜底，登记面有意留空"
        : "不在平台身份键空间（PROVIDERS 键集，由 Record<PlatformKey> 类型封闭）：三张出口表按表外兜底，登记面无从对账"
    };
  }

  // 三张表逐格查（表名只用于人读 detail；格本身原样带出，不重算 kind 与出处）。
  // 真实源走不到下面的 missing 支（键集由类型封闭）；该支只对**注入源**（假设新增平台 /
  // 过期形状用例）可达，故判据保留。
  const exitTables: ReadonlyArray<{
    cell: MessagesExitCellId;
    name: string;
    table: Readonly<Record<string, MessagesTierExitCell | MessagesOffExitCell | MessagesOnExitCell>>;
  }> = [
    { cell: "tier", name: "MESSAGES_TIER_EXIT", table: sources.messagesTierExit },
    { cell: "off", name: "MESSAGES_OFF_EXIT", table: sources.messagesOffExit },
    { cell: "on", name: "MESSAGES_ON_EXIT", table: sources.messagesOnExit }
  ];
  const cells: MessagesExitCellState[] = exitTables.map(({ cell, name, table }) => {
    const registered = hasOwn(table, platformId) ? table[platformId] : undefined;
    return registered === undefined
      ? {
          cell,
          status: "missing",
          detail: `${name} 无本平台格（真实表键集由 Record<PlatformKey> 类型封闭；缺格只可能来自注入源）`
        }
      : {
          cell,
          status: "registered",
          kind: registered.kind,
          provenance: registered.provenance,
          detail: `${name}.${platformId}：kind=${registered.kind}`
        };
  });
  const complete = cells.every((cell) => cell.status === "registered");
  return {
    face: "messagesExits",
    status: complete ? "registered" : "missing",
    cells,
    detail: complete
      ? `三张出口表逐格已登记（${cells.map((cell) => `${cell.cell}=${cell.kind}`).join(" / ")}，出处随格带出）`
      : `三张出口表有缺格：${cells
          .filter((cell) => cell.status === "missing")
          .map((cell) => cell.cell)
          .join(" / ")}`
  };
}

function buildOrderFace(
  preset: AiProviderPreset | undefined,
  sources: ResolvedSources
): RegistrationFaceState {
  if (sources.buildOrder === undefined) {
    return {
      face: "buildOrder",
      status: "unchecked",
      detail:
        "构建期序位未注入（UPSTREAM_PRESET_ORDER 在 scripts/models-dev-upstream-providers.mjs）：本面未对账，不得当作已登记"
    };
  }
  if (!preset) {
    return {
      face: "buildOrder",
      status: "not-applicable",
      detail: "非预设不进上游产物序位"
    };
  }
  if (!preset.catalogProvider) {
    return {
      face: "buildOrder",
      status: "not-applicable",
      detail: "无 catalogProvider：不进两份上游产物，序位无要求"
    };
  }
  const index = sources.buildOrder.indexOf(preset.id);
  if (index < 0) {
    return {
      face: "buildOrder",
      status: "missing",
      detail:
        "登记了 catalogProvider 但不在 UPSTREAM_PRESET_ORDER：两份上游产物会静默缺席（脚本自身 fail-loud 的同一条判据）"
    };
  }
  return {
    face: "buildOrder",
    status: "registered",
    buildOrderIndex: index,
    detail: `UPSTREAM_PRESET_ORDER 第 ${index + 1} 位（产物键序 = 01 UI 目录与 02 思考事实共用）`
  };
}

// ===== 组装 =====

function buildView(platformId: string, sources: ResolvedSources): PresetRegistrationView {
  const preset = sources.presets.find((item) => item.id === platformId);
  const faces: RegistrationFaceState[] = [
    presetFace(preset),
    catalogFace(preset, sources),
    endpointsFace(preset),
    quirksFace(platformId, preset, sources),
    messagesExitsFace(platformId, preset, sources),
    buildOrderFace(preset, sources)
  ];

  // 欠账：出口面精确到格，其余面一条。unchecked / intentional-gap / not-applicable
  // 都不进欠账清单（但要能在 faces 里看见——这就是五态分开的理由）。
  const debts: RegistrationDebt[] = [];
  for (const face of faces) {
    if (face.face === "messagesExits") {
      for (const cell of face.cells ?? []) {
        if (cell.status === "missing") {
          debts.push({ face: face.face, cell: cell.cell, detail: cell.detail });
        }
      }
      continue;
    }
    if (face.status === "missing") {
      debts.push({ face: face.face, detail: face.detail });
    }
  }

  return {
    platformId,
    name: preset?.name ?? "",
    isPreset: Boolean(preset),
    faces,
    debts,
    ok: debts.length === 0
  };
}

function collectOrphans(sources: ResolvedSources): RegistrationOrphan[] {
  const orphans: RegistrationOrphan[] = [];
  const presetIds = new Set(sources.presets.map((preset) => preset.id));
  const platformKeys = new Set(sources.platformKeys);

  for (const id of sources.noCatalogPresets) {
    if (!presetIds.has(id)) {
      orphans.push({
        face: "catalog",
        key: id,
        detail: "NO_CATALOG_PRESETS 里的 id 不是现存预设（白名单只收真实预设）"
      });
    }
  }

  for (const key of Object.keys(sources.platformQuirks)) {
    if (!presetIds.has(key)) {
      orphans.push({
        face: "quirks",
        key,
        detail: "PLATFORM_QUIRKS 声明了非预设平台（词表校验器 validateCompatVocab 的同一条判据）"
      });
    }
  }

  const exitTables: ReadonlyArray<[string, Readonly<Record<string, unknown>>]> = [
    ["tier", sources.messagesTierExit],
    ["off", sources.messagesOffExit],
    ["on", sources.messagesOnExit]
  ];
  for (const [tableName, table] of exitTables) {
    for (const key of Object.keys(table)) {
      if (!platformKeys.has(key)) {
        orphans.push({
          face: "messagesExits",
          key,
          detail: `${tableName} 表有格但不在平台身份键空间（反向违纪；真实表由 Record<PlatformKey> 类型挡下，此处只抓注入源）`
        });
      }
    }
  }

  for (const id of sources.buildOrder ?? []) {
    const preset = sources.presets.find((item) => item.id === id);
    if (!preset || !preset.catalogProvider) {
      orphans.push({
        face: "buildOrder",
        key: id,
        detail: "UPSTREAM_PRESET_ORDER 里的 preset 不是「登记了 catalogProvider 的现存预设」"
      });
    }
  }

  return orphans;
}

/**
 * 单个平台（presetId 或平台身份键）的登记覆盖视图。未知 id（既不是预设、也不在
 * 平台身份键空间）返回 null——查不到即 null，不回落猜测值。
 */
export function presetRegistrationView(
  platformId: string,
  sources: RegistrationViewSources = {}
): PresetRegistrationView | null {
  const resolved = resolveSources(sources);
  const id = String(platformId || "").trim();
  const known =
    resolved.presets.some((preset) => preset.id === id) || resolved.platformKeys.includes(id);
  return known ? buildView(id, resolved) : null;
}

/**
 * 全量枚举：逐平台行（PRESETS 序 + 追加非预设的平台身份键）+ 反向孤儿键。
 * 序稳定（行序由预设表序与平台身份键序决定，不受对象键序影响）。
 */
export function registrationCoverageReport(
  sources: RegistrationViewSources = {}
): RegistrationCoverageReport {
  const resolved = resolveSources(sources);
  const presetIds = resolved.presets.map((preset) => preset.id);
  const ids = [...presetIds, ...resolved.platformKeys.filter((key) => !presetIds.includes(key))];
  return {
    rows: ids.map((id) => buildView(id, resolved)),
    orphans: collectOrphans(resolved)
  };
}
