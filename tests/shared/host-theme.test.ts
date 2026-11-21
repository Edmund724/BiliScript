import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  THEME_SNAPSHOT_STORAGE_KEY,
  applyPrePaintReaderTheme,
  detectBilibiliHostTheme,
  readThemeSnapshot,
  resolveEffectiveTheme,
  resolveReaderThemeMode,
  watchExternalThemeChanges,
  writeThemeSnapshot
} from "../../extension/shared/host-theme.js";

function clearHostThemeDom(): void {
  const html = document.documentElement;
  const body = document.body;
  html.className = "";
  body.className = "";
  for (const attr of [
    "data-dark",
    "data-theme",
    "data-bili-theme",
    "data-color-scheme",
    "data-darkreader-scheme",
    "data-biliscript-onboarding",
    "data-biliscript-reader-theme",
    "data-biliscript-reader-palette",
    "style"
  ]) {
    html.removeAttribute(attr);
    body.removeAttribute(attr);
  }
  body.innerHTML = "";
  window.localStorage.removeItem(THEME_SNAPSHOT_STORAGE_KEY);
}

describe("detectBilibiliHostTheme：B 站原生与插件深色探测", () => {
  beforeEach(() => {
    clearHostThemeDom();
  });

  afterEach(() => {
    clearHostThemeDom();
    vi.restoreAllMocks();
  });

  it("识别 BewlyBewly / BewlyCat 在 html 注入的 .dark 类名", () => {
    document.documentElement.classList.add("dark");
    expect(detectBilibiliHostTheme(document)).toBe("dark");
  });

  it("识别 B 站原生与常见扩展深色属性（data-dark / data-theme / data-darkreader-scheme / body.bili-dark）", () => {
    document.documentElement.setAttribute("data-dark", "true");
    expect(detectBilibiliHostTheme(document)).toBe("dark");

    clearHostThemeDom();
    document.documentElement.setAttribute("data-theme", "dark");
    expect(detectBilibiliHostTheme(document)).toBe("dark");

    clearHostThemeDom();
    document.documentElement.setAttribute("data-darkreader-scheme", "dark");
    expect(detectBilibiliHostTheme(document)).toBe("dark");

    clearHostThemeDom();
    document.body.classList.add("bili-dark");
    expect(detectBilibiliHostTheme(document)).toBe("dark");

    clearHostThemeDom();
    document.documentElement.setAttribute("data-dark", "false");
    expect(detectBilibiliHostTheme(document)).toBe("light");
  });

  it("无显式属性时按宿主背景色或 --bew-bg 计算亮度兜底", () => {
    document.body.style.backgroundColor = "rgb(18, 20, 24)";
    expect(detectBilibiliHostTheme(document)).toBe("dark");

    document.body.style.backgroundColor = "rgb(250, 250, 252)";
    expect(detectBilibiliHostTheme(document)).toBe("light");

    document.body.style.backgroundColor = "transparent";
    expect(detectBilibiliHostTheme(document)).toBeNull();
  });

  it("独立扩展页（data-biliscript-onboarding=1）跳过自身 data-theme，不误判为 B 站宿主", () => {
    document.documentElement.setAttribute("data-biliscript-onboarding", "1");
    document.documentElement.setAttribute("data-theme", "dark");
    expect(detectBilibiliHostTheme(document)).toBeNull();
  });
});

describe("四模式主题解析与存量兼容", () => {
  beforeEach(() => {
    clearHostThemeDom();
  });

  afterEach(() => {
    clearHostThemeDom();
    vi.restoreAllMocks();
  });

  it("resolveReaderThemeMode：新装与存量未手选均落默认 bilibili，手选浅/深原样保留", () => {
    expect(resolveReaderThemeMode(undefined)).toBe("bilibili");
    expect(resolveReaderThemeMode({ readerTheme: "light", readerThemeUserSet: false })).toBe("bilibili");
    expect(resolveReaderThemeMode({ readerTheme: "light", readerThemeUserSet: true })).toBe("light");
    expect(resolveReaderThemeMode({ readerTheme: "dark", readerThemeUserSet: true })).toBe("dark");
    expect(resolveReaderThemeMode({ readerTheme: "system", readerThemeUserSet: false })).toBe("system");
    expect(resolveReaderThemeMode({ readerTheme: "bilibili", readerThemeUserSet: true })).toBe("bilibili");
  });

  it("resolveEffectiveTheme：bilibili 优先跟宿主、无信号回落系统；system 跟系统；light/dark 固定", () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;

    document.documentElement.setAttribute("data-theme", "light");
    expect(resolveEffectiveTheme("bilibili", document)).toBe("light");
    expect(resolveEffectiveTheme("system", document)).toBe("dark");
    expect(resolveEffectiveTheme("light", document)).toBe("light");
    expect(resolveEffectiveTheme("dark", document)).toBe("dark");

    clearHostThemeDom();
    expect(resolveEffectiveTheme("bilibili", document)).toBe("dark");

    window.matchMedia = originalMatchMedia;
  });
});

describe("实时外部监听与首屏防闪烁快照", () => {
  beforeEach(() => {
    clearHostThemeDom();
  });

  afterEach(() => {
    clearHostThemeDom();
    vi.restoreAllMocks();
  });

  it("watchExternalThemeChanges 响应 BewlyBewly .dark 切换与 matchMedia change，并随 AbortSignal 回收", async () => {
    const mediaListeners: Array<() => void> = [];
    const removeListener = vi.fn();
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: (_ev: string, fn: () => void) => { mediaListeners.push(fn); },
      removeEventListener: removeListener
    }) as unknown as typeof window.matchMedia;

    const controller = new AbortController();
    const onChange = vi.fn();
    watchExternalThemeChanges(onChange, { doc: document, signal: controller.signal });

    document.documentElement.classList.add("dark");
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    document.documentElement.setAttribute("data-biliscript-reader-theme", "dark");
    await new Promise((r) => setTimeout(r, 20));
    expect(onChange).toHaveBeenCalledTimes(1);

    mediaListeners.forEach((fn) => fn());
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(2);
    });

    controller.abort();
    expect(removeListener).toHaveBeenCalledTimes(1);
    document.documentElement.classList.remove("dark");
    await new Promise((r) => setTimeout(r, 20));
    expect(onChange).toHaveBeenCalledTimes(2);

    window.matchMedia = originalMatchMedia;
  });

  it("applyPrePaintReaderTheme 同步消费本地快照与宿主探测，在翻门控前落位三处属性", () => {
    const view = document.createElement("section");
    view.id = "biliscript-reading-view";
    document.body.appendChild(view);

    writeThemeSnapshot({ mode: "bilibili", palette: "editorial", resolved: "dark" });
    expect(readThemeSnapshot()).toEqual({ mode: "bilibili", palette: "editorial", resolved: "dark" });

    document.documentElement.classList.add("dark");
    const result = applyPrePaintReaderTheme(undefined, document);
    expect(result).toEqual({ mode: "bilibili", theme: "dark", palette: "editorial" });
    expect(document.documentElement.dataset.biliscriptReaderTheme).toBe("dark");
    expect(document.body.dataset.biliscriptReaderPalette).toBe("editorial");
    expect(view.dataset.theme).toBe("dark");
    expect(view.dataset.palette).toBe("editorial");
  });
});
