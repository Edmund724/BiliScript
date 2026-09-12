// 候选03 常驻瘦身：setMessage 迁入 shared/ui-status.js，player-ai 动态 chunk
// 不再把 ui/ui-renderer.js 拖为静态依赖。
import { setMessage } from "../shared/ui-status.js";
import { buildPlayerAiQuickActionIconSvg } from "../ui/icons.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { getSettings } from "../core/runtime.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { getRuntimeVideoElement } from "../bilibili/video-probe.js";
import { state } from "../core/state.js";
// playerAi 状态微模块（随 ai 域内聚）：本模块独占读写，不再经 core/state。
import { playerAiState } from "./player-ai-state.js";
import { isVisibleReaderControl } from "../shared/dom-utils.js";
// 耗时日志走 shared/logging 的 Always 直出口（工单 button-injection-stability
// 决议：默认开启——调试门缺省关，不能走 logInfo）。
import { logInfoAlways } from "../shared/logging.js";
// S3 分层：播放器 AI 样式随本动态 chunk 挂载（节点创建前就绪，见文件尾注释）
import { ensurePlayerAiStyles, removePlayerAiStyles } from "../shared/style-injector.js";

// ===== S3 分层：样式挂载（模块求值即挂，幂等） =====
//
// 为什么在模块级挂：样式必须「节点创建前就绪」——startPlayerAiQuickAction 的
// schedulePlayerAiQuickActionSync() 会创建 #boc-player-ai-quick-action，若样式
// 尚未注入，首次 sync 创建出的节点会以无样式状态挂到播放器上，直到下一个
// sync（resize/滚动/观察器回调）才带样式，形成闪变。模块一旦装载（本文件
// 求值）即挂表，start 与创建节点之间无需等待样式就绪——节点创建前样式已注入。
// link 是异步加载，但样式数据会被浏览器缓存：后续每次 start（设置关→开）
// 重挂即同步生效，不闪变。
//
// 为什么 remove 在 stop：stopPlayerAiQuickAction 会移除按钮，随模块关闭把
// 样式一并摘掉；下次 start 重挂。幂等：模块未装载时本文件不会执行，mounted
// Map 防重复挂。
ensurePlayerAiStyles();

// 帧内快车道剩余帧数（工单 button-injection-stability/03）：首挂载前的 retry
// 走 requestAnimationFrame 而不是退避定时器——播放器容器已出现但尚未完成
// 布局/被显隐门挡住的窗口只有几帧，定时器路径要等满 100ms 起步的退避拍。
const PLAYER_AI_FRAME_RETRY_BUDGET = 20;
let playerAiQuickActionRetryCount = 0;
let playerAiQuickActionFrameRetriesLeft = PLAYER_AI_FRAME_RETRY_BUDGET;

// 注入耗时观测（工单 button-injection-stability/01 可观测，默认开启）：模块
// 求值到 AI 键首次挂载的耗时，只记一次。
const MODULE_BOOT_AT = Date.now();
let mountTimingLogged = false;

// layout 监听与游标监听的引用缓存：removeEventListener 必须用绑定时的同一
// 引用才能摘除，stop 生命周期与游标监听的防泄漏清理都依赖这里保存的引用。
let playerAiQuickActionLayoutHandler: (() => void) | null = null;
// 结构：{ host, wrap, showForCursorActivity, hideImmediately }
interface CursorSync {
  host: HTMLElement;
  wrap: HTMLElement;
  showForCursorActivity: () => void;
  hideImmediately: () => void;
}
let playerAiQuickActionCursorSync: CursorSync | null = null;

// 已挂载就位记录（性能工单）：sync 挂载成功时记下 (wrap, host)。
// 背景：播放中 B 站进度条 width 与弹幕持续改动播放器子树，回调排 rAF 后 sync
// 每帧都要全量跑字幕控件门（多个 querySelectorAll，逐候选读 aria-label /
// title / data-text / textContent / className，候选可达数百）。按钮已挂载且
// 宿主未变时该门结果稳定，跳过它——这份记录就是跳过的依据。
let playerAiQuickActionMountedWrap: HTMLElement | null = null;
let playerAiQuickActionMountedHost: HTMLElement | null = null;

