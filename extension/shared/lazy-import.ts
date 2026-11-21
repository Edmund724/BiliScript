// BILISCRIPT_DUAL_INSTANCE_STATEFUL
export function createLazyLoader<T>(loadFn: () => Promise<T>): {
  load(): Promise<T>;
  isLoaded(): boolean;
} {
  let promise: Promise<T> | null = null;
  return {
    load() {
      if (!promise) {
        promise = loadFn().catch((error: unknown) => {
          promise = null;
          throw error;
        });
      }
      return promise;
    },
    isLoaded() {
      return promise !== null;
    }
  };
}
