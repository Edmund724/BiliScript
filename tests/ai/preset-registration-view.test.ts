// tests/ai/preset-registration-view.test.ts
// 预设登记覆盖视图（ai/preset-registration-view.ts）的单测。票面要求「先列失败方式
// 再实现」，逐条对应下面的 describe：
//   ① 漏登记面：视图只覆盖部分事实表 → 面清单封闭 + 每行恰好 6 面；
//   ② 欠账判定写反：齐全报欠、欠账报齐 → 正反用例（minimax 齐全 vs 合成新平台）；
//   ③ 键空间混淆：拿 PROVIDERS 当 PLATFORM_QUIRKS 口径 / 拿 PRESETS 当出口表口径
//      → 三套键空间的差集逐个钉住（siliconflow / custom / ollama）；
//   ④ 视图读到过期形状：视图自己存快照 → 注入源改了、下一次查询必须跟着变；
//   ⑤「事实源未注入」被 falsy 默认吞成「已登记」→ unchecked 是显式状态；
//   ⑥ 有意缺口与欠账互相冒充 → 白名单判据 + 冻结「今天只有 custom」；
//   ⑦ provenance 丢格 → 出口面每格原样带出 kind + provenance（引用相等）；
//   ⑧ 视图搬第二份事实主人 → 源码级：无平台 id 字面量、import 面封闭；
//   ⑨ 视图被接进请求链 / SW 静态图 → 无人静态引用 + 依赖走在 build.js 禁区判据上；
//   ⑩ 全量枚举漏行 / 孤儿键不报 → 行序与孤儿正反用例。
//
// 事实源的注入只为测试与「假设新增一个平台」的自查：真身仍是各表（本文件不复制
// 任何事实表；构建期序位经脚本导出注入，不手抄）。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { staticImportersOf, walkExtensionFiles } from "../helpers/static-imports.js";
import { NO_CATALOG_PRESETS, PRESETS, type AiProviderPreset } from "../../extension/core/presets.js";
import { PLATFORM_QUIRKS, type CompatQuirk } from "../../extension/ai/compat-vocab.js";
import { PROVIDERS } from "../../extension/ai/thinking-profiles.js";
import {
  MESSAGES_OFF_EXIT,
  MESSAGES_ON_EXIT,
  MESSAGES_TIER_EXIT,
  type MessagesOffExitCell
} from "../../extension/ai/thinking-wire-map.js";
import {
  MESSAGES_EXIT_CELLS,
  REGISTRATION_FACES,
  presetRegistrationView,
  registrationCoverageReport,
  type PresetRegistrationView,
  type RegistrationFace,
  type RegistrationStatus
} from "../../extension/ai/preset-registration-view.js";
import { UPSTREAM_PRESET_ORDER } from "../../scripts/models-dev-upstream-providers.mjs";

const VIEW_MODULE = "extension/ai/preset-registration-view.ts";
const ALL_STATUSES: readonly RegistrationStatus[] = [
  "registered",
  "intentional-gap",
  "missing",
  "not-applicable",
  "unchecked"
];

// 构建期序位由脚本导出注入（视图不 import scripts/，也不手抄第二份）。
const buildOrder = (): string[] => [...UPSTREAM_PRESET_ORDER];
const viewOf = (id: string): PresetRegistrationView => {
  const view = presetRegistrationView(id, { buildOrder: buildOrder() });
  expect(view, `${id} 应当有一行（预设或平台身份键）`).not.toBeNull();
  return view!;
};
const reportOf = () => registrationCoverageReport({ buildOrder: buildOrder() });
const faceOf = (view: PresetRegistrationView, face: RegistrationFace) => {
  const state = view.faces.find((item) => item.face === face);
  expect(state, `${view.platformId} 缺 ${face} 面`).toBeTruthy();
  return state!;
};

// 静态边扫描的单源见 tests/helpers/static-imports.ts（掐块注释、跳过纯类型引入）。

