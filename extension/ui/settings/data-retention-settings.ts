import {
  countConversationHistory,
  pruneConversationHistoryToLimit
} from "../../chat/conversation-storage.js";
import type { ChatHistoryMaxCount, Settings, VideoCacheMaxMb } from "../../core/defaults.js";
import { state } from "../../core/state.js";
import {
  normalizeChatHistoryMaxCount,
  normalizeVideoCacheMaxMb,
  videoCacheMaxMbToBytes
} from "../../core/validators.js";
import type { VideoCacheUsage } from "../../subtitle/idb-store.js";
import { resolveActiveSubtitleStore } from "../../subtitle/store-client.js";
import { confirmDialog } from "../confirm-dialog.js";
import { initCustomSelect, setCustomSelectValue } from "../custom-select.js";
import { setStatus, type SettingsElements } from "./elements.js";
import { saveSettingField } from "./scalar-engine.js";

const MB = 1024 * 1024;
const GB = 1024 * MB;

export function formatCacheLimitMb(mb: VideoCacheMaxMb): string {
  return mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`;
}

export function formatCacheBytes(bytes: number): string {
  const safe = Math.max(0, Number(bytes) || 0);
  if (safe === 0) {
    return "0 MB";
  }
  if (safe < MB) {
    const kb = safe / 1024;
    return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
  }
  if (safe < GB) {
    const mb = safe / MB;
    return mb < 100 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
  }
  return `${(safe / GB).toFixed(2)} GB`;
}

export function formatVideoCacheUsageText(usage: VideoCacheUsage, limitMb: VideoCacheMaxMb): string {
  return `${formatCacheBytes(usage.totalBytes)} / ${formatCacheLimitMb(limitMb)}`;
}

export interface DataRetentionSettingsController {
  sync(settings: Partial<Settings>): void;
  applyStorageChanges(changes: Record<string, chrome.storage.StorageChange>): void;
  refreshUsage(): Promise<void>;
  dispose(): void;
}

export function bindDataRetentionSettings(
  elements: SettingsElements,
  deps: { syncSummaries: () => void }
): DataRetentionSettingsController {
  let committedChatHistoryMaxCount: ChatHistoryMaxCount = 0;
  let committedVideoCacheMaxMb: VideoCacheMaxMb = 150;
  let disposed = false;
  let usageRequestSeq = 0;
  let pendingChatChange = false;

  const chatSelect = elements.chatHistoryMaxCount;
  const cacheSelect = elements.videoCacheMaxMb;
  const usageEl = elements.videoCacheUsage;

  function renderSelectValues(): void {
    setCustomSelectValue(chatSelect, String(committedChatHistoryMaxCount));
    initCustomSelect(chatSelect, "custom-select-wrapper");
    setCustomSelectValue(cacheSelect, String(committedVideoCacheMaxMb));
    initCustomSelect(cacheSelect, "custom-select-wrapper");
  }

  function renderUsage(usage: VideoCacheUsage): void {
    if (disposed) return;
    usageEl.textContent = formatVideoCacheUsageText(usage, committedVideoCacheMaxMb);
  }

  async function refreshUsage(): Promise<void> {
    const reqId = ++usageRequestSeq;
    try {
      const usage = await resolveActiveSubtitleStore().getVideoCacheUsage();
      if (disposed || reqId !== usageRequestSeq) return;
      renderUsage(usage);
    } catch {
      if (disposed || reqId !== usageRequestSeq) return;
      usageEl.textContent = `— / ${formatCacheLimitMb(committedVideoCacheMaxMb)}`;
    }
  }

  const onChatHistoryChange = async (): Promise<void> => {
    if (disposed || pendingChatChange) {
      setCustomSelectValue(chatSelect, String(committedChatHistoryMaxCount));
      return;
    }
    const nextValue = normalizeChatHistoryMaxCount(chatSelect.value);
    const prevValue = committedChatHistoryMaxCount;
    if (nextValue === prevValue) {
      return;
    }

    pendingChatChange = true;
    try {
      let existingCount = 0;
      if (nextValue > 0) {
        try {
          existingCount = await countConversationHistory();
        } catch {
          existingCount = 0;
        }
      }

      if (disposed) return;

      if (nextValue > 0 && existingCount > nextValue) {
        const dropCount = existingCount - nextValue;
        const confirmed = await confirmDialog({
          message: `当前共有 ${existingCount} 条历史记录，改为保留最近 ${nextValue} 条将立即删除最早的 ${dropCount} 条记录（含对应图片），确定继续吗？`,
          confirmText: "继续裁剪",
          danger: true
        });
        if (disposed) return;
        if (!confirmed) {
          setCustomSelectValue(chatSelect, String(prevValue));
          return;
        }
      }

      committedChatHistoryMaxCount = nextValue;
      state.patchSettings({ chatHistoryMaxCount: nextValue });
      deps.syncSummaries();

      const ok = await saveSettingField(elements, { chatHistoryMaxCount: nextValue });
      if (disposed) return;
      if (!ok) {
        committedChatHistoryMaxCount = prevValue;
        state.patchSettings({ chatHistoryMaxCount: prevValue });
        setCustomSelectValue(chatSelect, String(prevValue));
        deps.syncSummaries();
        return;
      }

      if (nextValue > 0) {
        try {
          await pruneConversationHistoryToLimit(nextValue);
        } catch {
          if (!disposed) {
            setStatus(elements, "保存成功，但历史记录裁剪失败", true);
          }
        }
      }
    } finally {
      pendingChatChange = false;
    }
  };

  const onVideoCacheChange = async (): Promise<void> => {
    if (disposed) return;
    const nextValue = normalizeVideoCacheMaxMb(cacheSelect.value);
    const prevValue = committedVideoCacheMaxMb;
    if (nextValue === prevValue) {
      return;
    }

    committedVideoCacheMaxMb = nextValue;
    state.patchSettings({ videoCacheMaxMb: nextValue });
    deps.syncSummaries();

    const ok = await saveSettingField(elements, { videoCacheMaxMb: nextValue });
    if (disposed) return;
    if (!ok) {
      committedVideoCacheMaxMb = prevValue;
      state.patchSettings({ videoCacheMaxMb: prevValue });
      setCustomSelectValue(cacheSelect, String(prevValue));
      deps.syncSummaries();
      return;
    }

    const reqId = ++usageRequestSeq;
    try {
      const res = await resolveActiveSubtitleStore().setVideoCacheMaxBytes(
        videoCacheMaxMbToBytes(nextValue)
      );
      if (disposed || reqId !== usageRequestSeq) return;
      renderUsage(res.usage);
    } catch {
      if (disposed || reqId !== usageRequestSeq) return;
      void refreshUsage();
    }
  };

  const chatChangeListener = (): void => {
    void onChatHistoryChange();
  };
  const cacheChangeListener = (): void => {
    void onVideoCacheChange();
  };

  chatSelect.addEventListener("change", chatChangeListener);
  cacheSelect.addEventListener("change", cacheChangeListener);

  return {
    sync(settings) {
      committedChatHistoryMaxCount = normalizeChatHistoryMaxCount(settings.chatHistoryMaxCount);
      committedVideoCacheMaxMb = normalizeVideoCacheMaxMb(settings.videoCacheMaxMb);
      renderSelectValues();
      void refreshUsage();
    },
    applyStorageChanges(changes) {
      let changed = false;
      if (changes.chatHistoryMaxCount) {
        committedChatHistoryMaxCount = normalizeChatHistoryMaxCount(
          changes.chatHistoryMaxCount.newValue
        );
        setCustomSelectValue(chatSelect, String(committedChatHistoryMaxCount));
        changed = true;
      }
      if (changes.videoCacheMaxMb) {
        committedVideoCacheMaxMb = normalizeVideoCacheMaxMb(changes.videoCacheMaxMb.newValue);
        setCustomSelectValue(cacheSelect, String(committedVideoCacheMaxMb));
        void refreshUsage();
        changed = true;
      }
      if (changed) {
        deps.syncSummaries();
      }
    },
    refreshUsage,
    dispose() {
      disposed = true;
      chatSelect.removeEventListener("change", chatChangeListener);
      cacheSelect.removeEventListener("change", cacheChangeListener);
    }
  };
}
