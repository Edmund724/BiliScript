// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

type StyleInjector = typeof import("../../extension/shared/style-injector.js");

const READER_PATHS = [
  "entry/styles/tokens-primitive.css",
  "entry/styles/reader.css",
  "entry/styles/reader-gate.css"
];
const PLAYER_AI_PATH = "entry/styles/player-ai.css";
const READER_CHAT_PATHS = [
  "entry/styles/github-markdown.css",
  "entry/styles/github-markdown-theme.css",
  "entry/styles/reader-chat.css"
];
const SETTINGS_PATHS = [
  "entry/styles/reader-settings-shell.css",
  "entry/styles/reader-settings-rows.css",
  "entry/styles/reader-settings-providers.css"
];

let resident: StyleInjector;
let lazy: StyleInjector;

function installRecorder(opts?: { holdInsert?: boolean; holdRead?: boolean }) {
  const calls: Array<{ type: string; files: string[] }> = [];
  const pendingInserts: Array<() => void> = [];
  const pendingReads: Array<() => void> = [];
  const mounted = new Set<string>();

  vi.mocked(chrome.runtime.sendMessage).mockImplementation(
    (raw: unknown, callback?: (resp?: unknown) => void) => {
      const msg = raw as { type?: string; files?: string[] };
      if (msg?.type === "content-style-insert" && Array.isArray(msg.files)) {
        const files = [...msg.files];
        calls.push({ type: msg.type, files });
        const finish = () => {
          files.forEach((f) => mounted.add(f));
          callback?.({ ok: true });
        };
        if (opts?.holdInsert) pendingInserts.push(finish);
        else finish();
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
          for (const f of files) styles[f] = `/* ${f} */`;
          callback?.({ ok: true, styles });
        };
        if (opts?.holdRead) pendingReads.push(finish);
        else finish();
        return undefined;
      }
      callback?.({ ok: true });
      return undefined;
    }
  );
  return { calls, pendingInserts, pendingReads, mounted };
}

beforeEach(async () => {
  resetModuleState();
  document.head.innerHTML = "";
  resident = await import("../../extension/shared/style-injector.js");
  vi.resetModules();
  lazy = await import("../../extension/shared/style-injector.js");
});

describe("style-injector 挂载记录跨实例共享", () => {
  it("两个模块实例确实不同（前提校验）", () => {
    expect(lazy).not.toBe(resident);
  });

  it("一侧挂载、另一侧认账（只发一次 content-style-insert，零 DOM link）", async () => {
    const rec = installRecorder();
    await resident.ensureReaderStyles();
    await lazy.ensureReaderStyles();

    expect(rec.calls).toEqual([{ type: "content-style-insert", files: READER_PATHS }]);
    expect([...rec.mounted]).toEqual(READER_PATHS);
    expect(document.querySelectorAll("link")).toHaveLength(0);
  });

  it("一侧移除、另一侧认账（退出阅读模式不再残留）", async () => {
    const rec = installRecorder();
    await lazy.ensureReaderStyles();
    expect([...rec.mounted]).toEqual(READER_PATHS);

    resident.removeReaderStyles();
    await Promise.resolve();

    expect(rec.mounted.size).toBe(0);
    expect(rec.calls).toEqual([
      { type: "content-style-insert", files: READER_PATHS },
      { type: "content-style-remove", files: READER_PATHS }
    ]);
  });

  it("player-ai / 对话分区表：跨实例挂载记录一致", async () => {
    const rec = installRecorder();
    resident.ensurePlayerAiStyles();
    lazy.ensurePlayerAiStyles();
    lazy.ensureReaderChatStyles();
    resident.ensureReaderChatStyles();
    await vi.waitFor(() => {
      expect(rec.mounted.has(PLAYER_AI_PATH)).toBe(true);
      for (const path of READER_CHAT_PATHS) {
        expect(rec.mounted.has(path)).toBe(true);
      }
    });
    expect(rec.calls).toEqual([
      { type: "content-style-insert", files: [PLAYER_AI_PATH] },
      { type: "content-style-insert", files: READER_CHAT_PATHS }
    ]);
  });

  it("设置表 ready promise 跨实例同一份（whenReaderSettingsStylesReady 等的是同一个）", () => {
    installRecorder({ holdInsert: true });
    resident.ensureReaderSettingsStyles();
    const residentReady = resident.whenReaderSettingsStylesReady();
    const lazyReady = lazy.whenReaderSettingsStylesReady();

    expect(lazyReady).toBe(residentReady);
  });

  it("阅读表 ready 等后台 content-style-insert 完成，而不是提前 resolve", async () => {
    const rec = installRecorder({ holdInsert: true });
    const ready = resident.ensureReaderStyles();
    let settled = false;
    void ready.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(rec.pendingInserts).toHaveLength(1);

    rec.pendingInserts.shift()?.();
    await ready;
    expect(settled).toBe(true);
  });

  it("跨实例子窗口镜像：一侧同步并卸载，另一侧新建懒加载表可镜像并等待子文档就绪", async () => {
    const rec = installRecorder({ holdRead: true });
    const activeHost = await import("../../extension/shared/active-host.js");
    const detachedDoc = document.implementation.createHTMLDocument("Detached");
    const detachedWin = { closed: false } as unknown as Window;

    await resident.ensureReaderStyles();
    activeHost.setActiveReaderHost(detachedDoc, detachedWin);
    const initialSync = lazy.syncStylesToDocument(detachedDoc);
    rec.pendingReads.shift()?.();
    await initialSync;

    lazy.ensureReaderSettingsStyles();
    const ready = resident.whenReaderSettingsStylesReady();
    let settled = false;
    void ready.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(rec.pendingReads).toHaveLength(1);

    rec.pendingReads.shift()?.();
    await ready;
    expect(settled).toBe(true);

    const paths = Array.from(
      detachedDoc.head.querySelectorAll<HTMLStyleElement>('style[data-biliscript-style="1"]')
    ).map((el) => el.dataset.biliscriptStylePath);
    expect(paths).toEqual([...READER_PATHS, ...SETTINGS_PATHS]);
    expect(detachedDoc.querySelectorAll("link")).toHaveLength(0);

    resident.clearMirroredStyles(detachedDoc);
    expect(detachedDoc.head.querySelectorAll('style[data-biliscript-style="1"]')).toHaveLength(0);
    expect(rec.mounted.size).toBe(6);
  });
});
