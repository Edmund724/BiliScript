// tests/ai/thinking-level-boundary.types.ts — 档位「未归一的外部值 / 归一后的档位值」
// 分层的编译期断言（票 thinking-seam-tightening/02）。
//
// 本文件不是 vitest 用例（文件名不匹配 vitest 的 test/spec glob），由 `pnpm typecheck`
//（tsc --noEmit，include tests/**/*.ts）执行：
// - 收窄可被绕过 ⇒ 断言失败：链上任何一处签名被「顺手」改回 string（或在声明面假装
//   已经是合法档位）时，下面的直写不再编译失败，tsc 报 "Unused '@ts-expect-error'
//   directive"；反之边界签名被收窄成 ThinkingLevelValue 时，正向直写直接报错；
// - 末尾的正向对照证明断言不是「谁都传不进」（归一化的出口照常是档位值）。
//
// 为什么用类型而不是运行期用例：本票的收益正是「哪一层是归一化边界」在编译期可见——
// 运行期看不出链上某一层多调了一次归一化（归一幂等，落线字节相同），也看不出端口声明的
// 宽容面被悄悄收窄（脏值在运行期仍被解析入口兜住）。归一化边界画法（本票裁定）：
//   端口载荷 / 请求字段（未归一的外部值，宽容）
//      → 链上只透传（ladder / client / completion → 思考装配边的 ThinkingRequestFacts；
//        ChatRequest 承载的是装配产出 ThinkingWireOutput，不再是边界签名）
//      → 归一化施加点：resolveThinkingProfile / resolveThinkingAdjustment
//      → 归一之后才是 ThinkingLevelValue（面板 / 存储 / clamp 落线）。
// 设置 / 面板侧的另两处施加点（providers.ts 的 setThinkingLevel / 面板的 pickLevel）
// 与请求链同用「未归一的外部值」声明（票 thinking-seam-tightening/03）。
// 「链上只透传」的运行期判据在 tests/ai/ladder.test.ts（脏值原样到达下游，不判不归）。

import type { ChatMsg, StreamChatArgs } from "../../extension/ai/ladder.js";
import type { ChatCompletionInput } from "../../extension/ai/completion.js";
import type { ThinkingRequestFacts } from "../../extension/ai/plan-thinking.js";
// 设置 / 面板侧的两处归一入口声明面（票 thinking-seam-tightening/03）。
import type { ProviderPrefs } from "../../extension/chat/providers.js";
import type { CreateReaderChatModelPanelDeps } from "../../extension/reader/chat-model-panel.js";
import {
  THINKING_DEFAULT_LEVEL,
  normalizeThinkingLevel,
  type ThinkingLevelInput,
  type ThinkingLevelValue
} from "../../extension/ai/thinking-levels.js";

// 端口载荷里真实可到的任意脏值（wire 值是外部输入）：非字符串、空串、上游的 none、
// 编造词都算——与 tests/ai/thinking-default-fallback.test.ts 的脏值集合同源。
declare const dirtyWireValue: unknown;

function takesLevel(_level: ThinkingLevelValue): void {}

export function assertThinkingLevelBoundarySplit(): void {
  // ===== 正向：边界签名收得下「未归一的外部值」=====
  // 逐个塞进链上的每一个边界签名：任何一处收窄成 string 或 ThinkingLevelValue，下面的
  // 直写即编译失败（这正是收窄的「未改调用点先红」判据）。
  const atPort: ChatMsg["thinkingLevel"] = dirtyWireValue;
  const atLadder: StreamChatArgs["thinkingLevel"] = dirtyWireValue;
  const atCompletion: ChatCompletionInput["thinkingLevel"] = dirtyWireValue;
  // 请求链上最后一站未归一声明面：思考装配边的入参（唯一调用点是 completion.ts 的
  // fetch 点；adapter 的 ChatRequest 承载的是装配产出，不在本链上）。
  const atPlanning: ThinkingRequestFacts["level"] = dirtyWireValue;
  const boundary: ThinkingLevelInput = "ultra";
  const boundaryDirty: ThinkingLevelInput = dirtyWireValue;
  void [atPort, atLadder, atCompletion, atPlanning, boundary, boundaryDirty];

  // ===== 边界值不透明：不许把它当字符串用 =====
  // 收成 string 会让链上的值重新长出字符串语义（本票收窄口径的反面）。
  // @ts-expect-error 未归一的边界值不是 string（unknown 无字符串方法）
  (null as unknown as NonNullable<ChatMsg["thinkingLevel"]>).trim();
  // @ts-expect-error 同上（请求构造缝）：边界类型不可直接赋给 string
  const asString: string = null as unknown as NonNullable<ChatCompletionInput["thinkingLevel"]>;
  void asString;

  // ===== 设置 / 面板侧：同一条归一化的另两处施加点，入参域同为「未归一的外部值」（票 03）=====
  // 设置侧 = chat/providers.ts 的 setThinkingLevel（档位落盘入口，内部就调
  // normalizeAiThinkingLevel）；面板侧 = 面板档位条目的点击出口——chat-tab.ts 的
  // pickThinkingLevel 是模块私有实现，钉在它的声明面 chat-model-panel.ts 的 deps.pickLevel
  // 上（面板传的正是 dataset 里的档位词）。两处与请求链同用 ThinkingLevelInput：收 whatever、
  // 归一化只在落盘前做一次（缺省 / 脏值 → default），不在这里判、不在这里拒。
  const atSetThinkingLevel: Parameters<ProviderPrefs["setThinkingLevel"]>[0] = dirtyWireValue;
  const atPickLevel: Parameters<CreateReaderChatModelPanelDeps["pickLevel"]>[0] = dirtyWireValue;
  void [atSetThinkingLevel, atPickLevel];

  // @ts-expect-error 设置侧档位入口的形参是未归一外部值，不是 string（unknown 无字符串方法）
  (null as unknown as Parameters<ProviderPrefs["setThinkingLevel"]>[0]).trim();
  // @ts-expect-error 面板侧档位出口同上；收窄回 string 即让这两条 @ts-expect-error 变 Unused
  (null as unknown as Parameters<CreateReaderChatModelPanelDeps["pickLevel"]>[0]).trim();

  // ===== 分层：边界值 ≠ 档位值（归一化是唯一转换入口）=====
  // @ts-expect-error 未归一的边界值不能直接当档位值用（先过边界归一）
  takesLevel(dirtyWireValue as ThinkingLevelInput);
  // 正向对照：归一化的出口就是档位值（缺省 / 脏值 → default 是运行期事实，见
  // tests/ai/thinking-default-fallback.test.ts）。
  const normalized: ThinkingLevelValue = normalizeThinkingLevel(7);
  const fallback: ThinkingLevelValue = THINKING_DEFAULT_LEVEL;
  takesLevel(normalized);
  takesLevel(fallback);

  // ===== 负向：归一之后只能是词表叶的 8 个可选值 =====
  // @ts-expect-error 编造档位不是 ThinkingLevelValue
  const fake: ThinkingLevelValue = "hihg";
  // @ts-expect-error 裸 string 不能冒充档位值（string 含词表外的任意值）
  const bare: ThinkingLevelValue = "high" as string;
  void [fake, bare];
}
