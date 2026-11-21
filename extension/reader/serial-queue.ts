export interface SerialQueue {
  enqueue<T = void>(task: () => Promise<T> | T): Promise<T>;
}

export function createSerialQueue(): SerialQueue {
  let chain: Promise<void> = Promise.resolve();

  return {
    enqueue<T = void>(task: () => Promise<T> | T): Promise<T> {
      const settled = chain.catch(() => {});
      const next = (async () => {
        await settled;
        return await task();
      })();
      chain = next.then(
        () => {},
        () => {}
      );
      return next;
    },
  };
}
