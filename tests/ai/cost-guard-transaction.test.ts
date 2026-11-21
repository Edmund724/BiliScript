import { describe, expect, it, vi } from "vitest";
import { COST_GUARD_MIN_CALLS, runCostGuard } from "../../extension/ai/cost-guard.js";

function makeAsk(confirmed: boolean) {
  return vi.fn(async (_message: string) => confirmed);
}

describe("runCostGuard 护栏事务", () => {
  it("① 未达阈值：不询问、不拒绝，ask 与 onDecline 都不调用", async () => {
    const ask = makeAsk(true);
    const onDecline = vi.fn();

    const declined = await runCostGuard({
      estimatedCalls: COST_GUARD_MIN_CALLS - 1,
      estimatedTokens: 1234,
      ask,
      onDecline
    });

    expect(declined).toBe(false);
    expect(ask).not.toHaveBeenCalled();
    expect(onDecline).not.toHaveBeenCalled();
  });

  it("② 达阈值且确认：放行，onDecline 不被调用；询问文案由事务自身构建", async () => {
    const ask = makeAsk(true);
    const onDecline = vi.fn();

    const declined = await runCostGuard({
      estimatedCalls: 8,
      estimatedTokens: 150000,
      ask,
      onDecline
    });

    expect(declined).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toBe("预计约 8 次调用 / 约 150,000 token，可取消");
    expect(onDecline).not.toHaveBeenCalled();
  });

  it("③ 达阈值但未确认：走 onDecline 拒绝出口并报拒绝", async () => {
    const ask = makeAsk(false);
    const onDecline = vi.fn();

    const declined = await runCostGuard({
      estimatedCalls: 8,
      estimatedTokens: 150000,
      ask,
      onDecline
    });

    expect(declined).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  it("④ precheck 返回真值：询问前短路，ask 与 onDecline 都不调用", async () => {
    const ask = makeAsk(true);
    const onDecline = vi.fn();
    const precheck = vi.fn(() => true);

    const declined = await runCostGuard({
      estimatedCalls: 8,
      estimatedTokens: 150000,
      ask,
      onDecline,
      precheck
    });

    expect(declined).toBe(false);
    expect(precheck).toHaveBeenCalledTimes(1);
    expect(ask).not.toHaveBeenCalled();
    expect(onDecline).not.toHaveBeenCalled();
  });
});
