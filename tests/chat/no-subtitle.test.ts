import { describe, expect, it } from "vitest";
import { buildNoSubtitleNotice } from "../../extension/chat/no-subtitle.js";
import type { NoSubtitleReason } from "../../extension/chat/no-subtitle.js";
import type { NoSubtitleReason as CoreNoSubtitleReason } from "../../extension/core/state.js";
import {
  SIDEPANEL_BASE,
  SIDEPANEL_EMPTY_NOTICE,
  getAsrFailureNotice
} from "../../extension/core/asr-failure-notice.js";

describe("buildNoSubtitleNotice（薄适配层：文案单一真源 + remedy → openSettings）", () => {
  it("十一类原因逐字等于 sidepanel 面的文案（前缀 + 病因 + 补救）", () => {
    const cases: Array<[NoSubtitleReason, string]> = [
      [
        "upower-exclusive",
        `${SIDEPANEL_BASE} 该视频为充电专属视频，未开通充电无法获取完整音轨。 开通充电后可重新抓取生成字幕`
      ],
      [
        "bili-login-required",
        `${SIDEPANEL_BASE} 未登录 B 站，无法获取视频自带字幕。 请登录 B 站后重新抓取`
      ],
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
      ["asr-empty", SIDEPANEL_EMPTY_NOTICE]
    ];

    for (const [reason, expected] of cases) {
      expect(buildNoSubtitleNotice(reason).message).toBe(expected);
    }
  });

  it("openSettings 只由 remedy === open-settings 决定（配置类与鉴权类为 true，其余 false）", () => {
    const openSettingsReasons: CoreNoSubtitleReason[] = ["no-asr-config", "asr-disabled", "asr-auth"];
    const noSettingsReasons: CoreNoSubtitleReason[] = [
      "upower-exclusive",
      "bili-login-required",
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
    expect(buildNoSubtitleNotice("something-else" as unknown as NoSubtitleReason)).toEqual({
      message: `${SIDEPANEL_BASE} 语音识别失败，未能识别具体原因。 可重新抓取或稍后重试`,
      openSettings: false
    });
  });

  it("sidepanel 面不渲染详情行（该面只拿到 contextData.noSubtitleReason，没有 detail 字段）", () => {
    for (const reason of ["asr-auth", "asr-quota", "asr-unknown", "no-asr-config"] as NoSubtitleReason[]) {
      expect(buildNoSubtitleNotice(reason).message).not.toContain("错误详情");
    }
  });
});
