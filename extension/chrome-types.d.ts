declare namespace chrome {
  namespace runtime {
    interface LastError {
      message?: string;
    }

    interface Manifest {
      version: string;
    }

    interface MessageSender {
      tab?: { id?: number; url?: string };
      origin?: string;
      id?: string;
      url?: string;
    }

    type SendMessageCallback = (response?: unknown) => void;

    const lastError: LastError | undefined;

    function getManifest(): Manifest;
    function getURL(path: string): string;
    function connect(connectInfo: { name: string }): Port;
    function sendMessage(message: unknown): Promise<unknown>;
    function sendMessage(message: unknown, responseCallback?: SendMessageCallback): void;
    function getContexts(query: {
      contextTypes?: string[];
      documentUrls?: string[];
    }): Promise<unknown[]>;

    interface Port {
      name: string;
      sender?: MessageSender;
      postMessage(message: unknown): void;
      disconnect(): void;
      onMessage: {
        addListener(listener: (message: unknown) => void): void;
        removeListener(listener: (message: unknown) => void): void;
      };
      onDisconnect: {
        addListener(listener: () => void): void;
        removeListener(listener: () => void): void;
      };
    }

    interface OnConnect {
      addListener(listener: (port: Port) => void): void;
    }

    interface OnMessage {
      addListener(
        listener: (message: unknown, sender: MessageSender, sendResponse: SendMessageCallback) => boolean | void
      ): void;
      removeListener(
        listener: (message: unknown, sender: MessageSender, sendResponse: SendMessageCallback) => boolean | void
      ): void;
    }

    interface OnInstalled {
      addListener(listener: (details: { reason: string }) => void): void;
    }

    interface OnStartup {
      addListener(listener: () => void): void;
    }

    const id: string;
    const onConnect: OnConnect;
    const onMessage: OnMessage;
    const onInstalled: OnInstalled;
    const onStartup: OnStartup;
  }

  namespace action {
    interface OnClickedEvent {
      addListener(listener: (tab: tabs.Tab) => void): void;
    }

    interface BadgeTextDetails {
      tabId?: number;
      text: string;
    }

    interface BadgeBackgroundColorDetails {
      tabId?: number;
      color: string | [number, number, number, number];
    }

    interface TitleDetails {
      tabId?: number;
      title: string;
    }

    function setBadgeText(details: BadgeTextDetails): Promise<void>;
    function setBadgeBackgroundColor(details: BadgeBackgroundColorDetails): Promise<void>;
    function setTitle(details: TitleDetails): Promise<void>;

    const onClicked: OnClickedEvent;
  }

  namespace commands {
    interface OnCommandEvent {
      addListener(listener: (command: string, tab?: tabs.Tab) => void): void;
    }

    const onCommand: OnCommandEvent;
  }

  namespace tabs {
    interface Tab {
      id?: number;
      active?: boolean;
      status?: string;
      url?: string;
      title?: string;
    }

    interface CreateProperties {
      url?: string;
    }

    interface UpdateProperties {
      url?: string;
    }

    interface OnUpdatedEvent {
      addListener(
        listener: (tabId: number, changeInfo: { status?: string }, tab: Tab) => void
      ): void;
    }

    interface OnRemovedEvent {
      addListener(listener: (tabId: number, removeInfo: { windowId?: number; isWindowClosing?: boolean }) => void): void;
    }

    function get(tabId: number): Promise<Tab>;
    function query(queryInfo: { active?: boolean; currentWindow?: boolean; url?: string | string[] }): Promise<Tab[]>;
    function create(createProperties: CreateProperties): Promise<Tab>;
    function update(tabId: number, updateProperties: UpdateProperties): Promise<Tab>;
    function reload(tabId: number): Promise<void>;
    function sendMessage(tabId: number, message: unknown, responseCallback?: (response: unknown) => void): void;

    const onUpdated: OnUpdatedEvent;
    const onRemoved: OnRemovedEvent;
  }

  namespace alarms {
    interface Alarm {
      name: string;
    }

    interface OnAlarm {
      addListener(listener: (alarm: Alarm) => void): void;
    }

    function create(name: string, alarmInfo: { periodInMinutes: number }): Promise<void>;
    function clear(name: string): Promise<boolean>;
    const onAlarm: OnAlarm;
  }

  namespace storage {
    interface StorageArea {
      get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }

    interface StorageChange {
      oldValue?: unknown;
      newValue?: unknown;
    }

    interface OnChangedEvent {
      addListener(
        listener: (changes: Record<string, StorageChange>, areaName: string) => void
      ): void;
      removeListener(
        listener: (changes: Record<string, StorageChange>, areaName: string) => void
      ): void;
    }

    const sync: StorageArea;
    const local: StorageArea;
    const onChanged: OnChangedEvent;
  }

  namespace permissions {
    function contains(permissions: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
    function request(permissions: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
    function remove(permissions: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
  }

  namespace scripting {
    interface InjectionTarget {
      tabId: number;
    }

    interface InjectionResult {
      result?: unknown;
    }

    function executeScript(injection: { target: InjectionTarget; files: string[] }): Promise<InjectionResult[]>;
    function executeScript(injection: { target: InjectionTarget; func: () => unknown }): Promise<InjectionResult[]>;
    function executeScript(injection: { target: InjectionTarget; func: (...args: never[]) => unknown; args?: unknown[] }): Promise<InjectionResult[]>;
    function insertCSS(injection: { target: InjectionTarget; files: string[] }): Promise<void>;
  }

  namespace offscreen {
    interface CreateDocumentOptions {
      url: string;
      reasons: string[];
      justification: string;
    }

    function createDocument(options: CreateDocumentOptions): Promise<void>;
    function closeDocument(): Promise<void>;
  }

  namespace tts {
    interface TtsEvent {
      type: string;
    }

    interface TtsVoice {
      voiceName?: string;
      lang?: string;
      remote?: boolean;
    }

    interface SpeakOptions {
      voiceName?: string;
      lang?: string;
      volume?: number;
      onEvent?: (event: TtsEvent) => void;
    }

    function getVoices(): Promise<TtsVoice[]>;
    function speak(text: string, options?: SpeakOptions): Promise<void>;
    function stop(): void;
  }

  namespace declarativeNetRequest {
    interface SessionRule {
      id: number;
    }

    interface ModifyHeaderInfo {
      header: string;
      operation: string;
      value?: string;
    }

    interface RuleAction {
      type: string;
      requestHeaders?: ModifyHeaderInfo[];
      responseHeaders?: ModifyHeaderInfo[];
    }

    interface RuleCondition {
      urlFilter?: string;
      requestDomains?: string[];
      initiatorDomains?: string[];
      tabIds?: number[];
      resourceTypes: string[];
    }

    interface Rule {
      id: number;
      priority?: number;
      action: RuleAction;
      condition: RuleCondition;
    }

    function getSessionRules(): Promise<SessionRule[]>;

    function updateSessionRules(options: {
      removeRuleIds?: number[];
      addRules?: Rule[];
    }): Promise<void>;
  }
}

interface Window {
  __BILISCRIPT_CONTENT_SCRIPT_LOADED__?: string;
  __BILISCRIPT_CONTENT_BOOTSTRAP_STARTED__?: boolean;
}

var __BILISCRIPT_CONTENT_SCRIPT_LOADED__: string | undefined;
var __BILISCRIPT_CONTENT_BOOTSTRAP_STARTED__: boolean | undefined;
