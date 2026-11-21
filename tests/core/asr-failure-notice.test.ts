import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASR_FAILURE_DETAIL_MAX_CHARS,
  SIDEPANEL_BASE,
  SIDEPANEL_EMPTY_NOTICE,
  STATUS_LINE_BASE,
  buildAsrNoSubtitleMessage,
  canRetryNoSubtitleOnSend,
  formatAsrFailureDetail,
  getAsrFailureNotice,
  reasonFromFailureKind
} from "../../extension/core/asr-failure-notice.js";
import type { NoSubtitleReason } from "../../extension/core/state.js";
import type { diffDualInstanceAllowlist } from "../../scripts/build-guards.js";

const COPY_TABLE: Record<string, { cause: string; remedyText: string; remedy: string }> = {
  "upower-exclusive": {
    cause: "该视频为充电专属视频，未开通充电无法获取完整音轨。",
    remedyText: "开通充电后可重新抓取生成字幕",
    remedy: "retry-later"
  },
  "bili-login-required": {
    cause: "未登录 B 站，无法获取视频自带字幕。",
    remedyText: "请登录 B 站后重新抓取",
    remedy: "retry-later"
  },
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

const ALL_REASONS: readonly NoSubtitleReason[] = [
  "upower-exclusive",
  "bili-login-required",
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

const DETAIL_ALLOWED: readonly NoSubtitleReason[] = ["no-asr-config", "asr-auth", "asr-quota", "asr-unknown"];

const NO_DETAIL = { status: null, detail: "" };

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
    expect(reasonFromFailureKind(undefined)).toBe("asr-unknown");
    expect(reasonFromFailureKind(null)).toBe("asr-unknown");
    expect(reasonFromFailureKind("")).toBe("asr-unknown");
    expect(reasonFromFailureKind(42)).toBe("asr-unknown");
    expect(reasonFromFailureKind({})).toBe("asr-unknown");
  });

  it("非失败类的 reason 不是 kind：退回 asr-unknown", () => {
    expect(reasonFromFailureKind("upower-exclusive")).toBe("asr-unknown");
    expect(reasonFromFailureKind("bili-login-required")).toBe("asr-unknown");
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
    expect(reasonFromFailureKind("toString")).toBe("asr-unknown");
  });
});

describe("canRetryNoSubtitleOnSend：发送闸重抓策略单表口径", () => {
  const RETRYABLE_ON_SEND: readonly NoSubtitleReason[] = [
    "bili-login-required",
    "no-asr-config",
    "asr-disabled",
    "asr-auth"
  ];

  it("仅可经配置或登录恢复的四个 reason 允许发送前重抓，其余与 null 一律拒绝", () => {
    const allowed = nullableReasons.filter((reason) => canRetryNoSubtitleOnSend(reason));
    expect(allowed).toEqual(RETRYABLE_ON_SEND);
  });

  it("未知运行期字面量与原型属性名一律返回 false", () => {
    expect(canRetryNoSubtitleOnSend("asr-failed" as unknown as NoSubtitleReason)).toBe(false);
    expect(canRetryNoSubtitleOnSend("toString" as unknown as NoSubtitleReason)).toBe(false);
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

describe("基础句不变量：状态文案永远含「当前视频无字幕。」", () => {
  for (const reason of ALL_REASONS) {
    it(`${reason}：含基础句`, () => {
      const message = buildAsrNoSubtitleMessage("status-line", reason, { status: 500, detail: "boom" });
      expect(message).toContain(STATUS_LINE_BASE);
    });
  }

  it("null reason 同样含基础句", () => {
    expect(buildAsrNoSubtitleMessage("status-line", null)).toContain(STATUS_LINE_BASE);
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
    const roots = ["extension/entry/content.ts", "extension/core/state.ts", "extension/subtitle/commit.ts"];
    for (const root of roots) {
      const source = readModuleSource(`../../${root}`).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
      const importClauses = [...source.matchAll(/(?:^|\n)[ \t]*(?:import|export)\s+([^;]*?)\s*from\s*["'][^"']+["']/g)];
      const mentions = importClauses.filter((match) => match[1].includes("asr-failure-notice"));
      expect(mentions, `${root} 静态引入了 asr-failure-notice`).toEqual([]);
    }
  });
});
