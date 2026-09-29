// core/asr-failure-notice.ts 单测（asr-error-reporting/06 文案表 + 08 验收表 A2 档）。
//
// 锁三件事：
// 1. 文案逐字：10 个 reason + null 各一段病因 / 补救 / remedy / 详情行。文案是产品
//    契约，所以断言期望值一律写成字面量（独立真源），不从模块里回抄；
// 2. 详情行口径：status 与报文怎么拼、换行怎么去、80 字符怎么截、无信息时整段
//    不出现（不写「无」），以及只有四个 reason 允许带详情行；
// 3. 常驻不变量（票 07 Q2）：状态栏拼装对每个非 null reason 都必须含基础句
//    「当前视频无字幕。」——它命中 core/reading-status-line 的 /无字幕/ 常驻
//    词表，是失败文案不被 5 秒自动收起的唯一依据。基础句丢失 = 用户看不到病因。
//
// 另有两条结构用例：模块是零运行时 import 的叶子（只 type-import
// NoSubtitleReason），且未被静态拖进常驻图（它被 content 侧两侧消费，进常驻图会
// 变成双实例，须先按 build-content 的清单对账）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASR_FAILURE_DETAIL_MAX_CHARS,
  SIDEPANEL_BASE,
  SIDEPANEL_EMPTY_NOTICE,
  STATUS_LINE_BASE,
  buildAsrNoSubtitleMessage,
  formatAsrFailureDetail,
  getAsrFailureNotice,
  reasonFromFailureKind
} from "../../extension/core/asr-failure-notice.js";
import { isPersistentStatusText } from "../../extension/core/reading-status-line.js";
import type { NoSubtitleReason } from "../../extension/core/state.js";
// 构建脚本在 CJS 下无类型声明，`import type` 不产生运行时边（沿用既有对账用例的口径）。
import type { diffDualInstanceAllowlist } from "../../scripts/build-guards.js";

// 文案表真源：票 06 的表格逐字誊写。cause / remedyText / remedy 三元组由用例逐条
// 对账，避免「实现改一处、期望跟着改」的循环论证。
const COPY_TABLE: Record<string, { cause: string; remedyText: string; remedy: string }> = {
  "no-asr-config": {
    cause: "语音识别平台不可用：未配置平台、域名未授权，或这个模型不存在。",
    remedyText: "请到设置页检查语音转写平台",
    remedy: "open-settings"
  },
  "asr-disabled": {
    cause: "语音转写开关已关闭。",
    remedyText: "可在设置页开启「无字幕时自动生成字幕」后再试",
    remedy: "open-settings"
  },
  "asr-auth": {
    cause: "语音识别平台拒绝了本次请求：API Key 无效、已过期，或没有权限。",
    remedyText: "请到设置页检查或更换 API Key",
    remedy: "open-settings"
  },
  "asr-quota": {
    cause: "语音识别平台的额度或余额不足。",
    remedyText: "请到平台充值，或稍后重试",
    remedy: "retry-later"
  },
  "asr-ratelimit": {
    cause: "请求过于频繁，已被语音识别平台限流。",
    remedyText: "请稍后重试",
    remedy: "retry-later"
  },
  "asr-network": {
    cause: "无法连接语音识别平台（网络不通或请求超时）。",
    remedyText: "请检查网络后重新抓取",
    remedy: "retry-later"
  },
  "asr-media": {
    cause: "这个视频的音轨下载或解码失败（可能受保护，或文件过大）。",
    remedyText: "可换一个视频，或稍后重新抓取",
    remedy: "retry-later"
  },
  "asr-server": {
    cause: "语音识别平台暂时不可用（服务端错误）。",
    remedyText: "请稍后重新抓取",
    remedy: "retry-later"
  },
  "asr-unknown": {
    cause: "语音识别失败，未能识别具体原因。",
    remedyText: "可重新抓取或稍后重试",
    remedy: "retry-later"
  },
  "asr-empty": {
    cause: "未识别到语音内容，这个视频可能没有人声。",
    remedyText: "",
    remedy: "none"
  },
  null: {
    cause: "",
    remedyText: "可在设置页配置语音识别平台自动生成字幕。",
    remedy: "open-settings"
  }
};

