// chat/no-subtitle.js 纯模块测试：无字幕拦截的判定与按原因文案。
// 锁定三件事：
//   - isNoSubtitleEmptyContext：仅「empty 且字幕体为空」拦截（与
//     isContextPending 的 loading 等待语义互补）；字幕体非空一律放行。
//   - buildNoSubtitleNotice：十个 reason + 缺失未知的提示文案与「前往设置」
//     动作位。本模块已退化为薄适配层（票 06）：文案逐字来自 core 的单一真源
//     （buildAsrNoSubtitleMessage 的 sidepanel 面），openSettings 由 remedy
//     枚举映射（open-settings → true，其余 → false）。
//   - NO_SUBTITLE_SEND_BLOCKED：ensureCurrentContextForSend 的类型化拦截信号
//     （chat-runtime 以 !== true 判定提前返回）。

import { describe, expect, it } from "vitest";
import type { SubtitleBodyItem } from "../../extension/ai/types.js";
import {
  NO_SUBTITLE_SEND_BLOCKED,
  buildNoSubtitleNotice,
  isNoSubtitleEmptyContext
} from "../../extension/chat/no-subtitle.js";
import type { NoSubtitleReason } from "../../extension/chat/no-subtitle.js";
// 文案表与 remedy 的入参是 core 联合（不含读边界的 undefined）：本文件的遍历数组
// 用 core 侧类型，chat 侧镜像类型（core | undefined）的兼容性另有用例覆盖。
import type { NoSubtitleReason as CoreNoSubtitleReason } from "../../extension/core/state.js";
import {
  SIDEPANEL_BASE,
  SIDEPANEL_EMPTY_NOTICE,
  getAsrFailureNotice
} from "../../extension/core/asr-failure-notice.js";

describe("NO_SUBTITLE_SEND_BLOCKED", () => {
  it("类型化拦截信号：真值但严格不等 true（chat-runtime 以 !== true 放行）", () => {
    expect(NO_SUBTITLE_SEND_BLOCKED).toBeTruthy();
    expect(NO_SUBTITLE_SEND_BLOCKED).not.toBe(true);
  });
});

describe("isNoSubtitleEmptyContext", () => {
  it("empty 且字幕体为空：拦截", () => {
    expect(isNoSubtitleEmptyContext({ subtitleFetchState: "empty", subtitleBody: [] })).toBe(true);
  });

  it("字幕体非空：一律放行（就绪优先于状态字段）", () => {
    expect(
      isNoSubtitleEmptyContext({
        subtitleFetchState: "empty",
        subtitleBody: [{ from: 0, to: 1, content: "x" }]
      })
    ).toBe(false);
    expect(
      isNoSubtitleEmptyContext({
        subtitleFetchState: "ready",
        subtitleBody: [{ from: 0, to: 1, content: "x" }]
      })
    ).toBe(false);
  });

  it("非 empty 状态不受影响（loading/idle/error/ready 均不拦截）", () => {
    expect(isNoSubtitleEmptyContext({ subtitleFetchState: "loading", subtitleBody: [] })).toBe(false);
    expect(isNoSubtitleEmptyContext({ subtitleFetchState: "idle", subtitleBody: [] })).toBe(false);
    expect(isNoSubtitleEmptyContext({ subtitleFetchState: "error", subtitleBody: [] })).toBe(false);
    expect(isNoSubtitleEmptyContext({ subtitleFetchState: "ready", subtitleBody: [] })).toBe(false);
  });

  it("快照缺失或字幕体字段异常：不拦截（读取失败走既有 false 路径）", () => {
    expect(isNoSubtitleEmptyContext(null)).toBe(false);
    expect(isNoSubtitleEmptyContext(undefined)).toBe(false);
    expect(isNoSubtitleEmptyContext({ subtitleFetchState: "empty" })).toBe(true); // 非数组 body 折算为空
    expect(isNoSubtitleEmptyContext({ subtitleFetchState: "empty", subtitleBody: "x" as unknown as SubtitleBodyItem[] })).toBe(true);
  });
});

