// 候选4 守卫批：player-ai 显式启停生命周期。
// - 设置关闭 → 不挂 observer、不绑 window layout 监听（开关关闭态不启动）
// - 设置开启（含 storage 未存键的默认开启，2026-09 起）→ observer 启动、
//   layout 监听挂上；start 幂等
// - stop → 宿主上的游标监听按同一引用摘除、retry 定时器清理、按钮移除
// - storage.onChanged 里 enablePlayerAiQuickAction true→false→true 正确启停
//
// chrome stub 采用内存实现（参照 tests/setup.js / tests/reader 模式）：
// runtime.sendMessage 回调同步返回 get-settings 结果，
// storage.onChanged 收集 listener 由 emitStorageChange 手动派发。
// 定时器全文件 fake：player-ai 的 sync/retry 定时器与 observer 是跨用例活体
// （resetModules 每用例换注册表，jsdom document 与真实时钟却按文件共享），
// 真实时钟下上一用例的残留定时器会在下一用例的时间窗开火，以旧注册表的
// settings 对当前 DOM mount/remove（偶发 button-null、重复绑、环境销毁后
// ReferenceError 三形态同一根因）；fake 后未触发的残留随 afterEach 的
// useRealTimers 一并丢弃，时间由各用例显式推进。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, setLocationUrl, NORMAL_PAGE_URL } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
// playerAiState 须按用例动态获取：beforeEach 的 vi.resetModules() 会换模块
// 纪元，静态 import 拿到的实例与生产代码（动态 import 加载）不是同一对象。
let playerAiState = null;
async function getPlayerAiState() {
  playerAiState = (await import("../../extension/ai/player-ai-state.js")).playerAiState;
  return playerAiState;
}

const storageChangeListeners = new Set();

// 帧内快车道用例的手推 rAF 队列：jsdom 的 rAF 在 fake 时钟下按 16ms 拍触发，
// 逐帧重试与预算耗尽的边界要确定就得自己推帧（见 installRafQueue/flushRafQueue）。
let rafQueue = [];
let rafHandle = 0;
function installRafQueue() {
  rafQueue = [];
  rafHandle = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    rafQueue.push(cb);
    rafHandle += 1;
    return rafHandle;
  });
}
function flushRafQueue() {
  const pending = rafQueue;
  rafQueue = [];
  pending.forEach((cb) => cb());
}

// 当前用例的内存设置引用：stubChrome 写入，emitStorageChange 更新并派发。
let activeSettingsRef = null;
// deferGetSettings 模式下挂起的 get-settings 回包回调（模拟 SW 冷启动未回包）。
let pendingGetSettingsCallback = null;

// 本用例期望的"当前设置"（与 DEFAULT_SETTINGS 合并后由
// get-settings 回读返回，模拟 background 的 normalizeSettings 兜底）。
// runtime.getURL 已由 setup.js 的通用 chrome stub 提供（S3 分层样式挂载用），
// 这里沿用；startPlayerAiQuickAction 会触发 ensurePlayerAiStyles 挂 link。
// options.deferGetSettings：get-settings 不回包（缓存回调），模拟 SW 冷启动
// 未响应，用于验证 content.js 的 storage 快路径门控不等 SW 往返。
function stubChrome(settings, { deferGetSettings = false } = {}) {
  activeSettingsRef = { current: { ...settings } };
  pendingGetSettingsCallback = null;
  const runtime = {
    getURL: vi.fn((path) => `chrome-extension://test/${path}`),
    lastError: null,
    sendMessage: vi.fn((message, callback) => {
      if (message?.type === "get-settings") {
        if (deferGetSettings) {
          pendingGetSettingsCallback = callback;
          return undefined;
        }
        callback?.({
          ok: true,
          settings: { ...DEFAULT_SETTINGS, ...activeSettingsRef.current }
        });
      } else {
        callback?.({ ok: true });
      }
      return undefined;
    }),
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
      hasListener: vi.fn(() => false)
    }
  };
  vi.stubGlobal("chrome", { runtime, storage: {
      sync: {
        get: vi.fn(async () => ({ ...activeSettingsRef.current })),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {})
      },
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {})
      },
      onChanged: {
        addListener: vi.fn((listener) => {
          storageChangeListeners.add(listener);
        }),
        removeListener: vi.fn((listener) => {
          storageChangeListeners.delete(listener);
        })
      }
    }
  });
  return { runtime };
}

