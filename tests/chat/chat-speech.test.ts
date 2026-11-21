import { afterEach, describe, expect, it, vi } from "vitest";
import { attachChatSpeechPort, TTS_UNSUPPORTED_ERROR } from "../../extension/chat/chat-speech-bg.js";
import { CHAT_SPEECH_PORT_NAME, type ChatSpeechPortMessage } from "../../extension/chat/protocol.js";
import {
  createChatSpeechController,
  createDefaultSpeechEngine,
  createWebSpeechEngine,
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

  it("剔除来源引用编号，保留正文与标点", () => {
    const root = document.createElement("div");
    root.innerHTML = '<p>第一句<sup class="chat-cite">[1]</sup>，第二句<sup class="chat-cite">[12]</sup>。</p>';

    expect(speechTextFromElement(root)).toBe("第一句，第二句。");
  });

  it("表格单元格之间保留间隔", () => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown("| 名称 | 数值 |\n| --- | --- |\n| 甲 | 乙 |");

    expect(speechTextFromElement(root)).toContain("名称 数值");
  });

  it("toggle 支持直接传入 HTMLElement 按需提取，并剔除表格卡片标签与图表降级横幅", async () => {
    const engine = new FakeSpeechEngine();
    engine.voices = [localVoice("local-zh", "zh-CN")];
    const { controller } = makeController(engine);
    const root = document.createElement("div");
    root.innerHTML = `<p>正文内容</p><table><tbody><tr><td>甲</td><td><span class="biliscript-md-table-cell-label">列头</span>乙</td></tr></tbody></table><div class="biliscript-md-mermaid-fallback">图表渲染失败</div>`;
    const button = document.createElement("button");

    await controller.toggle(button, root);
    await vi.waitFor(() => expect(engine.speak).toHaveBeenCalledTimes(1));

    expect(engine.spoken[0].text).toBe("正文内容\n\n甲 乙");
  });
});