// 票 04 的 10 个非 null 取值（顺序即联合声明顺序，仅用于遍历）。
const ALL_REASONS: readonly NoSubtitleReason[] = [
  "no-asr-config",
  "asr-disabled",
  "asr-auth",
  "asr-quota",
  "asr-ratelimit",
  "asr-network",
  "asr-media",
  "asr-server",
  "asr-unknown",
  "asr-empty"
];

const nullableReasons: readonly NoSubtitleReason[] = [...ALL_REASONS, null];

// 只有这四个 reason 的文案表允许附详情行（票 06 的「详情行」列）。
const DETAIL_ALLOWED: readonly NoSubtitleReason[] = ["no-asr-config", "asr-auth", "asr-quota", "asr-unknown"];

// 结构性输入：无 status、无报文，从状态码到报文的每条拼装规则都被这份输入绕过——
// 详情行的「无信息 → 整段不出现」判定只能靠它。
const NO_DETAIL = { status: null, detail: "" };

// 8 个失败类 kind 的清单（票 03 判定，票 04 定字面量）。
const FAILURE_KINDS = [
  "no-asr-config",
  "asr-auth",
  "asr-quota",
  "asr-ratelimit",
  "asr-network",
  "asr-media",
  "asr-server",
  "asr-unknown"
] as const;

function readModuleSource(relativePath: string): string {
  // readFileSync 的路径重载只收 string（node:fs 的类型窄于 runtime 的 URL 支持）
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getAsrFailureNotice：文案表逐字", () => {
  for (const reason of nullableReasons) {
    const expected = COPY_TABLE[String(reason)];
    it(`${String(reason)}：病因 / 补救 / remedy 与文案表一致`, () => {
      const notice = getAsrFailureNotice(reason);
      expect(notice.cause).toBe(expected.cause);
      expect(notice.remedyText).toBe(expected.remedyText);
      expect(notice.remedy).toBe(expected.remedy);
    });
  }

  it("null：病因句为空串，补救句与设置入口仍在", () => {
    const notice = getAsrFailureNotice(null);
    expect(notice.cause).toBe("");
    expect(notice.remedyText).toBe("可在设置页配置语音识别平台自动生成字幕。");
    expect(notice.remedy).toBe("open-settings");
  });

  it("联合外的未知 reason：退回 asr-unknown 的中性文案，不抛错", () => {
    // 运行时值可来自旧快照 / 手改 storage，类型联合拦不住；中性句 + 重新抓取是
    // 唯一安全的兜底，绝不返回 null 文案。
    const notice = getAsrFailureNotice("asr-failed" as unknown as NoSubtitleReason);
    expect(notice.cause).toBe(COPY_TABLE["asr-unknown"].cause);
    expect(notice.remedy).toBe("retry-later");
  });

  it("仅「前往设置」与「重新抓取」两档：open-settings 只给需要用户去设置的三个 reason", () => {
    const openSettings = nullableReasons.filter((reason) => getAsrFailureNotice(reason).remedy === "open-settings");
    expect(openSettings).toEqual(["no-asr-config", "asr-disabled", "asr-auth", null]);
  });

  it("asr-quota 不带设置入口（票 04 Q6：额度不足的补救是充值而非设置）", () => {
    expect(getAsrFailureNotice("asr-quota").remedy).toBe("retry-later");
  });

  it("asr-empty 无补救句也无设置入口", () => {
    const notice = getAsrFailureNotice("asr-empty");
    expect(notice.remedyText).toBe("");
    expect(notice.remedy).toBe("none");
  });
});

