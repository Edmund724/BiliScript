import { state } from "../core/state.js";
import { BILI_HOST_SELECTORS } from "../bilibili/host-selectors.js";
import { cleanVideoUrl } from "../bilibili/video-id-shared.js";
import { findReaderPlayerHost, getRuntimeVideoElement } from "../bilibili/video-probe.js";
import {
  activeById,
  getActiveReaderDocument,
  getOpenerDocument,
  getOpenerWindow,
  isReaderDetached,
} from "../shared/active-host.js";
import { resolveNodeWindow } from "../shared/cross-doc.js";
import { ids } from "./state.js";

export function createReaderDebugSnapshot(label = "manual") {
  const openerDoc = getOpenerDocument();
  const openerWin = getOpenerWindow();
  const activeDoc = getActiveReaderDocument();
  const pickNodeSnapshot = (selector: string, targetDoc: Document = openerDoc) => {
    const node = targetDoc.querySelector(selector);
    if (!node) {
      return null;
    }
    const rect = node.getBoundingClientRect();
    const style = resolveNodeWindow(node).getComputedStyle(node);
    return {
      selector,
      tag: node.tagName,
      id: node.id || "",
      className: typeof node.className === "string" ? node.className : "",
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      },
      style: {
        display: style.display,
        position: style.position,
        width: style.width,
        height: style.height,
        maxWidth: style.maxWidth,
        maxHeight: style.maxHeight,
        top: style.top,
        left: style.left,
        transform: style.transform,
        overflow: style.overflow,
        zIndex: style.zIndex
      }
    };
  };

  const playerHostNode = findReaderPlayerHost(getRuntimeVideoElement());
  const video = state.reader.readingVideoEl || getRuntimeVideoElement();
  const hostChain = [];
  let current = playerHostNode;
  let depth = 0;
  while (current && depth < 8) {
    const rect = current.getBoundingClientRect();
    const style = openerWin.getComputedStyle(current);
    hostChain.push({
      tag: current.tagName,
      id: current.id || "",
      className: typeof current.className === "string" ? current.className : "",
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      },
      style: {
        position: style.position,
        width: style.width,
        height: style.height,
        top: style.top,
        left: style.left,
        transform: style.transform,
        overflow: style.overflow,
        zIndex: style.zIndex
      }
    });
    current = current.parentElement;
    depth += 1;
  }

  return {
    label: String(label || "manual"),
    url: cleanVideoUrl(),
    readerMode: openerDoc.documentElement.getAttribute("data-biliscript-reader-mode"),
    readingActive: openerDoc.body.getAttribute("data-biliscript-reading-active"),
    readingDetached: isReaderDetached(),
    readingViewOpen: state.reader.readingViewOpen,
    readingViewReady: state.reader.readingViewReady,
    hasRoot: Boolean(openerDoc.getElementById(ids.root)),
    hasReadingView: Boolean(activeById(ids.readingView)),
    playerHost: playerHostNode
      ? {
          tag: playerHostNode.tagName,
          id: playerHostNode.id || "",
          className: typeof playerHostNode.className === "string" ? playerHostNode.className : ""
        }
      : null,
    video: video
      ? {
          currentTime: Number(video.currentTime || 0) || 0,
          paused: Boolean(video.paused),
          videoWidth: Number(video.videoWidth || 0) || 0,
          videoHeight: Number(video.videoHeight || 0) || 0
        }
      : null,
    nodes: [
      ...BILI_HOST_SELECTORS.debugSnapshotNodes.map((selector) => pickNodeSnapshot(selector, openerDoc)),
      ...["#biliscript-reading-script-panel", "#biliscript-reading-view"].map((selector) =>
        pickNodeSnapshot(selector, activeDoc)
      )
    ].filter(Boolean),
    hostChain
  };
}
