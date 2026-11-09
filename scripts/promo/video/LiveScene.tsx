import {AbsoluteFill, Easing, Img, OffthreadVideo, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from "remotion";
import {voiceDuckEmphasisAtFrame} from "../audio.mjs";
import {LIVE_TIMELINE, SCENES} from "../timeline.mjs";
import {
  BottomLectureCaption,
  BRAND_FONT_FAMILY,
  COLORS,
  ELEVATION,
  EditorialHeaderBand,
  FONT_FAMILY,
  entranceOpacity
} from "./design";

const CLAMP = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;
const SMOOTH = Easing.bezier(0.16, 1, 0.3, 1);

const LIVE_FROM = SCENES.find((scene) => scene.id === "live")!.from;
const LIVE_VIDEO_SOURCE = "subtitle-seek-03.mp4";
const LIVE_VIDEO_START_FROM = 224;

// Real Bilibili video page player geometry in 1920x1080 page space (bili-page-shell.jpg: x=54..1398)
const PAGE_PLAYER = {
  left: 54,
  top: 171,
  width: 1344,
  height: 745
} as const;
const VIDEO_SOURCE_PLAYER_WIDTH = 1302;
const VIDEO_SCALE_X = PAGE_PLAYER.width / VIDEO_SOURCE_PLAYER_WIDTH;

export const LIVE_USER_PROMPT = "那普通人怎么跟 AI 打配合？";
export const LIVE_AI_REPLY = "把检索和拆解交给 AI，你来掌舵判断。";
export const LIVE_AI_QUOTE = "“把检索和拆解交给 AI，你来掌舵判断。”";

const PlayerLiveActionIcon = ({size = 20}: {size?: number}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" focusable="false" aria-hidden="true" fill="currentColor">
    <rect x="9" y="2.5" width="6" height="11" rx="3" fill="currentColor" />
    <path d="M5 10a7 7 0 0 0 14 0" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    <path d="M12 17v4.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    <path d="M8 21.5h8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
  </svg>
);

const MicIcon = ({size = 18}: {size?: number}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" x2="12" y1="19" y2="22" />
  </svg>
);

const SpeakerIcon = ({size = 18}: {size?: number}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
  </svg>
);

export const LiveScene = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const voiceEmphasis = voiceDuckEmphasisAtFrame(LIVE_FROM + frame);

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
  const pointerX = interpolate(frame, [2, LIVE_TIMELINE.toggleClickAt - 1], [116, 24], {...CLAMP, easing: SMOOTH});
  const pointerY = interpolate(frame, [2, LIVE_TIMELINE.toggleClickAt - 1], [58, 20], {...CLAMP, easing: SMOOTH});

  const overlaySpring = spring({
    fps,
    frame: frame - (LIVE_TIMELINE.overlayOpenAt - 4),
    config: {damping: 17, stiffness: 175, mass: 0.82}
  });
  const overlayOpacity = interpolate(frame, [LIVE_TIMELINE.overlayOpenAt - 5, LIVE_TIMELINE.overlayOpenAt + 4], [0, 1], CLAMP);

  // Keep the full Bilibili video page (title, UP card, right playlist, bottom bar) cleanly framed inside the 1776x852 stage
  const cameraBreath = interpolate(
    frame,
    [LIVE_TIMELINE.overlayOpenAt - 2, LIVE_TIMELINE.overlayOpenAt + 24],
    [0, 1],
    {...CLAMP, easing: SMOOTH}
  );
  const pageScale = interpolate(cameraBreath, [0, 1], [0.915, 0.935]);
  const pageLeft = (1776 - 1920 * pageScale) / 2;
  const pageTop = -64 * pageScale;

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

  const streamedChars = Math.max(
    0,
    Math.min(
      LIVE_AI_REPLY.length,
      Math.floor(
        interpolate(
          frame,
          [LIVE_TIMELINE.aiReplyAt, LIVE_TIMELINE.aiReplyAt + 42],
          [2, LIVE_AI_REPLY.length],
          CLAMP
        )
      )
    )
  );
  const visibleAiReply = frame >= LIVE_TIMELINE.aiReplyAt ? LIVE_AI_REPLY.slice(0, streamedChars) : "";

  return (
    <AbsoluteFill style={{fontFamily: FONT_FAMILY}}>
      <EditorialHeaderBand
        kicker="视频页 & 直播间通用 · 播放器液态玻璃伴看"
        title="懒得打字？开启实时伴看，边看边聊。"
        titleNode={
          <>
            懒得打字？开启<span style={{color: COLORS.pink}}>实时伴看</span>，边看边聊。
          </>
        }
        titleSize={52}
        delay={-12}
      />

      {/* Main Visual Stage: Bilibili Video Page + Player Top-Right Liquid-Glass Companion Overlay */}
      <div
        style={{
          position: "absolute",
          left: 72,
          top: 168,
          width: 1776,
          height: 856,
          borderRadius: 30,
          overflow: "hidden",
          boxShadow: ELEVATION.videoPlane,
          background: "#FFFFFF",
          opacity: entranceOpacity(frame, 1, 0),
          zIndex: 6
        }}
      >
        {/* Scaled 1920x1080 Bilibili Page Canvas (cropped cleanly below top nav bar) */}
        <div
          style={{
            position: "absolute",
            left: pageLeft,
            top: pageTop,
            width: 1920,
            height: 1080,
            transform: `scale(${pageScale.toFixed(4)})`,
            transformOrigin: "0% 0%"
          }}
        >
          {/* Real Bilibili Video Page Shell (Title, UP card, Danmaku list, Playlist, Action Bar) */}
          <Img
            src={staticFile("media/bili-page-shell.jpg")}
            style={{width: 1920, height: 1080, objectFit: "cover"}}
          />
          {/* Clean top-right unauthenticated login button in page header */}
          <div style={{position: "absolute", left: 1424, top: 8, width: 44, height: 48, background: "#FFFFFF"}} />

          {/* Bilibili Video Player Host (.bpx-player-container) */}
          <div
            style={{
              position: "absolute",
              left: PAGE_PLAYER.left,
              top: PAGE_PLAYER.top,
              width: PAGE_PLAYER.width,
              height: PAGE_PLAYER.height,
              borderRadius: 14,
              overflow: "hidden",
              background: "#0B0F17",
              boxShadow: "0 14px 36px rgba(15, 23, 42, 0.22)"
            }}
          >
            {/* Playing Lecture Video inside Player */}
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: VIDEO_SOURCE_PLAYER_WIDTH,
                height: PAGE_PLAYER.height,
                overflow: "hidden",
                transform: `scaleX(${VIDEO_SCALE_X.toFixed(5)})`,
                transformOrigin: "0% 0%"
              }}
            >
              <OffthreadVideo
                muted
                src={staticFile(`media/${LIVE_VIDEO_SOURCE}`)}
                startFrom={LIVE_VIDEO_START_FROM}
                playbackRate={0.35}
                style={{
                  position: "absolute",
                  left: -PAGE_PLAYER.left,
                  top: -PAGE_PLAYER.top,
                  width: 1920,
                  height: 1080,
                  maxWidth: "none"
                }}
              />
            </div>

            {/* Top-Left Scene & Audio Ducking Badges inside Player (unobtrusive, leaves lecturer clear) */}
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
              {/* Video & Live Room Support Corner Badge */}
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 16px",
                  borderRadius: 999,
                  background: "rgba(15, 23, 42, 0.72)",
                  backdropFilter: "blur(14px) saturate(160%)",
                  WebkitBackdropFilter: "blur(14px) saturate(160%)",
                  boxShadow:
                    "inset 1px 1px 0.5px rgba(255, 255, 255, 0.28), 0 8px 20px rgba(0, 0, 0, 0.28)",
                  color: "#F8FAFC",
                  fontSize: 18,
                  fontWeight: 720
                }}
              >
                <span
                  style={{
                    padding: "2px 10px",
                    borderRadius: 999,
                    background: "rgba(56, 189, 248, 0.24)",
                    color: "#7DD3FC",
                    fontSize: 16,
                    fontWeight: 760
                  }}
                >
                  视频页 + 直播间
                </span>
                <span>不挡看片 · 随看随聊</span>
              </div>

              {/* Voice Priority Auto-Ducking Pill */}
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 16px",
                  borderRadius: 999,
                  background: isDuckingVideo
                    ? "rgba(6, 78, 59, 0.80)"
                    : "rgba(15, 23, 42, 0.66)",
                  backdropFilter: "blur(14px) saturate(160%)",
                  WebkitBackdropFilter: "blur(14px) saturate(160%)",
                  boxShadow: isDuckingVideo
                    ? "inset 0 0 0 1.5px rgba(52, 211, 153, 0.65), 0 8px 22px rgba(16, 185, 129, 0.28)"
                    : "inset 1px 1px 0.5px rgba(255, 255, 255, 0.22), 0 8px 20px rgba(0, 0, 0, 0.24)",
                  color: isDuckingVideo ? "#ECFDF5" : "rgba(248, 250, 252, 0.9)",
                  fontSize: 17,
                  fontWeight: 720
                }}
              >
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    background: isDuckingVideo ? "#34D399" : "#38BDF8",
                    boxShadow: isDuckingVideo ? "0 0 10px #34D399" : "none"
                  }}
                />
                <span>
                  {isDuckingVideo ? "语音优先 · 原片音量自动压低至 20%" : "共享视频原声 · 100%"}
                </span>
              </div>
            </div>

            {/* HERO FOCAL POINT: Top-Right Liquid-Glass Companion Overlay (#biliscript-fullscreen-live-overlay) */}
            <div
              style={{
                position: "absolute",
                top: 18,
                right: 18,
                width: 556,
                borderRadius: 22,
                overflow: "hidden",
                /* Authentic Liquid-Glass material over live video: translucent dark tint + specular rim + backdrop blur & saturation */
                backgroundColor: "rgba(18, 20, 26, 0.44)",
                backgroundImage:
                  "radial-gradient(125% 95% at 10% 0%, rgba(255, 255, 255, 0.24) 0%, rgba(255, 255, 255, 0.06) 55%, transparent 100%), linear-gradient(165deg, rgba(255, 255, 255, 0.14) 0%, rgba(255, 255, 255, 0.03) 44%, rgba(8, 10, 16, 0.28) 100%)",
                backdropFilter: "blur(16px) saturate(180%) brightness(0.86)",
                WebkitBackdropFilter: "blur(16px) saturate(180%) brightness(0.86)",
                boxShadow:
                  "inset 1.5px 1.5px 1px -0.5px rgba(255, 255, 255, 0.54), inset -1.5px -1.5px 1px -0.5px rgba(255, 255, 255, 0.24), inset 0 0 0 1px rgba(255, 255, 255, 0.22), 0 0 0 0.5px rgba(0, 0, 0, 0.42), 0 24px 52px rgba(0, 0, 0, 0.54)",
                color: "rgba(255, 255, 255, 0.96)",
                opacity: overlayOpacity,
                transformOrigin: "100% 0%",
                translate: `0px ${((1 - overlaySpring) * 18).toFixed(1)}px`,
                scale: 0.92 + 0.08 * overlaySpring,
                zIndex: 20
              }}
            >
              {/* 12px Liquid-Glass Edge Refraction Rim Highlight */}
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  borderRadius: 22,
                  padding: 2,
                  background:
                    "linear-gradient(135deg, rgba(255, 255, 255, 0.48) 0%, rgba(56, 189, 248, 0.24) 28%, rgba(255, 255, 255, 0.06) 62%, rgba(251, 114, 153, 0.26) 100%)",
                  WebkitMask:
                    "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
                  WebkitMaskComposite: "xor",
                  maskComposite: "exclude",
                  pointerEvents: "none"
                }}
              />

              {/* .live-overlay-header */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "14px 18px",
                  borderBottom: "1px solid rgba(255, 255, 255, 0.12)"
                }}
              >
                {/* .live-overlay-status-capsule */}
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "6px 15px",
                    borderRadius: 999,
                    background: "rgba(255, 255, 255, 0.14)",
                    boxShadow:
                      "inset 1px 1px 0.5px -0.5px rgba(255, 255, 255, 0.38), inset 0 0 0 0.5px rgba(255, 255, 255, 0.18)"
                  }}
                >
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: isAiTalking ? "#38bdf8" : "#3fb950",
                      boxShadow: isAiTalking
                        ? "0 0 10px #38bdf8"
                        : "0 0 8px rgba(63, 185, 80, 0.75)",
                      transform: isAiTalking
                        ? `scale(${(1.22 + 0.18 * Math.sin(frame * 0.55)).toFixed(2)})`
                        : "scale(1)"
                    }}
                  />
                  <span style={{fontSize: 18, fontWeight: 740, color: "#FFFFFF"}}>正在陪看</span>
                  <span
                    style={{
                      padding: "2px 10px",
                      borderRadius: 999,
                      background: "rgba(56, 189, 248, 0.24)",
                      color: "#BAE6FD",
                      fontSize: 15,
                      fontWeight: 720
                    }}
                  >
                    MOSS Live · Gemini Live
                  </span>
                </div>

                {/* .live-overlay-header-actions */}
                <div style={{display: "flex", alignItems: "center", gap: 6}}>
                  <div
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 9,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: isUserSpeaking
                        ? "rgba(63, 185, 80, 0.28)"
                        : "rgba(255, 255, 255, 0.12)",
                      color: isUserSpeaking ? "#4ade80" : "rgba(255, 255, 255, 0.88)"
                    }}
                  >
                    <MicIcon size={18} />
                  </div>
                  <div
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 9,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "rgba(56, 189, 248, 0.22)",
                      color: "#7dd3fc"
                    }}
                  >
                    <SpeakerIcon size={18} />
                  </div>
                  <div
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 9,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "rgba(255, 255, 255, 0.08)",
                      color: "rgba(255, 255, 255, 0.78)",
                      fontSize: 20,
                      fontWeight: 600
                    }}
                  >
                    −
                  </div>
                  <div
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 9,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "rgba(255, 255, 255, 0.08)",
                      color: "rgba(255, 255, 255, 0.78)",
                      fontSize: 19,
                      fontWeight: 600
                    }}
                  >
                    ×
                  </div>
                </div>
              </div>

              {/* Compact Audio Preferences Strip (.live-overlay-audio-popover inline projection) */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  padding: "10px 18px",
                  background: "rgba(255, 255, 255, 0.07)",
                  borderBottom: "1px solid rgba(255, 255, 255, 0.09)",
                  opacity: 0.82 + 0.18 * duckReveal
                }}
              >
                <div style={{display: "flex", alignItems: "center", gap: 8}}>
                  <span style={{fontSize: 16, fontWeight: 680, color: "rgba(255, 255, 255, 0.92)"}}>
                    分享视频声音
                  </span>
                  <span
                    style={{
                      width: 34,
                      height: 19,
                      borderRadius: 999,
                      background: "#3fb950",
                      padding: 2.5,
                      display: "inline-flex",
                      justifyContent: "flex-end"
                    }}
                  >
                    <span style={{width: 14, height: 14, borderRadius: "50%", background: "#fff"}} />
                  </span>
                </div>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "3px 10px",
                    borderRadius: 999,
                    background: isDuckingVideo ? "rgba(56, 189, 248, 0.24)" : "transparent",
                    boxShadow: isDuckingVideo ? "inset 0 0 0 1px rgba(56, 189, 248, 0.48)" : "none"
                  }}
                >
                  <span
                    style={{
                      fontSize: 16,
                      fontWeight: 720,
                      color: isDuckingVideo ? "#BAE6FD" : "rgba(255, 255, 255, 0.92)"
                    }}
                  >
                    语音优先 · 自动压低原片
                  </span>
                  <span
                    style={{
                      width: 34,
                      height: 19,
                      borderRadius: 999,
                      background: "#3fb950",
                      padding: 2.5,
                      display: "inline-flex",
                      justifyContent: "flex-end"
                    }}
                  >
                    <span style={{width: 14, height: 14, borderRadius: "50%", background: "#fff"}} />
                  </span>
                </div>
              </div>

              {/* .live-overlay-messages */}
              <div
                style={{
                  padding: "16px 18px 18px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 13
                }}
              >
                {/* .live-overlay-bubble-user */}
                <div
                  style={{
                    alignSelf: "flex-end",
                    maxWidth: "88%",
                    padding: "12px 18px",
                    borderRadius: "16px 16px 3px 16px",
                    background: "#3fb950",
                    boxShadow:
                      "inset 0 1px 0 0 rgba(255, 255, 255, 0.34), 0 6px 16px rgba(0, 0, 0, 0.24)",
                    color: "#ffffff",
                    fontSize: 20,
                    fontWeight: 720,
                    lineHeight: 1.4,
                    opacity: userBubbleReveal,
                    translate: `0px ${((1 - userBubbleReveal) * 10).toFixed(1)}px`
                  }}
                >
                  <div style={{display: "flex", alignItems: "center", gap: 8}}>
                    <span>🎙️</span>
                    <span>{LIVE_USER_PROMPT}</span>
                  </div>
                </div>

                {/* .live-overlay-bubble-assistant */}
                <div
                  style={{
                    alignSelf: "flex-start",
                    width: "94%",
                    padding: "14px 18px",
                    borderRadius: "16px 16px 16px 3px",
                    background: "rgba(255, 255, 255, 0.16)",
                    boxShadow:
                      "inset 1px 1px 0.5px -0.5px rgba(255, 255, 255, 0.36), inset 0 0 0 0.5px rgba(255, 255, 255, 0.20), 0 8px 20px rgba(0, 0, 0, 0.24)",
                    color: "#ffffff",
                    opacity: aiBubbleReveal,
                    translate: `0px ${((1 - aiBubbleReveal) * 10).toFixed(1)}px`
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: 6
                    }}
                  >
                    <span style={{fontSize: 16, fontWeight: 720, color: "#BAE6FD"}}>
                      AI 实时语音伴看
                    </span>
                    <div style={{display: "flex", alignItems: "center", gap: 3.5, height: 16}}>
                      {[0, 1, 2, 3, 4, 5].map((barIdx) => {
                        const wave = isAiTalking
                          ? 0.4 + 0.6 * Math.abs(Math.sin((frame - LIVE_TIMELINE.aiReplyAt) * 0.45 + barIdx * 0.9))
                          : 0.25;
                        return (
                          <span
                            key={barIdx}
                            style={{
                              width: 3.5,
                              height: Math.round(5 + 11 * wave),
                              borderRadius: 999,
                              background: isAiTalking ? "#38bdf8" : "rgba(255, 255, 255, 0.38)"
                            }}
                          />
                        );
                      })}
                    </div>
                  </div>
                  <div
                    style={{
                      fontSize: 22,
                      fontWeight: 740,
                      lineHeight: 1.42,
                      color: "#FFFFFF",
                      minHeight: 32,
                      textShadow: "0 1px 4px rgba(0, 0, 0, 0.32)"
                    }}
                  >
                    {visibleAiReply}
                  </div>
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

              {/* Right Control Bar Items + #biliscript-player-live-quick-action */}
              <div style={{display: "flex", alignItems: "center", gap: 20}}>
                <span style={{fontSize: 17, fontWeight: 620, color: "rgba(255, 255, 255, 0.76)"}}>
                  1080P 高清
                </span>
                <span style={{fontSize: 17, fontWeight: 620, color: "rgba(255, 255, 255, 0.76)"}}>
                  倍速
                </span>
                <span style={{fontSize: 17, fontWeight: 620, color: "rgba(255, 255, 255, 0.76)"}}>
                  字幕
                </span>

                {/* #biliscript-player-live-quick-action */}
                <div
                  style={{
                    position: "relative",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 7,
                    padding: "7px 15px",
                    borderRadius: 999,
                    background: toggleClicked
                      ? "rgba(0, 174, 236, 0.26)"
                      : "rgba(255, 255, 255, 0.14)",
                    border: toggleClicked
                      ? "2px solid #00aeec"
                      : "1.5px solid rgba(255, 255, 255, 0.3)",
                    boxShadow: toggleClicked ? "0 0 22px rgba(0, 174, 236, 0.52)" : "none",
                    color: toggleClicked ? "#38bdf8" : "#ffffff",
                    fontSize: 18,
                    fontWeight: 760,
                    scale: interpolate(
                      frame,
                      [
                        LIVE_TIMELINE.toggleClickAt - 2,
                        LIVE_TIMELINE.toggleClickAt,
                        LIVE_TIMELINE.toggleClickAt + 4
                      ],
                      [1, 0.9, 1],
                      CLAMP
                    )
                  }}
                >
                  <PlayerLiveActionIcon size={19} />
                  <span>实时伴看</span>
                  <span
                    style={{
                      position: "absolute",
                      inset: -8,
                      borderRadius: 999,
                      border: "2.5px solid #00aeec",
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

                <span style={{fontSize: 17, fontWeight: 620, color: "rgba(255, 255, 255, 0.76)"}}>
                  网页全屏
                </span>
                <span style={{fontSize: 17, fontWeight: 620, color: "rgba(255, 255, 255, 0.76)"}}>
                  全屏
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <BottomLectureCaption
        timestamp="LIVE"
        speaker="MOSS Live 伴看语音"
        quote={LIVE_AI_QUOTE}
        active={voiceEmphasis > 0.01}
        emphasis={voiceEmphasis}
        from={LIVE_TIMELINE.aiReplyAt}
        duration={LIVE_TIMELINE.aiReplyDoneAt - LIVE_TIMELINE.aiReplyAt + 4}
        style={{bottom: 24}}
      />
    </AbsoluteFill>
  );
};
