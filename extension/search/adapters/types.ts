import type { SearchProviderType } from "../../core/presets.js";

export interface NormalizedSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface BuiltSearchRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export interface BuildSearchRequestInput {
  baseUrl: string;
  apiKey?: string;
  query: string;
  count: number;
}

export interface ParsedSearchResponse {
  results: NormalizedSearchResult[];
  credits?: number;
}

export interface SearchAdapter {
  readonly type: SearchProviderType;
  readonly name: string;
  build(input: BuildSearchRequestInput): BuiltSearchRequest;
  parse(payload: unknown): ParsedSearchResponse;
}

export const SEARCH_SNIPPET_MAX_LENGTH = 500;

export function truncateSnippet(value: unknown): string {
  return String(value || "").slice(0, SEARCH_SNIPPET_MAX_LENGTH);
}
