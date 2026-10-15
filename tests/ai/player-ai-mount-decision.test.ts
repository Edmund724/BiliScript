import { describe, expect, it } from "vitest";
import {
  decidePlayerAiQuickAction,
  type PlayerAiMountDecisionInput,
  type PlayerAiMountIntent
} from "../../extension/ai/player-ai-mount-decision.js";

describe("decidePlayerAiQuickAction 播放器快捷操作挂载判定纯函数", () => {
  describe("门控与次序不变量", () => {
    it("设置门控先于一切：enabled 为 false 时，无条件返回 none", () => {
      // 遍历所有非 enabled 状态组合，保证任何状态下关闭开关均输出 none
      const booleans = [true, false];
      for (const calibrated of booleans) {
        for (const hasSubtitleControl of booleans) {
          for (const mountedStable of booleans) {
            for (const hasHost of booleans) {
              const decision = decidePlayerAiQuickAction({
                enabled: false,
                calibrated,
                hasSubtitleControl,
                mountedStable,
                hasHost
              });
              expect(decision).toBe("none");
            }
          }
        }
      }
    });

    it("校准信号先于已就位短路：未校准且字幕控件就绪时，旁路短路进入复校", () => {
      // 当 mountedStable 为 true 时，若未校准且控件就绪，红线不变量要求不能走 refresh-visuals，
      // 必须走 recalibrate（有宿主）或 unmount-retry（无宿主）。
      expect(
        decidePlayerAiQuickAction({
          enabled: true,
          calibrated: false,
          hasSubtitleControl: true,
          mountedStable: true,
          hasHost: true
        })
      ).toBe("recalibrate");

      expect(
        decidePlayerAiQuickAction({
          enabled: true,
          calibrated: false,
          hasSubtitleControl: true,
          mountedStable: true,
          hasHost: false
        })
      ).toBe("unmount-retry");
    });

    it("已就位短路：未触发复校且稳定就位时，返回 refresh-visuals", () => {
      // 1. 已校准且已就位：稳定短路
      expect(
        decidePlayerAiQuickAction({
          enabled: true,
          calibrated: true,
          hasSubtitleControl: true,
          mountedStable: true,
          hasHost: true
        })
      ).toBe("refresh-visuals");

      // 2. 控件未就绪但已就位（例如无字幕视频容器门直挂）：稳定短路
      expect(
        decidePlayerAiQuickAction({
          enabled: true,
          calibrated: false,
          hasSubtitleControl: false,
          mountedStable: true,
          hasHost: true
        })
      ).toBe("refresh-visuals");
    });

    it("宿主缺失拆除重试：未就位且宿主缺失时，返回 unmount-retry", () => {
      // 常规挂载中宿主缺失
      expect(
        decidePlayerAiQuickAction({
          enabled: true,
          calibrated: true,
          hasSubtitleControl: true,
          mountedStable: false,
          hasHost: false
        })
      ).toBe("unmount-retry");

      // 初始装载中宿主缺失
      expect(
        decidePlayerAiQuickAction({
          enabled: true,
          calibrated: false,
          hasSubtitleControl: false,
          mountedStable: false,
          hasHost: false
        })
      ).toBe("unmount-retry");
    });

    it("常规挂载：宿主存在且未就位（且非校准信号），返回 mount", () => {
      // 首次挂载（无字幕控件）
      expect(
        decidePlayerAiQuickAction({
          enabled: true,
          calibrated: false,
          hasSubtitleControl: false,
          mountedStable: false,
          hasHost: true
        })
      ).toBe("mount");

      // 已校准但失同步（例如节点被移除后重新挂载）
      expect(
        decidePlayerAiQuickAction({
          enabled: true,
          calibrated: true,
          hasSubtitleControl: true,
          mountedStable: false,
          hasHost: true
        })
      ).toBe("mount");
    });
  });

  describe("五路出边 32 组合完整真值表断言", () => {
    it("真值表穷举：32 种状态全覆盖且五路出边计数守恒", () => {
      const counts: Record<PlayerAiMountIntent, number> = {
        none: 0,
        recalibrate: 0,
        "refresh-visuals": 0,
        mount: 0,
        "unmount-retry": 0
      };

      const booleans = [true, false];
      for (const enabled of booleans) {
        for (const calibrated of booleans) {
          for (const hasSubtitleControl of booleans) {
            for (const mountedStable of booleans) {
              for (const hasHost of booleans) {
                const input: PlayerAiMountDecisionInput = {
                  enabled,
                  calibrated,
                  hasSubtitleControl,
                  mountedStable,
                  hasHost
                };
                const decision = decidePlayerAiQuickAction(input);
                counts[decision] += 1;

                // 规则级严格断言
                if (!enabled) {
                  expect(decision).toBe("none");
                } else {
                  const shouldCalibrate = !calibrated && hasSubtitleControl;
                  if (shouldCalibrate) {
                    if (hasHost) {
                      expect(decision).toBe("recalibrate");
                    } else {
                      expect(decision).toBe("unmount-retry");
                    }
                  } else if (mountedStable) {
                    expect(decision).toBe("refresh-visuals");
                  } else if (!hasHost) {
                    expect(decision).toBe("unmount-retry");
                  } else {
                    expect(decision).toBe("mount");
                  }
                }
              }
            }
          }
        }
      }

      // 五路出边覆盖且总和为 2^5 = 32
      expect(counts.none).toBe(16);
      expect(counts.recalibrate).toBe(2);
      expect(counts["refresh-visuals"]).toBe(6);
      expect(counts.mount).toBe(3);
      expect(counts["unmount-retry"]).toBe(5);
      expect(
        counts.none +
          counts.recalibrate +
          counts["refresh-visuals"] +
          counts.mount +
          counts["unmount-retry"]
      ).toBe(32);
    });
  });
});
