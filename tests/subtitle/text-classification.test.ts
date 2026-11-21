import { describe, expect, it } from "vitest";
import {
  isNonSpeechSegment,
  isNoSpaceLanguage,
  joinSubtitleText
} from "../../extension/subtitle/text-classification.js";

describe("isNonSpeechSegment：纯音效/环境/说话人标记识别", () => {
  it("识别常见方括号、全角括号、>> 前缀及多标签组合", () => {
    expect(isNonSpeechSegment("[Music]")).toBe(true);
    expect(isNonSpeechSegment("  [Applause]  ")).toBe(true);
    expect(isNonSpeechSegment(">> [Laughter]")).toBe(true);
    expect(isNonSpeechSegment("[Music] [Applause]")).toBe(true);
    expect(isNonSpeechSegment("（音乐）")).toBe(true);
    expect(isNonSpeechSegment("（掌声）")).toBe(true);
    expect(isNonSpeechSegment(">> （笑声）[掌声]")).toBe(true);
  });

  it("识别纯音符或音符包裹行，但不误判仅以音符开头的歌词行", () => {
    expect(isNonSpeechSegment("♪")).toBe(true);
    expect(isNonSpeechSegment("♪♪")).toBe(true);
    expect(isNonSpeechSegment("♪ Music ♪")).toBe(true);
    expect(isNonSpeechSegment("♫ Instrumental ♫")).toBe(true);
    expect(isNonSpeechSegment(">> ♪ 轻音乐 ♪")).toBe(true);
    expect(isNonSpeechSegment("♪ Singing a lyric without closing note")).toBe(false);
    expect(isNonSpeechSegment("♪ Music ♪ and speech")).toBe(false);
  });

  it("包含正常说话内容、普通说话人前缀或空白字符串时返回 false", () => {
    expect(isNonSpeechSegment("")).toBe(false);
    expect(isNonSpeechSegment("   \n\t  ")).toBe(false);
    expect(isNonSpeechSegment("[Music] Hello everyone")).toBe(false);
    expect(isNonSpeechSegment("Hello [Applause]")).toBe(false);
    expect(isNonSpeechSegment(">> Hello everyone")).toBe(false);
    expect(isNonSpeechSegment("这是正常字幕内容")).toBe(false);
  });
});

describe("isNoSpaceLanguage：无空格语言代码与文本判定", () => {
  it("支持 zh/ja/ko/th 等语言代码及变体（含 B 站 ai- 前缀）", () => {
    for (const code of ["zh", "zh-CN", "zh_TW", "zh-Hans", "ai-zh", "ja", "ja-JP", "ko", "ko-KR", "th", "th-TH"]) {
      expect(isNoSpaceLanguage(code)).toBe(true);
    }
    for (const code of ["en", "en-US", "fr", "de", "es", "auto", ""]) {
      expect(isNoSpaceLanguage(code)).toBe(false);
    }
  });

  it("支持直接传入正文文本进行脚本检测", () => {
    expect(isNoSpaceLanguage("你好世界")).toBe(true);
    expect(isNoSpaceLanguage("こんにちは")).toBe(true);
    expect(isNoSpaceLanguage("안녕하세요")).toBe(true);
    expect(isNoSpaceLanguage("สวัสดีครับ")).toBe(true);
    expect(isNoSpaceLanguage("Hello world")).toBe(false);
    expect(isNoSpaceLanguage("the")).toBe(false);
  });
});

describe("joinSubtitleText：中英文与标点边界拼接", () => {
  it("中文及中日韩/泰语文本间不加多余空格", () => {
    expect(joinSubtitleText("你好", "世界")).toBe("你好世界");
    expect(joinSubtitleText("好。", "今天开始。")).toBe("好。今天开始。");
    expect(joinSubtitleText("こんにちは", "世界")).toBe("こんにちは世界");
    expect(joinSubtitleText("안녕하세요", "세계")).toBe("안녕하세요세계");
    expect(joinSubtitleText("สวัสดี", "ครับ")).toBe("สวัสดีครับ");
  });

  it("英文词句之间保留单个空格，且清理首尾冗余空白", () => {
    expect(joinSubtitleText("Hello", "world")).toBe("Hello world");
    expect(joinSubtitleText("  Hello.  ", "  World! ")).toBe("Hello. World!");
    expect(joinSubtitleText('He said "Hi."', "Then left.")).toBe('He said "Hi." Then left.');
    expect(joinSubtitleText("Hello.", "'Hi'")).toBe("Hello. 'Hi'");
    expect(joinSubtitleText("Hello", "world", "en")).toBe("Hello world");
  });

  it("标点紧贴、括号及中英混排边界处理正确", () => {
    expect(joinSubtitleText("Hello", "!")).toBe("Hello!");
    expect(joinSubtitleText("Hello", ",")).toBe("Hello,");
    expect(joinSubtitleText("(", "Hello")).toBe("(Hello");
    expect(joinSubtitleText("这是", "TypeScript")).toBe("这是TypeScript");
    expect(joinSubtitleText("TypeScript", "很好用")).toBe("TypeScript很好用");
    expect(joinSubtitleText("第1章。", "React")).toBe("第1章。React");
    expect(joinSubtitleText("React", "Hooks", "zh")).toBe("React Hooks");
  });

  it("空字符串边界安全返回另一侧裁剪文本", () => {
    expect(joinSubtitleText("", "hello")).toBe("hello");
    expect(joinSubtitleText("hello", "")).toBe("hello");
    expect(joinSubtitleText("  ", "  ")).toBe("");
  });
});
