import type { ResolveSearchProviderResponse } from "../../extension/shared/messaging-protocol.js";
import type {
  SearchChainCandidate,
  SearchChainResolution
} from "../../extension/search/search-chain.js";

type Expect<T extends true> = T;
type Extends<A, B> = A extends B ? true : false;

type ProtocolChainElement = NonNullable<ResolveSearchProviderResponse["chain"]>[number];
type SearchChainElement = SearchChainResolution["chain"][number];

export type ProtocolChainElementExtendsSearchChainElement = Expect<
  Extends<ProtocolChainElement, SearchChainElement>
>;
export type SearchChainElementExtendsProtocolChainElement = Expect<
  Extends<SearchChainElement, ProtocolChainElement>
>;

export type ReExportedCandidateExtendsProtocolChainElement = Expect<
  Extends<SearchChainCandidate, ProtocolChainElement>
>;
export type ProtocolChainElementExtendsReExportedCandidate = Expect<
  Extends<ProtocolChainElement, SearchChainCandidate>
>;
