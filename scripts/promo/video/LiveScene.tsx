import {AbsoluteFill, Easing, Img, OffthreadVideo, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from "remotion";
import {LIVE_TIMELINE} from "../timeline.mjs";
import {
  BRAND_FONT_FAMILY,
  COLORS,
  ELEVATION,
  FONT_FAMILY
} from "./design";

const CLAMP = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;
const SMOOTH = Easing.bezier(0.16, 1, 0.3, 1);
const EXPAND_EASING = Easing.bezier(0.55, 0, 0.25, 1);

const LIVE_VIDEO_SOURCE = "subtitle-seek-03.mp4";
const LIVE_VIDEO_START_FROM = 224;

// 页面播放器在 1920x1080 页面中的几何中心正好是 16:9 播放器 0.7 倍时的画面中心
const PAGE_PLAYER = {left: 54, top: 171, width: 1344, height: 745};
const PAGE_PLAYER_CENTER = {
  x: PAGE_PLAYER.left + PAGE_PLAYER.width / 2,
  y: PAGE_PLAYER.top + PAGE_PLAYER.height / 2
};
const PAGE_PLAYER_SCALE = 0.7;
const PAGE_PLAYER_RADIUS = 14;

// 录屏是整页画面，全屏只取播放器区域；按高度铺满并轻微横向裁切
const VIDEO_CROP_SCALE = 1080 / PAGE_PLAYER.height;
const VIDEO_CROP = {
  width: Number((1920 * VIDEO_CROP_SCALE).toFixed(2)),
  height: Number((1080 * VIDEO_CROP_SCALE).toFixed(2)),
  left: Number((960 - PAGE_PLAYER_CENTER.x * VIDEO_CROP_SCALE).toFixed(2)),
  top: Number((540 - PAGE_PLAYER_CENTER.y * VIDEO_CROP_SCALE).toFixed(2))
};

export const LIVE_USER_PROMPT = "那普通人怎么跟 AI 打配合？";
export const LIVE_AI_REPLY = "把检索和拆解交给 AI，你来掌舵判断。";

const PlayerLiveActionIcon = ({size = 22}: {size?: number}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" focusable="false" aria-hidden="true" fill="currentColor">
    <rect x="9" y="2.5" width="6" height="11" rx="3" fill="currentColor" />
    <path d="M5 10a7 7 0 0 0 14 0" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
    <path d="M12 17v4.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
    <path d="M8 21.5h8" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
  </svg>
);

const BiliVolumeIcon = ({size = 22}: {size?: number}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M3 9.2c0-.9.7-1.6 1.6-1.6h2.7l4.2-3.4c.9-.7 2.2-.1 2.2 1.1v13.4c0 1.2-1.3 1.8-2.2 1.1l-4.2-3.4H4.6c-.9 0-1.6-.7-1.6-1.6V9.2Z" />
    <path d="M16.4 8.6a4.8 4.8 0 0 1 0 6.8" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
    <path d="M19.2 5.8a8.8 8.8 0 0 1 0 12.4" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
  </svg>
);

const BiliSettingsIcon = ({size = 22}: {size?: number}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M10.1 2.4h3.8l.55 2.35c.54.18 1.05.47 1.5.85l2.3-.72 1.9 3.28-1.74 1.64c.09.52.09 1.08 0 1.6l1.74 1.64-1.9 3.28-2.3-.72c-.45.38-.96.67-1.5.85l-.55 2.35h-3.8l-.55-2.35a6.8 6.8 0 0 1-1.5-.85l-2.3.72-1.9-3.28 1.74-1.64a5.4 5.4 0 0 1 0-1.6L3.85 8.16l1.9-3.28 2.3.72c.45-.38.96-.67 1.5-.85L10.1 2.4ZM12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Zm0 2.1a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4Z"
    />
  </svg>
);

const BiliPipIcon = ({size = 22}: {size?: number}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M11 19H5.2A2.2 2.2 0 0 1 3 16.8V7.2A2.2 2.2 0 0 1 5.2 5h13.6A2.2 2.2 0 0 1 21 7.2V11"
      stroke="currentColor"
      strokeWidth="2.3"
      strokeLinecap="round"
    />
    <rect x="13" y="13.2" width="8.2" height="6.3" rx="1.6" fill="currentColor" />
  </svg>
);

const BiliTrefoilIcon = ({size = 22}: {size?: number}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="12" cy="12" r="1.45" />
    <path d="M9.6 10.6 4.9 7.9A8.2 8.2 0 0 1 11.1 3.9v5.4a2.8 2.8 0 0 0-1.5 1.3Z" />
    <path d="M14.4 10.6a2.8 2.8 0 0 0-1.5-1.3V3.9a8.2 8.2 0 0 1 6.2 4l-4.7 2.7Z" />
    <path d="M12 14.8c.55 0 1.06-.16 1.5-.44l4.7 2.7a8.2 8.2 0 0 1-12.4 0l4.7-2.7c.44.28.95.44 1.5.44Z" />
  </svg>
);

const MicIcon = ({size = 16}: {size?: number}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" x2="12" y1="19" y2="22" />
  </svg>
);

const SpeakerIcon = ({size = 16}: {size?: number}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
  </svg>
);

const MinimizeIcon = ({size = 16}: {size?: number}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const CloseIcon = ({size = 16}: {size?: number}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

// Build the exact 12px edge SDF displacement map used by extension/live/liquid-glass-lens.ts
const LENS_MAP_CACHE = new Map<string, {dataUrl: string; scale: number}>();
function getLiquidGlassLensMap(width: number, height: number, radius = 16, edge = 14) {
  const key = `${width}x${height}:r${radius}:e${edge}`;
  const cached = LENS_MAP_CACHE.get(key);
  if (cached) return cached;
  if (typeof document === "undefined") return null;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const imgData = ctx.createImageData(width, height);
  const data = imgData.data;
  const halfW = width / 2;
  const halfH = height / 2;
  const r = Math.min(radius, halfW, halfH);
  const bx = Math.max(0, halfW - r);
  const by = Math.max(0, halfH - r);
  const maxOffset = 1.1 * edge;
  const scale = 2 * maxOffset;

  for (let y = 0; y < height; y++) {
    const py = y + 0.5 - halfH;
    const absPy = Math.abs(py);
    const qy = absPy - by;
    const signY = py < 0 ? -1 : 1;

    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const px = x + 0.5 - halfW;
      const absPx = Math.abs(px);
      const qx = absPx - bx;
      const signX = px < 0 ? -1 : 1;

      const outX = Math.max(qx, 0);
      const outY = Math.max(qy, 0);
      const outLen = Math.hypot(outX, outY);
      const sdf = outLen + Math.min(Math.max(qx, qy), 0) - r;
      const d = -sdf;

      if (d <= 0 || d >= edge) {
        data[idx] = 128;
        data[idx + 1] = 128;
        data[idx + 2] = 128;
        data[idx + 3] = 255;
        continue;
      }

      let nx = 0;
      let ny = 0;
      if (outLen > 1e-4) {
        nx = signX * (outX / outLen);
        ny = signY * (outY / outLen);
      } else if (qx > qy) {
        nx = signX;
      } else {
        ny = signY;
      }

      const offset = maxOffset * Math.pow(1 - d / edge, 2.6);
      const dx = -nx * offset;
      const dy = -ny * offset;

      data[idx] = Math.max(0, Math.min(255, Math.round(128 + (dx / maxOffset) * 127)));
      data[idx + 1] = Math.max(0, Math.min(255, Math.round(128 + (dy / maxOffset) * 127)));
      data[idx + 2] = 128;
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  const result = {dataUrl: canvas.toDataURL("image/png"), scale};
  LENS_MAP_CACHE.set(key, result);
  return result;
}

export const LiveScene = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  // 从 B 站页面播放器位置展开铺满画幅，页面外壳同步淡出
  const expand = interpolate(
    frame,
    [LIVE_TIMELINE.fullscreenAt, LIVE_TIMELINE.fullscreenDoneAt],
    [0, 1],
    {...CLAMP, easing: EXPAND_EASING}
  );
  const playerScale = interpolate(expand, [0, 1], [PAGE_PLAYER_SCALE, 1]);
  const playerCenterX = interpolate(expand, [0, 1], [PAGE_PLAYER_CENTER.x, 960]);
  const playerCenterY = interpolate(expand, [0, 1], [PAGE_PLAYER_CENTER.y, 540]);
  const playerRadius = interpolate(expand, [0, 1], [PAGE_PLAYER_RADIUS, 0]);
  const pageShellOpacity = interpolate(frame, [LIVE_TIMELINE.fullscreenAt, 8, 17], [1, 1, 0], CLAMP);

  // 全屏沉淀后把镜头 1.4x 推近右上角伴看浮窗，控件与音量 HUD 留在画面内
  const cameraPush = interpolate(
    frame,
    [LIVE_TIMELINE.pushInAt, LIVE_TIMELINE.pushInAt + LIVE_TIMELINE.cameraPushFrames],
    [1, 1.4],
    {...CLAMP, easing: SMOOTH}
  );
  const cameraStyle = {
    position: "absolute" as const,
    inset: 0,
    overflow: "hidden" as const,
    transform: `scale(${cameraPush.toFixed(4)})`,
    transformOrigin: "100% 0%"
  };

  const toggleClicked = frame >= LIVE_TIMELINE.toggleClickAt;
  const rippleOpacity = interpolate(
    frame,
    [LIVE_TIMELINE.toggleClickAt - 1, LIVE_TIMELINE.toggleClickAt + 1, LIVE_TIMELINE.toggleClickAt + 15],
    [0, 0.9, 0],
    CLAMP
  );
  const rippleScale = interpolate(
    frame,
    [LIVE_TIMELINE.toggleClickAt - 1, LIVE_TIMELINE.toggleClickAt + 15],
    [0.5, 1.85],
    {...CLAMP, easing: SMOOTH}
  );

  const pointerOpacity =
    interpolate(frame, [2, 5], [0, 1], CLAMP) *
    interpolate(frame, [LIVE_TIMELINE.overlayOpenAt + 3, LIVE_TIMELINE.overlayOpenAt + 9], [1, 0], CLAMP);
  const pointerX = interpolate(frame, [2, LIVE_TIMELINE.toggleClickAt - 1], [86, 17], {...CLAMP, easing: SMOOTH});
  const pointerY = interpolate(frame, [2, LIVE_TIMELINE.toggleClickAt - 1], [48, 12], {...CLAMP, easing: SMOOTH});

  const overlaySpring = spring({
    fps,
    frame: frame - (LIVE_TIMELINE.overlayOpenAt - 4),
    config: {damping: 17, stiffness: 175, mass: 0.82}
  });
  const overlayOpacity = interpolate(frame, [LIVE_TIMELINE.overlayOpenAt - 5, LIVE_TIMELINE.overlayOpenAt + 4], [0, 1], CLAMP);

  const userBubbleReveal = interpolate(
    frame,
    [LIVE_TIMELINE.userPromptAt - 4, LIVE_TIMELINE.userPromptAt + 8],
    [0, 1],
    {...CLAMP, easing: SMOOTH}
  );
  const duckReveal = interpolate(
    frame,
    [LIVE_TIMELINE.duckActiveAt - 4, LIVE_TIMELINE.duckActiveAt + 8],
    [0, 1],
    {...CLAMP, easing: SMOOTH}
  );
  const aiBubbleReveal = interpolate(
    frame,
    [LIVE_TIMELINE.aiReplyAt - 4, LIVE_TIMELINE.aiReplyAt + 8],
    [0, 1],
    {...CLAMP, easing: SMOOTH}
  );

  const isUserSpeaking = frame >= LIVE_TIMELINE.userPromptAt && frame < LIVE_TIMELINE.aiReplyAt - 3;
  const isAiTalking = frame >= LIVE_TIMELINE.aiReplyAt && frame <= LIVE_TIMELINE.aiReplyDoneAt;
  const isDuckingVideo = frame >= LIVE_TIMELINE.userPromptAt && frame <= LIVE_TIMELINE.aiReplyDoneAt;

  // Smoothly animate the original video volume meter from 100% down to 20% during voice priority ducking
  const duckProgress =
    interpolate(frame, [LIVE_TIMELINE.userPromptAt - 2, LIVE_TIMELINE.duckActiveAt + 6], [0, 1], {...CLAMP, easing: SMOOTH}) *
    interpolate(frame, [LIVE_TIMELINE.aiReplyDoneAt - 2, LIVE_TIMELINE.aiReplyDoneAt + 10], [1, 0], {...CLAMP, easing: SMOOTH});
  const videoVolumePercent = Math.round(interpolate(duckProgress, [0, 1], [100, 20]));

  // 1:1 authentic floating window geometry (uniformly scaled 1.25x from 320px -> 400px for 1080p legibility)
  const OVERLAY_WIDTH = 400;
  const OVERLAY_HEIGHT = 210;
  const OVERLAY_RADIUS = 18;
  const lensMap = getLiquidGlassLensMap(OVERLAY_WIDTH, OVERLAY_HEIGHT, OVERLAY_RADIUS, 15);

  const streamedChars = Math.max(
    0,
    Math.min(
      LIVE_AI_REPLY.length,
      Math.floor(
        interpolate(
          frame,
          [LIVE_TIMELINE.aiReplyAt, LIVE_TIMELINE.aiReplyAt + 68],
          [2, LIVE_AI_REPLY.length],
          CLAMP
        )
      )
    )
  );
  const visibleAiReply = frame >= LIVE_TIMELINE.aiReplyAt ? LIVE_AI_REPLY.slice(0, streamedChars) : "";

  return (
    <AbsoluteFill style={{fontFamily: FONT_FAMILY, background: "#07090F"}}>
      {/* B 站页面底板：全屏化过程中淡出，让播放器接管整幅画面 */}
      <div style={{position: "absolute", inset: 0, opacity: pageShellOpacity}}>
        <Img
          src={staticFile("media/bili-page-shell.jpg")}
          style={{width: 1920, height: 1080, objectFit: "cover"}}
        />
        {/* Clean top-right unauthenticated login button in page header */}
        <div style={{position: "absolute", left: 1424, top: 8, width: 44, height: 48, background: "#FFFFFF"}} />
      </div>

      {/* 全屏播放器：从页面播放器位置展开到铺满画幅 */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 1920,
          height: 1080,
          translate: `${(playerCenterX - 960).toFixed(2)}px ${(playerCenterY - 540).toFixed(2)}px`,
          scale: playerScale.toFixed(4),
          transformOrigin: "50% 50%",
          borderRadius: playerRadius,
          overflow: "hidden",
          background: "#0B0F17",
          boxShadow: ELEVATION.videoPlane
        }}
      >
        {/* 镜头推近层：原片跟随右上角浮窗一起放大 */}
        <div style={cameraStyle}>
          <div style={{position: "absolute", inset: 0, overflow: "hidden"}}>
            <OffthreadVideo
              muted
              src={staticFile(`media/${LIVE_VIDEO_SOURCE}`)}
              startFrom={LIVE_VIDEO_START_FROM}
              playbackRate={0.35}
              style={{
                position: "absolute",
                left: VIDEO_CROP.left,
                top: VIDEO_CROP.top,
                width: VIDEO_CROP.width,
                height: VIDEO_CROP.height,
                maxWidth: "none"
              }}
            />
          </div>
        </div>

            {/* SVG Liquid-Glass 12px Edge Refraction + 3-Channel Chromatic Dispersion Filter (from liquid-glass-lens.ts) */}
            {lensMap ? (
              <svg
                aria-hidden="true"
                width="0"
                height="0"
                style={{position: "absolute", width: 0, height: 0, pointerEvents: "none", overflow: "hidden"}}
              >
                <defs>
                  <filter
                    id="promo-biliscript-live-glass-lens"
                    x="0%"
                    y="0%"
                    width="100%"
                    height="100%"
                    colorInterpolationFilters="sRGB"
                  >
                    <feImage
                      href={lensMap.dataUrl}
                      x="0"
                      y="0"
                      width={OVERLAY_WIDTH}
                      height={OVERLAY_HEIGHT}
                      preserveAspectRatio="none"
                      result="dispMap"
                    />
                    <feDisplacementMap
                      in="SourceGraphic"
                      in2="dispMap"
                      scale={(lensMap.scale * 1.15).toFixed(2)}
                      xChannelSelector="R"
                      yChannelSelector="G"
                      result="rawR"
                    />
                    <feColorMatrix
                      in="rawR"
                      type="matrix"
                      values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
                      result="chR"
                    />
                    <feDisplacementMap
                      in="SourceGraphic"
                      in2="dispMap"
                      scale={lensMap.scale.toFixed(2)}
                      xChannelSelector="R"
                      yChannelSelector="G"
                      result="rawG"
                    />
                    <feColorMatrix
                      in="rawG"
                      type="matrix"
                      values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"
                      result="chG"
                    />
                    <feDisplacementMap
                      in="SourceGraphic"
                      in2="dispMap"
                      scale={(lensMap.scale * 0.85).toFixed(2)}
                      xChannelSelector="R"
                      yChannelSelector="G"
                      result="rawB"
                    />
                    <feColorMatrix
                      in="rawB"
                      type="matrix"
                      values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"
                      result="chB"
                    />
                    <feBlend in="chR" in2="chG" mode="screen" result="chRG" />
                    <feBlend in="chRG" in2="chB" mode="screen" result="blended" />
                  </filter>
                </defs>
              </svg>
            ) : null}

            {/* Top-Left Scene Badge inside Player */}
            <div
              style={{
                position: "absolute",
                top: 18,
                left: 18,
                display: "flex",
                alignItems: "center",
                gap: 10,
                zIndex: 12
              }}
            >
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "7px 15px",
                  borderRadius: 999,
                  background: "rgba(15, 23, 42, 0.72)",
                  backdropFilter: "blur(14px) saturate(160%)",
                  WebkitBackdropFilter: "blur(14px) saturate(160%)",
                  boxShadow:
                    "inset 1px 1px 0.5px rgba(255, 255, 255, 0.28), 0 8px 20px rgba(0, 0, 0, 0.28)",
                  color: "#F8FAFC",
                  fontSize: 17,
                  fontWeight: 720
                }}
              >
                <span
                  style={{
                    padding: "2px 10px",
                    borderRadius: 999,
                    background: "rgba(56, 189, 248, 0.24)",
                    color: "#7DD3FC",
                    fontSize: 15,
                    fontWeight: 760
                  }}
                >
                  视频页 + 直播间
                </span>
                <span>不挡看片 · 随看随聊</span>
              </div>
            </div>

            {/* Bottom-Left Player Dual-Track Audio & Voice Priority HUD (Outside Floating Window) */}
            <div
              style={{
                position: "absolute",
                left: 20,
                bottom: 84,
                width: 396,
                padding: "13px 16px",
                borderRadius: 16,
                background: "rgba(15, 23, 42, 0.78)",
                backdropFilter: "blur(16px) saturate(170%)",
                WebkitBackdropFilter: "blur(16px) saturate(170%)",
                boxShadow: isDuckingVideo
                  ? "inset 0 0 0 1px rgba(52, 211, 153, 0.42), inset 1px 1px 0.5px rgba(255, 255, 255, 0.24), 0 14px 32px rgba(0, 0, 0, 0.42)"
                  : "inset 1px 1px 0.5px rgba(255, 255, 255, 0.26), inset 0 0 0 0.5px rgba(255, 255, 255, 0.14), 0 14px 32px rgba(0, 0, 0, 0.36)",
                color: "#F8FAFC",
                display: "flex",
                flexDirection: "column",
                gap: 11,
                opacity: overlayOpacity,
                translate: `0px ${((1 - overlaySpring) * 14).toFixed(1)}px`,
                zIndex: 16
              }}
            >
              {/* Track 1: 分享视频声音 (AI 同步听片) */}
              <div style={{display: "flex", flexDirection: "column", gap: 6}}>
                <div style={{display: "flex", alignItems: "center", justifyContent: "space-between"}}>
                  <div style={{display: "flex", alignItems: "center", gap: 8}}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: "#38BDF8",
                        boxShadow: "0 0 8px #38BDF8"
                      }}
                    />
                    <span style={{fontSize: 15, fontWeight: 740, color: "#FFFFFF"}}>
                      分享视频声音
                    </span>
                  </div>
                  <div style={{display: "flex", alignItems: "center", gap: 6}}>
                    <div style={{display: "flex", alignItems: "center", gap: 2.5, height: 12}}>
                      {[0, 1, 2, 3, 4].map((idx) => {
                        const wave = 0.35 + 0.65 * Math.abs(Math.sin(frame * 0.32 + idx * 0.85));
                        return (
                          <span
                            key={idx}
                            style={{
                              width: 2.5,
                              height: Math.round(3 + 9 * wave),
                              borderRadius: 999,
                              background: "#38BDF8"
                            }}
                          />
                        );
                      })}
                    </div>
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 700,
                        color: "#7DD3FC",
                        background: "rgba(56, 189, 248, 0.16)",
                        padding: "2px 8px",
                        borderRadius: 999
                      }}
                    >
                      AI 同步听原声
                    </span>
                  </div>
                </div>
              </div>

              <div style={{height: 1, background: "rgba(255, 255, 255, 0.10)"}} />

              {/* Track 2: 语音优先 (开口自动压低原片音量 100% -> 20%) */}
              <div style={{display: "flex", flexDirection: "column", gap: 7}}>
                <div style={{display: "flex", alignItems: "center", justifyContent: "space-between"}}>
                  <div style={{display: "flex", alignItems: "center", gap: 8}}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: isDuckingVideo ? "#34D399" : "rgba(255, 255, 255, 0.45)",
                        boxShadow: isDuckingVideo ? "0 0 8px #34D399" : "none"
                      }}
                    />
                    <span style={{fontSize: 15, fontWeight: 740, color: "#FFFFFF"}}>
                      语音优先
                    </span>
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 680,
                        color: isDuckingVideo ? "#6EE7B7" : "rgba(226, 232, 240, 0.78)"
                      }}
                    >
                      {isDuckingVideo ? "对话中自动压低原片" : "开口即避让原片"}
                    </span>
                  </div>
                  <span
                    style={{
                      fontFamily: BRAND_FONT_FAMILY,
                      fontSize: 14,
                      fontWeight: 760,
                      fontVariantNumeric: "tabular-nums",
                      color: isDuckingVideo ? "#34D399" : "#E2E8F0",
                      background: isDuckingVideo ? "rgba(16, 185, 129, 0.20)" : "rgba(255, 255, 255, 0.10)",
                      padding: "2px 9px",
                      borderRadius: 999
                    }}
                  >
                    {isDuckingVideo ? `100% → ${videoVolumePercent}%` : `原片 ${videoVolumePercent}%`}
                  </span>
                </div>

                {/* Animated Volume Ducking Meter Bar */}
                <div
                  style={{
                    position: "relative",
                    height: 7,
                    borderRadius: 999,
                    background: "rgba(255, 255, 255, 0.14)",
                    overflow: "hidden"
                  }}
                >
                  {/* Ghost 100% reference marker when ducking */}
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      borderRadius: 999,
                      background: "rgba(255, 255, 255, 0.12)",
                      opacity: duckReveal
                    }}
                  />
                  {/* Active Original Video Volume Fill */}
                  <div
                    style={{
                      width: `${videoVolumePercent}%`,
                      height: "100%",
                      borderRadius: 999,
                      background: isDuckingVideo
                        ? "linear-gradient(90deg, #10B981 0%, #34D399 100%)"
                        : "linear-gradient(90deg, #38BDF8 0%, #7DD3FC 100%)",
                      boxShadow: isDuckingVideo ? "0 0 10px rgba(52, 211, 153, 0.6)" : "none"
                    }}
                  />
                </div>
              </div>
            </div>

            {/* 镜头推近层：右上角浮窗与视频同一镜头倍率 */}
            <div style={cameraStyle}>
            {/* HERO FOCAL POINT: 1:1 Authentic Top-Right Liquid-Glass Companion Overlay (#biliscript-fullscreen-live-overlay) */}
            <div
              style={{
                position: "absolute",
                top: 18,
                right: 18,
                width: OVERLAY_WIDTH,
                height: OVERLAY_HEIGHT,
                borderRadius: OVERLAY_RADIUS,
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
                /* Exact --biliscript-live-glass-tint from extension/entry/styles/player-ai.css */
                background:
                  "radial-gradient(125% 95% at 10% 0%, rgba(255, 255, 255, 0.15) 0%, rgba(255, 255, 255, 0.04) 55%, transparent 100%), linear-gradient(165deg, rgba(255, 255, 255, 0.08) 0%, transparent 44%, rgba(0, 0, 0, 0.16) 100%), rgba(18, 20, 24, 0.48)",
                /* Exact --biliscript-live-glass-filter + SVG 12px edge refraction lens */
                backdropFilter: lensMap
                  ? "blur(8px) saturate(168%) brightness(0.78) url(#promo-biliscript-live-glass-lens)"
                  : "blur(10px) saturate(168%) brightness(0.78)",
                WebkitBackdropFilter: lensMap
                  ? "blur(8px) saturate(168%) brightness(0.78) url(#promo-biliscript-live-glass-lens)"
                  : "blur(10px) saturate(168%) brightness(0.78)",
                /* Exact --biliscript-live-glass-rim from extension/entry/styles/player-ai.css */
                boxShadow:
                  "inset 1.5px 1.5px 1px -1px rgba(255, 255, 255, 0.38), inset -1.5px -1.5px 1px -1px rgba(255, 255, 255, 0.18), inset 0 0 0 0.5px rgba(255, 255, 255, 0.18), 0 0 0 0.5px rgba(0, 0, 0, 0.40), 0 12px 32px rgba(0, 0, 0, 0.48)",
                color: "rgba(255, 255, 255, 0.94)",
                opacity: overlayOpacity,
                transformOrigin: "100% 0%",
                translate: `0px ${((1 - overlaySpring) * 16).toFixed(1)}px`,
                scale: 0.92 + 0.08 * overlaySpring,
                zIndex: 20
              }}
            >
              {/* .live-overlay-header (exact 1.25x scale of fullscreen-live-overlay.ts + player-ai.css) */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 13px",
                  background: "transparent",
                  borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
                  gap: 10
                }}
              >
                {/* .live-overlay-status-capsule */}
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 7.5,
                    padding: "4px 11px",
                    borderRadius: 999,
                    background: "rgba(255, 255, 255, 0.10)",
                    boxShadow:
                      "inset 1px 1px 0.5px -0.5px rgba(255, 255, 255, 0.34), inset 0 0 0 0.5px rgba(255, 255, 255, 0.16)"
                  }}
                >
                  <span
                    style={{
                      width: 8.5,
                      height: 8.5,
                      borderRadius: "50%",
                      background: isAiTalking ? "#38bdf8" : "#3fb950",
                      boxShadow: isAiTalking ? "0 0 8px #38bdf8" : "none",
                      transform: isAiTalking ? "scale(1.25)" : "scale(1)"
                    }}
                  />
                  <span
                    style={{
                      fontSize: 15,
                      fontWeight: 540,
                      color: "rgba(255, 255, 255, 0.94)",
                      mixBlendMode: "plus-lighter"
                    }}
                  >
                    正在陪看
                  </span>
                </div>

                {/* .live-overlay-header-actions (pure transparent icon buttons with 0.72 opacity white stroke) */}
                <div style={{display: "flex", alignItems: "center", gap: 5}}>
                  <div
                    style={{
                      padding: 5,
                      borderRadius: 7.5,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "transparent",
                      color: isUserSpeaking ? "#3fb950" : "#ffffff",
                      opacity: isUserSpeaking ? 1 : 0.72,
                      mixBlendMode: "plus-lighter"
                    }}
                  >
                    <MicIcon size={19} />
                  </div>
                  <div
                    style={{
                      padding: 5,
                      borderRadius: 7.5,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "transparent",
                      color: "#ffffff",
                      opacity: 0.72,
                      mixBlendMode: "plus-lighter"
                    }}
                  >
                    <SpeakerIcon size={19} />
                  </div>
                  <div
                    style={{
                      padding: 5,
                      borderRadius: 7.5,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "transparent",
                      color: "#ffffff",
                      opacity: 0.72,
                      mixBlendMode: "plus-lighter"
                    }}
                  >
                    <MinimizeIcon size={19} />
                  </div>
                  <div
                    style={{
                      padding: 5,
                      borderRadius: 7.5,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "transparent",
                      color: "#ffffff",
                      opacity: 0.72,
                      mixBlendMode: "plus-lighter"
                    }}
                  >
                    <CloseIcon size={19} />
                  </div>
                </div>
              </div>

              {/* .live-overlay-body > .live-overlay-messages */}
              <div
                style={{
                  padding: "13px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 10
                }}
              >
                {/* .live-overlay-bubble-user (pure text, #3fb950 green, 15px 15px 2.5px 15px radius) */}
                <div
                  style={{
                    alignSelf: "flex-end",
                    maxWidth: "82%",
                    padding: "10px 15px",
                    borderRadius: "15px 15px 2.5px 15px",
                    background: "#3fb950",
                    boxShadow:
                      "inset 0 1px 0 0 rgba(255, 255, 255, 0.28), 0 2px 8px rgba(0, 0, 0, 0.18)",
                    color: "#ffffff",
                    fontSize: 15.5,
                    fontWeight: 500,
                    lineHeight: 1.45,
                    opacity: userBubbleReveal,
                    translate: `0px ${((1 - userBubbleReveal) * 8).toFixed(1)}px`
                  }}
                >
                  {LIVE_USER_PROMPT}
                </div>

                {/* .live-overlay-bubble-assistant (pure text, translucent glass, 15px 15px 15px 2.5px radius) */}
                {frame >= LIVE_TIMELINE.aiReplyAt - 4 ? (
                  <div
                    style={{
                      alignSelf: "flex-start",
                      maxWidth: "82%",
                      padding: "10px 15px",
                      borderRadius: "15px 15px 15px 2.5px",
                      background: "rgba(255, 255, 255, 0.13)",
                      boxShadow:
                        "inset 1px 1px 0.5px -0.5px rgba(255, 255, 255, 0.30), inset 0 0 0 0.5px rgba(255, 255, 255, 0.16)",
                      color: "rgba(255, 255, 255, 0.95)",
                      mixBlendMode: "plus-lighter",
                      fontSize: 15.5,
                      fontWeight: 500,
                      lineHeight: 1.45,
                      opacity: aiBubbleReveal,
                      translate: `0px ${((1 - aiBubbleReveal) * 8).toFixed(1)}px`
                    }}
                  >
                    {visibleAiReply}
                  </div>
                ) : null}
              </div>
            </div>
            </div>

            {/* Bottom Bilibili Player Control Bar with #biliscript-player-live-quick-action */}
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                height: 68,
                padding: "0 24px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                background:
                  "linear-gradient(180deg, rgba(10, 14, 22, 0) 0%, rgba(10, 14, 22, 0.82) 48%, rgba(10, 14, 22, 0.94) 100%)",
                color: "rgba(255, 255, 255, 0.9)"
              }}
            >
              {/* Progress Bar Line */}
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: 0,
                  height: 4,
                  background: "rgba(255, 255, 255, 0.24)"
                }}
              >
                <div style={{width: "18%", height: "100%", background: "#00AEEC"}} />
              </div>

              {/* Left Playback Controls */}
              <div style={{display: "flex", alignItems: "center", gap: 18}}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="6 4 20 12 6 20 6 4" />
                </svg>
                <span
                  style={{
                    fontFamily: BRAND_FONT_FAMILY,
                    fontSize: 18,
                    fontWeight: 680,
                    fontVariantNumeric: "tabular-nums"
                  }}
                >
                  04:52 / 48:16
                </span>
              </div>

              {/* Right Control Bar Items (.bpx-player-control-bottom-right) */}
              <div style={{display: "flex", alignItems: "center", gap: 22, paddingRight: 4}}>
                {/* #biliscript-player-live-quick-action (mounted before 1080P 高码率, pure icon button) */}
                <div
                  style={{
                    position: "relative",
                    width: 36,
                    height: 22,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    marginRight: 2,
                    borderRadius: 6,
                    background: "transparent",
                    border: "none",
                    color: toggleClicked ? "#00AEEC" : "rgba(255, 255, 255, 0.9)",
                    opacity: toggleClicked ? 1 : 0.92,
                    filter: toggleClicked ? "drop-shadow(0 0 8px rgba(0, 174, 236, 0.45))" : "none",
                    scale: interpolate(
                      frame,
                      [
                        LIVE_TIMELINE.toggleClickAt - 2,
                        LIVE_TIMELINE.toggleClickAt,
                        LIVE_TIMELINE.toggleClickAt + 4
                      ],
                      [1, 0.88, 1],
                      CLAMP
                    )
                  }}
                >
                  <PlayerLiveActionIcon size={22} />
                  <span
                    style={{
                      position: "absolute",
                      left: "50%",
                      top: "50%",
                      width: 34,
                      height: 34,
                      marginLeft: -17,
                      marginTop: -17,
                      borderRadius: "50%",
                      border: "2px solid #00AEEC",
                      background: "rgba(0, 174, 236, 0.18)",
                      opacity: rippleOpacity,
                      scale: rippleScale,
                      pointerEvents: "none"
                    }}
                  />
                  {pointerOpacity > 0.01 ? (
                    <svg
                      viewBox="0 0 30 38"
                      style={{
                        position: "absolute",
                        left: 0,
                        top: 0,
                        width: 30,
                        height: 38,
                        opacity: pointerOpacity,
                        translate: `${pointerX}px ${pointerY}px`,
                        filter: "drop-shadow(0 4px 8px rgba(0, 0, 0, 0.45))",
                        pointerEvents: "none",
                        zIndex: 25
                      }}
                    >
                      <path
                        d="M3 2 L3 29 L10 23 L16 35 L22 32 L16 21 L26 20 Z"
                        fill="white"
                        stroke={COLORS.foreground}
                        strokeWidth="2"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : null}
                </div>

                <span style={{fontSize: 16, fontWeight: 650, color: "rgba(255, 255, 255, 0.9)", letterSpacing: "0.01em"}}>
                  1080P 高码率
                </span>
                <span style={{fontSize: 16, fontWeight: 650, color: "rgba(255, 255, 255, 0.9)"}}>
                  倍速
                </span>
                <span style={{fontSize: 16, fontWeight: 650, color: "rgba(255, 255, 255, 0.9)"}}>
                  字幕
                </span>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    color: isDuckingVideo ? "#34D399" : "rgba(255, 255, 255, 0.9)"
                  }}
                >
                  <BiliVolumeIcon size={22} />
                  {overlayOpacity > 0.05 ? (
                    <span
                      style={{
                        fontFamily: BRAND_FONT_FAMILY,
                        fontSize: 13.5,
                        fontWeight: 740,
                        fontVariantNumeric: "tabular-nums",
                        padding: "1px 7px",
                        borderRadius: 999,
                        background: isDuckingVideo ? "rgba(16, 185, 129, 0.22)" : "rgba(255, 255, 255, 0.14)",
                        color: isDuckingVideo ? "#6EE7B7" : "rgba(255, 255, 255, 0.88)"
                      }}
                    >
                      {videoVolumePercent}%
                    </span>
                  ) : null}
                </span>
                <span style={{display: "inline-flex", alignItems: "center", color: "rgba(255, 255, 255, 0.9)"}}>
                  <BiliSettingsIcon size={22} />
                </span>
                <span style={{display: "inline-flex", alignItems: "center", color: "rgba(255, 255, 255, 0.9)"}}>
                  <BiliPipIcon size={22} />
                </span>
                <span style={{display: "inline-flex", alignItems: "center", color: "rgba(255, 255, 255, 0.9)"}}>
                  <BiliTrefoilIcon size={22} />
                </span>
              </div>
            </div>
      </div>
    </AbsoluteFill>
  );
};
