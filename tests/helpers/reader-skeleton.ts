import { READER_MODE_URL } from "../setup.js";
import type { ids as readerIds } from "../../extension/reader/state.js";

const DEFAULT_VIDEO_PROPS = {
  duration: 600,
  videoWidth: 1920,
  videoHeight: 1080,
  paused: true,
  readyState: 4
};

export function stubVideoMediaProps(video: HTMLVideoElement): HTMLVideoElement {
  Object.entries(DEFAULT_VIDEO_PROPS).forEach(([key, value]) => {
    Object.defineProperty(video, key, { value, configurable: true });
  });
  return video;
}

export function mountPlayerChain(container = document.body) {
  const playerWrap = document.createElement("div");
  playerWrap.id = "playerWrap";
  const bilibiliPlayer = document.createElement("div");
  bilibiliPlayer.id = "bilibili-player";
  const playerContainer = document.createElement("div");
  playerContainer.className = "bpx-player-container";
  const playerVideoArea = document.createElement("div");
  playerVideoArea.className = "bpx-player-video-area";
  const playerPrimaryArea = document.createElement("div");
  playerPrimaryArea.className = "bpx-player-primary-area";
  const video = document.createElement("video");
  video.controls = false;
  stubVideoMediaProps(video);

  playerPrimaryArea.appendChild(video);
  playerVideoArea.appendChild(playerPrimaryArea);
  playerContainer.appendChild(playerVideoArea);
  bilibiliPlayer.appendChild(playerContainer);
  playerWrap.appendChild(bilibiliPlayer);
  container.appendChild(playerWrap);

  return video;
}

