// BILISCRIPT_DUAL_INSTANCE_STATEFUL
export interface StorageKeyWatch {
  sync?: readonly string[];
  local?: readonly string[];
}

type StorageChangeMap = { [key: string]: chrome.storage.StorageChange };
type StorageOnChangeHandler = (changes: StorageChangeMap, areaName: string) => void;

interface StorageKeySubscription {
  watch: StorageKeyWatch | undefined;
  handler: StorageOnChangeHandler;
}

const subscriptions = new Set<StorageKeySubscription>();
let registeredHost: typeof chrome.storage.onChanged | null = null;

function subscriptionMatches(subscription: StorageKeySubscription, changes: StorageChangeMap, areaName: string): boolean {
  if (!subscription.watch) {
    return true;
  }
  const keys = subscription.watch[areaName as keyof StorageKeyWatch];
  if (!keys) {
    return false;
  }
  return keys.some((key) => Object.prototype.hasOwnProperty.call(changes, key));
}

const dispatchListener = (changes: StorageChangeMap, areaName: string): void => {
  for (const subscription of [...subscriptions]) {
    if (!subscriptionMatches(subscription, changes, areaName)) {
      continue;
    }
    subscription.handler(changes, areaName);
  }
};

export function watchStorageKeys(handler: StorageOnChangeHandler, watch?: StorageKeyWatch): () => void {
  const subscription: StorageKeySubscription = { watch, handler };
  subscriptions.add(subscription);
  const host = typeof chrome === "undefined" ? undefined : chrome.storage?.onChanged;
  if (host && registeredHost !== host) {
    host.addListener(dispatchListener);
    registeredHost = host;
  }
  return () => {
    subscriptions.delete(subscription);
    if (registeredHost && subscriptions.size === 0) {
      registeredHost.removeListener(dispatchListener);
      registeredHost = null;
    }
  };
}