// 样式常量提升到模块级：挂载时写入与「是否已在位」的幂等探测共用同一组值。
// 三个值都是常量，不随全屏/宽屏等播放器状态变化（现状也是每次写同一组字面量）；
// 写在 wrap/button 自身的 inline style 上，特异性高于祖先的继承值。
const PLAYER_AI_HIT_SIZE_PX = 36;
const PLAYER_AI_ICON_SIZE_PX = 24;
const PLAYER_AI_BASE_COLOR = "#f6f7f8";

// 「已就位」：按钮与 wrap 仍在记录的原位，且宿主判定结果仍是记录的那个。
// 宿主用现有 findPlayerAiQuickActionHost() 复判而非另设近似——锚点判定语义是
// 红线，只有原判定说「还是它」才允许跳过。宿主切换（全屏/宽屏换容器）时复判
// 结果变化，落回全量路径重挂到新宿主，按钮样式按现状跟着重同步。
// 任一不成立都落回全量路径——按钮被 B 站重渲染摘掉、宿主被替换、wrap 被移走
// 都是失同步，必须走原 rAF / 退避兜底补回。
function isPlayerAiQuickActionMountedStable(): boolean {
  const wrap = playerAiQuickActionMountedWrap;
  const host = playerAiQuickActionMountedHost;
  const button = wrap?.firstElementChild;
  if (!(wrap instanceof HTMLElement) || !(host instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) {
    return false;
  }
  return wrap.isConnected && host.isConnected && wrap.parentElement === host && findPlayerAiQuickActionHost() === host;
}

// 按钮内联变量是否已在位：逐值读取比值写入便宜，稳定态零写入；被外部抹掉时
// 抹除本身就是属性变更（观察记录），下一拍探测到缺失即补回，视觉不漂移。
// 只探测三个变量里对视觉影响最大的两个尺寸/色值+命中区，覆盖「内联被清空」
// 这一现实场景；逐像素等价不是本路径的目标（漏判最多是一次多余的幂等写）。
function isPlayerAiQuickActionVisualsCurrent(button: HTMLElement): boolean {
  const wrap = button.parentElement;
  if (button.style.getPropertyValue("--boc-player-ai-action-icon-size") !== `${PLAYER_AI_ICON_SIZE_PX}px`) {
    return false;
  }
  if (!(wrap instanceof HTMLElement)) {
    return true;
  }
  return (
    wrap.style.getPropertyValue("--boc-player-ai-action-hit-size") === `${PLAYER_AI_HIT_SIZE_PX}px` &&
    wrap.style.getPropertyValue("--boc-player-ai-action-color") === PLAYER_AI_BASE_COLOR
  );
}

// 属性记录（进度条 width / class 抖动）与全量 sync 的共用入口：已就位就只
// 校准按钮样式（幂等探测，值在位时零写入），不碰字幕门、挂载结构与新建节点；
// 返回 false 表示未就位，调用方按各自口径落回全量路径（观察器侧排一次帧内
// 快车道，sync 侧继续往下走完整流程）——装载窗口的行为与短路前一致。
function tryRefreshPlayerAiQuickActionVisuals(): boolean {
  if (!isPlayerAiQuickActionMountedStable()) {
    return false;
  }
  const button = playerAiQuickActionMountedWrap?.firstElementChild;
  if (button instanceof HTMLButtonElement && !isPlayerAiQuickActionVisualsCurrent(button)) {
    syncPlayerAiQuickActionVisuals(button);
  }
  return true;
}

function clearPlayerAiQuickActionMountRecord(): void {
  playerAiQuickActionMountedWrap = null;
  playerAiQuickActionMountedHost = null;
}

export function resetPlayerAiQuickActionRetryCount(): void {
  playerAiQuickActionRetryCount = 0;
  playerAiQuickActionFrameRetriesLeft = PLAYER_AI_FRAME_RETRY_BUDGET;
}

const PLAYER_CONTAINER_SELECTOR = ".bpx-player-container, #bilibili-player";

// 显式启动入口：绑定 layout 监听并挂 observer。bind/observe 各自带幂等守卫
// （layoutBound / observer 槽位），重复调用不会重复绑。
export function startPlayerAiQuickAction(): void {
  bindPlayerAiQuickActionLayoutEvents();
  startPlayerAiQuickActionObserver();
  // observer 只在 DOM 变化时回调，初始挂载需要主动 sync 一次。走帧内快车道
  // （delayMs=0 → rAF）而不是 120ms 定时器：播放器容器通常已就绪，差的是它
  // 完成布局的那一帧——等一帧即挂，定时器路径在首载负载下会被拖到 200ms+。
  schedulePlayerAiQuickActionSync(0);
}

// 显式停止入口：断开 observer、摘除全部本模块监听（含挂在宿主元素上的游标
// 监听，修复移除→重建时的泄漏）、清理 retry 定时器与计数并移除按钮。
export function stopPlayerAiQuickAction(): void {
  // S3：先摘样式再移除按钮——按钮在样式摘除的瞬间仍按旧规则渲染，摘除后
  // 节点立即被移除，无可见中间态；下次 start 重挂（mounted Map 幂等）。
  removePlayerAiStyles();
  if (playerAiState.playerAiQuickActionObserver) {
    // 容器 observer 与 body 回退 observer 共用同一 state 槽位，统一断开
    playerAiState.playerAiQuickActionObserver.disconnect();
    playerAiState.setObserver(null);
  }
  unbindPlayerAiQuickActionLayoutEvents();
  unbindPlayerAiQuickActionCursorSync();
  // retry 复用 sync 定时器（schedulePlayerAiQuickActionRetry → scheduleSync），
  // 清掉挂起句柄（rAF 或定时器，见 cancelPlayerAiQuickActionSync）与计数，
  // 避免 stop 后残留回调再次尝试挂按钮。
  cancelPlayerAiQuickActionSync();
  resetPlayerAiQuickActionRetryCount();
  removePlayerAiQuickActionButton();
}

export function startPlayerAiQuickActionObserver(): void {
  if (playerAiState.playerAiQuickActionObserver || !document.body) {
    return;
  }

  // 记录分流（性能工单）：childList 用于挂载/摘除与结构变化的发现，必须走
  // 全量 sync（delayMs=0 的帧内快车道）；纯属性记录（播放中进度条 width、
  // 弹幕、B 站自己的 class 抖动都落在 subtree 的 style/class 上）在按钮已就位
  // 时走轻量路径，未就位（装载窗口）仍落回全量 sync，行为与短路前一致。
  const sync = (records: MutationRecord[] = []) => {
    if (!records.some((record) => record.type === "childList") && tryRefreshPlayerAiQuickActionVisuals()) {
      return;
    }
    // 0 → 帧内快车道（rAF）：DOM 变化后等一帧让 rect 落定即挂，避免 120ms 防抖
    schedulePlayerAiQuickActionSync(0);
  };
  const observer = new MutationObserver(sync);

  // 优先观察播放器容器；容器不存在时退回观察 body 的 childList+subtree
  //（B 站播放器常挂进嵌套容器，不带 subtree 发现不了深层挂载，只能等
  // retry 退避兜底，最坏 1s 步长）。发现播放器后断开 body 观察并
  // 切换到容器，subtree 全观察的开销只存在于启动窗口。
  const playerContainer = document.querySelector(PLAYER_CONTAINER_SELECTOR);
  if (playerContainer) {
    observer.observe(playerContainer, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"]
    });
    playerAiState.setObserver(observer);
    return;
  }

  const bodyObserver = new MutationObserver(() => {
    const nextPlayerContainer = document.querySelector(PLAYER_CONTAINER_SELECTOR);
    if (!nextPlayerContainer) {
      return;
    }
    bodyObserver.disconnect();
    observer.observe(nextPlayerContainer, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"]
    });
    playerAiState.setObserver(observer);
    sync();
  });
  bodyObserver.observe(document.body, { childList: true, subtree: true });
  playerAiState.setObserver(bodyObserver);
}

