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