export function mountReaderSkeleton(ids: typeof readerIds) {
  const doc = document;

  const root = doc.createElement("div");
  root.id = ids.root;
  doc.body.appendChild(root);

  const readingView = doc.createElement("div");
  readingView.id = ids.readingView;
  doc.body.appendChild(readingView);

  const scriptPanel = doc.createElement("aside");
  scriptPanel.id = ids.readingScriptPanel;
  scriptPanel.className = "biliscript-reading-script-panel";
  readingView.appendChild(scriptPanel);

  const readingHeader = doc.createElement("header");
  readingHeader.className = "biliscript-reading-header";
  scriptPanel.appendChild(readingHeader);

  const readingSubtitleNotice = doc.createElement("p");
  readingSubtitleNotice.id = ids.readingSubtitleNotice;
  readingSubtitleNotice.setAttribute("role", "alert");
  readingSubtitleNotice.hidden = true;
  scriptPanel.appendChild(readingSubtitleNotice);

  const readingMeta = doc.createElement("div");
  readingMeta.id = ids.readingMeta;
  scriptPanel.appendChild(readingMeta);

  const readingSettingsPanel = doc.createElement("div");
  readingSettingsPanel.id = ids.readingSettingsPanel;
  const readingSettingsBackBtn = doc.createElement("button");
  readingSettingsBackBtn.id = ids.readingSettingsBackBtn;
  readingSettingsPanel.appendChild(readingSettingsBackBtn);
  scriptPanel.appendChild(readingSettingsPanel);

  const tabSubtitle = doc.createElement("button");
  tabSubtitle.id = ids.readingTabSubtitle;
  tabSubtitle.className = "biliscript-reading-tab is-active";
  scriptPanel.appendChild(tabSubtitle);

  const tabOverview = doc.createElement("button");
  tabOverview.id = ids.readingTabOverview;
  tabOverview.className = "biliscript-reading-tab";
  scriptPanel.appendChild(tabOverview);

  const tabChat = doc.createElement("button");
  tabChat.id = ids.readingTabChat;
  tabChat.className = "biliscript-reading-tab";
  scriptPanel.appendChild(tabChat);

  const overviewExportBtn = doc.createElement("button");
  overviewExportBtn.type = "button";
  overviewExportBtn.id = ids.readingOverviewExportBtn;
  overviewExportBtn.className = "biliscript-reading-icon-btn";
  overviewExportBtn.dataset.overviewAction = "export-note";
  overviewExportBtn.hidden = true;
  scriptPanel.appendChild(overviewExportBtn);

  const tabBodySubtitle = doc.createElement("div");
  tabBodySubtitle.id = ids.readingTabBodySubtitle;
  tabBodySubtitle.className = "biliscript-reading-tab-body is-active";
  scriptPanel.appendChild(tabBodySubtitle);

  const tabBodyOverview = doc.createElement("div");
  tabBodyOverview.id = ids.readingTabBodyOverview;
  tabBodyOverview.className = "biliscript-reading-tab-body";
  tabBodyOverview.setAttribute("hidden", "");
  scriptPanel.appendChild(tabBodyOverview);

  const tabBodyChat = doc.createElement("div");
  tabBodyChat.id = ids.readingTabBodyChat;
  tabBodyChat.className = "biliscript-reading-tab-body";
  tabBodyChat.setAttribute("hidden", "");
  scriptPanel.appendChild(tabBodyChat);

  const overviewBody = doc.createElement("div");
  overviewBody.id = ids.readingOverviewBody;
  overviewBody.className = "biliscript-reading-overview";
  tabBodyOverview.appendChild(overviewBody);

  const subToolbar = doc.createElement("div");
  subToolbar.className = "biliscript-reading-sub-toolbar";
  tabBodySubtitle.appendChild(subToolbar);

  const searchBox = doc.createElement("div");
  searchBox.className = "biliscript-reading-search";
  subToolbar.appendChild(searchBox);

  const searchInput = doc.createElement("input");
  searchInput.type = "text";
  searchInput.id = ids.readingSearchInput;
  searchInput.className = "biliscript-reading-search-input";
  searchBox.appendChild(searchInput);

  const searchCount = doc.createElement("span");
  searchCount.id = ids.readingSearchCount;
  searchCount.className = "biliscript-reading-search-count";
  searchBox.appendChild(searchCount);

  const searchPrev = doc.createElement("button");
  searchPrev.type = "button";
  searchPrev.id = ids.readingSearchPrevBtn;
  searchPrev.className = "biliscript-reading-search-nav";
  searchPrev.disabled = true;
  searchBox.appendChild(searchPrev);

  const searchNext = doc.createElement("button");
  searchNext.type = "button";
  searchNext.id = ids.readingSearchNextBtn;
  searchNext.className = "biliscript-reading-search-nav";
  searchNext.disabled = true;
  searchBox.appendChild(searchNext);

  const copySubtitleBtn = doc.createElement("button");
  copySubtitleBtn.type = "button";
  copySubtitleBtn.id = ids.readingCopySubtitleBtn;
  copySubtitleBtn.className = "biliscript-reading-icon-btn";
  copySubtitleBtn.title = "复制字幕";
  copySubtitleBtn.setAttribute("aria-label", "复制字幕");
  subToolbar.appendChild(copySubtitleBtn);

  const exportSubtitleBtn = doc.createElement("button");
  exportSubtitleBtn.type = "button";
  exportSubtitleBtn.id = ids.readingExportSubtitleBtn;
  exportSubtitleBtn.className = "biliscript-reading-icon-btn";
  exportSubtitleBtn.title = "导出字幕";
  exportSubtitleBtn.setAttribute("aria-label", "导出字幕");
  subToolbar.appendChild(exportSubtitleBtn);

  const transcribeBanner = doc.createElement("aside");
  transcribeBanner.id = ids.readingTranscribeBanner;
  transcribeBanner.className = "biliscript-reading-asr-banner";
  transcribeBanner.setAttribute("hidden", "");
  tabBodySubtitle.appendChild(transcribeBanner);

  const transcribeBannerTitle = doc.createElement("div");
  transcribeBannerTitle.id = ids.readingTranscribeBannerTitle;
  transcribeBannerTitle.className = "biliscript-reading-asr-title";
  transcribeBanner.appendChild(transcribeBannerTitle);

  const transcribeBannerCopy = doc.createElement("p");
  transcribeBannerCopy.id = ids.readingTranscribeBannerCopy;
  transcribeBannerCopy.className = "biliscript-reading-asr-copy";
  transcribeBanner.appendChild(transcribeBannerCopy);

  const transcribeProgress = doc.createElement("div");
  transcribeProgress.id = ids.readingTranscribeProgress;
  transcribeProgress.className = "biliscript-reading-asr-foot";
  transcribeBanner.appendChild(transcribeProgress);

  const readingMain = doc.createElement("div");
  readingMain.className = "biliscript-reading-main";
  tabBodySubtitle.appendChild(readingMain);

  const readingSubtitleList = doc.createElement("div");
  readingSubtitleList.id = ids.readingSubtitleList;
  readingMain.appendChild(readingSubtitleList);

  const followBtn = doc.createElement("button");
  followBtn.type = "button";
  followBtn.id = ids.readingFollowBtn;
  followBtn.className = "biliscript-reading-follow-btn";
  const followLabel = doc.createElement("span");
  followLabel.className = "biliscript-reading-follow-label";
  followLabel.textContent = "回到当前播放";
  const followMeta = doc.createElement("span");
  followMeta.className = "biliscript-reading-follow-meta";
  followMeta.hidden = true;
  const followSep = doc.createElement("span");
  followSep.className = "biliscript-reading-follow-sep";
  followSep.setAttribute("aria-hidden", "true");
  followSep.textContent = " · ";
  const followTime = doc.createElement("span");
  followTime.className = "biliscript-reading-follow-time";
  followMeta.append(followSep, followTime);
  followBtn.append(followLabel, followMeta);
  tabBodySubtitle.appendChild(followBtn);

  const explainPop = doc.createElement("div");
  explainPop.id = ids.readingExplainPop;
  explainPop.className = "biliscript-reading-explain-pop";
  explainPop.setAttribute("hidden", "");
  scriptPanel.appendChild(explainPop);

  const explainBtn = doc.createElement("button");
  explainBtn.type = "button";
  explainBtn.className = "biliscript-selection-pill-btn biliscript-reading-explain-btn";
  explainBtn.dataset.selectionAction = "explain";
  explainPop.appendChild(explainBtn);

  const explainCard = doc.createElement("div");
  explainCard.id = ids.readingExplainCard;
  explainCard.className = "biliscript-reading-explain-card";
  explainCard.setAttribute("hidden", "");
  scriptPanel.appendChild(explainCard);

  const chatIntent = doc.createElement("div");
  chatIntent.id = ids.readingChatIntent;
  chatIntent.className = "biliscript-reading-chat-intent";
  chatIntent.setAttribute("hidden", "");
  tabBodyChat.appendChild(chatIntent);

  const intentHead = doc.createElement("div");
  intentHead.className = "biliscript-reading-chat-intent-head";
  chatIntent.appendChild(intentHead);

  const intentTitle = doc.createElement("span");
  intentTitle.className = "biliscript-reading-chat-intent-title";
  intentHead.appendChild(intentTitle);

  const intentTime = doc.createElement("span");
  intentTime.className = "biliscript-reading-chat-intent-time biliscript-reading-time";
  intentHead.appendChild(intentTime);

  const intentQuote = doc.createElement("blockquote");
  intentQuote.className = "biliscript-reading-chat-intent-quote";
  chatIntent.appendChild(intentQuote);

  const readingSettingsBtn = doc.createElement("button");
  readingSettingsBtn.id = ids.readingSettingsBtn;
  scriptPanel.appendChild(readingSettingsBtn);

  const readingInfoHost = doc.createElement("div");
  readingInfoHost.id = ids.readingSettingsHost;
  scriptPanel.appendChild(readingInfoHost);

  return { readingView, readingMain, scriptPanel };
}

export function mockPlayerRects(extraSelectors: string[] = []) {
  const selectors = [
    ".bpx-player-primary-area",
    ".bpx-player-video-area",
    ".bpx-player-container",
    "#bilibili-player",
    "#playerWrap",
    ...extraSelectors
  ];

  const nodes = selectors
    .map((selector) => document.querySelector(selector))
    .filter((node): node is Element => node !== null);

  nodes.forEach((node) => {
    node.getBoundingClientRect = () => STANDARD_RECT();
  });

  const video = document.querySelector("video");
  if (video) {
    video.getBoundingClientRect = () => STANDARD_RECT();
  }
}

function STANDARD_RECT() {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 800,
    bottom: 450,
    width: 800,
    height: 450,
    toJSON: () => ({})
  };
}

export function readerModeUrl() {
  return READER_MODE_URL;
}