export function bindPlayerAiQuickActionLayoutEvents(): void {
  if (playerAiState.playerAiQuickActionLayoutBound) {
    return;
  }
  // handler 提升为模块级引用：stop 时必须用同一引用才能成对摘除监听
  playerAiQuickActionLayoutHandler = () => schedulePlayerAiQuickActionSync(80);
  const schedule = playerAiQuickActionLayoutHandler;
  window.addEventListener("resize", schedule, { passive: true });
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("pageshow", schedule, { passive: true });
  document.addEventListener("fullscreenchange", schedule);
  document.addEventListener("webkitfullscreenchange", schedule);
  window.visualViewport?.addEventListener?.("resize", schedule, { passive: true });
  playerAiState.setLayoutBound(true);
}

function unbindPlayerAiQuickActionLayoutEvents(): void {
  if (!playerAiQuickActionLayoutHandler) {
    return;
  }
  // addEventListener 的 { passive: true } 不参与 removeEventListener 匹配，
  // 只需 type + handler（+capture）一致即可摘除
  const schedule = playerAiQuickActionLayoutHandler;
  window.removeEventListener("resize", schedule);
  window.removeEventListener("scroll", schedule);
  window.removeEventListener("pageshow", schedule);
  document.removeEventListener("fullscreenchange", schedule);
  document.removeEventListener("webkitfullscreenchange", schedule);
  window.visualViewport?.removeEventListener?.("resize", schedule);
  playerAiQuickActionLayoutHandler = null;
  playerAiState.setLayoutBound(false);
}