describe("① 面集合封闭（失败方式：视图漏掉一个登记面）", () => {
  it("注册面清单 = 票面的 6 处登记（顺序是契约；新增事实表须显式进清单）", () => {
    expect([...REGISTRATION_FACES]).toEqual([
      "preset",
      "catalog",
      "protocolEndpoints",
      "quirks",
      "messagesExits",
      "buildOrder"
    ]);
    expect([...MESSAGES_EXIT_CELLS]).toEqual(["tier", "off", "on"]);
  });

  it("每行恰好 6 面、顺序稳定、每面都答得出「本平台在该面的现状」", () => {
    for (const row of reportOf().rows) {
      expect(row.faces.map((face) => face.face), row.platformId).toEqual([...REGISTRATION_FACES]);
      for (const face of row.faces) {
        expect(ALL_STATUSES, `${row.platformId}.${face.face}`).toContain(face.status);
        expect(face.detail.trim().length, `${row.platformId}.${face.face} 无现状说明`).toBeGreaterThan(0);
      }
    }
  });
});

describe("② 欠账判定不写反（正反用例）", () => {
  it("反向：登记齐全的平台欠账为空（minimax / deepseek 六面全 registered）", () => {
    for (const id of ["minimax", "deepseek", "sensenova"]) {
      const view = viewOf(id);
      expect(view.debts, `${id} 不该有欠账`).toEqual([]);
      expect(view.ok, id).toBe(true);
      expect(
        view.faces.map((face) => face.status),
        id
      ).toEqual(["registered", "registered", "registered", "registered", "registered", "registered"]);
    }
    // 齐全不是空转：minimax 的六面各有内容（最后新增的平台样本）。
    const minimax = viewOf("minimax");
    expect(faceOf(minimax, "catalog").catalogProvider).toBe("minimax-cn");
    expect(faceOf(minimax, "buildOrder").buildOrderIndex).toBe(11);
    expect(faceOf(minimax, "messagesExits").cells?.map((cell) => cell.kind)).toEqual([
      "effort",
      "native",
      "word"
    ]);
  });

  it("正向：新加一个平台（形如 minimax 登记之前），视图一次答清还欠什么", () => {
    const nextPlatform: AiProviderPreset = {
      id: "exampleai",
      name: "Example AI",
      baseUrl: "https://api.exampleai.com/v1",
      requiresKey: true,
      catalogProvider: "exampleai-cn"
    };
    const view = presetRegistrationView("exampleai", {
      presets: [...PRESETS, nextPlatform],
      buildOrder: buildOrder()
    })!;
    // 已登记的面（PRESETS 行 / 目录身份 / 怪癖空声明）不再进欠账；欠的是剩下三面：
    // anthropic 端点、三张 Messages 出口表（平台身份未登记）、构建期序位。
    expect(view.debts.map((debt) => `${debt.face}${debt.cell ? `:${debt.cell}` : ""}`)).toEqual([
      "protocolEndpoints",
      "messagesExits:tier",
      "messagesExits:off",
      "messagesExits:on",
      "buildOrder"
    ]);
    expect(view.ok).toBe(false);
    expect(faceOf(view, "messagesExits").detail).toContain("PROVIDERS");
  });

  it("正向：出口面欠账精确到格，其余面一面一条（欠账清单可执行）", () => {
    const bare: AiProviderPreset = {
      id: "bareai",
      name: "Bare AI",
      baseUrl: "https://api.bareai.com",
      requiresKey: true
    };
    const view = presetRegistrationView("bareai", { presets: [...PRESETS, bare], buildOrder: buildOrder() })!;
    // 无 catalogProvider → 目录身份欠账；无上游身份 → 出口三格欠账；序位面对它无要求。
    expect(view.debts.map((debt) => `${debt.face}${debt.cell ? `:${debt.cell}` : ""}`)).toEqual([
      "catalog",
      "messagesExits:tier",
      "messagesExits:off",
      "messagesExits:on"
    ]);
    expect(faceOf(view, "buildOrder").status).toBe("not-applicable");
  });

  it("反向：注入空序位后，有 catalogProvider 的平台一律欠 buildOrder（正面对照）", () => {
    const view = presetRegistrationView("deepseek", { buildOrder: [] })!;
    expect(view.debts.map((debt) => debt.face)).toEqual(["buildOrder"]);
    expect(faceOf(view, "buildOrder").detail).toContain("UPSTREAM_PRESET_ORDER");
    expect(viewOf("deepseek").ok).toBe(true);
  });
});