describe("语音选择与长文", () => {
  it("自然音色与在线语音优先于本地机械音色，按回答语言精确匹配", async () => {
    const engine = new FakeSpeechEngine();
    engine.voices = [
      localVoice("Microsoft Huihui Desktop", "zh-CN"),
      { voiceName: "Google 普通话（中国大陆）", lang: "zh-CN", remote: true },
      { voiceName: "Microsoft 晓晓 Online (Natural) - Chinese (Mandarin, Simplified)", lang: "zh-CN", remote: true },
      localVoice("local-en", "en-US")
    ];
    const { controller } = makeController(engine);
    const button = document.createElement("button");

    await controller.toggle(button, "中文回答");
    await vi.waitFor(() => expect(engine.speak).toHaveBeenCalled());

    expect(engine.spoken[0].options.voiceName).toBe("Microsoft 晓晓 Online (Natural) - Chinese (Mandarin, Simplified)");
    expect(engine.spoken[0].options.lang).toBe("zh-CN");
  });

  it("无 Natural 标记时在线语音优先于普通本地语音", async () => {
    const engine = new FakeSpeechEngine();
    engine.voices = [
      localVoice("local-zh", "zh-CN"),
      { voiceName: "remote-zh", lang: "zh-CN", remote: true },
      localVoice("local-en", "en-US")
    ];
    const { controller } = makeController(engine);
    const button = document.createElement("button");

    await controller.toggle(button, "中文回答");
    await vi.waitFor(() => expect(engine.speak).toHaveBeenCalled());

    expect(engine.spoken[0].options.voiceName).toBe("remote-zh");
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

  it("同一消息换上新按钮后仍按消息身份停止，旧按钮脱离 DOM 不影响", async () => {
    const engine = new FakeSpeechEngine();
    engine.voices = [localVoice("local-zh", "zh-CN")];
    const { controller } = makeController(engine);
    const first = document.createElement("button");
    document.body.appendChild(first);

    await controller.toggle(first, "同一条回答", { messageId: "message-1" });
    await vi.waitFor(() => expect(engine.speak).toHaveBeenCalledTimes(1));
    first.remove();
    const replacement = document.createElement("button");
    replacement.setAttribute("aria-label", "朗读回答");
    await controller.toggle(replacement, "同一条回答", { messageId: "message-1" });

    expect(engine.stop).toHaveBeenCalledTimes(1);
    expect(engine.speak).toHaveBeenCalledTimes(1);
    expect(replacement.getAttribute("aria-label")).toBe("朗读回答");
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

  it("在线语音合成报错时自动回退到本地匹配语音", async () => {
    const engine = new FakeSpeechEngine();
    engine.voices = [
      localVoice("local-zh", "zh-CN"),
      { voiceName: "remote-zh", lang: "zh-CN", remote: true }
    ];
    const { controller, onError } = makeController(engine);
    const button = document.createElement("button");

    await controller.toggle(button, "中文回答");
    await vi.waitFor(() => expect(engine.speak).toHaveBeenCalledTimes(1));
    expect(engine.spoken[0].options.voiceName).toBe("remote-zh");

    engine.emit(0, "error");
    await vi.waitFor(() => expect(engine.speak).toHaveBeenCalledTimes(2));

    expect(engine.spoken[1].options.voiceName).toBe("local-zh");
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

  it("三态按钮：getVoices 等待与首包到达前为 is-loading，start 后为 is-speaking；loading 期间点击可中止；无可用语音给出明确提示", async () => {
    let resolveVoices!: (voices: ChatSpeechVoice[]) => void;
    const engine = new FakeSpeechEngine();
    engine.getVoices = vi.fn(() => new Promise<ChatSpeechVoice[]>((resolve) => {
      resolveVoices = resolve;
    }));
    const { controller, onError } = makeController(engine);
    const button = document.createElement("button");

    const pending = controller.toggle(button, "准备朗读");
    expect(button.classList.contains("is-loading")).toBe(true);
    expect(button.classList.contains("is-speaking")).toBe(false);

    await controller.toggle(button, "准备朗读");
    expect(button.classList.contains("is-loading")).toBe(false);
    resolveVoices([localVoice("local-zh", "zh-CN")]);
    await pending;
    expect(engine.speak).not.toHaveBeenCalled();

    engine.getVoices = vi.fn(async () => [localVoice("local-zh", "zh-CN")]);
    await controller.toggle(button, "正式朗读");
    await vi.waitFor(() => expect(engine.speak).toHaveBeenCalledTimes(1));
    expect(button.classList.contains("is-loading")).toBe(true);
    expect(button.classList.contains("is-speaking")).toBe(false);
    engine.emit(0, "start");
    expect(button.classList.contains("is-loading")).toBe(false);
    expect(button.classList.contains("is-speaking")).toBe(true);
    controller.stop();

    engine.getVoices = vi.fn(async () => []);
    await controller.toggle(button, "空语音测试");
    expect(onError).toHaveBeenCalledWith("当前设备未找到可用朗读语音");
  });

  it("speechTextFromElement 跳过代码块操作栏（.biliscript-md-code-bar），不朗读语言与复制文案", () => {
    const root = document.createElement("div");
    root.innerHTML = `<p>前面一句</p><div class="biliscript-md-code"><div class="biliscript-md-code-bar"><span class="biliscript-md-code-lang">typescript</span><button class="biliscript-md-code-copy">复制代码</button></div><pre><code>const x = 1;</code></pre></div><p>后面一句</p>`;
    const spoken = speechTextFromElement(root);
    expect(spoken).not.toContain("typescript");
    expect(spoken).not.toContain("复制代码");
    expect(spoken).toContain("前面一句");
    expect(spoken).toContain("代码块，已跳过。");
    expect(spoken).toContain("后面一句");
  });
});

describe("音量对齐", () => {
  it("getVolume 提供时透传当前音量到 speak options", async () => {
    const engine = new FakeSpeechEngine();
    engine.voices = [localVoice("local-zh", "zh-CN")];
    const controller = createChatSpeechController({
      engine,
      getBrowserLanguage: () => "zh-CN",
      getVolume: () => 0.25
    });
    const button = document.createElement("button");

    await controller.toggle(button, "测试音量对齐");
    await vi.waitFor(() => expect(engine.speak).toHaveBeenCalledTimes(1));

    expect(engine.spoken[0].options.volume).toBe(0.25);
  });

  it("分块续读期间动态读取最新音量", async () => {
    const engine = new FakeSpeechEngine();
    engine.voices = [localVoice("local-zh", "zh-CN")];
    let currentVolume = 0.6;
    const controller = createChatSpeechController({
      engine,
      getBrowserLanguage: () => "zh-CN",
      getVolume: () => currentVolume
    });
    const button = document.createElement("button");

    await controller.toggle(button, "第一句。\n\n第二句。", { maxChunkChars: 6 });
    await vi.waitFor(() => expect(engine.speak).toHaveBeenCalledTimes(1));
    expect(engine.spoken[0].options.volume).toBe(0.6);

    currentVolume = 0.2;
    engine.emit(0, "end");
    await vi.waitFor(() => expect(engine.speak).toHaveBeenCalledTimes(2));
    expect(engine.spoken[1].options.volume).toBe(0.2);
  });

  it("音量越界时归一化至 [0, 1]，非法数值回落 undefined", async () => {
    const engine = new FakeSpeechEngine();
    engine.voices = [localVoice("local-zh", "zh-CN")];
    let currentVolume: number | undefined = -0.5;
    const controller = createChatSpeechController({
      engine,
      getBrowserLanguage: () => "zh-CN",
      getVolume: () => currentVolume
    });
    const button = document.createElement("button");

    await controller.toggle(button, "负数音量");
    await vi.waitFor(() => expect(engine.speak).toHaveBeenCalledTimes(1));
    expect(engine.spoken[0].options.volume).toBe(0);

    controller.stop();
    currentVolume = 1.8;
    await controller.toggle(button, "超上限音量");
    await vi.waitFor(() => expect(engine.speak).toHaveBeenCalledTimes(2));
    expect(engine.spoken[1].options.volume).toBe(1);

    controller.stop();
    currentVolume = Number.NaN;
    await controller.toggle(button, "NaN 音量");
    await vi.waitFor(() => expect(engine.speak).toHaveBeenCalledTimes(3));
    expect(engine.spoken[2].options.volume).toBeUndefined();
  });

  it("toggle options.volume 显式传入时优先于 getVolume", async () => {
    const engine = new FakeSpeechEngine();
    engine.voices = [localVoice("local-zh", "zh-CN")];
    const controller = createChatSpeechController({
      engine,
      getBrowserLanguage: () => "zh-CN",
      getVolume: () => 0.1
    });
    const button = document.createElement("button");

    await controller.toggle(button, "手动指定音量", { volume: 0.8 });
    await vi.waitFor(() => expect(engine.speak).toHaveBeenCalledTimes(1));

    expect(engine.spoken[0].options.volume).toBe(0.8);
  });
});

describe("SW 朗读端口跨标签页抢占", () => {
  it("新端口发起 speak 时主动向旧活动端口补发 interrupted，避免被抢占标签页按钮卡死", () => {
    const ttsCallbacks: Array<(event: { type: string }) => void> = [];
    vi.stubGlobal("chrome", {
      tts: {
        speak: vi.fn((_text: string, options: { onEvent: (event: { type: string }) => void }) => {
          const prev = ttsCallbacks.at(-1);
          ttsCallbacks.push(options.onEvent);
          prev?.({ type: "interrupted" });
        }),
        stop: vi.fn(),
        getVoices: vi.fn(async () => [])
      }
    });

    function makeMockPort() {
      const messageListeners: Array<(msg: unknown) => void> = [];
      const disconnectListeners: Array<() => void> = [];
      const sent: ChatSpeechPortMessage[] = [];
      const port = {
        name: CHAT_SPEECH_PORT_NAME,
        postMessage: vi.fn((msg: ChatSpeechPortMessage) => sent.push(msg)),
        onMessage: { addListener: (fn: (msg: unknown) => void) => messageListeners.push(fn) },
        onDisconnect: { addListener: (fn: () => void) => disconnectListeners.push(fn) }
      } as unknown as chrome.runtime.Port;
      attachChatSpeechPort(port);
      return {
        sent,
        emitMessage: (msg: unknown) => messageListeners.forEach((fn) => fn(msg))
      };
    }

    const tabA = makeMockPort();
    const tabB = makeMockPort();

    tabA.emitMessage({ type: "speak", requestId: 1, text: "标签页A朗读" });
    expect(tabA.sent).toEqual([]);

    tabB.emitMessage({ type: "speak", requestId: 1, text: "标签页B朗读" });
    expect(tabA.sent).toEqual([
      { type: "event", requestId: 1, event: { type: "interrupted" } }
    ]);

    ttsCallbacks[1]?.({ type: "end" });
    expect(tabB.sent).toEqual([
      { type: "event", requestId: 1, event: { type: "end" } }
    ]);
  });

  it("端口因 bfcache 断开时消费 runtime.lastError", () => {
    let lastErrorRead = false;
    const disconnectListeners: Array<() => void> = [];
    vi.stubGlobal("chrome", {
      runtime: {
        get lastError() {
          lastErrorRead = true;
          return { message: "The page keeping the extension port is moved into back/forward cache, so the message channel is closed." };
        }
      },
      tts: { stop: vi.fn() }
    });
    const port = {
      name: CHAT_SPEECH_PORT_NAME,
      postMessage: vi.fn(),
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: (fn: () => void) => disconnectListeners.push(fn) }
    } as unknown as chrome.runtime.Port;

    expect(attachChatSpeechPort(port)).toBe(true);
    disconnectListeners.forEach((fn) => fn());
    expect(lastErrorRead).toBe(true);
  });
});

describe("Web Speech 引擎与自适应回退", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function createFakeSynth(initialVoices: SpeechSynthesisVoice[] = []) {
    const listeners = new Map<string, Set<() => void>>();
    let voices = initialVoices;
    const spoken: Array<Record<string, unknown>> = [];
    const synth = {
      getVoices: vi.fn(() => voices),
      speak: vi.fn((utterance: SpeechSynthesisUtterance) => {
        spoken.push(utterance as unknown as Record<string, unknown>);
      }),
      cancel: vi.fn(),
      addEventListener: vi.fn((event: string, listener: () => void, options?: { once?: boolean }) => {
        let bucket = listeners.get(event);
        if (!bucket) {
          bucket = new Set();
          listeners.set(event, bucket);
        }
        const wrapped = options?.once
          ? () => {
              bucket!.delete(wrapped);
              listener();
            }
          : listener;
        bucket.add(wrapped);
      }),
      removeEventListener: vi.fn((event: string, listener: () => void) => {
        listeners.get(event)?.delete(listener);
      })
    } as unknown as SpeechSynthesis;
    return {
      synth,
      spoken,
      setVoices(next: SpeechSynthesisVoice[]) {
        voices = next;
      },
      emitVoicesChanged() {
        Array.from(listeners.get("voiceschanged") ?? []).forEach((fn) => fn());
      }
    };
  }

  function makeFakeUtterance(text: string): SpeechSynthesisUtterance {
    return { text } as unknown as SpeechSynthesisUtterance;
  }

  function nativeVoice(name: string, lang: string, localService: boolean): SpeechSynthesisVoice {
    return { name, lang, localService, default: false, voiceURI: name } as SpeechSynthesisVoice;
  }

  it("首次 getVoices 为空时等待 voiceschanged 并正确映射音色；未触发时 800ms 超时兜底", async () => {
    const fake = createFakeSynth([]);
    const engine = createWebSpeechEngine(fake.synth, makeFakeUtterance);
    const pending = engine.getVoices();

    fake.setVoices([
      nativeVoice("Firefox Local", "zh-CN", true),
      nativeVoice("Cloud Voice", "en-US", false)
    ]);
    fake.emitVoicesChanged();

    await expect(pending).resolves.toEqual([
      { voiceName: "Firefox Local", lang: "zh-CN", remote: false },
      { voiceName: "Cloud Voice", lang: "en-US", remote: true }
    ]);

    vi.useFakeTimers();
    const timeoutFake = createFakeSynth([]);
    const timeoutEngine = createWebSpeechEngine(timeoutFake.synth, makeFakeUtterance);
    const timeoutPromise = timeoutEngine.getVoices();
    timeoutFake.setVoices([nativeVoice("Delayed Voice", "zh-CN", true)]);
    await vi.advanceTimersByTimeAsync(800);

    await expect(timeoutPromise).resolves.toEqual([
      { voiceName: "Delayed Voice", lang: "zh-CN", remote: false }
    ]);
  });

  it("speak 先清理残留并绑定匹配的 utterance.voice、lang 与钳制后的 volume", async () => {
    const zhVoice = nativeVoice("Microsoft Xiaoxiao", "zh-CN", false);
    const fake = createFakeSynth([zhVoice]);
    const engine = createWebSpeechEngine(fake.synth, makeFakeUtterance);

    await engine.getVoices();
    engine.speak("第一句", { voiceName: "Microsoft Xiaoxiao", lang: "zh-CN", volume: 1.5 });
    engine.speak("第二句", { voiceName: "Microsoft Xiaoxiao", lang: "zh-CN", volume: -0.2 });

    expect(fake.synth.cancel).toHaveBeenCalledTimes(2);
    expect(fake.spoken[0].voice).toBe(zhVoice);
    expect(fake.spoken[0].lang).toBe("zh-CN");
    expect(fake.spoken[0].volume).toBe(1);
    expect(fake.spoken[1].volume).toBe(0);
  });

  it("配合控制器支持分块续读并在全部结束后恢复按钮", async () => {
    const fake = createFakeSynth([nativeVoice("Local ZH", "zh-CN", true)]);
    const engine = createWebSpeechEngine(fake.synth, makeFakeUtterance);
    const { controller } = makeController(engine);
    const button = document.createElement("button");

    await controller.toggle(button, "第一段。\n\n第二段。", { maxChunkChars: 5 });
    await vi.waitFor(() => expect(fake.synth.speak).toHaveBeenCalledTimes(1));

    const first = fake.spoken[0] as unknown as SpeechSynthesisUtterance;
    first.onstart?.({} as SpeechSynthesisEvent);
    expect(button.classList.contains("is-speaking")).toBe(true);
    first.onboundary?.({} as SpeechSynthesisEvent);
    first.onend?.({} as SpeechSynthesisEvent);

    await vi.waitFor(() => expect(fake.synth.speak).toHaveBeenCalledTimes(2));
    const second = fake.spoken[1] as unknown as SpeechSynthesisUtterance;
    second.onend?.({} as SpeechSynthesisEvent);

    expect(button.getAttribute("aria-label")).toBe("朗读回答");
    expect(button.classList.contains("is-speaking")).toBe(false);
  });

  it("stop()、pagehide 与 canceled/interrupted 错误事件正确归一且不触发报错", () => {
    const fake = createFakeSynth([nativeVoice("Local ZH", "zh-CN", true)]);
    const engine = createWebSpeechEngine(fake.synth, makeFakeUtterance);
    const events: ChatSpeechEvent[] = [];

    engine.speak("测试停止", { onEvent: (event) => events.push(event) });
    const first = fake.spoken[0] as unknown as SpeechSynthesisUtterance;
    engine.stop();
    expect(fake.synth.cancel).toHaveBeenCalledTimes(2);
    first.onend?.({} as SpeechSynthesisEvent);
    expect(events).toEqual([]);

    engine.speak("外部取消", { onEvent: (event) => events.push(event) });
    const second = fake.spoken[1] as unknown as SpeechSynthesisUtterance;
    second.onerror?.({ error: "canceled" } as unknown as SpeechSynthesisErrorEvent);

    engine.speak("外部打断", { onEvent: (event) => events.push(event) });
    const third = fake.spoken[2] as unknown as SpeechSynthesisUtterance;
    third.onerror?.({ error: "interrupted" } as unknown as SpeechSynthesisErrorEvent);

    engine.speak("真实失败", { onEvent: (event) => events.push(event) });
    const fourth = fake.spoken[3] as unknown as SpeechSynthesisUtterance;
    fourth.onerror?.({ error: "synthesis-failed" } as unknown as SpeechSynthesisErrorEvent);

    expect(events).toEqual([
      { type: "cancelled" },
      { type: "interrupted" },
      { type: "error", errorMessage: "synthesis-failed" }
    ]);

    window.dispatchEvent(new Event("pagehide"));
    expect(fake.synth.cancel).toHaveBeenCalledTimes(6);

    engine.dispose?.();
    expect(fake.synth.cancel).toHaveBeenCalledTimes(7);
    window.dispatchEvent(new Event("pagehide"));
    expect(fake.synth.cancel).toHaveBeenCalledTimes(7);
  });

  it("后台返回 TTS_UNSUPPORTED 时断开主端口并切换缓存 Web Speech 引擎；无 speechSynthesis 时走原有失败提示", async () => {
    const fake = createFakeSynth([nativeVoice("Firefox Voice", "zh-CN", true)]);
    const disconnectSpies: Array<ReturnType<typeof vi.fn>> = [];
    const connectSpy = vi.fn(() => {
      const clientMessageListeners: Array<(msg: unknown) => void> = [];
      const bgMessageListeners: Array<(msg: unknown) => void> = [];
      const disconnectSpy = vi.fn();
      disconnectSpies.push(disconnectSpy);
      const clientPort = {
        name: CHAT_SPEECH_PORT_NAME,
        postMessage: vi.fn((msg: unknown) => bgMessageListeners.forEach((fn) => fn(msg))),
        disconnect: disconnectSpy,
        onMessage: { addListener: (fn: (msg: unknown) => void) => clientMessageListeners.push(fn) },
        onDisconnect: { addListener: vi.fn() }
      } as unknown as chrome.runtime.Port;
      const bgPort = {
        name: CHAT_SPEECH_PORT_NAME,
        postMessage: vi.fn((msg: unknown) => clientMessageListeners.forEach((fn) => fn(msg))),
        onMessage: { addListener: (fn: (msg: unknown) => void) => bgMessageListeners.push(fn) },
        onDisconnect: { addListener: vi.fn() }
      } as unknown as chrome.runtime.Port;
      attachChatSpeechPort(bgPort);
      return clientPort;
    });

    vi.stubGlobal("chrome", {
      runtime: { connect: connectSpy, lastError: null },
      tts: undefined
    });
    vi.stubGlobal("speechSynthesis", fake.synth);
    vi.stubGlobal("SpeechSynthesisUtterance", function FakeUtterance(this: Record<string, unknown>, text: string) {
      this.text = text;
    });

    const engine = createDefaultSpeechEngine();
    const { controller } = makeController(engine);
    const button = document.createElement("button");

    await controller.toggle(button, "Firefox 朗读测试");
    await vi.waitFor(() => expect(fake.synth.speak).toHaveBeenCalledTimes(1));
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(disconnectSpies[0]).toHaveBeenCalledTimes(1);

    const utterance = fake.spoken[0] as unknown as SpeechSynthesisUtterance;
    expect(utterance.voice).toMatchObject({ name: "Firefox Voice" });
    utterance.onend?.({} as SpeechSynthesisEvent);

    await controller.toggle(button, "第二次朗读");
    await vi.waitFor(() => expect(fake.synth.speak).toHaveBeenCalledTimes(2));
    expect(connectSpy).toHaveBeenCalledTimes(1);
    controller.stop();
    engine.dispose?.();
    const cancelCountAfterDispose = (fake.synth.cancel as ReturnType<typeof vi.fn>).mock.calls.length;
    window.dispatchEvent(new Event("pagehide"));
    expect(fake.synth.cancel).toHaveBeenCalledTimes(cancelCountAfterDispose);

    vi.stubGlobal("speechSynthesis", undefined);
    const fallbackError = vi.fn();
    const noSpeechEngine = createDefaultSpeechEngine();
    const noSpeechController = createChatSpeechController({
      engine: noSpeechEngine,
      getBrowserLanguage: () => "zh-CN",
      onError: fallbackError
    });
    const noSpeechBtn = document.createElement("button");
    await noSpeechController.toggle(noSpeechBtn, "无语音测试");

    expect(TTS_UNSUPPORTED_ERROR).toBe("TTS_UNSUPPORTED");
    expect(disconnectSpies[1]).toHaveBeenCalledTimes(1);
    expect(fallbackError).toHaveBeenCalledWith("当前设备未找到可用朗读语音");
    expect(noSpeechBtn.getAttribute("aria-label")).toBe("朗读回答");
    noSpeechEngine.dispose?.();
  });

  it("缺少 runtime.connect 时不惰性构建 chrome 适配器，直接走 Web Speech 且可完整释放", async () => {
    const createChromeEngine = vi.fn();
    const webDispose = vi.fn();
    const webEngine: ChatSpeechEngine = {
      getVoices: vi.fn(async () => [localVoice("Web ZH", "zh-CN")]),
      speak: vi.fn(),
      stop: vi.fn(),
      dispose: webDispose
    };
    vi.stubGlobal("chrome", undefined);

    const engine = createDefaultSpeechEngine({
      createChromeEngine,
      createWebEngine: () => webEngine
    });

    await expect(engine.getVoices()).resolves.toEqual([localVoice("Web ZH", "zh-CN")]);
    expect(createChromeEngine).not.toHaveBeenCalled();

    engine.dispose?.();
    expect(webDispose).toHaveBeenCalledTimes(1);
  });

  it("speak 路径收到 TTS_UNSUPPORTED 时同样释放主适配器并切换 Web Speech", () => {
    const chromeDispose = vi.fn();
    const chromeEngine: ChatSpeechEngine = {
      getVoices: vi.fn(async () => []),
      speak: vi.fn((_text, options) => {
        options.onEvent?.({ type: "error", errorMessage: TTS_UNSUPPORTED_ERROR });
      }),
      stop: vi.fn(),
      dispose: chromeDispose
    };
    const webSpeak = vi.fn();
    const webEngine: ChatSpeechEngine = {
      getVoices: vi.fn(async () => []),
      speak: webSpeak,
      stop: vi.fn()
    };

    const engine = createDefaultSpeechEngine({
      chromeEngine,
      createWebEngine: () => webEngine
    });

    engine.speak("切换测试", { lang: "zh-CN" });

    expect(chromeDispose).toHaveBeenCalledTimes(1);
    expect(webSpeak).toHaveBeenCalledTimes(1);
    expect(webSpeak).toHaveBeenCalledWith("切换测试", { lang: "zh-CN" });
  });
});