// 挂载同步的调度器（delayMs === 0 走帧内快车道）：0 用 requestAnimationFrame，
// 其余用 setTimeout。为什么快车道必要：首挂载必须等播放器完成布局，而合成帧
// 之后就能拿到正确 rect，比任何 ≥100ms 的退避拍都快一个量级；实测首挂载的
// setTimeout(120) 在页面首载负载下会被拖到 200–400ms。同步槽位以符号区分两种
// 句柄（正数 = setTimeout id，负数 = rAF id），保持 state 单一槽位不变。
export function schedulePlayerAiQuickActionSync(delayMs = 120): void {
  cancelPlayerAiQuickActionSync();
  if (delayMs === 0) {
    // rAF 句柄另挂到 window 上：用例间 vi.resetModules() 换注册表后，上一注册表
    // 排的帧仍会在下一用例的 fake 时钟里开火（本文件头注记的残留时钟问题），
    // beforeEach 需要能按 id 取消上一注册表的帧。
    const rafId = window.requestAnimationFrame(() => {
      playerAiState.setSyncTimer(0);
      syncPlayerAiQuickActionButton();
    });
    (window as Window).__bocPlayerAiSyncRaf = rafId;
    playerAiState.setSyncTimer(-rafId);
    return;
  }
  playerAiState.setSyncTimer(window.setTimeout(() => {
    playerAiState.setSyncTimer(0);
    syncPlayerAiQuickActionButton();
  }, delayMs));
}

function cancelPlayerAiQuickActionSync(): void {
  const handle = playerAiState.playerAiQuickActionSyncTimer;
  if (!handle) {
    return;
  }
  if (handle < 0) {
    window.cancelAnimationFrame(-handle);
  } else {
    window.clearTimeout(handle);
  }
  playerAiState.setSyncTimer(0);
}

function schedulePlayerAiQuickActionRetry(): void {
  // 帧内快车道（工单 button-injection-stability/03）：宿主控件/播放器容器的
  // 就绪窗口只有几帧，先用 rAF 逐帧重试（预算 20 帧 ≈330ms），预算耗尽再回落到
  // 退避定时器，避免长时间不可见时逐帧空转。
  if (playerAiQuickActionFrameRetriesLeft > 0) {
    playerAiQuickActionFrameRetriesLeft -= 1;
    schedulePlayerAiQuickActionSync(0);
    return;
  }
  // 退避节奏加密（工单 button-injection-stability/01）：首拍 100ms、步进
  // +100ms、封顶 1s（原 260ms 起步 / 2.5s 封顶——视频已出而字幕控件未渲染时
  // 按钮最坏以 2.5s 步长干等）。字幕控件门语义不变，只加密重试节拍。
  const delay = Math.min(100 * (playerAiQuickActionRetryCount + 1), 1000);
  playerAiQuickActionRetryCount += 1;
  schedulePlayerAiQuickActionSync(delay);
}

