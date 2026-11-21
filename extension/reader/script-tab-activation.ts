import { logWarn } from "../shared/logging.js";
import { requestUiCommand, subscribeTabIntent } from "./reader-bus.js";
import { saveReaderScriptTab } from "./script-tab-persistence.js";
import { createSerialQueue } from "./serial-queue.js";
import { setReaderActiveScriptTab, type ReaderScriptTab } from "./state.js";
import { closeReaderSettingsMode } from "./settings-mode.js";
import { ensureReaderChatTab, isReaderChatTabLoaded } from "./lazy-chat-tab.js";
import { ensureReaderDomain } from "./lazy-reader.js";

export interface ActivateScriptTabOptions {
  consumeIntent?: boolean;
  persist?: boolean;
}

const activationQueue = createSerialQueue();

export function activateScriptTab(
  tab: ReaderScriptTab,
  { consumeIntent = true, persist = true }: ActivateScriptTabOptions = {}
): Promise<void> {
  return activationQueue.enqueue(() =>
    runActivation(tab, { consumeIntent, persist })
  );
}

async function runActivation(
  tab: ReaderScriptTab,
  { consumeIntent, persist }: Required<ActivateScriptTabOptions>
): Promise<void> {
  closeReaderSettingsMode();
  setReaderActiveScriptTab(tab);
  if (persist) {
    saveReaderScriptTab(tab);
  }
  requestUiCommand("project-tab", { tab });
  if (tab === "chat") {
    try {
      const chat = await ensureReaderChatTab();
      await chat.ensureChatTabActivated({ consumeIntent });
    } catch (error) {
      logWarn("[BILISCRIPT] chat tab activate failed", error);
    }
    return;
  }
  if (isReaderChatTabLoaded()) {
    try {
      const chat = await ensureReaderChatTab();
      chat.stopChatSpeech();
      (chat as typeof chat & { deactivateChatTabOverlays?: () => void }).deactivateChatTabOverlays?.();
    } catch (error) {
      logWarn("[BILISCRIPT] chat speech stop failed", error);
    }
  }
  if (tab === "overview") {
    try {
      const reader = await ensureReaderDomain();
      reader.ensureReaderOverviewTab();
    } catch (error) {
      logWarn("[BILISCRIPT] overview tab enter failed", error);
    }
  }
}

subscribeTabIntent((tab) => {
  void activateScriptTab(tab);
});
