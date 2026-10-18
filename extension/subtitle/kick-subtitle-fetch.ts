// 字幕抓取起跑序列的单一实现：「先 ensureSummarizeChain() 再起字幕刷新」的次序
// 不变量只写在此处。refreshClip 的同步前缀先于首个 await 写 loading（
// clip.subtitleFetchState = "loading"），对话发送路径的等待闸据此不放行空上下文——
// 次序被打乱（先刷新请求后装链）会让等待闸在 loading 写入前抢跑。
//
// 收进本模块的共有序列：「在手或在飞」判定 → 等视频元数据 → （后判定）→ 装链 →
// 起刷新。各起跑方只在 policy 里注入自己的差异：
//   - 失败出口形态：布尔返回（函数返回值，false = 链装载失败且未继续）与
//     onChainLoadFailed / onRefreshFailed 回调（状态栏文案 / 播报文案 / 日志）；
//   - awaitRefresh：false 时起跑后浮空——业务上只需 loading 同步前缀，失败仍走
//     onRefreshFailed；
//   - stale（代次让位，code === "STALE_RUN"）错误口径：isRefreshFailureSilent，
//     缺省 stale 静默。该过滤只作用于刷新失败；链装载失败原样进
//     onChainLoadFailed（chunk 装载错误不会是 STALE_RUN，各出口的 stale 口径
//     由回调自行决定）。
//
// 刷新动作以注入的 refresh 回调给出而非本模块直调 chain.refreshClip：
// reader 侧两条入口（lifecycle 后台兜底、chat 发送前起跑）必须经 reader-bus
// seam 转发（reader → fetcher 的依赖反转边，seam 只传话、handler 由链装载
// 注册），本模块身处 subtitle 域不触达 reader；message-handler 的 URL 换片
// 刷新无 seam 约束，直接拿注入的链调 refreshClip。
import { waitForVideoMetadata } from "../bilibili/video-probe.js";
import { isStaleRunError } from "../shared/error-helpers.js";
import { logWarn } from "../shared/logging.js";
import { ensureSummarizeChain, type SummarizeChain } from "./lazy.js";
import { isSubtitleInHandOrInFlight } from "./subtitle-in-hand.js";

export interface KickSubtitleFetchPolicy {
  /** 起跑前判定「本视频字幕在手或在飞」：命中即返回 true（无需起跑，不算失败）。 */
  skipIfInHandOrInFlight?: boolean;
  /** 等元数据后再判一次（等待期间字幕可能已被别处落账，重抓只是白刷一轮）。命中走 onInHandOrInFlight 后返回 true。 */
  recheckAfterVideoMetadata?: boolean;
  /** 后判定命中时的收尾（lifecycle 的对账重渲）。 */
  onInHandOrInFlight?: () => void;
  /** 起跑前等视频元数据（时长可用字幕轨才能按时长对齐；bilibili/video-probe 叶子，永不拒绝）。 */
  awaitVideoMetadata?: boolean;
  /** 总结链装载失败的出口（chunk 装载错误原样传入，stale 过滤不在此作用）。缺省记日志。 */
  onChainLoadFailed?: (error: unknown) => void;
  /** 链装载失败后是否仍发起 refresh。reader 后台路径为 true：seam 无 handler 时空转，行为等价于旧链的「logWarn 后照旧刷新」。缺省 false（返回 false，不发起）。 */
  continueAfterChainLoadFailed?: boolean;
  /** refresh 是否 await。false 时起跑后浮空（失败仍走 onRefreshFailed）。缺省 true。 */
  awaitRefresh?: boolean;
  /** refresh 失败是否静默。缺省 stale（STALE_RUN，代次让位）静默。 */
  isRefreshFailureSilent?: (error: unknown) => boolean;
  /** refresh 失败（且 isRefreshFailureSilent 判为不静默）的出口。缺省记日志。 */
  onRefreshFailed?: (error: unknown) => void;
  /** await 模式下 refresh 落定后的收尾（成败都走；lifecycle 的对账）。浮空模式无落定概念，不调用。 */
  afterRefreshSettled?: () => void;
}

// 返回值：true = 已起跑、或判定/业务口径下无需起跑；false = 总结链装载失败且
// policy 未要求继续（抓取没能起跑）——布尔拦截出口（发送闸）只认这一种失败。
// 重载：continueAfterChainLoadFailed 为 true 时链可能装载失败，refresh 拿到的
// chain 可为 null（seam 转发在无 handler 时空转）；缺省（false）时装载失败即
// 返回，refresh 只会拿到已装载的链。
export function kickSubtitleFetch(
  refresh: (chain: SummarizeChain) => Promise<unknown>,
  policy?: KickSubtitleFetchPolicy & { continueAfterChainLoadFailed?: false }
): Promise<boolean>;
export function kickSubtitleFetch(
  refresh: (chain: SummarizeChain | null) => Promise<unknown>,
  policy: KickSubtitleFetchPolicy & { continueAfterChainLoadFailed: true }
): Promise<boolean>;
export async function kickSubtitleFetch(
  // never 形参是重载兼容写法：两个重载的回调形参互为子类型，实现签名取 never
  // 后两边都可赋值。
  refresh: (chain: never) => Promise<unknown>,
  policy: KickSubtitleFetchPolicy = {}
): Promise<boolean> {
  if (policy.skipIfInHandOrInFlight && isSubtitleInHandOrInFlight()) {
    return true;
  }
  if (policy.awaitVideoMetadata) {
    await waitForVideoMetadata();
  }
  if (policy.recheckAfterVideoMetadata && isSubtitleInHandOrInFlight()) {
    policy.onInHandOrInFlight?.();
    return true;
  }
  let chain: SummarizeChain | null = null;
  try {
    chain = await ensureSummarizeChain();
  } catch (error) {
    (policy.onChainLoadFailed ?? ((e: unknown) =>
      logWarn("[BILISCRIPT] subtitle kick (summarize chain load) failed", { error: e })))(error);
    if (!policy.continueAfterChainLoadFailed) {
      return false;
    }
  }
  const settleRefreshFailure = (error: unknown) => {
    const isSilent = policy.isRefreshFailureSilent ?? isStaleRunError;
    if (!isSilent(error)) {
      (policy.onRefreshFailed ?? ((e: unknown) =>
        logWarn("[BILISCRIPT] subtitle kick refresh failed", { error: e })))(error);
    }
  };
  const runRefresh = async () => refresh(chain as never);
  if (policy.awaitRefresh === false) {
    // 浮空：同步前缀（写 loading）已随 refresh 调用落地，之后的失败只走出口回调。
    void (async () => {
      try {
        await runRefresh();
      } catch (error) {
        settleRefreshFailure(error);
      }
    })();
    return true;
  }
  try {
    await runRefresh();
  } catch (error) {
    settleRefreshFailure(error);
  }
  policy.afterRefreshSettled?.();
  return true;
}