function syncPlayerAiQuickActionButton(): void {
  // 设置门控先于一切：关闭态仍要摘按钮（含清就位记录）。
  if (!state.settings?.enablePlayerAiQuickAction) {
    // 工单 08 决议 2：按钮常驻（阅读模式内/外都显示），仅设置开关门控挂载。
    removePlayerAiQuickActionButton();
    return;
  }

  // 已就位短路（性能工单）：按钮在原位且宿主判定仍是它时，跳过字幕控件扫描
  // （多个 querySelectorAll + 逐候选读属性）——播放中每帧回调的主要开销。只留
  // 幂等的视觉校准（值已在位则零写入）。失同步自愈不受影响：按钮被 B 站摘掉后
  // wrap.isConnected / 宿主记录即失效，本短路不成立，落到下方原有路径走
  // rAF / 退避重试补回。
  if (tryRefreshPlayerAiQuickActionVisuals()) {
    // 与下方挂载成功同一条不变量：成功即在位，重置重试计数并补满帧内快车道
    // 预算（下次「宿主重新就绪」仍从逐帧重试开始）。
    playerAiQuickActionRetryCount = 0;
    playerAiQuickActionFrameRetriesLeft = PLAYER_AI_FRAME_RETRY_BUDGET;
    return;
  }

  const existing = document.getElementById("boc-player-ai-quick-action");
  const existingWrap = existing?.closest(".boc-player-ai-wrap");
  if (!hasPlayerSubtitleControl()) {
    removePlayerAiQuickActionButton();
    schedulePlayerAiQuickActionRetry();
    return;
  }

  const playerHost = findPlayerAiQuickActionHost();
  if (!playerHost) {
    existingWrap?.remove();
    existing?.remove();
    clearPlayerAiQuickActionMountRecord();
    schedulePlayerAiQuickActionRetry();
    return;
  }

  let button: HTMLButtonElement | null = existing instanceof HTMLButtonElement ? existing : null;
  let wrap = existingWrap instanceof HTMLElement ? existingWrap : null;
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "boc-player-ai-wrap";
    wrap.setAttribute("data-boc-extension-node", "ai-quick-action");
  }
  if (!button) {
    button = document.createElement("button");
    button.id = "boc-player-ai-quick-action";
    button.type = "button";
    button.className = "boc-player-ai-quick-action";
    button.title = "用 AI 分析这期视频";
    button.setAttribute("aria-label", "用 AI 分析这期视频");
    button.innerHTML = buildPlayerAiQuickActionIconSvg();
    button.addEventListener("click", handlePlayerAiQuickActionClick, true);
  }

  if (button.parentElement !== wrap) {
    wrap.replaceChildren(button);
  }
  if (wrap.parentElement !== playerHost) {
    playerHost.appendChild(wrap);
  }
  bindPlayerAiQuickActionCursorSync(wrap);
  syncPlayerAiQuickActionVisuals(button);
  // 就位记录（性能工单）：下一次 sync 走短路，只校准样式。
  playerAiQuickActionMountedWrap = wrap;
  playerAiQuickActionMountedHost = playerHost;
  playerAiQuickActionRetryCount = 0;
  // 挂载成功即补满帧内快车道预算：下次「宿主重新就绪」（SPA 换片、阅读模式
  // 进出后的重挂）同样从逐帧重试开始，不用等退避拍。
  playerAiQuickActionFrameRetriesLeft = PLAYER_AI_FRAME_RETRY_BUDGET;
  if (!mountTimingLogged) {
    mountTimingLogged = true;
    logInfoAlways(
      `[BOC] player-ai: AI 键已挂载，装载→挂载耗时 ${Date.now() - MODULE_BOOT_AT}ms`
    );
  }
}

