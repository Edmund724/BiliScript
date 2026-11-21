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

export const REGISTRATION_FACES = [
  "preset",
  "catalog",
  "protocolEndpoints",
  "quirks",
  "messagesExits",
  "buildOrder"
] as const;
export type RegistrationFace = (typeof REGISTRATION_FACES)[number];

export const MESSAGES_EXIT_CELLS = ["tier", "off", "on"] as const;
export type MessagesExitCellId = (typeof MESSAGES_EXIT_CELLS)[number];

export type RegistrationStatus =
  | "registered"
  | "intentional-gap"
  | "missing"
  | "not-applicable"
  | "unchecked";

const DEFAULT_PROTOCOL: AiProtocol = "openai";

export interface ProtocolEndpointState {
  protocol: AiProtocol;
  source: "explicit" | "base-url" | "none";
  endpoint: string;
  fallbackRepeatsV1: boolean;
}

export interface MessagesExitCellState {
  cell: MessagesExitCellId;
  status: RegistrationStatus;
  kind?: MessagesTierExitKind | MessagesOffExitKind | MessagesOnExitKind;
  provenance?: MessagesExitProvenance;
  detail: string;
}

export interface RegistrationFaceState {
  face: RegistrationFace;
  status: RegistrationStatus;
  detail: string;
  catalogProvider?: string;
  endpoints?: readonly ProtocolEndpointState[];
  quirks?: readonly CompatQuirk[];
  cells?: readonly MessagesExitCellState[];
  buildOrderIndex?: number;
}

export interface RegistrationDebt {
  face: RegistrationFace;
  cell?: MessagesExitCellId;
  detail: string;
}

export interface PresetRegistrationView {
  platformId: string;
  name: string;
  isPreset: boolean;
  faces: readonly RegistrationFaceState[];
  debts: readonly RegistrationDebt[];
  ok: boolean;
}

export interface RegistrationOrphan {
  face: RegistrationFace;
  key: string;
  detail: string;
}

export interface RegistrationCoverageReport {
  rows: readonly PresetRegistrationView[];
  orphans: readonly RegistrationOrphan[];
}

export interface RegistrationViewSources {
  presets?: readonly AiProviderPreset[];
  noCatalogPresets?: readonly string[];
  platformQuirks?: Readonly<Record<string, readonly CompatQuirk[]>>;
  messagesTierExit?: Readonly<Record<string, MessagesTierExitCell>>;
  messagesOffExit?: Readonly<Record<string, MessagesOffExitCell>>;
  messagesOnExit?: Readonly<Record<string, MessagesOnExitCell>>;
  platformKeys?: readonly string[];
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

function hasOwn(table: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, key);
}

function repeatsV1(baseUrl: string): boolean {
  return /\/v1$/.test(baseUrl);
}

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
      fallbackRepeatsV1: protocol === "anthropic" ? repeatsV1(preset.baseUrl) : false
    };
  });

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
