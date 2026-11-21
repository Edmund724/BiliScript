export interface TokenBatcherOptions {
  onFlush: (tokens: string[]) => void;
  windowMs?: number;
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
    }
  }
}