export function removePlayerAiQuickActionButton(): void {
  // 就位记录同步清空：按钮已摘，下次 sync 必须重跑完整路径才能补回。
  clearPlayerAiQuickActionMountRecord();
  if (playerAiState.playerAiQuickActionRevealTimer) {
    window.clearTimeout(playerAiState.playerAiQuickActionRevealTimer);
    playerAiState.setRevealTimer(0);
  }
  if (playerAiState.playerAiQuickActionHideTimer) {
    window.clearTimeout(playerAiState.playerAiQuickActionHideTimer);
    playerAiState.setHideTimer(0);
  }
  if (playerAiState.playerAiQuickActionCursorHideTimer) {
    window.clearTimeout(playerAiState.playerAiQuickActionCursorHideTimer);
    playerAiState.setCursorHideTimer(0);
  }
  document.getElementById("boc-player-ai-quick-action")?.closest(".boc-player-ai-wrap")?.remove();
}

function bindPlayerAiQuickActionCursorSync(wrap: HTMLElement): void {
  if (!(wrap instanceof HTMLElement)) {
    return;
  }
  const host = wrap.parentElement instanceof HTMLElement ? wrap.parentElement : null;
  if (!host) {
    return;
  }
  // 防重挂守卫语义保持：同一 host + 同一 wrap 不重复绑
  if (
    playerAiQuickActionCursorSync &&
    playerAiQuickActionCursorSync.host === host &&
    playerAiQuickActionCursorSync.wrap === wrap
  ) {
    return;
  }
  // 按钮移除重建会生成新 wrap（旧闭包仍挂在 host 上），换 host 或重建时
  // 先摘掉旧监听再绑新的，否则每次移除→重建泄漏 4 个闭包监听
  unbindPlayerAiQuickActionCursorSync();
  const hideForIdle = () => {
    playerAiState.setCursorHideTimer(0);
    wrap.classList.remove("is-active");
  };
  const showForCursorActivity = () => {
    if (!wrap.isConnected) {
      wrap.classList.remove("is-active");
      return;
    }
    wrap.classList.add("is-active");
    if (playerAiState.playerAiQuickActionCursorHideTimer) {
      window.clearTimeout(playerAiState.playerAiQuickActionCursorHideTimer);
    }
    playerAiState.setCursorHideTimer(window.setTimeout(hideForIdle, 1900));
  };
  const hideImmediately = () => {
    if (playerAiState.playerAiQuickActionCursorHideTimer) {
      window.clearTimeout(playerAiState.playerAiQuickActionCursorHideTimer);
      playerAiState.setCursorHideTimer(0);
    }
    wrap.classList.remove("is-active");
  };
  host.addEventListener("mousemove", showForCursorActivity, { passive: true });
  host.addEventListener("mouseenter", showForCursorActivity, { passive: true });
  host.addEventListener("mouseleave", hideImmediately, { passive: true });
  playerAiQuickActionCursorSync = { host, wrap, showForCursorActivity, hideImmediately };
  (wrap as HTMLElement & { __bocPlayerAiCursorHost?: HTMLElement }).__bocPlayerAiCursorHost = host;
}

function unbindPlayerAiQuickActionCursorSync(): void {
  if (!playerAiQuickActionCursorSync) {
    return;
  }
  const { host, showForCursorActivity, hideImmediately } = playerAiQuickActionCursorSync;
  host.removeEventListener("mousemove", showForCursorActivity);
  host.removeEventListener("mouseenter", showForCursorActivity);
  host.removeEventListener("mouseleave", hideImmediately);
  playerAiQuickActionCursorSync = null;
}

function hasPlayerSubtitleControl(): boolean {
  return Boolean(findPlayerSubtitleControlNode());
}

function findPlayerSubtitleControlNode(): Element | null {
  const controlRoots = Array.from(
    document.querySelectorAll(
      "#bilibili-player .bpx-player-control-wrap, #playerWrap .bpx-player-control-wrap, .bpx-player-container .bpx-player-control-wrap, #bilibili-player, #playerWrap, .bpx-player-container, .player-wrap"
    )
  );

  for (const root of controlRoots) {
    const candidates = Array.from(
      root.querySelectorAll(
        "[aria-label*='字幕'], [title*='字幕'], [data-text*='字幕'], [class*='subtitle'], [class*='caption'], button, [role='button']"
      )
    );
    const matched = candidates.find((node) => isPlayerSubtitleControlNode(node));
    if (matched) {
      return matched;
    }
  }

  return null;
}

