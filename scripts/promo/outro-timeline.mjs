export const OUTRO_TIMELINE = {
  fps: 30,
  from: 750,
  duration: 240,
  featureEntranceFrames: 8,
  features: [
    {id: "feature-bilingual", label: "双语字幕", at: 15, x: -330, y: -170, driftX: -18, driftY: -10},
    {id: "feature-export", label: "字幕导出", at: 30, x: 330, y: -170, driftX: 18, driftY: -10},
    {id: "feature-asr", label: "语音识别", at: 45, x: -330, y: 170, driftX: -18, driftY: 10},
    {id: "feature-search", label: "联网搜索", at: 60, x: 330, y: 170, driftX: 18, driftY: 10}
  ],
  convergeAt: 110,
  brandResolveAt: 126,
  brandNameAt: 130,
  taglineAt: 142,
  ctaAt: 148,
  installClickAt: 168,
  finalHoldAt: 188
};
