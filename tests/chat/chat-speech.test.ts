// 朗读控制器的孤立失败方式：
// 1. Markdown 的 URL、代码与标记进入朗读正文，或段落粘连；
// 2. 本地音色未优先匹配，或在线音色与浏览器语言回退失效；
// 3. 长回答超过单次 speak 上限，或分块结束后不续读；
// 4. 停止/切换后，迟到的 getVoices 与旧 utterance 事件污染新状态；
// 5. 自然结束、无任何匹配语音和 speak 失败后按钮未恢复或错误不可见。
import { describe, expect, it, vi } from "vitest";
import {
  createChatSpeechController,
  speechTextFromElement,
  splitSpeechText,
  type ChatSpeechEngine,
  type ChatSpeechEvent,
  type ChatSpeechSpeakOptions,
  type ChatSpeechVoice
} from "../../extension/chat/chat-speech.js";
import { renderMarkdown } from "../../extension/ui/markdown.js";

class FakeSpeechEngine implements ChatSpeechEngine {
  voices: ChatSpeechVoice[] = [];
  spoken: Array<{ text: string; options: ChatSpeechSpeakOptions }> = [];
  getVoices = vi.fn(async (): Promise<ChatSpeechVoice[]> => this.voices);
  stop = vi.fn();
  speak = vi.fn((text: string, options: ChatSpeechSpeakOptions) => {
    this.spoken.push({ text, options });
  });

  emit(index: number, type: ChatSpeechEvent["type"]): void {
    this.spoken[index].options.onEvent?.({ type });
  }
}

function localVoice(voiceName: string, lang: string): ChatSpeechVoice {
  return { voiceName, lang, remote: false };
}

function makeController(engine: ChatSpeechEngine, onError = vi.fn()) {
  return {
    controller: createChatSpeechController({ engine, getBrowserLanguage: () => "zh-CN", onError }),
    onError
  };
}

describe("朗读正文", () => {
  it("只读可见文本：链接不读 URL，代码块提示跳过，段落保持分隔", () => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown("第一段\n\n[链接文字](https://example.com/path)\n\n```js\nconst secret = 1;\n```\n\n第二段");

    const text = speechTextFromElement(root);

    expect(text).toContain("第一段\n\n链接文字");
    expect(text).toContain("代码块，已跳过。");
    expect(text).toContain("第二段");
    expect(text).not.toContain("https://");
    expect(text).not.toContain("const secret");
    expect(text).not.toContain("```");
  });

  it("表格单元格之间保留间隔", () => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown("| 名称 | 数值 |\n| --- | --- |\n| 甲 | 乙 |");

    expect(speechTextFromElement(root)).toContain("名称 数值");
  });
});

describe("语音选择与长文", () => {
  it("本地语音优先于在线语音，按回答语言精确匹配", async () => {
    const engine = new FakeSpeechEngine();
    engine.voices = [
      { voiceName: "remote-zh", lang: "zh-CN", remote: true },
      localVoice("local-en", "en-US"),
      localVoice("local-zh", "zh-CN")
    ];
    const { controller } = makeController(engine);
    const button = document.createElement("button");

    await controller.toggle(button, "中文回答");
    await vi.waitFor(() => expect(engine.speak).toHaveBeenCalled());

    expect(engine.spoken[0].options.voiceName).toBe("local-zh");
    expect(engine.spoken[0].options.lang).toBe("zh-CN");
  });

  it("回答语言无匹配时回退浏览器本地语言", async () => {
    const engine = new FakeSpeechEngine();
    engine.voices = [localVoice("local-en", "en-US"), localVoice("browser-zh", "zh-CN")];
    const { controller } = makeController(engine);

    await controller.toggle(document.createElement("button"), "日本語");
    await vi.waitFor(() => expect(engine.speak).toHaveBeenCalled());

    expect(engine.spoken[0].options.voiceName).toBe("browser-zh");
  });

  it("按段落和句子软切分，任何分块都不超过上限", () => {
    const chunks = splitSpeechText(`${"短句。".repeat(20)}\n\n${"下一段。".repeat(20)}`, 60);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 60)).toBe(true);
    expect(chunks.join("")).toContain("短句。");
    expect(chunks.join("")).toContain("下一段。");
  });

  it("一块自然结束后续读下一块，末块结束恢复按钮", async () => {
    const engine = new FakeSpeechEngine();
    engine.voices = [localVoice("local-zh", "zh-CN")];
    const { controller } = makeController(engine);
    const button = document.createElement("button");

    await controller.toggle(button, "第一段。\n\n第二段。", { maxChunkChars: 5 });
    await vi.waitFor(() => expect(engine.speak).toHaveBeenCalledTimes(1));
    engine.emit(0, "end");
    await vi.waitFor(() => expect(engine.speak).toHaveBeenCalledTimes(2));
    engine.emit(1, "end");

    expect(button.getAttribute("aria-label")).toBe("朗读回答");
    expect(button.classList.contains("is-speaking")).toBe(false);
  });
});