describe("详情行：只给四个 reason，其余整段不出现", () => {
  const detailInput = { status: 401, detail: '{"message":"Invalid token"}' };

  for (const reason of nullableReasons) {
    const allowed = DETAIL_ALLOWED.includes(reason);
    it(`${String(reason)}：${allowed ? "带详情行" : "详情行恒为空串"}`, () => {
      const notice = getAsrFailureNotice(reason, detailInput);
      if (allowed) {
        expect(notice.detail).toBe('（错误详情：HTTP 401: {"message":"Invalid token"}）');
      } else {
        expect(notice.detail).toBe("");
      }
    });
  }

  it("asr-unknown：无结构化信息时详情行仍为空串（不写「无」）", () => {
    expect(getAsrFailureNotice("asr-unknown", NO_DETAIL).detail).toBe("");
  });

  it("缺省入参（不传 detail）：详情行为空串", () => {
    expect(getAsrFailureNotice("asr-auth").detail).toBe("");
    expect(getAsrFailureNotice("asr-auth", null).detail).toBe("");
    expect(getAsrFailureNotice("asr-auth", undefined).detail).toBe("");
  });
});

describe("formatAsrFailureDetail：status 与报文的拼装", () => {
  it("status + 报文：冒号分隔，HTTP <status> 前缀", () => {
    expect(formatAsrFailureDetail({ status: 500, detail: '{"error":"boom"}' })).toBe(
      '（错误详情：HTTP 500: {"error":"boom"}）'
    );
  });

  it("只有报文：不加 HTTP 前缀", () => {
    expect(formatAsrFailureDetail({ detail: "Model does not exist" })).toBe("（错误详情：Model does not exist）");
  });

  it("只有 status：不加多余冒号", () => {
    expect(formatAsrFailureDetail({ status: 429 })).toBe("（错误详情：HTTP 429）");
  });

  it("两者皆无：整段不出现", () => {
    expect(formatAsrFailureDetail({})).toBe("");
    expect(formatAsrFailureDetail({ status: null, detail: null })).toBe("");
    expect(formatAsrFailureDetail(null)).toBe("");
    expect(formatAsrFailureDetail(undefined)).toBe("");
  });

  it("status 非正数与非有限值：不当作状态码", () => {
    // 适配器用 status === -1 表示「响应体不是合法 JSON」，那是 reason 的信号而非
    // 可展示的状态码；0 / NaN 同理。
    expect(formatAsrFailureDetail({ status: -1, detail: "非 JSON 响应体" })).toBe("（错误详情：非 JSON 响应体）");
    expect(formatAsrFailureDetail({ status: 0, detail: "boom" })).toBe("（错误详情：boom）");
    expect(formatAsrFailureDetail({ status: Number.NaN, detail: "boom" })).toBe("（错误详情：boom）");
  });

  it("换行与连续空白折叠为单个空格并 trim", () => {
    expect(formatAsrFailureDetail({ status: 400, detail: "line1\n\nline2\t  line3" })).toBe(
      "（错误详情：HTTP 400: line1 line2 line3）"
    );
    expect(formatAsrFailureDetail({ detail: "  \n  boom \n " })).toBe("（错误详情：boom）");
  });

  it("纯空白报文：等价于无报文，整段不出现", () => {
    expect(formatAsrFailureDetail({ detail: "   \n\t " })).toBe("");
    expect(formatAsrFailureDetail({ status: 401, detail: "\n" })).toBe("（错误详情：HTTP 401）");
  });
});

describe("详情行截断：上限 80 字符", () => {
  // detail 已由适配器截到 200 字符，本模块再按展示宽度截到 80——纯 ASCII 下
  // "HTTP 401: " 恰好 10 字符，便于逐位核对边界。
  const body = (n: number) => "x".repeat(n);
  const contentOf = (line: string) => line.slice("（错误详情：".length, -"）".length);

  it("上限常量是 80（票 06 的 Q13）", () => {
    expect(ASR_FAILURE_DETAIL_MAX_CHARS).toBe(80);
  });

  it("内容 79 字符：不截断", () => {
    const line = formatAsrFailureDetail({ status: 401, detail: body(69) });
    expect(contentOf(line)).toBe(`HTTP 401: ${body(69)}`);
    expect(contentOf(line)).toHaveLength(79);
  });

  it("内容 80 字符：不截断（边界取闭区间）", () => {
    const line = formatAsrFailureDetail({ status: 401, detail: body(70) });
    expect(contentOf(line)).toBe(`HTTP 401: ${body(70)}`);
    expect(contentOf(line)).toHaveLength(80);
  });

  it("内容 81 字符：截到 80，整体仍挂在全角括号里", () => {
    const line = formatAsrFailureDetail({ status: 401, detail: body(71) });
    expect(contentOf(line)).toBe(`HTTP 401: ${body(70)}`);
    expect(contentOf(line)).toHaveLength(80);
    expect(line.startsWith("（错误详情：")).toBe(true);
    expect(line.endsWith("）")).toBe(true);
  });

  it("超长报文：截断后不再出现尾部残余（截断从内容头部算起）", () => {
    // 无状态码时内容就是报文本体，前 80 字符必须逐字保留，尾部被切掉。
    const line = formatAsrFailureDetail({ detail: `${body(80)}TAIL` });
    expect(contentOf(line)).toBe(body(80));
    expect(line).not.toContain("TAIL");
  });
});