// 派发 storage 变更并同步内存中的"当前设置"，模拟真实 sync storage 的读写一致
// （reader watcher 的异步全量回读会拿到与 onChanged 相同的新值）。
function emitStorageChange(key, newValue) {
  activeSettingsRef.current = { ...activeSettingsRef.current, [key]: newValue };
  const changes = { [key]: { newValue } };
  for (const listener of [...storageChangeListeners]) {
    listener(changes, "sync");
  }
}

// content.js 顶层即执行 init()；getSettings().then 是微任务链（stub 回调同步），
// 穿透若干层微任务后设置即已应用。
//
// 候选4 分包：content.js 经 ai/lazy-player-ai.js 动态加载 player-ai（默认
// 关闭的设置不再静态常驻），因此这里先 await 加载器 promise（单例缓存）把
// 模块预热到位，再穿透微任务让 start/stop 的 then 回调落地。
async function flushMicrotasks(times = 20) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

async function loadContentScript(settings) {
  setLocationUrl(NORMAL_PAGE_URL);
  // S3 分层：player-ai 模块顶层即挂样式 link（ensurePlayerAiStyles），
  // 挂载用的 runtime.getURL 引用与断言无关。
  stubChrome(settings);
  await import("../../extension/entry/content.js");
  // 仅在开关开启时预热懒加载的 player-ai 模块（loadPlayerAi 返回缓存的同一
  // promise）：「关闭 ⇒ 未加载」是生产不变量（subscribePlayerAiSync seam 与
  // stopLazy 据此跳过），无条件预热会让关闭用例的注册表带出能开火的 sync
  // 定时器。模块加载本身不挂 observer/监听，不影响「设置关闭」用例的断言。
  if (settings.enablePlayerAiQuickAction) {
    const { loadPlayerAi } = await import("../../extension/ai/lazy-player-ai.js");
    await loadPlayerAi();
  }
  // digest 按钮模块无条件常驻（工单 button-injection-stability/01 快路径：
  // init() 直接触发装载），同样预热到位。模块求值即寻锚注入——往
  // .bpx-player-container 插浮动层会触发 AI 容器观察器回 scheduleSync；不预热
  // 的话该插入的微任务时序可能落到用例中途，冲掉用例手排的 sync 定时器。
  const { loadDigestButton } = await import("../../extension/ui/lazy-digest-button.js");
  await loadDigestButton();
  await flushMicrotasks();
  // 模块级 playerAiState 经 getPlayerAiState() 绑定到本用例注册表的实例；
  // 用例要读状态槽位请用这里返回的对象，不要再次 getPlayerAiState()——再次
  // 调用会重置模块注册表并给出另一个实例，读到的槽位与生产代码写的不是同一个。
  const aiState = await getPlayerAiState();
  return { state: (await import("../../extension/core/state.js")).state, playerAiState: aiState };
}

function makePlayerDom() {
  document.body.innerHTML = `
    <div class="bpx-player-container">
      <button type="button" aria-label="字幕" title="字幕">CC</button>
    </div>`;
  return document.querySelector(".bpx-player-container");
}

