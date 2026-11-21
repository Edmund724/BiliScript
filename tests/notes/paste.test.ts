import { describe, expect, it } from "vitest";

import { normalizeMarkdownForSectionPaste } from "../../extension/notes/paste.js";

describe("normalizeMarkdownForSectionPaste", () => {
  it("默认 baseLevel=2：1-4 级各下移两档，5/6 级夹到最深档 6", () => {
    expect(normalizeMarkdownForSectionPaste("# 一\n## 二\n### 三\n#### 四\n##### 五\n###### 六")).toBe(
      "### 一\n#### 二\n##### 三\n###### 四\n###### 五\n###### 六"
    );
  });

  it("7 个及以上 # 不是标题：原样保留，不会被误加档", () => {
    expect(normalizeMarkdownForSectionPaste("####### 七\n#无空格")).toBe("####### 七\n#无空格");
  });

  it("baseLevel=0 不位移；显式档位同样夹在 6 级以内", () => {
    expect(normalizeMarkdownForSectionPaste("#### 四", 0)).toBe("#### 四");
    expect(normalizeMarkdownForSectionPaste("# 一", 5)).toBe("###### 一");
  });

  it("缩进标题保缩进，正文与列表行不受影响", () => {
    expect(normalizeMarkdownForSectionPaste("  ## 缩进二\n段落 # 井号在中间\n- 列表项")).toBe(
      "  #### 缩进二\n段落 # 井号在中间\n- 列表项"
    );
  });

  it("围栏代码块内不改写标题，围栏标记本身不计开合", () => {
    const input = "```md\n# 不该动\n```\n# 该动";
    expect(normalizeMarkdownForSectionPaste(input)).toBe("```md\n# 不该动\n```\n### 该动");
  });

  it("只含时间戳的行内代码去反引号，其余行内代码保留", () => {
    expect(normalizeMarkdownForSectionPaste("`01:23` 与 `\u4ee3\u7801`")).toBe("01:23 与 `\u4ee3\u7801`");
  });
});
