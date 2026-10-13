// extension/entry/clip-switch-transaction.ts
// 换片事务：一次 URL 变化（切视频 / 切 P / 跳进阅读模式地址）的换片编排唯一落点。
// 机制侧（core/url-watcher 的 history 补丁与 href 轮询、popstate / hashchange）
// 只把变化交给 handleUrlChange()；签名判定、换片身份写入、抓取代次递增、各域步骤
// 的启动次序与完成边都在本模块收口。步骤本身由调用点注入——事务只编排次序与错误
// 收口口径，不静态依赖任何域（各域步骤的装载策略留在组合根）。reader 侧对话上下
// 文的 urlchange 自订阅不在此列（补偿订阅见末段完成边注）。
//
// 顺序不变量：
//  1. 同步段（handleUrlChange 返回前完成）：读地址 → 算签名 → 与已落账签名比对，
//     相同即直接返回（零步骤、不发完成边）→ 写地址与签名 → 递增 fetchRunId →
//     恢复普通页状态。
//  2. 递增必须同步先行于本函数派生的任何异步工作（reset 步骤与新视频 refreshClip
//     都在各自的动态装载链之后才执行）。放进 reset 步骤会让装载次序决定成败：
//     新视频的 refreshClip 可能先起跑，再被迟到的递增误杀，自动刷新静默失效。
//  3. 异步段按原启动次序、不 await 地启动：reset 步骤 → player-ai 按钮同步 →
//     三档互斥的 reader 分支。三档恰起步一个：视图未开且地址是阅读模式 → 进入
//     阅读壳；视图已开或正要进入 → 刷新阅读字幕；其余（普通页换片）→ 字幕预抓取。
//     前两档不再起预抓取，只有普通页档起。
//
// 完成边（subscribeSettled）：本次换片启动的步骤全部 settle 后恰发布一次（订阅者
// 异常被吞，不外溢到事务）；签名未变则不发布。它表达「本轮换片编排已派发且其步骤
// 已 settle」——字幕体落定（clip 内容落定）仍由 reader 侧的 subtitle-ready 承担，
// 其补偿订阅的删除另票，本事务不接管该信号。

export interface ClipSwitchTransactionDeps {
  /** 当前地址 */
  readUrl(): string;
  /** 按当前页身份计算的 clip 签名 */
  computeSignature(): string;
  /** 已落账的 clip 签名 */
  readSignature(): string;
  /** 落账换片身份（地址 + 签名） */
  writeIdentity(url: string, signature: string): void;
  /** 当前抓取代次 */
  readRunId(): number;
  /** 覆写抓取代次（fetchRunId 的唯一递增写点） */
  writeRunId(runId: number): void;
  /** 页面状态恢复成普通页（阅读表 / 门控属性的 DOM 守卫） */
  enforceNormalPageStateIfNeeded(url: string): void;
  isReaderViewOpen(): boolean;
  isReaderMode(url: string): boolean;
  isPlayerAiLoaded(): boolean;
  ensureUiReady(): Promise<void>;
  resetClipState(): void | Promise<void>;
  syncPlayerAiQuickAction(): void | Promise<void>;
  enterReaderShellOnUrlNavigation(url: string): void | Promise<void>;
  refreshReaderClip(): void | Promise<void>;
  startSubtitlePrefetch(): void;
  logWarn(message: string, detail?: unknown): void;
}

export interface ClipSwitchTransaction {
  /** 机制入口（popstate / hashchange / biliscript:urlchange）的唯一调用点 */
  handleUrlChange(): void;
  /** 订阅完成边；返回退订函数 */
  subscribeSettled(listener: () => void): () => void;
}

export function createClipSwitchTransaction(deps: ClipSwitchTransactionDeps): ClipSwitchTransaction {
  const settledListeners = new Set<() => void>();

  function publishSettled(): void {
    // 迭代副本：订阅者在回调里退订/新订都不影响本轮发布。
    for (const listener of [...settledListeners]) {
      try {
        listener();
      } catch {
        // 订阅者异常不外溢：完成边只报告本轮换片编排已派发完毕。
      }
    }
  }

  function handleUrlChange(): void {
    const nextUrl = deps.readUrl();
    const nextSignature = deps.computeSignature();
    if (nextSignature === deps.readSignature()) {
      return;
    }

    deps.writeIdentity(nextUrl, nextSignature);
    deps.writeRunId(deps.readRunId() + 1);
    deps.enforceNormalPageStateIfNeeded(nextUrl);

    const shouldEnter = deps.isReaderMode(nextUrl);
    const started: Array<Promise<void>> = [];

    // reset 步骤：UI 壳只在阅读视图已开或本次正要进入时才需要（reset 的重渲与
    // 进入链都要取壳节点）；普通页换片不装载 ui chunk，轻量路径只重置状态——故
    // 壳装载是条件步，reset 本身无条件执行。
    started.push(
      (async () => {
        if (deps.isReaderViewOpen() || shouldEnter) {
          // 壳装载失败不中断编排也不漏 unhandled rejection：记日志即止，本步骤的
          // reset 随之中止（后续 reader 分支与状态提示仍需走到）。
          try {
            await deps.ensureUiReady();
          } catch (error) {
            deps.logWarn("[BILISCRIPT] UI shell ensure after URL change failed", error);
            return;
          }
        }
        // resetClipState 属总结链层，经 ensure 装载后执行；装载/执行失败记日志
        // 不中断编排。
        try {
          await deps.resetClipState();
        } catch (error) {
          deps.logWarn("[BILISCRIPT] clip state reset after URL change failed", error);
        }
      })()
    );

    // player-ai 按钮同步：未加载（快捷开关关闭态）时按钮不存在，跳过——player-ai
    // start 自带初始 sync，开启后的 URL 变化自会恢复同步。
    if (deps.isPlayerAiLoaded()) {
      started.push(
        (async () => {
          try {
            await deps.syncPlayerAiQuickAction();
          } catch {
            // 同步失败静默
          }
        })()
      );
    }

    // 三档互斥分支（恰起步一个）。
    if (!deps.isReaderViewOpen() && shouldEnter) {
      started.push(
        (async () => {
          try {
            await deps.enterReaderShellOnUrlNavigation(nextUrl);
          } catch (error) {
            deps.logWarn("[BILISCRIPT] reading shell load failed", error);
          }
        })()
      );
    } else if (deps.isReaderViewOpen() || shouldEnter) {
      started.push(
        (async () => {
          await deps.refreshReaderClip();
        })()
      );
    } else {
      deps.startSubtitlePrefetch();
    }

    // 完成边：allSettled 不 reject，故恰好发布一次。
    void Promise.allSettled(started).then(publishSettled);
  }

  return {
    handleUrlChange,
    subscribeSettled(listener) {
      settledListeners.add(listener);
      return () => {
        settledListeners.delete(listener);
      };
    }
  };
}