beforeEach(() => {
  storageChangeListeners.clear();
  // 上一用例注册表可能留有已排的帧内快车道 rAF：resetModules() 换注册表后
  // 该帧仍会在本用例的 fake 时钟里开火，用旧注册表的设置对当前 DOM 挂按钮。
  // 模块把它挂到 window 上正是为了这里能按 id 取消（见 player-ai.ts 调度器）。
  if (window.__bocPlayerAiSyncRaf !== undefined) {
    window.cancelAnimationFrame(window.__bocPlayerAiSyncRaf);
    delete window.__bocPlayerAiSyncRaf;
  }
  resetModuleState();
  // resetModuleState 内部的 useRealTimers 复位后，本文件统一挂 fake 时钟
  vi.useFakeTimers();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("player-ai 启停守卫", () => {
  it("设置关闭 → 不挂 observer、不绑 window layout 监听", async () => {
    const windowAddSpy = vi.spyOn(window, "addEventListener");
    const { state } = await loadContentScript({ enablePlayerAiQuickAction: false });

    expect(playerAiState.playerAiQuickActionObserver).toBeNull();
    expect(playerAiState.playerAiQuickActionLayoutBound).toBe(false);
    expect(windowAddSpy.mock.calls.some(([type]) => type === "resize")).toBe(false);
    expect(document.getElementById("boc-player-ai-quick-action")).toBeNull();
  });

  it("设置开启 → observe 被调、layout 监听挂上", async () => {
    const windowAddSpy = vi.spyOn(window, "addEventListener");
    const documentAddSpy = vi.spyOn(document, "addEventListener");
    const { state } = await loadContentScript({ enablePlayerAiQuickAction: true });

    expect(playerAiState.playerAiQuickActionObserver).not.toBeNull();
    expect(playerAiState.playerAiQuickActionLayoutBound).toBe(true);
    expect(windowAddSpy.mock.calls.some(([type]) => type === "resize")).toBe(true);
    expect(windowAddSpy.mock.calls.some(([type]) => type === "pageshow")).toBe(true);
    expect(documentAddSpy.mock.calls.some(([type]) => type === "fullscreenchange")).toBe(true);
  });

  it("默认设置（storage 未存该键）→ AI 按钮随页面加载自动启动", async () => {
    // 2026-09 起默认开启（core/defaults.ts enablePlayerAiQuickAction: true）：
    // 存量安装的历史默认值 false 由安装/更新迁移一次性清位
    //（entry/settings-migration.ts），这里锁「storage 无键 ⇒ 默认值生效 ⇒
    // 慢路径自动 start」的进页可点契约。快路径读不到键直接跳过，交给慢路径。
    expect(DEFAULT_SETTINGS.enablePlayerAiQuickAction).toBe(true);

    const windowAddSpy = vi.spyOn(window, "addEventListener");
    const { state } = await loadContentScript({});
    // 未预热路径：start 经 loadPlayerAi().then 异步执行，显式等模块在位
    const { loadPlayerAi } = await import("../../extension/ai/lazy-player-ai.js");
    await loadPlayerAi();
    await flushMicrotasks();

    expect(state.settings.enablePlayerAiQuickAction).toBe(true);
    expect(playerAiState.playerAiQuickActionObserver).not.toBeNull();
    expect(playerAiState.playerAiQuickActionLayoutBound).toBe(true);
    expect(windowAddSpy.mock.calls.some(([type]) => type === "resize")).toBe(true);
  });

  it("start 幂等：重复调用不重复绑 observer 与监听", async () => {
    const { state } = await loadContentScript({ enablePlayerAiQuickAction: true });
    // loadContentScript 的 preload 与这里的 import 为同一模块实例；vitest 对
    // 已加载模块的重复 import 返回缓存（诊断实测），此处拿真实命名空间（非
    // doMock 产物，后者的依赖图会被 doMock 的 import 拦截带偏）
    const { startPlayerAiQuickAction } = await import("../../extension/ai/player-ai.js");
    const observerBefore = playerAiState.playerAiQuickActionObserver;
    const windowAddSpy = vi.spyOn(window, "addEventListener");

    startPlayerAiQuickAction();

    expect(playerAiState.playerAiQuickActionObserver).toBe(observerBefore);
    expect(windowAddSpy.mock.calls.some(([type]) => type === "resize")).toBe(false);
  });

  it("stop → 宿主上的游标监听按同一引用摘除、按钮移除、layout 监听解绑", async () => {
    const host = makePlayerDom();
    // spy 必须在 import content.js（可能触发初始 sync）之前装上，
    // 否则初始挂载的游标绑定会逃过捕获
    const hostAddSpy = vi.spyOn(host, "addEventListener");
    const hostRemoveSpy = vi.spyOn(host, "removeEventListener");
    const { state } = await loadContentScript({ enablePlayerAiQuickAction: true });
    const { schedulePlayerAiQuickActionSync, stopPlayerAiQuickAction } = await import("../../extension/ai/player-ai.js");

    // 装载期的 sync 帧全部作废，只留「手动排一帧」这一条路径，绑定数才可数。
    // 真实 rAF 在 fake 时钟下按 16ms 拍触发、时序不受控（观察器补 sync 会在同
    // 一窗口内再挂一次），手推队列让挂载精确到一次。
    vi.clearAllTimers();
    installRafQueue();
    schedulePlayerAiQuickActionSync(0);
    flushRafQueue();

    const button = document.getElementById("boc-player-ai-quick-action");
    expect(button).not.toBeNull();
    const wrap = button.closest(".boc-player-ai-wrap");
    // 游标监听已绑：mousemove 应点亮按钮
    host.dispatchEvent(new MouseEvent("mousemove"));
    expect(wrap.classList.contains("is-active")).toBe(true);

    const cursorTypes = ["mousemove", "mouseenter", "mouseleave"];
    const cursorBinds = hostAddSpy.mock.calls.filter(([type]) => cursorTypes.includes(type));
    expect(cursorBinds.length).toBe(3);

    stopPlayerAiQuickAction();

    expect(document.getElementById("boc-player-ai-quick-action")).toBeNull();
    expect(document.querySelector(".boc-player-ai-wrap")).toBeNull();
    expect(playerAiState.playerAiQuickActionObserver).toBeNull();
    expect(playerAiState.playerAiQuickActionLayoutBound).toBe(false);
    // 3 个游标 handler 均以绑定时的同一引用被 removeEventListener 摘除
    for (const [type, handler] of cursorBinds) {
      expect(hostRemoveSpy.mock.calls.some(([t, h]) => t === type && h === handler)).toBe(true);
    }
  });

  it("游标监听防重挂守卫：同一 host 不重复绑", async () => {
    const host = makePlayerDom();
    const hostAddSpy = vi.spyOn(host, "addEventListener");
    const { state } = await loadContentScript({ enablePlayerAiQuickAction: true });
    const { schedulePlayerAiQuickActionSync } = await import("../../extension/ai/player-ai.js");

    schedulePlayerAiQuickActionSync(0);
    // fake 时钟显式推进：0 → 帧内快车道（rAF），推进一帧即执行 sync
    await vi.advanceTimersByTimeAsync(20);
    expect(document.getElementById("boc-player-ai-quick-action")).not.toBeNull();

    // 再次 sync（按钮已挂载路径）：不应重复绑游标监听
    schedulePlayerAiQuickActionSync(0);
    // fake 时钟显式推进：0 → 帧内快车道（rAF），推进一帧即执行 sync
    await vi.advanceTimersByTimeAsync(20);

    const mousemoveBinds = hostAddSpy.mock.calls.filter(([type]) => type === "mousemove");
    expect(mousemoveBinds.length).toBe(1);
    expect(playerAiState.playerAiQuickActionLayoutBound).toBe(true);
  });

  it("stop → retry 定时器清理，stop 后不再触发挂载", async () => {
    // 只有容器、无字幕控件 → sync 挂载失败进入 retry 退避
    document.body.innerHTML = `<div class="bpx-player-container"></div>`;
    const { state } = await loadContentScript({ enablePlayerAiQuickAction: true });
    const { schedulePlayerAiQuickActionSync, stopPlayerAiQuickAction } = await import("../../extension/ai/player-ai.js");

    // 手动 sync 会 clear 掉 start 的初始 120ms 定时器并立即执行一次 sync
    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(1);

    // 挂载失败已进入 retry：sync 定时器为 260ms 退避定时器
    expect(document.getElementById("boc-player-ai-quick-action")).toBeNull();
    expect(playerAiState.playerAiQuickActionSyncTimer).not.toBe(0);

    stopPlayerAiQuickAction();
    expect(playerAiState.playerAiQuickActionSyncTimer).toBe(0);

    // 推进 3 秒：retry 定时器已清，不会再触发挂载
    await vi.advanceTimersByTimeAsync(3000);
    expect(document.getElementById("boc-player-ai-quick-action")).toBeNull();
    expect(playerAiState.playerAiQuickActionSyncTimer).toBe(0);
  });

  it("get-settings 未回包（SW 冷启动）时，storage 快路径已启动 observer 与 layout 监听", async () => {
    const windowAddSpy = vi.spyOn(window, "addEventListener");
    setLocationUrl(NORMAL_PAGE_URL);
    stubChrome({ enablePlayerAiQuickAction: true }, { deferGetSettings: true });
    await import("../../extension/entry/content.js");
    const { loadPlayerAi } = await import("../../extension/ai/lazy-player-ai.js");
    await loadPlayerAi();
    await flushMicrotasks();
    const state = (await import("../../extension/core/state.js")).state;
    await getPlayerAiState();

    // get-settings 始终未回包：以下状态全部来自 chrome.storage.sync 快路径
    expect(pendingGetSettingsCallback).not.toBeNull();
    expect(state.settings.enablePlayerAiQuickAction).toBe(true);
    expect(playerAiState.playerAiQuickActionObserver).not.toBeNull();
    expect(playerAiState.playerAiQuickActionLayoutBound).toBe(true);
    expect(windowAddSpy.mock.calls.some(([type]) => type === "resize")).toBe(true);
  });

  it("body 回退观察器带 subtree：播放器深层挂载可发现", async () => {
    // 功能路径在 fake 时钟下会被初始 sync 定时器掩盖（动态 import 落地时机
    // 不确定），这里直接锁机制：容器缺席时回退观察 body 必须带 subtree，
    // 否则深层嵌套挂载（B 站播放器常见）发现不了，只能等 retry 退避兜底。
    const observeSpy = vi.spyOn(MutationObserver.prototype, "observe");
    await loadContentScript({ enablePlayerAiQuickAction: true });

    // reader 呈现层另有针对 body 的属性观察器（attributeFilter 带 data-boc-reader-*），
    // 按 childList 形态区分出 player-ai 的回退观察器。
    const bodyObserveCall = observeSpy.mock.calls.find(
      ([target, options]) => target === document.body && options?.childList === true
    );
    expect(bodyObserveCall?.[1]).toMatchObject({ childList: true, subtree: true });
  });

  it("storage.onChanged：enablePlayerAiQuickAction true→false→true 正确启停", async () => {
    const windowAddSpy = vi.spyOn(window, "addEventListener");
    const windowRemoveSpy = vi.spyOn(window, "removeEventListener");
    const { state } = await loadContentScript({ enablePlayerAiQuickAction: false });
    // 关闭态未预热：首次开启会触发真实动态 import，用例内要显式等加载完成
    const { loadPlayerAi } = await import("../../extension/ai/lazy-player-ai.js");

    // 初始关闭：已 stop
    expect(playerAiState.playerAiQuickActionObserver).toBeNull();
    expect(playerAiState.playerAiQuickActionLayoutBound).toBe(false);

    // false → true：启动 observer 与监听，并同步 state.settings
    // （懒加载接线：start 经 loadPlayerAi().then 异步执行，先等模块在位、
    // 再穿透微任务让 start 回调落地后断言）
    emitStorageChange("enablePlayerAiQuickAction", true);
    await loadPlayerAi();
    await flushMicrotasks();
    expect(state.settings.enablePlayerAiQuickAction).toBe(true);
    expect(playerAiState.playerAiQuickActionObserver).not.toBeNull();
    expect(playerAiState.playerAiQuickActionLayoutBound).toBe(true);
    const resizeBinds = windowAddSpy.mock.calls.filter(([type]) => type === "resize");
    expect(resizeBinds.length).toBe(1);

    // true → false：observer 断开、layout 监听按同一引用摘除
    emitStorageChange("enablePlayerAiQuickAction", false);
    await flushMicrotasks();
    expect(state.settings.enablePlayerAiQuickAction).toBe(false);
    expect(playerAiState.playerAiQuickActionObserver).toBeNull();
    expect(playerAiState.playerAiQuickActionLayoutBound).toBe(false);
    const [, resizeHandler] = resizeBinds[0];
    expect(
      windowRemoveSpy.mock.calls.some(([type, handler]) => type === "resize" && handler === resizeHandler)
    ).toBe(true);

    // false → true：再次启动
    emitStorageChange("enablePlayerAiQuickAction", true);
    await flushMicrotasks();
    expect(playerAiState.playerAiQuickActionObserver).not.toBeNull();
    expect(playerAiState.playerAiQuickActionLayoutBound).toBe(true);
    expect(windowAddSpy.mock.calls.filter(([type]) => type === "resize").length).toBe(2);
  });
});

describe("player-ai 重试退避节奏与注入耗时观测（工单 button-injection-stability/01、03）", () => {
  it("首挂载走帧内快车道（rAF），不等 120ms 定时器", async () => {
    // 工单 03：首挂载的 120ms 防抖定时器在首载负载下会被拖到 200-400ms，
    // 改走 requestAnimationFrame——模块装载后一帧内即执行首次 sync 尝试。
    makePlayerDom();
    // rAF 换成手推队列（真实 rAF 的返回值不是数字句柄，调度器按数值句柄取消）；
    // 队列非空本身就说明首挂载走的是帧快车道。
    installRafQueue();
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const { playerAiState: state } = await loadContentScript({ enablePlayerAiQuickAction: true });

    // 初始 sync 走帧内快车道：排的是 rAF（setTimeout 句柄恒为正，槽位符号即来源），
    // 且没有 sync 的 120ms 防抖定时器——这正是工单 03 要干掉的等待。
    expect(rafQueue.length).toBeGreaterThan(0);
    expect(state.playerAiQuickActionSyncTimer).toBeLessThan(0);
    expect(setTimeoutSpy.mock.calls.find(([, ms]) => ms === 120)).toBeUndefined();

    // 挂载本身照常：推一帧 + 微任务后按钮在位
    flushRafQueue();
    await flushMicrotasks();
    expect(document.getElementById("boc-player-ai-quick-action")).not.toBeNull();
  });

  it("retry 快车道：先逐帧重试，预算耗尽后回落 100ms 起步退避", async () => {
    // 字幕控件门语义保留：只有容器、无字幕控件 → 挂载失败走 retry。
    // rAF 换成手推队列，并把装载期残留的帧/定时器清掉，边界必须确定，不依赖
    // jsdom 的帧拍，也不受容器观察器那条 sync 链路的干扰。
    installRafQueue();
    document.body.innerHTML = `<div class="bpx-player-container"></div>`;
    const { playerAiState: state } = await loadContentScript({ enablePlayerAiQuickAction: true });
    vi.clearAllTimers();
    rafQueue = [];
    const { schedulePlayerAiQuickActionSync } = await import("../../extension/ai/player-ai.js");

    // 快车道阶段：手排一次 sync，逐帧排空。帧内 retry 的句柄槽位恒为负（rAF），
    // 预算 20 帧。
    schedulePlayerAiQuickActionSync(0);
    let drained = 0;
    while (rafQueue.length > 0 && drained < 20) {
      flushRafQueue();
      drained += 1;
      expect(state.playerAiQuickActionSyncTimer).toBeLessThan(0);
    }
    expect(drained).toBe(20);
    // 预算耗尽前不得出现退避定时器（正句柄）：这一帧之后才是退避拍
    expect(rafQueue.length).toBe(1);

    // 预算耗尽（20 帧）：第 21 帧再失败即落到退避定时器——rAF 不再续排（队列
    // 停在 0），并排出 100ms 起步的退避拍（毫秒数从 globalThis.setTimeout 的
    // 实参读：那才是 fake 时钟那一层，window.setTimeout 上挂着 Node 的真实定时器）。
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    flushRafQueue();
    expect(rafQueue.length).toBe(0);
    expect(setTimeoutSpy.mock.calls.at(-1)[1]).toBe(100);

    // 退避节奏：预算耗尽后每一拍都是「定时器到点 → 重新吃满 20 帧 → 落回下一
    // 拍」，所以每观察一拍就整轮推进一次（20 帧 + 该拍毫秒数）。
    const stepOnce = async () => {
      const ms = setTimeoutSpy.mock.calls.at(-1)[1];
      for (let i = 0; i < 20; i += 1) {
        flushRafQueue();
      }
      await vi.advanceTimersByTimeAsync(ms);
      return ms;
    };
    const delays = [await stepOnce()];
    for (let i = 0; i < 12; i += 1) {
      delays.push(await stepOnce());
    }
    expect(delays.slice(0, 10)).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
    // 封顶 1s 并维持，不再增长
    expect(delays.slice(10)).toEqual([1000, 1000, 1000]);
  });

  it("首次挂载打注入耗时日志（默认开启）", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    makePlayerDom();
    await loadContentScript({ enablePlayerAiQuickAction: true });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(120);

    expect(document.getElementById("boc-player-ai-quick-action")).not.toBeNull();
    const timingLog = infoSpy.mock.calls.find((args) => {
      const line = args.join(" ");
      return line.includes("player-ai") && line.includes("装载→挂载耗时");
    });
    expect(timingLog).toBeDefined();
  });
});