describe("③ 键空间不混淆（三套键空间各有差集）", () => {
  it("PRESETS / PROVIDERS / PLATFORM_QUIRKS 互不相等：键空间差集是事实", () => {
    const presetIds = PRESETS.map((preset) => preset.id);
    const platformKeys = Object.keys(PROVIDERS);
    const quirkKeys = Object.keys(PLATFORM_QUIRKS);
    expect(presetIds).toContain("custom");
    expect(platformKeys).not.toContain("custom");
    expect(platformKeys).toContain("siliconflow");
    expect(presetIds).not.toContain("siliconflow");
    expect(quirkKeys.every((key) => presetIds.includes(key))).toBe(true);
    expect(quirkKeys.length).toBeLessThan(platformKeys.length);
  });

  it("非预设的平台身份键（siliconflow）也有行：出口面按 PROVIDERS 键空间判为已登记", () => {
    const siliconflow = viewOf("siliconflow");
    expect(siliconflow.isPreset).toBe(false);
    expect(siliconflow.name).toBe("");
    expect(faceOf(siliconflow, "preset").status).toBe("not-applicable");
    expect(faceOf(siliconflow, "catalog").status).toBe("not-applicable");
    expect(faceOf(siliconflow, "messagesExits").status).toBe("registered");
    // quirks 面按自有键判：siliconflow 不在稀疏声明面里 → 合法地空声明。
    expect(Object.prototype.hasOwnProperty.call(PLATFORM_QUIRKS, "siliconflow")).toBe(false);
    expect(faceOf(siliconflow, "quirks").quirks).toEqual([]);
    expect(siliconflow.debts).toEqual([]);
  });

  it("custom（预设、非 PROVIDERS 成员）：出口面是有意缺口，不是欠账", () => {
    const custom = viewOf("custom");
    expect(faceOf(custom, "messagesExits").status).toBe("intentional-gap");
    expect(faceOf(custom, "messagesExits").cells?.map((cell) => cell.status)).toEqual([
      "intentional-gap",
      "intentional-gap",
      "intentional-gap"
    ]);
    expect(custom.debts).toEqual([]);
  });

  it("quirks 面不拿 PROVIDERS 当口径：PROVIDERS 成员无怪癖声明 ≠ 欠账", () => {
    // openrouter / ollama 都在 PROVIDERS（出口面已登记）但不在 PLATFORM_QUIRKS。
    for (const id of ["openrouter", "ollama"]) {
      expect(faceOf(viewOf(id), "quirks").quirks).toEqual([]);
      expect(faceOf(viewOf(id), "quirks").status).toBe("registered");
      expect(faceOf(viewOf(id), "messagesExits").status).toBe("registered");
    }
    expect(faceOf(viewOf("stepfun"), "quirks").quirks).toEqual(["effortVocabMessages"]);
  });

  it("目录身份面按预设 id 判：白名单成员缺 catalogProvider 不算欠账，两者并存才是欠账", () => {
    for (const id of NO_CATALOG_PRESETS) {
      expect(faceOf(viewOf(id), "catalog").status, id).toBe("registered");
    }
    const contradictory = presetRegistrationView("deepseek", {
      noCatalogPresets: [...NO_CATALOG_PRESETS, "deepseek"],
      buildOrder: buildOrder()
    })!;
    expect(faceOf(contradictory, "catalog").status).toBe("missing");
    expect(contradictory.debts.map((debt) => debt.face)).toEqual(["catalog"]);
  });
});

describe("④ 视图读到过期形状（零缓存：注入源改了，下一次查询必须跟着变）", () => {
  it("怪癖面：注入表在两次查询之间被改，输出跟着变（视图不存快照）", () => {
    const platformQuirks: Record<string, readonly CompatQuirk[]> = {};
    expect(faceOf(presetRegistrationView("stepfun", { platformQuirks })!, "quirks").quirks).toEqual([]);
    platformQuirks.stepfun = ["effortVocabMessages"];
    expect(faceOf(presetRegistrationView("stepfun", { platformQuirks })!, "quirks").quirks).toEqual([
      "effortVocabMessages"
    ]);
  });

  it("出口面：删掉一格后立刻报欠账（同上，视图不许持有旧表）", () => {
    const messagesOffExit: Record<string, MessagesOffExitCell> = { ...MESSAGES_OFF_EXIT };
    const before = presetRegistrationView("stepfun", { messagesOffExit, platformKeys: Object.keys(PROVIDERS) })!;
    expect(faceOf(before, "messagesExits").status).toBe("registered");
    delete messagesOffExit.stepfun;
    const after = presetRegistrationView("stepfun", { messagesOffExit, platformKeys: Object.keys(PROVIDERS) })!;
    expect(faceOf(after, "messagesExits").status).toBe("missing");
    expect(after.debts.map((debt) => debt.cell)).toEqual(["off"]);
  });

  it("默认源 = 真实表：不传源时两次全量查询深相等（现查现算，无隐藏状态）", () => {
    expect(registrationCoverageReport()).toEqual(registrationCoverageReport());
  });
});

