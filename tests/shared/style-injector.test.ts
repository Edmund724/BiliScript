// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

const READER_PATHS = [
  "entry/styles/tokens-primitive.css",
  "entry/styles/reader.css",
  "entry/styles/reader-gate.css"
];
const PLAYER_AI_PATH = "entry/styles/player-ai.css";
const SETTINGS_PATHS = [
  "entry/styles/reader-settings-shell.css",
  "entry/styles/reader-settings-rows.css",
  "entry/styles/reader-settings-providers.css"
];

function loadInjector() {
  return import("../../extension/shared/style-injector.js");
}

function mirroredStyleElements(doc: Document): HTMLStyleElement[] {
  return Array.from(doc.querySelectorAll<HTMLStyleElement>('style[data-biliscript-style="1"]'));
}

function mirroredStylePaths(doc: Document): string[] {
  return mirroredStyleElements(doc).map((el) => el.dataset.biliscriptStylePath || "");
}

interface StyleIpcRecord {
  type: string;
  files: string[];
}

function installStyleIpcRecorder(options?: {
  holdInsert?: boolean;
  holdRead?: boolean;
  failInsert?: boolean;
}) {
  const calls: StyleIpcRecord[] = [];
  const pendingInserts: Array<() => void> = [];
  const pendingReads: Array<() => void> = [];
  const mounted = new Set<string>();

  vi.mocked(chrome.runtime.sendMessage).mockImplementation(
    (rawMessage: unknown, callback?: (resp?: unknown) => void) => {
      const msg = rawMessage as { type?: string; files?: string[] };
      if (msg?.type === "content-style-insert" && Array.isArray(msg.files)) {
        const files = [...msg.files];
        calls.push({ type: msg.type, files });
        const finish = () => {
          if (options?.failInsert) {
            callback?.({ ok: false, error: "failed" });
            return;
          }
          files.forEach((f) => mounted.add(f));
          callback?.({ ok: true });
        };
        if (options?.holdInsert) {
          pendingInserts.push(finish);
        } else {
          finish();
        }
        return undefined;
      }
      if (msg?.type === "content-style-remove" && Array.isArray(msg.files)) {
        const files = [...msg.files];
        calls.push({ type: msg.type, files });
        files.forEach((f) => mounted.delete(f));
        callback?.({ ok: true });
        return undefined;
      }
      if (msg?.type === "content-style-read" && Array.isArray(msg.files)) {
        const files = [...msg.files];
        calls.push({ type: msg.type, files });
        const finish = () => {
          const styles: Record<string, string> = {};
          for (const f of files) {
            styles[f] = `/* ${f} */`;
          }
          callback?.({ ok: true, styles });
        };
        if (options?.holdRead) {
          pendingReads.push(finish);
        } else {
          finish();
        }
        return undefined;
      }
      callback?.({ ok: true });
      return undefined;
    }
  );

  return { calls, pendingInserts, pendingReads, mounted };
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("style-injector 挂载生命周期", () => {
  it("ensureReaderStyles 按级联顺序批量发 content-style-insert 且不在主文档创建 link", async () => {
    const rec = installStyleIpcRecorder({ holdInsert: true });
    const injector = await loadInjector();
    let settled = false;
    const ready = injector.ensureReaderStyles().then(() => {
      settled = true;
    });

    expect(rec.calls).toEqual([{ type: "content-style-insert", files: READER_PATHS }]);
    expect(document.querySelectorAll("link")).toHaveLength(0);
    await Promise.resolve();
    expect(settled).toBe(false);

    rec.pendingInserts.shift()?.();
    await ready;
    expect(settled).toBe(true);
    expect([...rec.mounted]).toEqual(READER_PATHS);
  });

  it("幂等：重复 ensure 不重复发 IPC；未挂时 remove 是零 IPC no-op", async () => {
    const rec = installStyleIpcRecorder();
    const injector = await loadInjector();

    injector.removeReaderStyles();
    injector.removePlayerAiStyles();
    expect(rec.calls).toHaveLength(0);

    await Promise.all([injector.ensureReaderStyles(), injector.ensureReaderStyles()]);
    injector.ensurePlayerAiStyles();
    injector.ensurePlayerAiStyles();
    await Promise.resolve();

    expect(rec.calls).toEqual([
      { type: "content-style-insert", files: READER_PATHS },
      { type: "content-style-insert", files: [PLAYER_AI_PATH] }
    ]);
    expect(document.querySelectorAll("link")).toHaveLength(0);
  });

  it("扩展自源页（chrome-extension:// / moz-extension://）不触发 content-style-insert/remove IPC", async () => {
    const rec = installStyleIpcRecorder();
    const injector = await loadInjector();
    const jsdomApi = (globalThis as unknown as { jsdom?: { reconfigure: (opts: { url: string }) => void } }).jsdom;
    if (jsdomApi) {
      jsdomApi.reconfigure({ url: "chrome-extension://test-ext/onboarding.html" });
      try {
        await injector.ensureReaderStyles();
        injector.ensureCustomSelectStyles();
        injector.removeReaderStyles();
        expect(rec.calls).toHaveLength(0);
      } finally {
        jsdomApi.reconfigure({ url: "https://www.bilibili.com/video/BV1test000000/" });
      }
    }
  });

  it("开→关→开：remove 发 content-style-remove 并允许再次 ensure 重新注入", async () => {
    const rec = installStyleIpcRecorder();
    const injector = await loadInjector();

    await injector.ensureReaderStyles();
    injector.ensurePlayerAiStyles();
    await Promise.resolve();
    expect(rec.mounted.size).toBe(4);

    injector.removeReaderStyles();
    await vi.waitFor(() => expect([...rec.mounted]).toEqual([PLAYER_AI_PATH]));

    await injector.ensureReaderStyles();
    expect(rec.mounted.size).toBe(4);
    expect(rec.calls.map((c) => c.type)).toEqual([
      "content-style-insert",
      "content-style-insert",
      "content-style-remove",
      "content-style-insert"
    ]);
  });

  it("insert 失败或超时有界返回，且允许后续重试", async () => {
    const rec = installStyleIpcRecorder({ failInsert: true });
    const injector = await loadInjector();

    await expect(injector.ensureReaderStyles()).resolves.toBeUndefined();
    expect(rec.mounted.size).toBe(0);

    const rec2 = installStyleIpcRecorder();
    await injector.ensureReaderStyles();
    expect(rec2.calls).toEqual([{ type: "content-style-insert", files: READER_PATHS }]);
    expect([...rec2.mounted]).toEqual(READER_PATHS);
  });

  it("syncStylesToDocument 经 content-style-read 缓存文本、按级联顺序幂等镜像且零 chrome-extension link", async () => {
    const rec = installStyleIpcRecorder();
    const injector = await loadInjector();
    await injector.ensureReaderStyles();
    injector.ensureReaderChatStyles();
    await Promise.resolve();

    const detachedDoc = document.implementation.createHTMLDocument("Detached");
    await injector.syncStylesToDocument(document);
    expect(document.querySelectorAll('style[data-biliscript-style="1"]')).toHaveLength(0);

    await injector.syncStylesToDocument(detachedDoc);
    await injector.syncStylesToDocument(detachedDoc);

    expect(detachedDoc.querySelectorAll("link")).toHaveLength(0);
    expect(mirroredStylePaths(detachedDoc)).toEqual([
      ...READER_PATHS,
      "entry/styles/github-markdown.css",
      "entry/styles/github-markdown-theme.css",
      "entry/styles/reader-chat.css"
    ]);
    expect(rec.calls.filter((c) => c.type === "content-style-read")).toHaveLength(1);

    const secondDetachedDoc = document.implementation.createHTMLDocument("Detached2");
    await injector.syncStylesToDocument(secondDetachedDoc);
    expect(rec.calls.filter((c) => c.type === "content-style-read")).toHaveLength(1);
    expect(mirroredStylePaths(secondDetachedDoc)).toHaveLength(6);
  });

  it("支持同 realm Constructable Stylesheets（adoptedStyleSheets）并在移除时仅摘除自有样式表", async () => {
    installStyleIpcRecorder();
    const injector = await loadInjector();
    await injector.ensureReaderStyles();
    injector.ensurePlayerAiStyles();
    await Promise.resolve();

    class FakeSheet {
      cssText = "";
      replaceSync(text: string): void {
        this.cssText = text;
      }
    }
    const foreignSheet = new FakeSheet();
    const detachedDoc = document.implementation.createHTMLDocument("DetachedAdopted");
    let adoptedSheets: unknown[] = [foreignSheet];
    Object.defineProperty(detachedDoc, "defaultView", {
      value: { CSSStyleSheet: FakeSheet },
      configurable: true
    });
    Object.defineProperty(detachedDoc, "adoptedStyleSheets", {
      get: () => adoptedSheets,
      set: (next: unknown[]) => {
        adoptedSheets = next;
      },
      configurable: true
    });

    await injector.syncStylesToDocument(detachedDoc);
    expect(detachedDoc.querySelectorAll("link")).toHaveLength(0);
    expect(detachedDoc.querySelectorAll('style[data-biliscript-style="1"]')).toHaveLength(0);
    expect(adoptedSheets).toHaveLength(5);
    expect((adoptedSheets[1] as FakeSheet).cssText).toContain("tokens-primitive.css");

    const activeHost = await import("../../extension/shared/active-host.js");
    activeHost.setActiveReaderHost(detachedDoc, { closed: false } as unknown as Window);
    injector.removeReaderStyles();
    expect(adoptedSheets).toHaveLength(2);
    expect(adoptedSheets[0]).toBe(foreignSheet);
    expect((adoptedSheets[1] as FakeSheet).cssText).toContain("player-ai.css");

    injector.clearMirroredStyles(detachedDoc);
    expect(adoptedSheets).toEqual([foreignSheet]);
  });

  it("adoptedStyleSheets 触发 Firefox XrayWrapper 异常时安全回退为 <style>.textContent", async () => {
    installStyleIpcRecorder();
    const injector = await loadInjector();
    await injector.ensureReaderStyles();

    const detachedDoc = document.implementation.createHTMLDocument("DetachedXray");
    Object.defineProperty(detachedDoc, "defaultView", {
      value: { CSSStyleSheet: class {} },
      configurable: true
    });
    Object.defineProperty(detachedDoc, "adoptedStyleSheets", {
      get: () => {
        throw new Error("Accessing from Xray wrapper is not supported.");
      },
      configurable: true
    });

    await injector.syncStylesToDocument(detachedDoc);
    expect(detachedDoc.querySelectorAll("link")).toHaveLength(0);
    expect(mirroredStylePaths(detachedDoc)).toEqual(READER_PATHS);
    expect(mirroredStyleElements(detachedDoc)[0].textContent).toContain("tokens-primitive.css");
  });

  it("子窗口活跃时，懒加载样式镜像到子文档，removeReaderStyles 同时摘除双端阅读样式", async () => {
    const rec = installStyleIpcRecorder();
    const activeHost = await import("../../extension/shared/active-host.js");
    const injector = await loadInjector();
    const detachedDoc = document.implementation.createHTMLDocument("Detached");
    const detachedWin = { closed: false } as unknown as Window;

    injector.ensurePlayerAiStyles();
    await injector.ensureReaderStyles();
    activeHost.setActiveReaderHost(detachedDoc, detachedWin);
    await injector.syncStylesToDocument(detachedDoc);

    injector.ensureCustomSelectStyles();
    injector.ensureToggleSwitchStyles();
    injector.ensureBilingualSubtitleStyles();
    injector.ensureReaderChatStyles();
    await vi.waitFor(() => {
      const paths = mirroredStylePaths(detachedDoc);
      expect(paths).toContain("entry/styles/custom-select.css");
      expect(paths).toContain("entry/styles/toggle-switch.css");
      expect(paths).toContain("entry/styles/bilingual-subtitles.css");
      expect(paths).toContain("entry/styles/reader-chat.css");
    });

    injector.removeReaderStyles();
    await vi.waitFor(() => {
      for (const path of READER_PATHS) {
        expect(rec.mounted.has(path)).toBe(false);
        expect(mirroredStylePaths(detachedDoc)).not.toContain(path);
      }
    });
    expect(mirroredStylePaths(detachedDoc)).toContain(PLAYER_AI_PATH);

    injector.clearMirroredStyles(detachedDoc);
    expect(mirroredStyleElements(detachedDoc)).toHaveLength(0);
    expect(rec.mounted.has(PLAYER_AI_PATH)).toBe(true);
  });

  it("clearMirroredStyles 取消在途镜像并在目标文档抛出死亡对象异常时安全完成", async () => {
    const rec = installStyleIpcRecorder({ holdRead: true });
    const injector = await loadInjector();
    await injector.ensureReaderStyles();

    const detachedDoc = document.implementation.createHTMLDocument("DetachedAbort");
    const syncing = injector.syncStylesToDocument(detachedDoc);
    injector.clearMirroredStyles(detachedDoc);
    rec.pendingReads.shift()?.();
    await syncing;
    expect(mirroredStyleElements(detachedDoc)).toHaveLength(0);

    const deadDoc = document.implementation.createHTMLDocument("Dead");
    Object.defineProperty(deadDoc, "querySelectorAll", {
      value: () => {
        throw new TypeError("can't access dead object");
      }
    });
    expect(() => injector.clearMirroredStyles(deadDoc)).not.toThrow();
  });

  it("syncStylesToDocument 与分离态 ensure*Styles 在死亡 appendChild 或无容器文档下不抛错", async () => {
    installStyleIpcRecorder();
    const activeHost = await import("../../extension/shared/active-host.js");
    const injector = await loadInjector();
    const brokenDoc = document.implementation.createHTMLDocument("Broken");
    const brokenWin = { closed: false } as unknown as Window;
    brokenDoc.head.appendChild = (() => {
      throw new TypeError("can't access dead object");
    }) as typeof brokenDoc.head.appendChild;

    await injector.ensureReaderStyles();
    activeHost.setActiveReaderHost(brokenDoc, brokenWin);

    await expect(injector.syncStylesToDocument(brokenDoc)).resolves.toBeUndefined();
    expect(() => injector.ensurePlayerAiStyles()).not.toThrow();
    expect(() => injector.ensureReaderSettingsStyles()).not.toThrow();
    await expect(injector.whenReaderSettingsStylesReady()).resolves.toBeUndefined();
    expect(() => injector.ensureReaderChatStyles()).not.toThrow();

    const emptyDoc = document.implementation.createHTMLDocument("Empty");
    const emptyWin = { closed: false } as unknown as Window;
    emptyDoc.documentElement.remove();
    activeHost.setActiveReaderHost(emptyDoc, emptyWin);

    await expect(injector.syncStylesToDocument(emptyDoc)).resolves.toBeUndefined();
    expect(() => injector.ensurePlayerAiStyles()).not.toThrow();
    expect(() => injector.ensureReaderSettingsStyles()).not.toThrow();
    await expect(injector.whenReaderSettingsStylesReady()).resolves.toBeUndefined();
  });

  it("停靠态已加载设置表后，分离态经 syncStylesToDocument 镜像后再调 ensureReaderSettingsStyles 仍等待子文档就绪", async () => {
    const rec = installStyleIpcRecorder({ holdRead: true });
    const activeHost = await import("../../extension/shared/active-host.js");
    const injector = await loadInjector();

    injector.ensureReaderSettingsStyles();
    await injector.whenReaderSettingsStylesReady();

    const detachedDoc = document.implementation.createHTMLDocument("Detached");
    const detachedWin = { closed: false } as unknown as Window;
    activeHost.setActiveReaderHost(detachedDoc, detachedWin);
    const syncing = injector.syncStylesToDocument(detachedDoc);

    injector.ensureReaderSettingsStyles();
    const ready = injector.whenReaderSettingsStylesReady();
    let settled = false;
    void ready.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    while (rec.pendingReads.length > 0) {
      rec.pendingReads.shift()?.();
    }
    await Promise.all([syncing, ready]);
    expect(settled).toBe(true);
    expect(mirroredStylePaths(detachedDoc)).toEqual(SETTINGS_PATHS);
    expect(detachedDoc.querySelectorAll("link")).toHaveLength(0);
  });

  it("content-style-insert 返回回落样式文本（如 live.bilibili.com 无 host_permissions）时本地安全挂载且移除不发 removeCSS", async () => {
    const calls: Array<{ type: string; files: string[] }> = [];
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      (raw: unknown, callback?: (resp?: unknown) => void) => {
        const msg = raw as { type?: string; files?: string[] };
        if (msg?.type === "content-style-insert" && Array.isArray(msg.files)) {
          calls.push({ type: msg.type, files: [...msg.files] });
          const styles: Record<string, string> = {};
          for (const f of msg.files) styles[f] = `/* fallback:${f} */`;
          callback?.({ ok: true, styles });
          return undefined;
        }
        if (msg?.type === "content-style-remove" && Array.isArray(msg.files)) {
          calls.push({ type: msg.type, files: [...msg.files] });
        }
        callback?.({ ok: true });
        return undefined;
      }
    );

    const injector = await loadInjector();
    injector.ensurePlayerAiStyles();
    await vi.waitFor(() => {
      expect(mirroredStylePaths(document)).toEqual([PLAYER_AI_PATH]);
    });
    expect(document.querySelectorAll("link")).toHaveLength(0);

    injector.removePlayerAiStyles();
    expect(mirroredStylePaths(document)).toEqual([]);
    expect(calls).toEqual([{ type: "content-style-insert", files: [PLAYER_AI_PATH] }]);
  });
});
