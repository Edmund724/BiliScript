import { isAbortedMarkerError } from "../shared/error-helpers.js";

export const DEFAULT_MAP_CONCURRENCY = 3;
export const MAX_MAP_RETRIES = 2;

interface MarkedError extends Error {
  overflow?: boolean;
}

interface RunMapBoundedOptions<T, R> {
  items: T[];
  worker: (item: T, index: number) => Promise<R>;
  concurrency?: number;
  signal?: AbortSignal | null;
  onItemDone?: (result: R, index: number) => void;
}

interface RunCachedMapOptions<T, R> {
  items: T[];
  loadCached: (item: T, index: number) => Promise<R | null | undefined> | R | null | undefined;
  run: (item: T, index: number) => Promise<R>;
  concurrency?: number;
  signal?: AbortSignal | null;
  onItemDone?: (result: R, index: number) => void;
}

export async function runCachedMap<T, R>({
  items,
  loadCached,
  run,
  concurrency,
  signal,
  onItemDone
}: RunCachedMapOptions<T, R>): Promise<R[]> {
  const worker = async (item: T, index: number): Promise<R> => {
    const cached = await loadCached(item, index);
    if (cached !== null && cached !== undefined) {
      return cached;
    }
    return await run(item, index);
  };
  return await runMapBounded({ items, worker, concurrency, signal, onItemDone });
}

export async function runMapBounded<T, R>({
  items,
  worker,
  concurrency = DEFAULT_MAP_CONCURRENCY,
  signal,
  onItemDone
}: RunMapBoundedOptions<T, R>): Promise<R[]> {
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Math.floor(Number(concurrency)) || 1);
  const results = new Array<R | undefined>(list.length);
  const queue = list.map((_, index) => index);
  let inFlight = 0;
  let finished = false;

  return await new Promise((resolve, reject) => {
    const settle = (error?: MarkedError | null) => {
      if (finished) return;
      finished = true;
      if (error) reject(error);
      else resolve(results as R[]);
    };

    const pump = () => {
      while (!finished && !signal?.aborted && inFlight < limit && queue.length > 0) {
        const index = queue.shift();
        if (index === undefined) break;
        inFlight += 1;
        runItem(index);
      }
      if (!finished && (signal?.aborted || queue.length === 0) && inFlight === 0) {
        settle(null);
      }
    };

    const runItem = async (index: number) => {
      let lastError: MarkedError | null = null;
      let result: R | undefined;
      for (let attempt = 0; attempt <= MAX_MAP_RETRIES; attempt++) {
        try {
          result = await worker(list[index], index);
          break;
        } catch (e) {
          const err = e as MarkedError;
          if (isAbortedMarkerError(err)) {
            inFlight -= 1;
            settle(err);
            return;
          }
          if (err?.overflow) {
            inFlight -= 1;
            settle(err);
            return;
          }
          lastError = err;
          if (attempt >= MAX_MAP_RETRIES || signal?.aborted) {
            inFlight -= 1;
            settle(lastError);
            return;
          }
        }
      }
      results[index] = result;
      try {
        if (!finished) onItemDone?.(result as R, index);
      } catch (e) {
        inFlight -= 1;
        settle(e as MarkedError);
        return;
      }
      inFlight -= 1;
      pump();
    };

    pump();
  });
}