describe("reasonFromFailureKind：kind → reason（8 个失败类）", () => {
  for (const kind of FAILURE_KINDS) {
    it(`${kind}：映射到同名 reason`, () => {
      expect(reasonFromFailureKind(kind)).toBe(kind);
    });
  }

  it("缺失 / null / 非字符串：一律 asr-unknown，绝不返回 null", () => {
    // null 会落成「无原因」文案并丢掉详情；判不出原因时必须落到可重试的中性类。
    expect(reasonFromFailureKind(undefined)).toBe("asr-unknown");
    expect(reasonFromFailureKind(null)).toBe("asr-unknown");
    expect(reasonFromFailureKind("")).toBe("asr-unknown");
    expect(reasonFromFailureKind(42)).toBe("asr-unknown");
    expect(reasonFromFailureKind({})).toBe("asr-unknown");
  });

  it("非失败类的 reason 不是 kind：退回 asr-unknown", () => {
    // 这两个由 asr-skip 路由产生，不经 failure-kind 判定；误当 kind 传进来时
    // 说明判层错位，中性兜底比静默复用好。
    // 注：no-asr-config 同时是**配置类失败**的合法 kind（404 / 模型不存在 / 无
    // baseUrl 都判它），故它按 kind 映射回自身，不在此列。
    expect(reasonFromFailureKind("asr-disabled")).toBe("asr-unknown");
    expect(reasonFromFailureKind("asr-empty")).toBe("asr-unknown");
    expect(reasonFromFailureKind("no-asr-config")).toBe("no-asr-config");
  });

  it("已删除的历史字面量 asr-failed 不是 kind：退回 asr-unknown", () => {
    expect(reasonFromFailureKind("asr-failed")).toBe("asr-unknown");
  });

  it("任意字符串：退回 asr-unknown（不抛错、不回显未知输入）", () => {
    expect(reasonFromFailureKind("garbage")).toBe("asr-unknown");
    expect(reasonFromFailureKind("ASR-AUTH")).toBe("asr-unknown");
  });
});

describe("buildAsrNoSubtitleMessage：两个面各拼自己的前缀", () => {
  it("status-line：基础句 + 病因 + 补救 + 详情", () => {
    expect(buildAsrNoSubtitleMessage("status-line", "asr-auth", { status: 401, detail: "Invalid token" })).toBe(
      `${STATUS_LINE_BASE} ${COPY_TABLE["asr-auth"].cause} ${COPY_TABLE["asr-auth"].remedyText}` +
        " （错误详情：HTTP 401: Invalid token）"
    );
  });

  it("sidepanel：基础句 + 病因 + 补救 + 详情（前缀不同）", () => {
    expect(buildAsrNoSubtitleMessage("sidepanel", "asr-auth", { status: 401, detail: "Invalid token" })).toBe(
      `${SIDEPANEL_BASE} ${COPY_TABLE["asr-auth"].cause} ${COPY_TABLE["asr-auth"].remedyText}` +
        " （错误详情：HTTP 401: Invalid token）"
    );
  });

  it("sidepanel 的 asr-empty 例外：整句替换，不拼接", () => {
    expect(buildAsrNoSubtitleMessage("sidepanel", "asr-empty")).toBe(SIDEPANEL_EMPTY_NOTICE);
    expect(buildAsrNoSubtitleMessage("sidepanel", "asr-empty")).not.toContain(SIDEPANEL_BASE);
  });

  it("status-line 的 asr-empty 不走例外：基础句 + 病因，无补救句", () => {
    expect(buildAsrNoSubtitleMessage("status-line", "asr-empty")).toBe(
      `${STATUS_LINE_BASE} ${COPY_TABLE["asr-empty"].cause}`
    );
  });

  it("null reason：基础句 + 通用补救句", () => {
    expect(buildAsrNoSubtitleMessage("status-line", null)).toBe(
      `${STATUS_LINE_BASE} ${COPY_TABLE[String(null)].remedyText}`
    );
    expect(buildAsrNoSubtitleMessage("sidepanel", null)).toBe(
      `${SIDEPANEL_BASE} ${COPY_TABLE[String(null)].remedyText}`
    );
  });

  it("空段被过滤：不留双空格、不留尾空格", () => {
    const message = buildAsrNoSubtitleMessage("status-line", "asr-empty");
    expect(message).not.toMatch(/\s{2,}/);
    expect(message).toBe(message.trim());
  });
});

