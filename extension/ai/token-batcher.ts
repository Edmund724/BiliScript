// 「流式 token 合帧」模块（07 票）：offscreen 侧把流式 token 按时间预算合并成
// 数组再 postMessage，削减 offscreen → 宿主 port 的结构化克隆次数（长回复上千
// token 时消息条数下降 ≥90%）。契约：
//   - 窗口从批次内首 token 起算（windowMs，默认 40，票面预算 30~50ms），到期
//     整批吐出；单批次延迟以窗口为上界；
//   - maxPending（默认 32）积压上限提前 flush：高吞吐时延迟不以批次大小无限拉长；
//   - flush() 同步收尾（流结束/中断路径调用），清空积压与计时器，空 flush 无输出；
//   - 全批次拼接与原 token 序列逐字节一致：不丢、不重、不改序（对拍测试锁定）。
// 视觉输出不变：宿主侧按数组逐个走同一 appendToken 渲染收口，帧合帧（rAF）不变。

export interface TokenBatcherOptions {
  /** 批次吐出回调：收到一批 token（至少 1 个）。 */
  onFlush: (tokens: string[]) => void;
  /** 合帧窗口（ms），从批次内首 token 起算。默认 40。 */
  windowMs?: number;
  /** 积压上限：待吐 token 达到该数立即 flush（不再等窗口）。默认 32。 */
  maxPending?: number;
}

export class TokenBatcher {
  private readonly onFlush: (tokens: string[]) => void;
  private readonly windowMs: number;
  private readonly maxPending: number;
  private pending: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor({ onFlush, windowMs = 40, maxPending = 32 }: TokenBatcherOptions) {
    if (typeof onFlush !== "function") {
      throw new Error("TokenBatcher：onFlush 必须是函数");
    }
    this.onFlush = onFlush;
    this.windowMs = Math.max(1, Math.floor(Number(windowMs)) || 40);
    this.maxPending = Math.max(1, Math.floor(Number(maxPending)) || 32);
  }

  push(token: string): void {
    this.pending.push(token);
    if (this.pending.length >= this.maxPending) {
      this.flush();
      return;
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.windowMs);
    }
  }

  /** 同步吐出全部积压并清掉计时器；无积压时无输出。流结束/中断时调用。
   *  onFlush 自身抛错（端口已断）时吞掉并丢弃本批——端口已断意味着本流无可
   *  接收方，后续事件回吐会走同一错误路径，不另起 unhandled rejection。 */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) {
      return;
    }
    const batch = this.pending;
    this.pending = [];
    try {
      this.onFlush(batch);
    } catch {
      // 端口断连等发送失败：本批丢弃，流将在下一个非 token 事件处收束为错误。
    }
  }
}