describe("⑤「事实源未注入」不被 falsy 默认吞掉", () => {
  it("buildOrder 未注入 → unchecked（不是 registered，也不算欠账）", () => {
    const view = presetRegistrationView("minimax")!;
    const buildFace = faceOf(view, "buildOrder");
    expect(buildFace.status).toBe("unchecked");
    expect(buildFace.detail).toContain("不得当作已登记");
    expect(view.debts.some((debt) => debt.face === "buildOrder")).toBe(false);
    // ok 只答「有没有欠账」；未对账的面在 faces 里显式可见。
    expect(view.ok).toBe(true);
  });
});

describe("⑥ 有意缺口与欠账互相冒充（白名单是唯一判据）", () => {
  it("今天的有意缺口包含 custom 与过渡态 gemini（冻结：新增即须显式复核）", () => {
    const rows = reportOf().rows;
    const intentional = rows
      .filter((row) => row.faces.some((face) => face.status === "intentional-gap"))
      .map((row) => row.platformId);
    expect(intentional.sort()).toEqual(["custom", "gemini"].sort());
    const custom = viewOf("custom");
    expect(
      custom.faces.filter((face) => face.status === "intentional-gap").map((face) => face.face)
    ).toEqual(["protocolEndpoints", "messagesExits"]);
  });

  it("把 custom 移出白名单 → 立刻从有意缺口变成欠账（判据取自事实，不是写死的 id）", () => {
    const withoutCustom = NO_CATALOG_PRESETS.filter((id) => id !== "custom");
    const view = presetRegistrationView("custom", {
      noCatalogPresets: withoutCustom,
      buildOrder: buildOrder()
    })!;
    expect(view.debts.map((debt) => debt.face)).toEqual([
      "catalog",
      "messagesExits",
      "messagesExits",
      "messagesExits"
    ]);
    expect(faceOf(view, "messagesExits").status).toBe("missing");
  });
});

describe("⑦ provenance 不丢（出口面逐格原样带出）", () => {
  it("registered 的格带出的 kind 与 provenance 就是事实表里的那一个（引用相等）", () => {
    const tables = {
      tier: MESSAGES_TIER_EXIT as Readonly<Record<string, { kind: string; provenance: unknown }>>,
      off: MESSAGES_OFF_EXIT as Readonly<Record<string, { kind: string; provenance: unknown }>>,
      on: MESSAGES_ON_EXIT as Readonly<Record<string, { kind: string; provenance: unknown }>>
    };
    let checked = 0;
    for (const row of reportOf().rows) {
      const cells = faceOf(row, "messagesExits").cells ?? [];
      for (const cell of cells) {
        if (cell.status !== "registered") {
          expect(cell.kind, `${row.platformId}.${cell.cell}`).toBeUndefined();
          expect(cell.provenance, `${row.platformId}.${cell.cell}`).toBeUndefined();
          continue;
        }
        const source = tables[cell.cell][row.platformId];
        expect(source, `${row.platformId}.${cell.cell} 不在事实表里`).toBeTruthy();
        expect(cell.kind, `${row.platformId}.${cell.cell}`).toBe(source.kind);
        // 引用相等 = 视图没有重算、没有重写一处出处（provenance 的主人仍是出口表）。
        expect(cell.provenance, `${row.platformId}.${cell.cell}`).toBe(source.provenance);
        checked += 1;
      }
    }
    // 口径自检：真实表今天 14 平台 × 3 格全满（custom 走表外，不在出口表键空间里）。
    expect(checked).toBe(Object.keys(PROVIDERS).length * MESSAGES_EXIT_CELLS.length);
  });
});