describe("常驻不变量：状态栏文案永远含基础句（票 07 Q2）", () => {
  for (const reason of ALL_REASONS) {
    it(`${reason}：含基础句且命中常驻词表`, () => {
      // 状态行写策略（core/reading-status-line）用词表决定 5 秒后是否收起：含
      // 「无字幕」即常驻。基础句丢失不会有任何报错，只会让病因悄悄消失。
      const message = buildAsrNoSubtitleMessage("status-line", reason, { status: 500, detail: "boom" });
      expect(message).toContain(STATUS_LINE_BASE);
      expect(isPersistentStatusText(message)).toBe(true);
    });
  }

  it("null reason 同样常驻", () => {
    const message = buildAsrNoSubtitleMessage("status-line", null);
    expect(message).toContain(STATUS_LINE_BASE);
    expect(isPersistentStatusText(message)).toBe(true);
  });

  it("词表未扩：不依赖「失败 / 错误 / 无法」以外的兜底词", () => {
    // 不变量靠基础句成立，而不是靠给词表加词——扩表要改 core 显示策略，本图明确不做。
    expect(isPersistentStatusText("当前视频无字幕。")).toBe(true);
  });
});

describe("叶子纪律（结构用例）", () => {
  it("模块只有 type import：零运行时依赖，不拖入 asr 域", () => {
    const source = readModuleSource("../../extension/core/asr-failure-notice.ts").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(source).not.toMatch(/^\s*import\s+(?!type\b)/m);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).toContain('import type { NoSubtitleReason } from "./state.js"');
  });

  it("模块无模块级可变状态（纯函数库，双实例安全）", () => {
    const source = readModuleSource("../../extension/core/asr-failure-notice.ts").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(source).not.toContain("BILISCRIPT_DUAL_INSTANCE_STATEFUL");
    expect(source).not.toMatch(/\blet\s+/);
    expect(source).not.toMatch(/\bvar\s+/);
  });

  it("未被静态拖进常驻图：新双实例模块必须先入 build-content 白名单", () => {
    // core/ 是常驻图的可达区，而本模块只被懒加载区（chat/subtitle 域）消费。若
    // 常驻侧静态 import 了它，它就变成双实例，构建期守卫会报错要求人工评估；
    // 这条用例让「新增常驻边」在单测层就现形，不必等到跑构建。
    // 只看 import/export 子句（注释里提到本模块名不算依赖边，state.ts 的类型
    // 注释就引了票 06 的路径）。
    const roots = ["extension/entry/content.ts", "extension/core/state.ts", "extension/subtitle/commit.ts"];
    for (const root of roots) {
      const source = readModuleSource(`../../${root}`).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
      const importClauses = [...source.matchAll(/(?:^|\n)[ \t]*(?:import|export)\s+([^;]*?)\s*from\s*["'][^"']+["']/g)];
      const mentions = importClauses.filter((match) => match[1].includes("asr-failure-notice"));
      expect(mentions, `${root} 静态引入了 asr-failure-notice`).toEqual([]);
    }
  });
});
