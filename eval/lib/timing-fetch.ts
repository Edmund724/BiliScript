export interface RequestTiming {
  requestIndex: number;
  url: string;
  method: string;
  status: number;
  durationMs: number;
}

export function installTimingFetch(
  realFetch: typeof fetch,
  onRecord: (t: RequestTiming) => void
): () => void {
  const original = globalThis.fetch;
  let requestIndex = 0;

  const timedFetch: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const index = requestIndex++;
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const startedAt = Date.now();

    return realFetch(input, init).then(
      (response) => {
        response
          .clone()
          .arrayBuffer()
          .then(
            () => {
              onRecord({
                requestIndex: index,
                url,
                method,
                status: response.status,
                durationMs: Date.now() - startedAt
              });
            },
            () => {
              onRecord({
                requestIndex: index,
                url,
                method,
                status: response.status,
                durationMs: Date.now() - startedAt
              });
            }
          );
        return response;
      },
      (error) => {
        onRecord({
          requestIndex: index,
          url,
          method,
          status: -1,
          durationMs: Date.now() - startedAt
        });
        throw error;
      }
    );
  }) as typeof fetch;

  globalThis.fetch = timedFetch;

  return () => {
    globalThis.fetch = original;
  };
}