describe("⑧ 视图不搬事实主人（源码级判据）", () => {
  it("源码不含任何预设 id 字面量（不复制平台清单）", () => {
    const source = readFileSync(VIEW_MODULE, "utf8");
    for (const preset of PRESETS) {
      expect(source.includes(`"${preset.id}"`), `视图源码出现 "${preset.id}"`).toBe(false);
      expect(source.includes(`'${preset.id}'`), `视图源码出现 '${preset.id}'`).toBe(false);
    }
  });

  it("import 面封闭：只查既有事实表，不拖入目录产物 / 请求链 / scripts", () => {
    const source = readFileSync(VIEW_MODULE, "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]).sort();
    expect(imports).toEqual([
      "../core/presets.js",
      "./compat-vocab.js",
      "./protocol-vocab.js",
      "./thinking-profiles.js",
      "./thinking-wire-map.js"
    ]);
    // 逐条 import 说明符判（注释里指路「端点约定见 adapters/anthropic.ts」不算拖入：
    // 判据是依赖边，不是文本）。
    for (const spec of imports) {
      for (const forbidden of [
        "models-dev-catalog.generated",
        "models-dev-thinking.generated",
        "model-catalog",
        "adapters",
        "scripts"
      ]) {
        expect(spec.includes(forbidden), `视图 import 了 ${spec}（拖入 ${forbidden}）`).toBe(false);
      }
    }
  });

  it("目录身份不因协议登记而变（protocol 不参与目录查表，ADR-0013）", () => {
    const plain: AiProviderPreset = {
      id: "probeai-plain",
      name: "Probe AI",
      baseUrl: "https://api.probeai.com/v1",
      requiresKey: true,
      catalogProvider: "probeai-cn"
    };
    // 与上面只差协议登记的两行：目录面必须逐字相同，协议只改端点面。
    const withProtocols: AiProviderPreset = {
      ...plain,
      id: "probeai-anthropic",
      protocol: "anthropic",
      protocolBaseUrls: { anthropic: "https://api.probeai.com/anthropic" }
    };
    const sources = { presets: [plain, withProtocols], buildOrder: [] as string[] };
    const plainCatalog = faceOf(presetRegistrationView("probeai-plain", sources)!, "catalog");
    const protocolCatalog = faceOf(presetRegistrationView("probeai-anthropic", sources)!, "catalog");
    expect(protocolCatalog).toEqual(plainCatalog);
    expect(protocolCatalog.catalogProvider).toBe("probeai-cn");
    // 反面对照：协议确实影响端点面（否则上面那条断言是恒真的）。
    expect(faceOf(presetRegistrationView("probeai-anthropic", sources)!, "protocolEndpoints")).not.toEqual(
      faceOf(presetRegistrationView("probeai-plain", sources)!, "protocolEndpoints")
    );
  });
});

describe("⑨ 视图不进请求链 / 不进 SW 静态图", () => {
  it("无人静态引用本视图（引入请求链或 SW 侧都要先改这里）", () => {
    expect(staticImportersOf("preset-registration-view")).toEqual([]);
  });

  it("请求执行路径的文件里没有它（运行时不引入登记视图）", () => {
    const requestPath = [
      "extension/core/provider-http.ts",
      "extension/ai/completion.ts",
      ...walkExtensionFiles("extension/ai/adapters")
    ];
    for (const file of requestPath) {
      expect(readFileSync(file, "utf8"), `${file} 引用了登记视图`).not.toContain(
        "preset-registration-view"
      );
    }
  });

  it("它引用的 thinking-profiles 在 build.js 的 SW 静态图禁区清单里（静态引入必被拦下）", () => {
    const build = readFileSync("scripts/build.js", "utf8");
    const list = build.slice(
      build.indexOf("BACKGROUND_FORBIDDEN_STATIC_SOURCES"),
      build.indexOf("function assertBackgroundStaticGraphSlim")
    );
    expect(list).toContain("thinking-profiles\\.ts");
    expect(readFileSync(VIEW_MODULE, "utf8")).toContain('"./thinking-profiles.js"');
  });
});

describe("⑩ 全量枚举不漏行、孤儿键反向对账", () => {
  it("行 = PRESETS 序 + 追加非预设平台身份键（稳定序，不重不漏）", () => {
    const presetIds = PRESETS.map((preset) => preset.id);
    const expected = [...presetIds, ...Object.keys(PROVIDERS).filter((id) => !presetIds.includes(id))];
    const rows = reportOf().rows;
    expect(rows.map((row) => row.platformId)).toEqual(expected);
    expect(rows.filter((row) => row.isPreset).map((row) => row.platformId)).toEqual(presetIds);
  });

  it("真实表今天零孤儿；注入四类漂移后逐面报出（含序位里的非 catalogProvider 预设）", () => {
    expect(reportOf().orphans).toEqual([]);
    const drifted = registrationCoverageReport({
      noCatalogPresets: [...NO_CATALOG_PRESETS, "ghost"],
      platformQuirks: { ...PLATFORM_QUIRKS, ghost: ["sessionHeader"] },
      messagesOnExit: {
        ...MESSAGES_ON_EXIT,
        ghost: { kind: "native", provenance: { level: "推断", source: "测试注入的漂移格" } }
      },
      buildOrder: [...buildOrder(), "ghost", "ollama"]
    });
    expect(drifted.orphans.map((orphan) => `${orphan.face}:${orphan.key}`).sort()).toEqual([
      "buildOrder:ghost",
      "buildOrder:ollama",
      "catalog:ghost",
      "messagesExits:ghost",
      "quirks:ghost"
    ]);
  });

  it("查不到即 null：未知 id / 空串 / 原型链上的键都不回落猜测值", () => {
    expect(presetRegistrationView("no-such-platform")).toBeNull();
    expect(presetRegistrationView("")).toBeNull();
    expect(presetRegistrationView("constructor")).toBeNull();
    expect(presetRegistrationView("toString")).toBeNull();
  });
});

describe("端点面（测试手抄 id 清单的派生替代）", () => {
  it("显式登记 anthropic 端点的预设 = 审计名单（派生名单与冻结 oracle 双向可对）", () => {
    const derived = reportOf()
      .rows.filter((row) =>
        (faceOf(row, "protocolEndpoints").endpoints ?? []).some(
          (endpoint) => endpoint.protocol === "anthropic" && endpoint.source === "explicit"
        )
      )
      .map((row) => row.platformId);
    // 定义方向：= PRESETS 里登记了 protocolBaseUrls.anthropic 的（视图不手抄清单）。
    expect(derived).toEqual(PRESETS.filter((preset) => preset.protocolBaseUrls?.anthropic).map((preset) => preset.id));
    // 家数冻结（审计表的独立 oracle 在 tests/core/ai-preset-protocol-endpoints.test.ts，
    // 那份手抄清单逐个断言这条派生结果——这里只钉住「名单非空且不多不少」这一侧）。
    expect(derived).toHaveLength(13);
    const auditOracle = readFileSync("tests/core/ai-preset-protocol-endpoints.test.ts", "utf8");
    for (const id of derived) {
      expect(auditOracle, `审计名单里缺 ${id}`).toContain(`"${id}"`);
    }
  });

  it("anthropic 端点回落不重复 /v1：欠账已随 ollama 补登记清零（冻结：新增带 /v1 尾 baseUrl 的预设即须复核）", () => {
    const hazardous = reportOf()
      .rows.filter((row) =>
        (faceOf(row, "protocolEndpoints").endpoints ?? []).some((endpoint) => endpoint.fallbackRepeatsV1)
      )
      .map((row) => row.platformId);
    expect(hazardous).toEqual([]);
    // ollama 曾是唯一欠账（回落拼 /v1/v1/messages），2026-10-05 补显式 anthropic 端点后清账。
    const ollama = viewOf("ollama");
    expect(ollama.debts).toEqual([]);
    expect(faceOf(ollama, "protocolEndpoints").status).toBe("registered");
    expect(faceOf(ollama, "messagesExits").status).toBe("registered");
    expect(faceOf(ollama, "catalog").status).toBe("registered");
  });

  it("baseUrl 为空的自定义端点预设：端点面是有意缺口，不报 /v1 类欠账", () => {
    const endpoints = faceOf(viewOf("custom"), "protocolEndpoints").endpoints ?? [];
    expect(endpoints.map((endpoint) => endpoint.source)).toEqual(["none", "none", "none"]);
    expect(endpoints.every((endpoint) => endpoint.fallbackRepeatsV1)).toBe(false);
  });
});
