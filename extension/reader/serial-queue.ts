// reader 通用串行队列（createSerialQueue）
//
// 语义契约：
//   - 后到等先到落定（含失败）再起跑；
//   - 前序失败不阻断后序，队列链不被前序异常污染；
//   - 每个调用返回的 promise 在其自身任务落定后 resolve / reject；
//   - 链头同步捕获，避免异步微任务间隙 race。
//
// 双实例纪律（对照 docs/adr/0008-content-two-round-build.md 与 scripts/build-content.js）：
//   本模块只进轮 B 懒加载区（reader 域 + shell/script-tab-activation 的共享 chunk），
//   无跨实例消费方，模块级串行队列不挂 globalThis 槽。各调用方分别创建持有独立队列实例。

export interface SerialQueue {
  enqueue<T = void>(task: () => Promise<T> | T): Promise<T>;
}

/**
 * 创建一个独立的单飞串行队列实例。
 * 多个调用并发 enqueue 时，任务按 FIFO 顺序排队执行；
 * 每一个任务均等待前序任务落定（无论 resolve 或 reject）后再启动；
 * 返回的 promise 反映自身任务的落定结果。
 */
export function createSerialQueue(): SerialQueue {
  let chain: Promise<void> = Promise.resolve();

  return {
    enqueue<T = void>(task: () => Promise<T> | T): Promise<T> {
      const settled = chain.catch(() => {});
      const next = (async () => {
        await settled;
        return await task();
      })();
      chain = next.then(
        () => {},
        () => {}
      );
      return next;
    },
  };
}
