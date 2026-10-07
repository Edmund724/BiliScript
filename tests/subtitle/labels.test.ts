// 本扩展 ASR 回退的来源串（2026-09 用户决议，2026-10-04 收窄到只此一支）：
//   - 语言档位只有发起转写那一刻知道，zh / en 附中文 / 英文，auto 与空值不附
//     （宁缺勿猜）；平台名不进串——平台归设置页，串只回答「这段字幕怎么来的」；
//   - 该串生成时定型，同时写进 ASR 伪轨 lanDoc 与 selectedSubtitleLang
//     （asr/fallback），下载文件名与 AI 上下文据此一致。
//
// 面板 meta 行的「字幕：来源（语言）」投影已随 2026-10-04 用户决议（不再注明字幕
// 来源）整条下线：normalizeSubtitleLanguageLabel / isAiSubtitle / isAsrSubtitle /
// buildSubtitleSourceLabel / buildSubtitleOptionViews 与其测试一并退场，此处只留
// ASR 链真实消费的 buildAsrSubtitleLabel。
//
// 本用例随落点迁自 tests/subtitle/selection-labels.test.ts（架构评审「轨道身份」：
// 显示文案归位 subtitle/labels.ts），用例语义不变。

import { describe, expect, it } from "vitest";
import { buildAsrSubtitleLabel } from "../../extension/subtitle/labels.js";

describe("buildAsrSubtitleLabel：本扩展转写的来源串", () => {
  it("语言档位 zh/en 附中文/英文", () => {
    expect(buildAsrSubtitleLabel("zh")).toBe("自配平台转写（中文）");
    expect(buildAsrSubtitleLabel("en")).toBe("自配平台转写（英文）");
  });

  it("auto/空值不附语言（宁缺勿猜）", () => {
    expect(buildAsrSubtitleLabel("auto")).toBe("自配平台转写");
    expect(buildAsrSubtitleLabel("")).toBe("自配平台转写");
    expect(buildAsrSubtitleLabel(undefined)).toBe("自配平台转写");
  });
});
