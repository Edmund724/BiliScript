const BLOCKED_SELECTORS = [
  ".right-entry",
  ".header-entry__avatar",
  ".header-avatar-wrap",
  ".rec-list",
  ".recommend-list",
  ".video-page-card-small",
  ".video-page-special-card",
  ".video-page-special-card-small",
  ".feed-card",
  ".bili-video-card",
  ".ad-report",
  "[class*='ad-report']",
  "[class*='adcard']",
  ".video-page-ad",
  ".activity-m",
  ".activity-banner",
  ".ad-pos-cover",
  ".ad-time",
  ".slide-ad-exp",
  ".gg-banner",
  "[href*='updream']",
  "[src*='updream']",
  ".bpx-player-ending-panel",
  ".bpx-player-ending-related",
  ".bpx-player-login-tip",
  ".bpx-player-dialog",
  ".bpx-player-toast",
  ".player-login-tip",
  ".login-panel-popover",
  ".bili-mini-mask",
  ".inside-wrp"
];

export async function assertPromoCaptureClean(cdp) {
  const hits = await cdp.evaluate(`(() => {
    const selectors = ${JSON.stringify(BLOCKED_SELECTORS)};
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.01;
    };
    const hits = [];
    for (const element of document.querySelectorAll(selectors.join(','))) {
      if (!element.closest('#biliscript-root, #biliscript-reading-view') && visible(element)) hits.push(element.className || element.id || element.tagName);
    }
    for (const link of document.querySelectorAll('a')) {
      const text = (link.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!link.closest('#biliscript-root, #biliscript-reading-view') && /Seedance|updream|广告|\\d+(?:\\.\\d+)?万人?感兴趣/.test(text) && visible(link)) hits.push(text.slice(0, 100));
    }
    return [...new Set(hits)].slice(0, 12);
  })()`);
  if (hits.length) throw new Error(`演示页面仍有广告或推荐内容：${JSON.stringify(hits)}`);
}

export async function preparePromoCapture(cdp) {
  await cdp.evaluate(`(() => {
    const selectors = ${JSON.stringify(BLOCKED_SELECTORS)};
    window.__biliscriptPromoCaptureObserver?.disconnect();
    let style = document.getElementById('biliscript-promo-capture-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'biliscript-promo-capture-style';
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = selectors.map((selector) => selector + ' { display: none !important; }').join('\\n');
    const scrub = () => {
      for (const link of document.querySelectorAll('a')) {
        if (link.closest('#biliscript-root, #biliscript-reading-view')) continue;
        const text = (link.textContent || '').replace(/\\s+/g, ' ').trim();
        if (/Seedance|updream|广告|\\d+(?:\\.\\d+)?万人?感兴趣/.test(text)) link.style.setProperty('display', 'none', 'important');
      }
    };
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        scrub();
      });
    };
    window.__biliscriptPromoScrub = scrub;
    window.__biliscriptPromoCaptureObserver = new MutationObserver(schedule);
    window.__biliscriptPromoCaptureObserver.observe(document.body, {childList: true, subtree: true});
    scrub();
    return true;
  })()`);
  await cdp.evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
  await assertPromoCaptureClean(cdp);
}
