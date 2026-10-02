// 链候选形状漂移守卫（typecheck-only）：
// 文件名不含 .test.，vitest 不收集；tsc --noEmit 门禁执行本文件。
// chain 元素形状单源在协议层（shared/messaging-protocol.ts 的 SearchChainCandidate），
// search-chain 侧反向 import 消费并 re-export。本守卫把「协议层 chain 元素」与
// 「search-chain 实际消费的链元素」钉成互为 extends（双向赋值兼容）：任一侧悄悄
// 改形状、或 search-chain 重新自持一份结构副本，都会在此处编译报错，而不是退化成
// 静默的结构兼容（两侧各自演进、赋值点不报错）。
import type { ResolveSearchProviderResponse } from "../../extension/shared/messaging-protocol.js";
import type {
  SearchChainCandidate,
  SearchChainResolution
} from "../../extension/search/search-chain.js";

type Expect<T extends true> = T;
type Extends<A, B> = A extends B ? true : false;

// 协议层 chain 元素（NonNullable 收掉可选）与 search-chain 链解析产物的元素。
type ProtocolChainElement = NonNullable<ResolveSearchProviderResponse["chain"]>[number];
type SearchChainElement = SearchChainResolution["chain"][number];

// 双向：任一侧多出必填字段 / 改字段类型都会有一向为 false。
export type ProtocolChainElementExtendsSearchChainElement = Expect<
  Extends<ProtocolChainElement, SearchChainElement>
>;
export type SearchChainElementExtendsProtocolChainElement = Expect<
  Extends<SearchChainElement, ProtocolChainElement>
>;

// re-export 面：search-chain 导出的候选类型与协议层 chain 元素互为 extends
// （既有消费方从 search-chain import 的类型必须与线格式同形）。
export type ReExportedCandidateExtendsProtocolChainElement = Expect<
  Extends<SearchChainCandidate, ProtocolChainElement>
>;
export type ProtocolChainElementExtendsReExportedCandidate = Expect<
  Extends<ProtocolChainElement, SearchChainCandidate>
>;