describe("buildNoSubtitleNotice（薄适配层：文案单一真源 + remedy → openSettings）", () => {
  it("十类原因逐字等于 sidepanel 面的文案（前缀 + 病因 + 补救）", () => {
    const cases: Array<[NoSubtitleReason, string]> = [
      [
        "no-asr-config",
        `${SIDEPANEL_BASE} 语音识别平台不可用：未配置平台、域名未授权，或这个模型不存在。 请到设置页检查语音转写平台`
      ],
      ["asr-disabled", `${SIDEPANEL_BASE} 语音转写开关已关闭。 可在设置页开启「无字幕时自动生成字幕」后再试`],
      [
        "asr-auth",
        `${SIDEPANEL_BASE} 语音识别平台拒绝了本次请求：API Key 无效、已过期，或没有权限。 请到设置页检查或更换 API Key`
      ],
      ["asr-quota", `${SIDEPANEL_BASE} 语音识别平台的额度或余额不足。 请到平台充值，或稍后重试`],
      ["asr-ratelimit", `${SIDEPANEL_BASE} 请求过于频繁，已被语音识别平台限流。 请稍后重试`],
      ["asr-network", `${SIDEPANEL_BASE} 无法连接语音识别平台（网络不通或请求超时）。 请检查网络后重新抓取`],
      ["asr-media", `${SIDEPANEL_BASE} 这个视频的音轨下载或解码失败（可能受保护，或文件过大）。 可换一个视频，或稍后重新抓取`],
      ["asr-server", `${SIDEPANEL_BASE} 语音识别平台暂时不可用（服务端错误）。 请稍后重新抓取`],
      ["asr-unknown", `${SIDEPANEL_BASE} 语音识别失败，未能识别具体原因。 可重新抓取或稍后重试`],
      // asr-empty 是 sidepanel 面的例外整句（不是「没字幕所以总结不了」）
      ["asr-empty", SIDEPANEL_EMPTY_NOTICE]
    ];

    for (const [reason, expected] of cases) {
      expect(buildNoSubtitleNotice(reason).message).toBe(expected);
    }
  });

  it("openSettings 只由 remedy === open-settings 决定（配置类与鉴权类为 true，其余 false）", () => {
    const openSettingsReasons: CoreNoSubtitleReason[] = ["no-asr-config", "asr-disabled", "asr-auth"];
    const noSettingsReasons: CoreNoSubtitleReason[] = [
      "asr-quota",
      "asr-ratelimit",
      "asr-network",
      "asr-media",
      "asr-server",
      "asr-unknown",
      "asr-empty"
    ];

    for (const reason of openSettingsReasons) {
      expect(buildNoSubtitleNotice(reason).openSettings, String(reason)).toBe(true);
      expect(getAsrFailureNotice(reason).remedy, String(reason)).toBe("open-settings");
    }
    for (const reason of noSettingsReasons) {
      expect(buildNoSubtitleNotice(reason).openSettings, String(reason)).toBe(false);
      expect(getAsrFailureNotice(reason).remedy, String(reason)).not.toBe("open-settings");
    }
    // null 原因给了设置入口（最常见的成因就是压根没配平台）
    expect(buildNoSubtitleNotice(null).openSettings).toBe(true);
  });

  it("reason 缺失：通用文案（基础句 + 通用补救句），附设置入口", () => {
    const expected = {
      message: `${SIDEPANEL_BASE} 可在设置页配置语音识别平台自动生成字幕。`,
      openSettings: true
    };
    expect(buildNoSubtitleNotice(null)).toEqual(expected);
    expect(buildNoSubtitleNotice(undefined)).toEqual(expected);
  });

  it("联合外取值（防御性脏数据）：落中性句 + 重新抓取，不附设置入口", () => {
    // reason 的取值来源是 core 的联合；异常值是「判不出原因」的镜像，
    // 单一真源的兜底是 asr-unknown 的中性句（绝不返回 null 丢原因）。
    expect(buildNoSubtitleNotice("something-else" as unknown as NoSubtitleReason)).toEqual({
      message: `${SIDEPANEL_BASE} 语音识别失败，未能识别具体原因。 可重新抓取或稍后重试`,
      openSettings: false
    });
  });

  it("sidepanel 面不渲染详情行（该面只拿到 contextData.noSubtitleReason，没有 detail 字段）", () => {
    // 票 07 的数据表：sidepanel 侧快照无 noSubtitleDetail；即使报文可展示，
    // 本面也不出现「（错误详情：…）」。
    for (const reason of ["asr-auth", "asr-quota", "asr-unknown", "no-asr-config"] as NoSubtitleReason[]) {
      expect(buildNoSubtitleNotice(reason).message).not.toContain("错误详情");
    }
  });
});
