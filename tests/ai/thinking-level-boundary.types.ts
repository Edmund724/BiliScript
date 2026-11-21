//   已经是合法档位）时，下面的直写不再编译失败，tsc 报 "Unused '@ts-expect-error'

import type { ChatMsg, StreamChatArgs } from "../../extension/ai/ladder.js";
import type { ChatCompletionInput } from "../../extension/ai/completion.js";
import type { ThinkingRequestFacts } from "../../extension/ai/plan-thinking.js";
import type { CreateReaderChatModelPanelDeps, ReaderChatModelPanel } from "../../extension/reader/chat-model-panel.js";
import {
  THINKING_DEFAULT_LEVEL,
  normalizeThinkingLevel,
  type ThinkingLevelInput,
  type ThinkingLevelValue
} from "../../extension/ai/thinking-levels.js";

declare const dirtyWireValue: unknown;

function takesLevel(_level: ThinkingLevelValue): void {}

export function assertThinkingLevelBoundarySplit(): void {
  const atPort: ChatMsg["thinkingLevel"] = dirtyWireValue;
  const atLadder: StreamChatArgs["thinkingLevel"] = dirtyWireValue;
  const atCompletion: ChatCompletionInput["thinkingLevel"] = dirtyWireValue;
  const atPlanning: ThinkingRequestFacts["level"] = dirtyWireValue;
  const boundary: ThinkingLevelInput = "ultra";
  const boundaryDirty: ThinkingLevelInput = dirtyWireValue;
  void [atPort, atLadder, atCompletion, atPlanning, boundary, boundaryDirty];

  // @ts-expect-error 未归一的边界值不是 string（unknown 无字符串方法）
  (null as unknown as NonNullable<ChatMsg["thinkingLevel"]>).trim();
  // @ts-expect-error 同上（请求构造缝）：边界类型不可直接赋给 string
  const asString: string = null as unknown as NonNullable<ChatCompletionInput["thinkingLevel"]>;
  void asString;

  const atSetThinkingLevel: Parameters<ReaderChatModelPanel["setThinkingLevel"]>[0] = dirtyWireValue;
  const atPickLevel: Parameters<NonNullable<CreateReaderChatModelPanelDeps["pickLevel"]>>[0] = dirtyWireValue;
  void [atSetThinkingLevel, atPickLevel];

  // @ts-expect-error 设置侧档位入口的形参是未归一外部值，不是 string（unknown 无字符串方法）
  (null as unknown as Parameters<ReaderChatModelPanel["setThinkingLevel"]>[0]).trim();
  // @ts-expect-error 面板侧档位出口同上；收窄回 string 即让这两条 @ts-expect-error 变 Unused
  (null as unknown as Parameters<NonNullable<CreateReaderChatModelPanelDeps["pickLevel"]>>[0]).trim();

  // @ts-expect-error 未归一的边界值不能直接当档位值用（先过边界归一）
  takesLevel(dirtyWireValue as ThinkingLevelInput);
  const normalized: ThinkingLevelValue = normalizeThinkingLevel(7);
  const fallback: ThinkingLevelValue = THINKING_DEFAULT_LEVEL;
  takesLevel(normalized);
  takesLevel(fallback);

  // @ts-expect-error 编造档位不是 ThinkingLevelValue
  const fake: ThinkingLevelValue = "hihg";
  // @ts-expect-error 裸 string 不能冒充档位值（string 含词表外的任意值）
  const bare: ThinkingLevelValue = "high" as string;
  void [fake, bare];
}
