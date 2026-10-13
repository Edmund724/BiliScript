// offscreen-lifecycle.ts — offscreen 文档自身生命周期的簿记与终态判决（可测）。
//
// 同一 offscreen 文档承载三条通道：聊天（"offscreen-chat"）、asr-decode 解码、
// 概览代发（"provider-http-offscreen"，overview-offscreen-transport）。三条通道的
// 存活状态都由本模块持有：聊天用计数，解码与代发用存活端口集合（终态判决要排除
// 本次任务的端口自身——done/error 时它还连着，集合比计数少一分监听注册时序依赖）。
// 端口在 onConnect 时即入集（同步，先于任何消息），入集与出集（断连监听）也都由
// 本模块登记，故三条件的每个读数只有本模块一份来源。
//
// asr-decode 任务到达终态（done / error / 断连取消 / 装载失败）后，调用方调
// noteAsrTerminal 交回判决：聊天端口还在（currentChatCount > 0）、有其他解码任务
// 在跑（刷新竞态下新任务可能已连上本文档）、或有概览代发端口在飞（分钟级请求，
// 被自关吞掉的话回执永远不到）时保留；三条件全空时文档再无承载，自关以释放渲染
// 进程。关闭动作由调用方经 closeSelf 注入（offscreen 文档侧该动作是经 SW 代执行的
// 关闭请求）。
//
// 独立成文件：entry/offscreen.ts 顶层挂满 chrome 事件监听，不可在 Node 测试环境
// 导入；本模块只认识端口的最小结构面，不引用 chrome。

// 本模块只用端口的断连事件；chrome.runtime.Port 结构上满足该面。
export interface LifetimePort {
  onDisconnect: {
    addListener(listener: () => void): void;
  };
}

export interface OffscreenLifetime {
  // 聊天端口入集；其断连自动出集
  trackChatPort(port: LifetimePort): void;
  // asr-decode 端口入集；其断连自动出集
  trackAsrPort(port: LifetimePort): void;
  // 概览代发端口入集；其断连自动出集
  trackProviderPort(port: LifetimePort): void;
  // asr-decode 任务终态：先删自身端口再判，三条件全空才关
  noteAsrTerminal(port: LifetimePort): void;
}

// currentChatCount 为 0 且无在飞代发请求 → 关；NaN/undefined（计数异常）
// → 不关，保守保留文档。
export function shouldCloseAfterAsrTask(
  currentChatCount: unknown,
  activeProviderRequests: unknown
): boolean {
  return Number(currentChatCount) <= 0 && Number(activeProviderRequests) <= 0;
}

// closeSelf 在判决为「关」时同步调用一次；本模块不关心关闭动作的实现与结果。
export function createOffscreenLifetime({
  closeSelf
}: {
  closeSelf: () => void;
}): OffscreenLifetime {
  let currentChatCount = 0;
  const activeAsrPorts = new Set<LifetimePort>();
  const activeProviderPorts = new Set<LifetimePort>();

  return {
    trackChatPort(port) {
      currentChatCount += 1;
      port.onDisconnect.addListener(() => {
        currentChatCount -= 1;
      });
    },
    trackAsrPort(port) {
      activeAsrPorts.add(port);
      port.onDisconnect.addListener(() => {
        activeAsrPorts.delete(port);
      });
    },
    trackProviderPort(port) {
      activeProviderPorts.add(port);
      port.onDisconnect.addListener(() => {
        activeProviderPorts.delete(port);
      });
    },
    noteAsrTerminal(port) {
      // 排除本次终态任务的端口：done/error 时它还连着（页面收到终态后才断连
      // 收尾），断连取消时可能已被断连监听移出——Set.delete 幂等，两种时序都
      // 正确。判决必须在终态消息 postMessage 发完之后，关闭之后无法再发。
      activeAsrPorts.delete(port);
      if (
        activeAsrPorts.size > 0 ||
        !shouldCloseAfterAsrTask(currentChatCount, activeProviderPorts.size)
      ) {
        return;
      }
      closeSelf();
    }
  };
}
