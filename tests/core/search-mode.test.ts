import { describe, expect, it } from "vitest";
import { SEARCH_PROVIDER_PRESETS } from "../../extension/core/presets.js";
import {
  SMART_SEARCH_ACTIVE_ID,
  isSmartSearchActive,
  resolveSearchMode
} from "../../extension/core/search-mode.js";

describe("搜索模式单源（spec §1 S6 / §12.1）", () => {
  it("哨兵字面量 = __smart__，不以 search_ 开头、≠ 任何 search_<presetId>（§10 第 83 行）", () => {
    expect(SMART_SEARCH_ACTIVE_ID).toBe("__smart__");
    expect(SMART_SEARCH_ACTIVE_ID.startsWith("search_")).toBe(false);
    for (const preset of SEARCH_PROVIDER_PRESETS) {
      expect(SMART_SEARCH_ACTIVE_ID).not.toBe(`search_${preset.id}`);
    }
  });

  it("哨兵 / 空串 / 空白 / null / undefined 都是智能模式", () => {
    for (const activeId of [SMART_SEARCH_ACTIVE_ID, "", "   ", null, undefined]) {
      expect(resolveSearchMode(activeId)).toBe("smart");
      expect(isSmartSearchActive(activeId)).toBe(true);
    }
  });

  it("trim 后判定：带空白的哨兵仍是智能", () => {
    expect(resolveSearchMode(` ${SMART_SEARCH_ACTIVE_ID} `)).toBe("smart");
  });

  it("记录 id（两条生成路径都带 search_ 前缀）都是单选模式", () => {
    for (const activeId of ["search_firecrawl", "search_lx1a2b_7k3d", "tavily-picked"]) {
      expect(resolveSearchMode(activeId)).toBe("single");
      expect(isSmartSearchActive(activeId)).toBe(false);
    }
  });
});
