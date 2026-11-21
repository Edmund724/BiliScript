import { createDisposableContext, type DisposableContext } from "../shared/typed-event-bus.js";

export type SessionTriggerTeardown = () => void;

export interface ReaderChatSessionTriggersDeps {
  statusBus: () => SessionTriggerTeardown;
  urlChange: () => SessionTriggerTeardown;
  clipSettle: () => SessionTriggerTeardown;
  storageWatcher: () => SessionTriggerTeardown;
  quickPrompts: () => SessionTriggerTeardown;
  outsideClick: () => SessionTriggerTeardown;
  escapeKey: () => SessionTriggerTeardown;
}

export interface ReaderChatSessionTriggers {
  activate: () => void;
  deactivate: () => void;
  isActive: () => boolean;
}

const TRIGGER_ORDER: ReadonlyArray<keyof ReaderChatSessionTriggersDeps> = [
  "statusBus",
  "urlChange",
  "clipSettle",
  "storageWatcher",
  "quickPrompts",
  "outsideClick",
  "escapeKey"
];

export function createReaderChatSessionTriggers(deps: ReaderChatSessionTriggersDeps): ReaderChatSessionTriggers {
  let scope: DisposableContext | null = null;

  function activate(): void {
    if (scope && !scope.isDisposed()) {
      return;
    }
    const nextScope = createDisposableContext();
    scope = nextScope;
    TRIGGER_ORDER.forEach((source) => {
      nextScope.track(deps[source]());
    });
  }

  function deactivate(): void {
    const current = scope;
    scope = null;
    current?.dispose();
  }

  return {
    activate,
    deactivate,
    isActive: () => Boolean(scope && !scope.isDisposed())
  };
}