function isPlayerSubtitleControlNode(node: unknown): boolean {
  if (!(node instanceof Element)) {
    return false;
  }
  const text = [
    node.getAttribute("aria-label"),
    node.getAttribute("title"),
    node.getAttribute("data-text"),
    node.textContent,
    typeof node.className === "string" ? node.className : ""
  ]
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .join(" ");
  return /字幕|subtitle/i.test(text);
}

function findPlayerAiQuickActionHost(): HTMLElement | null {
  const candidates = [
    document.querySelector(".bpx-player-container"),
    document.querySelector(".bpx-player-video-area"),
    document.getElementById("bilibili-player"),
    document.getElementById("playerWrap"),
    document.querySelector(".player-wrap")
  ];
  const direct = candidates.find((node): node is HTMLElement => node instanceof HTMLElement && isVisibleReaderControl(node)) || null;
  if (direct) {
    return direct;
  }

  const video = getRuntimeVideoElement();
  if (!video) {
    return null;
  }

  const host =
    video.closest(".bpx-player-container") ||
    video.closest(".bpx-player-video-area") ||
    video.closest("#bilibili-player") ||
    video.closest("#playerWrap") ||
    video.closest(".player-wrap") ||
    video.parentElement;
  if (host instanceof HTMLElement && isVisibleReaderControl(host)) {
    return host;
  }

  return null;
}

function syncPlayerAiQuickActionVisuals(button: HTMLElement): void {
  if (!(button instanceof HTMLElement)) {
    return;
  }
  const wrap = button.parentElement instanceof HTMLElement ? button.parentElement : null;
  [wrap, button].filter((node): node is HTMLElement => Boolean(node)).forEach((node) => {
    node.style.setProperty("--boc-player-ai-action-hit-size", `${PLAYER_AI_HIT_SIZE_PX}px`);
    node.style.setProperty("--boc-player-ai-action-color", PLAYER_AI_BASE_COLOR);
    node.style.setProperty("--boc-player-ai-action-hover-color", PLAYER_AI_BASE_COLOR);
  });
  button.style.setProperty("--boc-player-ai-action-icon-size", `${PLAYER_AI_ICON_SIZE_PX}px`);
}

async function handlePlayerAiQuickActionClick(event: MouseEvent): Promise<void> {
  event.preventDefault();
  event.stopPropagation();
  if (playerAiState.playerAiQuickActionSubmitting || Date.now() < playerAiState.playerAiQuickActionSuppressedUntil) {
    return;
  }

  playerAiState.setSubmitting(true);
  const button = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null;
  if (button) {
    button.disabled = true;
  }

  try {
    state.setSettings(await getSettings());
    if (!state.settings?.enablePlayerAiQuickAction) {
      throw new Error("AI 按钮未开启");
    }
    // 工单 08 决议 2（语义反转）：按钮常驻。阅读模式外点击 = background 触发
    // 进入阅读模式；阅读模式内点击 = 直接定位对话 tab。两条路径都由 background
    // 以单条带 chat 负载的 reader-enter 携快捷提示词，content 侧经对话 seam
    // （runQuickActionPrompt）消费：定位对话 tab + 新会话 + 填提示词 + 自动发送。
    // 响应形状由消息类型经 ResponseOf 推断（arch-slim-2/02）；resp?. 保留对
    // 「无监听器时回包为 undefined」的运行时防御。
    const resp = await sendRuntimeMessage({ type: "player-ai-quick-action" });
    if (!resp?.ok) {
      throw new Error(resp?.error || "打开 AI 对话失败");
    }
    setMessage("已定位 AI 对话并发送快捷提示词。");
  } catch (error) {
    setMessage(`AI 快捷操作失败：${getErrorMessage(error)}`);
  } finally {
    playerAiState.setSubmitting(false);
    if (button) {
      button.disabled = false;
    }
  }
}