describe("停止、切换与失败", () => {
  it("再次点击停止，点击另一回答会复位旧按钮", async () => {
    const engine = new FakeSpeechEngine();
    engine.voices = [localVoice("local-zh", "zh-CN")];
    const { controller } = makeController(engine);
    const first = document.createElement("button");
    const second = document.createElement("button");

    await controller.toggle(first, "第一条");
    await vi.waitFor(() => expect(engine.speak).toHaveBeenCalledTimes(1));
    await controller.toggle(second, "第二条");

    expect(engine.stop).toHaveBeenCalled();
    expect(first.getAttribute("aria-label")).toBe("朗读回答");
    expect(second.getAttribute("aria-label")).toBe("停止朗读");

    await controller.toggle(second, "第二条");
    expect(engine.stop).toHaveBeenCalledTimes(2);
    expect(second.getAttribute("aria-label")).toBe("朗读回答");
  });

  it("getVoices 尚未返回时停止，迟到的结果不再发声", async () => {
    const engine = new FakeSpeechEngine();
    let releaseVoices: (voices: ChatSpeechVoice[]) => void = () => {};
    engine.getVoices = vi.fn(() => new Promise<ChatSpeechVoice[]>((resolve) => {
      releaseVoices = resolve;
    }));
    const { controller } = makeController(engine);
    const button = document.createElement("button");

    const pending = controller.toggle(button, "等待语音");
    controller.stop();
    releaseVoices([localVoice("local-zh", "zh-CN")]);
    await pending;

    expect(engine.speak).not.toHaveBeenCalled();
    expect(button.getAttribute("aria-label")).toBe("朗读回答");
  });

  it("旧 utterance 的迟到 end 不会停止新回答", async () => {
    const engine = new FakeSpeechEngine();
    engine.voices = [localVoice("local-zh", "zh-CN")];
    const { controller } = makeController(engine);
    const first = document.createElement("button");
    const second = document.createElement("button");

    await controller.toggle(first, "第一条");
    await vi.waitFor(() => expect(engine.speak).toHaveBeenCalledTimes(1));
    const oldEvent = engine.spoken[0].options.onEvent;
    await controller.toggle(second, "第二条");
    await vi.waitFor(() => expect(engine.speak).toHaveBeenCalledTimes(2));
    oldEvent?.({ type: "end" });

    expect(second.getAttribute("aria-label")).toBe("停止朗读");
  });

  it("没有本地匹配语音时回退在线语音", async () => {
    const engine = new FakeSpeechEngine();
    engine.voices = [{ voiceName: "remote-zh", lang: "zh-CN", remote: true }];
    const { controller, onError } = makeController(engine);
    const button = document.createElement("button");

    await controller.toggle(button, "中文回答");
    await vi.waitFor(() => expect(engine.speak).toHaveBeenCalledTimes(1));

    expect(engine.spoken[0].options.voiceName).toBe("remote-zh");
    expect(onError).not.toHaveBeenCalled();
    expect(button.getAttribute("aria-label")).toBe("停止朗读");
  });

  it("utterance 错误恢复按钮并提示，重试可以重新发起", async () => {
    const engine = new FakeSpeechEngine();
    engine.voices = [localVoice("local-zh", "zh-CN")];
    const { controller, onError } = makeController(engine);
    const button = document.createElement("button");

    await controller.toggle(button, "回答");
    await vi.waitFor(() => expect(engine.speak).toHaveBeenCalledTimes(1));
    engine.emit(0, "error");

    expect(onError).toHaveBeenCalledWith("当前设备无法朗读");
    expect(button.getAttribute("aria-label")).toBe("朗读回答");

    await controller.toggle(button, "回答");
    await vi.waitFor(() => expect(engine.speak).toHaveBeenCalledTimes(2));
  });
});
