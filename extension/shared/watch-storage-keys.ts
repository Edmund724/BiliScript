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

interface WatchStorageKeysSlot {
  subscriptions: Set<StorageKeySubscription>;
  registeredHost: typeof chrome.storage.onChanged | null;
  dispatchListener: StorageOnChangeHandler;
}

const WATCH_STORAGE_KEYS_SLOT_KEY = "__BILISCRIPT_WATCH_STORAGE_KEYS__";

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

function getWatchStorageKeysSlot(): WatchStorageKeysSlot {
  const host = globalThis as unknown as Record<string, WatchStorageKeysSlot | undefined>;
  let slot = host[WATCH_STORAGE_KEYS_SLOT_KEY];
  if (!slot) {
    const subscriptions = new Set<StorageKeySubscription>();
    const dispatchListener: StorageOnChangeHandler = (changes, areaName) => {
      for (const subscription of [...subscriptions]) {
        if (!subscriptionMatches(subscription, changes, areaName)) {
          continue;
        }
        subscription.handler(changes, areaName);
      }
    };
    slot = {
      subscriptions,
      registeredHost: null,
      dispatchListener
    };
    host[WATCH_STORAGE_KEYS_SLOT_KEY] = slot;
  }
  return slot;
}

export function watchStorageKeys(handler: StorageOnChangeHandler, watch?: StorageKeyWatch): () => void {
  const slot = getWatchStorageKeysSlot();
  const subscription: StorageKeySubscription = { watch, handler };
  slot.subscriptions.add(subscription);
  const host = typeof chrome === "undefined" ? undefined : chrome.storage?.onChanged;
  if (host && slot.registeredHost !== host) {
    host.addListener(slot.dispatchListener);
    slot.registeredHost = host;
  }
  return () => {
    slot.subscriptions.delete(subscription);
    if (slot.registeredHost && slot.subscriptions.size === 0) {
      slot.registeredHost.removeListener(slot.dispatchListener);
      slot.registeredHost = null;
    }
  };
}
