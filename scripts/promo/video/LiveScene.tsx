import {AbsoluteFill, Easing, OffthreadVideo, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from "remotion";
import {voiceDuckEmphasisAtFrame} from "../audio.mjs";
import {LIVE_TIMELINE, SCENES} from "../timeline.mjs";
import {
  BottomLectureCaption,
  BRAND_FONT_FAMILY,
  COLORS,
  Crop,
  ELEVATION,
  EditorialHeaderBand,
  FONT_FAMILY,
  entranceOpacity,
  microPerspective
} from "./design";

const CLAMP = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;
const SMOOTH = Easing.bezier(0.16, 1, 0.3, 1);

const LIVE_FROM = SCENES.find((scene) => scene.id === "live")!.from;
const PLAYER_CROP: Crop = {x: 54, y: 171, width: 1272, height: 764};
const LIVE_VIDEO_SOURCE = "subtitle-seek-03.mp4";
const LIVE_VIDEO_START_FROM = 224;

export const LIVE_USER_PROMPT = "那普通人怎么跟 AI 打配合？";
export const LIVE_AI_REPLY = "把检索和拆解交给 AI，你来掌舵判断。";
export const LIVE_AI_QUOTE = "“把检索和拆解交给 AI，你来掌舵判断。”";

const MicIcon = ({size = 22, muted = false}: {size?: number; muted?: boolean}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" x2="12" y1="19" y2="22" />
    {muted ? <line x1="2" x2="22" y1="2" y2="22" stroke="#f85149" strokeWidth="2.2" /> : null}
  </svg>
);

const SpeakerIcon = ({size = 22}: {size?: number}) => (
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
    interpolate(frame, [2, 6], [0, 1], CLAMP) *
    interpolate(frame, [LIVE_TIMELINE.overlayOpenAt + 4, LIVE_TIMELINE.overlayOpenAt + 10], [1, 0], CLAMP);
  const pointerX = interpolate(frame, [2, LIVE_TIMELINE.toggleClickAt - 1], [120, 26], {...CLAMP, easing: SMOOTH});
  const pointerY = interpolate(frame, [2, LIVE_TIMELINE.toggleClickAt - 1], [68, 22], {...CLAMP, easing: SMOOTH});

  const overlaySpring = spring({
    fps,
    frame: frame - (LIVE_TIMELINE.overlayOpenAt - 4),
    config: {damping: 18, stiffness: 170, mass: 0.85}
  });
  const overlayOpacity = interpolate(frame, [LIVE_TIMELINE.overlayOpenAt - 6, LIVE_TIMELINE.overlayOpenAt + 4], [0, 1], CLAMP);

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

  const playerWidth = 884;
  const playerHeight = 532;
  const cropScale = playerWidth / PLAYER_CROP.width;

  return (
    <AbsoluteFill style={{fontFamily: FONT_FAMILY}}>
      <EditorialHeaderBand
        kicker="全双工语音 · 视频页 & 直播间实时伴看"
        title="懒得打字？开启实时伴看，边看边聊。"
        titleNode={
          <>
            懒得打字？开启<span style={{color: COLORS.pink}}>实时伴看</span>，边看边聊。
          </>
        }
        titleSize={52}
        delay={-12}
      />

      {/* Left Stage: Bilibili Video Player with Control Bar Live Quick Action & Ducking Meter */}
      <div
        style={{
          position: "absolute",
          left: 96,
          top: 254,
          width: playerWidth,
          opacity: entranceOpacity(frame, 2, 0),
          zIndex: 6
        }}
      >
        {/* Scene Context Bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 14,
            padding: "0 4px"
          }}
        >
          <div style={{display: "flex", alignItems: "center", gap: 10}}>
            <span
              style={{
                padding: "6px 14px",
                borderRadius: 999,
                background: "rgba(0, 174, 236, 0.14)",
                color: COLORS.bilibiliBlue,
                fontSize: 20,
                fontWeight: 760
              }}
            >
              视频页 + 直播间通用
            </span>
            <span style={{fontSize: 21, fontWeight: 660, color: COLORS.muted}}>
              复旦《AI 与未来社会》04:52
            </span>
          </div>

          {/* Original Video Audio Ducking Indicator */}
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 16px",
              borderRadius: 999,
              background: isDuckingVideo ? "rgba(16, 185, 129, 0.14)" : "rgba(15, 23, 42, 0.06)",
              border: isDuckingVideo ? "1.5px solid rgba(16, 185, 129, 0.38)" : "1.5px solid rgba(15, 23, 42, 0.08)",
              color: isDuckingVideo ? "#047857" : COLORS.muted,
              fontSize: 19,
              fontWeight: 740
            }}
          >
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: "50%",
                background: isDuckingVideo ? "#10b981" : "#94a3b8",
                boxShadow: isDuckingVideo ? "0 0 10px rgba(16, 185, 129, 0.8)" : "none"
              }}
            />
            <span>{isDuckingVideo ? "语音优先 · 原片音量自动压低 80%" : "分享视频原声 · 100%"}</span>
          </div>
        </div>

        {/* Bilibili Video Frame */}
        <div
          style={{
            position: "relative",
            width: playerWidth,
            height: playerHeight,
            borderRadius: 26,
            overflow: "hidden",
            boxShadow: ELEVATION.videoPlane,
            background: "#0F172A"
          }}
        >
          <OffthreadVideo
            muted
            src={staticFile(`media/${LIVE_VIDEO_SOURCE}`)}
            startFrom={LIVE_VIDEO_START_FROM}
            playbackRate={0.35}
            style={{
              position: "absolute",
              left: -PLAYER_CROP.x * cropScale,
              top: -PLAYER_CROP.y * cropScale - 20,
              width: 1920 * cropScale,
              height: 1080 * cropScale,
              maxWidth: "none",
              filter: isDuckingVideo ? "brightness(0.92)" : "none"
            }}
          />

          {/* Top-Right In-Situ Mini Preview Badge inside Player */}
          <div
            style={{
              position: "absolute",
              top: 18,
              right: 18,
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 18px",
              borderRadius: 999,
              background: "rgba(18, 20, 24, 0.68)",
              backdropFilter: "blur(18px) saturate(168%)",
              boxShadow:
                "inset 1.5px 1.5px 1px -1px rgba(255, 255, 255, 0.36), 0 12px 28px rgba(0, 0, 0, 0.36)",
              color: "#f0f6fc",
              fontSize: 19,
              fontWeight: 700,
              opacity: overlayOpacity
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: isAiTalking ? "#38bdf8" : "#3fb950",
                boxShadow: isAiTalking ? "0 0 10px #38bdf8" : "0 0 8px rgba(63, 185, 80, 0.6)",
                transform: isAiTalking ? "scale(1.3)" : "scale(1)"
              }}
            />
            <span>全屏液态玻璃浮层 · 正在陪看</span>
          </div>

          {/* Bottom Player Control Bar with #biliscript-player-live-quick-action */}
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              height: 78,
              padding: "0 24px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              background: "linear-gradient(180deg, rgba(10, 14, 22, 0) 0%, rgba(10, 14, 22, 0.88) 45%, rgba(10, 14, 22, 0.96) 100%)",
              color: "rgba(255, 255, 255, 0.88)"
            }}
          >
            {/* Left playback controls */}
            <div style={{display: "flex", alignItems: "center", gap: 18}}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="6 4 20 12 6 20 6 4" />
              </svg>
              <span
                style={{
                  fontFamily: BRAND_FONT_FAMILY,
                  fontSize: 20,
                  fontWeight: 680,
                  fontVariantNumeric: "tabular-nums"
                }}
              >
                04:52 / 48:16
              </span>
            </div>

            {/* Right control bar with #biliscript-player-live-quick-action */}
            <div style={{display: "flex", alignItems: "center", gap: 18}}>
              <span style={{fontSize: 19, fontWeight: 620, color: "rgba(255, 255, 255, 0.72)"}}>1080P 高清</span>
              <span style={{fontSize: 19, fontWeight: 620, color: "rgba(255, 255, 255, 0.72)"}}>倍速</span>

              {/* #biliscript-player-live-quick-action */}
              <div
                style={{
                  position: "relative",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "9px 18px",
                  borderRadius: 999,
                  background: toggleClicked ? "rgba(0, 174, 236, 0.24)" : "rgba(255, 255, 255, 0.14)",
                  border: toggleClicked ? "2px solid #00aeec" : "1.5px solid rgba(255, 255, 255, 0.28)",
                  boxShadow: toggleClicked ? "0 0 24px rgba(0, 174, 236, 0.48)" : "none",
                  color: toggleClicked ? "#38bdf8" : "#ffffff",
                  fontSize: 20,
                  fontWeight: 760,
                  scale: interpolate(
                    frame,
                    [LIVE_TIMELINE.toggleClickAt - 2, LIVE_TIMELINE.toggleClickAt, LIVE_TIMELINE.toggleClickAt + 4],
                    [1, 0.9, 1],
                    CLAMP
                  )
                }}
              >
                <MicIcon size={20} />
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
                      width: 32,
                      height: 40,
                      opacity: pointerOpacity,
                      translate: `${pointerX}px ${pointerY}px`,
                      filter: "drop-shadow(0 4px 8px rgba(0, 0, 0, 0.45))",
                      pointerEvents: "none",
                      zIndex: 12
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

              <span style={{fontSize: 19, fontWeight: 620, color: "rgba(255, 255, 255, 0.72)"}}>全屏</span>
            </div>
          </div>
        </div>
      </div>

      {/* Right Stage: 1:1 Magnified #biliscript-fullscreen-live-overlay Liquid-Glass Companion Card */}
      <div
        style={{
          position: "absolute",
          left: 1024,
          top: 242,
          width: 800,
          zIndex: 9,
          opacity: overlayOpacity,
          translate: `0px ${((1 - overlaySpring) * 28).toFixed(1)}px`,
          scale: 0.94 + 0.06 * overlaySpring
        }}
      >
        <div
          style={{
            position: "relative",
            width: 800,
            borderRadius: 30,
            overflow: "hidden",
            backgroundColor: "rgba(18, 20, 24, 0.86)",
            backgroundImage:
              "radial-gradient(120% 90% at 12% 0%, rgba(255, 255, 255, 0.16) 0%, rgba(255, 255, 255, 0.04) 42%, transparent 72%), linear-gradient(160deg, rgba(255, 255, 255, 0.12) 0%, rgba(255, 255, 255, 0.03) 48%, rgba(8, 10, 14, 0.24) 100%)",
            backdropFilter: "blur(24px) saturate(168%)",
            WebkitBackdropFilter: "blur(24px) saturate(168%)",
            boxShadow:
              "inset 1.5px 1.5px 1px -1px rgba(255, 255, 255, 0.42), inset -1px -1px 1px -0.5px rgba(255, 255, 255, 0.16), inset 0 0 0 1px rgba(255, 255, 255, 0.12), 0 28px 64px -14px rgba(15, 23, 42, 0.46), 0 8px 24px -4px rgba(15, 23, 42, 0.24)",
            padding: "24px 28px 28px",
            transform: microPerspective(-5, 1),
            color: "#f0f6fc"
          }}
        >
          {/* .live-overlay-header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              paddingBottom: 18,
              marginBottom: 18,
              borderBottom: "1px solid rgba(255, 255, 255, 0.1)"
            }}
          >
            {/* .live-overlay-status-capsule */}
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 12,
                padding: "8px 18px",
                borderRadius: 999,
                background: "rgba(255, 255, 255, 0.1)",
                boxShadow: "inset 0 1px 0.5px rgba(255, 255, 255, 0.28)"
              }}
            >
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: "50%",
                  background: isAiTalking ? "#38bdf8" : "#3fb950",
                  boxShadow: isAiTalking ? "0 0 12px #38bdf8" : "0 0 8px rgba(63, 185, 80, 0.65)",
                  transform: isAiTalking ? `scale(${(1.22 + 0.18 * Math.sin(frame * 0.55)).toFixed(2)})` : "scale(1)"
                }}
              />
              <span style={{fontSize: 22, fontWeight: 740, color: "#f0f6fc"}}>正在陪看</span>
              <span
                style={{
                  marginLeft: 4,
                  padding: "3px 12px",
                  borderRadius: 999,
                  background: "rgba(56, 189, 248, 0.18)",
                  color: "#7dd3fc",
                  fontSize: 18,
                  fontWeight: 700
                }}
              >
                MOSS Live · Gemini Live
              </span>
            </div>

            {/* .live-overlay-header-actions */}
            <div style={{display: "flex", alignItems: "center", gap: 10}}>
              <div
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 12,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: isUserSpeaking ? "rgba(63, 185, 80, 0.24)" : "rgba(255, 255, 255, 0.1)",
                  color: isUserSpeaking ? "#4ade80" : "#f0f6fc"
                }}
              >
                <MicIcon size={21} />
              </div>
              <div
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 12,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "rgba(56, 189, 248, 0.2)",
                  color: "#38bdf8"
                }}
              >
                <SpeakerIcon size={21} />
              </div>
              <div
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 12,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "rgba(255, 255, 255, 0.08)",
                  color: "rgba(240, 246, 252, 0.72)",
                  fontSize: 24,
                  fontWeight: 600
                }}
              >
                −
              </div>
            </div>
          </div>

          {/* .live-overlay-audio-popover inline strip: 分享视频声音 + 语音优先 */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 14,
              marginBottom: 20,
              opacity: 0.75 + 0.25 * duckReveal
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 18px",
                borderRadius: 16,
                background: "rgba(255, 255, 255, 0.08)",
                boxShadow: "inset 0 1px 0.5px rgba(255, 255, 255, 0.18)"
              }}
            >
              <div>
                <div style={{fontSize: 20, fontWeight: 720, color: "#f0f6fc"}}>分享视频声音</div>
                <div style={{fontSize: 18, fontWeight: 560, color: "rgba(240, 246, 252, 0.68)", marginTop: 2}}>
                  画面 + 原声同步喂给 AI
                </div>
              </div>
              <div
                style={{
                  width: 46,
                  height: 26,
                  borderRadius: 999,
                  background: "#3fb950",
                  padding: 3,
                  display: "flex",
                  justifyContent: "flex-end"
                }}
              >
                <span style={{width: 20, height: 20, borderRadius: "50%", background: "#ffffff"}} />
              </div>
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 18px",
                borderRadius: 16,
                background: isDuckingVideo ? "rgba(56, 189, 248, 0.16)" : "rgba(255, 255, 255, 0.08)",
                border: isDuckingVideo ? "1.5px solid rgba(56, 189, 248, 0.45)" : "1.5px solid transparent",
                boxShadow: "inset 0 1px 0.5px rgba(255, 255, 255, 0.22)"
              }}
            >
              <div>
                <div style={{fontSize: 20, fontWeight: 720, color: "#f0f6fc"}}>语音优先</div>
                <div style={{fontSize: 18, fontWeight: 620, color: isDuckingVideo ? "#7dd3fc" : "rgba(240, 246, 252, 0.68)", marginTop: 2}}>
                  开口自动压低原片音量
                </div>
              </div>
              <div
                style={{
                  width: 46,
                  height: 26,
                  borderRadius: 999,
                  background: "#3fb950",
                  padding: 3,
                  display: "flex",
                  justifyContent: "flex-end"
                }}
              >
                <span style={{width: 20, height: 20, borderRadius: "50%", background: "#ffffff"}} />
              </div>
            </div>
          </div>

          {/* .live-overlay-messages */}
          <div style={{display: "flex", flexDirection: "column", gap: 18}}>
            {/* .live-overlay-bubble-user */}
            <div
              style={{
                alignSelf: "flex-end",
                maxWidth: 640,
                padding: "16px 24px",
                borderRadius: "20px 20px 4px 20px",
                background: "#3fb950",
                boxShadow: "inset 0 1px 0.5px rgba(255, 255, 255, 0.35), 0 8px 20px rgba(16, 185, 129, 0.28)",
                color: "#ffffff",
                fontSize: 25,
                fontWeight: 720,
                lineHeight: 1.42,
                opacity: userBubbleReveal,
                translate: `0px ${((1 - userBubbleReveal) * 14).toFixed(1)}px`
              }}
            >
              <div style={{display: "flex", alignItems: "center", gap: 10}}>
                <span>🎙️</span>
                <span>{LIVE_USER_PROMPT}</span>
              </div>
            </div>

            {/* .live-overlay-bubble-assistant */}
            <div
              style={{
                alignSelf: "flex-start",
                width: "100%",
                padding: "20px 24px",
                borderRadius: "20px 20px 20px 4px",
                background: "rgba(255, 255, 255, 0.12)",
                boxShadow: "inset 0 1px 0.5px rgba(255, 255, 255, 0.25), 0 10px 24px rgba(0, 0, 0, 0.22)",
                color: "#f0f6fc",
                opacity: aiBubbleReveal,
                translate: `0px ${((1 - aiBubbleReveal) * 14).toFixed(1)}px`
              }}
            >
              <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10}}>
                <span style={{fontSize: 19, fontWeight: 720, color: "#7dd3fc"}}>
                  AI 伴看实时语音回复
                </span>
                {/* Voice waveform bars */}
                <div style={{display: "flex", alignItems: "center", gap: 4, height: 20}}>
                  {[0, 1, 2, 3, 4, 5].map((barIdx) => {
                    const wave = isAiTalking
                      ? 0.4 + 0.6 * Math.abs(Math.sin((frame - LIVE_TIMELINE.aiReplyAt) * 0.45 + barIdx * 0.9))
                      : 0.25;
                    return (
                      <span
                        key={barIdx}
                        style={{
                          width: 4,
                          height: Math.round(6 + 14 * wave),
                          borderRadius: 999,
                          background: isAiTalking ? "#38bdf8" : "rgba(255, 255, 255, 0.35)"
                        }}
                      />
                    );
                  })}
                </div>
              </div>
              <div style={{fontSize: 27, fontWeight: 740, lineHeight: 1.45, color: "#ffffff", minHeight: 39}}>
                {visibleAiReply}
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
      />
    </AbsoluteFill>
  );
};
