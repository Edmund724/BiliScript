// ui/reading-icons.ts — 阅读视图跨域共用的内联 SVG 图标（复制 / 下载 / 播放）。
// 与 ui/reading-header-icons.ts（面板 header 专用表）分开：本表消费方横跨
// reader / chat / subtitle 三个域的叶子，header 表只随 UI 壳常驻。
// 均为纯字符串常量，不依赖 DOM/全局状态；stroke/fill 属性自绘（宿主 CSS
// 只定尺寸），故三个域的渲染形状逐字节一致。

export const READING_COPY_ICON = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><rect x="9" y="9" width="10" height="10" rx="2"></rect><path d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1"></path></svg>
`;

export const READING_DOWNLOAD_ICON = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"></path><path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path></svg>
`;

export const READING_PLAY_ICON = `
  <svg viewBox="0 0 24 24" fill="currentColor" focusable="false" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"></path></svg>
`;

export const READING_RESET_ICON = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"></path><path d="M3 3v5h5"></path></svg>
`;
