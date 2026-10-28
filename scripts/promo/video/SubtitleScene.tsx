import {Easing, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame} from "remotion";
import {
  SUBTITLE_DURATION,
  SUBTITLE_MATCH_FRAME,
  SUBTITLE_PLAYBACK_RATE,
  SUBTITLE_SECOND_SHOT_SOURCE_FRAME
} from "../subtitle-timeline.mjs";
import {BRAND_FONT_FAMILY, COLORS, EditorialHeaderBand, FONT_FAMILY, MIST_GLASS, VoiceWaveBar} from "./design";

const SOURCE = "subtitle-seek-03.mp4";
const CLAMP = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;
const SMOOTH = Easing.bezier(0.16, 1, 0.3, 1);

const PLAYER_STAGE_TRANSFORM = {
  scale: 1.35,
  x: 101.4,
  y: -206.85
};

const LectureVideoBackdrop = ({duration}: {duration: number}) => {
  const frame = useCurrentFrame();
  const dimOpacity = interpolate(frame, [4, 14, SUBTITLE_MATCH_FRAME - 1, SUBTITLE_MATCH_FRAME + 7], [0, 1, 1, 0], {
    ...CLAMP,
    easing: SMOOTH
  });
  const seekScale = interpolate(
    frame,
    [SUBTITLE_MATCH_FRAME, SUBTITLE_MATCH_FRAME + 2, SUBTITLE_MATCH_FRAME + 10, duration],
    [PLAYER_STAGE_TRANSFORM.scale * 1.055, PLAYER_STAGE_TRANSFORM.scale * 0.994, PLAYER_STAGE_TRANSFORM.scale, PLAYER_STAGE_TRANSFORM.scale],
    {...CLAMP, easing: SMOOTH}
  );
  const snapFlashOpacity = interpolate(
    frame,
    [SUBTITLE_MATCH_FRAME - 1, SUBTITLE_MATCH_FRAME, SUBTITLE_MATCH_FRAME + 5],
    [0, 0.42, 0],
    CLAMP
  );
  const videoProps = {
    muted: true,
    src: staticFile(`media/${SOURCE}`),
    playbackRate: SUBTITLE_PLAYBACK_RATE,
    style: {width: 1920, height: 1080, maxWidth: "none"} as const
  };

  return (
    <div style={{position: "absolute", inset: 0, overflow: "hidden"}}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          transformOrigin: "0 0",
          scale: frame >= SUBTITLE_MATCH_FRAME ? seekScale : PLAYER_STAGE_TRANSFORM.scale,
          translate: `${PLAYER_STAGE_TRANSFORM.x}px ${PLAYER_STAGE_TRANSFORM.y}px`
        }}
      >
        <Sequence durationInFrames={SUBTITLE_MATCH_FRAME}>
          <OffthreadVideo {...videoProps} />
        </Sequence>
        <Sequence from={SUBTITLE_MATCH_FRAME} durationInFrames={SUBTITLE_DURATION - SUBTITLE_MATCH_FRAME}>
          <OffthreadVideo {...videoProps} startFrom={SUBTITLE_SECOND_SHOT_SOURCE_FRAME} />
        </Sequence>
      </div>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "radial-gradient(circle at 50% 54%, rgba(17, 24, 39, 0.34) 0%, rgba(17, 24, 39, 0.18) 68%, rgba(17, 24, 39, 0.08) 100%)",
          backdropFilter: "blur(8px)",
          WebkitBackdropFilter: "blur(8px)",
          opacity: dimOpacity,
          pointerEvents: "none"
        }}
      />
      {snapFlashOpacity > 0.01 && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "radial-gradient(circle at 46% 48%, rgba(255, 255, 255, 0.92) 0%, rgba(0, 140, 255, 0.28) 45%, rgba(255, 255, 255, 0) 80%)",
            opacity: snapFlashOpacity,
            pointerEvents: "none"
          }}
        />
      )}
    </div>
  );
};

const SubtitleHeroSpotlight = () => {
  const frame = useCurrentFrame();
  if (frame < 4 || frame > 68) return null;

  const enter = interpolate(frame, [4, 14], [0, 1], {...CLAMP, easing: SMOOTH});
  const exit = interpolate(frame, [SUBTITLE_MATCH_FRAME, SUBTITLE_MATCH_FRAME + 6], [1, 0], {...CLAMP, easing: SMOOTH});
  const opacity = enter * exit;
  const cardScale =
    interpolate(frame, [4, 14], [0.94, 1], {...CLAMP, easing: SMOOTH}) *
    interpolate(frame, [SUBTITLE_MATCH_FRAME, SUBTITLE_MATCH_FRAME + 6], [1, 1.04], {...CLAMP, easing: SMOOTH});
  const cardY = interpolate(frame, [4, 14], [28, 0], {...CLAMP, easing: SMOOTH});

  const typedQuery = frame < 12 ? "" : frame < 16 ? "幻" : "幻觉";
  const enterKeyPressed = frame >= 20 && frame <= 26;
  const enterKeyScale = interpolate(frame, [20, 22, 26], [1, 0.93, 1], {...CLAMP, easing: SMOOTH});
  const resultsProgress = interpolate(frame, [16, 25], [0, 1], {...CLAMP, easing: SMOOTH});
  const rowHover = interpolate(frame, [42, 52], [0, 1], {...CLAMP, easing: SMOOTH});
  const isClicked = frame >= SUBTITLE_MATCH_FRAME - 2;
  const rowPress = interpolate(
    frame,
    [SUBTITLE_MATCH_FRAME - 2, SUBTITLE_MATCH_FRAME, SUBTITLE_MATCH_FRAME + 3],
    [1, 0.984, 1.01],
    CLAMP
  );

  const cursorOpacity =
    interpolate(frame, [38, 44], [0, 1], CLAMP) *
    interpolate(frame, [SUBTITLE_MATCH_FRAME + 1, SUBTITLE_MATCH_FRAME + 5], [1, 0], CLAMP);
  const cursorX = interpolate(frame, [38, 56], [420, 48], {...CLAMP, easing: SMOOTH});
  const cursorY = interpolate(frame, [38, 56], [140, 26], {...CLAMP, easing: SMOOTH});
  const rippleOpacity = interpolate(frame, [SUBTITLE_MATCH_FRAME - 2, SUBTITLE_MATCH_FRAME, SUBTITLE_MATCH_FRAME + 6], [0, 0.9, 0], CLAMP);
  const rippleScale = interpolate(frame, [SUBTITLE_MATCH_FRAME - 2, SUBTITLE_MATCH_FRAME + 6], [0.55, 1.75], {...CLAMP, easing: SMOOTH});

  return (
    <div
      style={{
        position: "absolute",
        left: 310,
        top: 224,
        width: 1300,
        borderRadius: 30,
        overflow: "hidden",
        background: MIST_GLASS.surface,
        backdropFilter: "blur(24px) saturate(1.2)",
        WebkitBackdropFilter: "blur(24px) saturate(1.2)",
        boxShadow: MIST_GLASS.shellShadow,
        padding: "28px 36px 32px",
        fontFamily: FONT_FAMILY,
        opacity,
        transform: `perspective(1800px) rotateY(-1.4deg) rotateX(1deg) translateY(${cardY}px) scale(${cardScale})`,
        transformOrigin: "50% 50%"
      }}
    >
      {/* Flyme Blue-Mist Ambient Blobs */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: MIST_GLASS.blobs,
          filter: "blur(28px)",
          pointerEvents: "none"
        }}
      />

      {/* Top Bar: Tabs + Search Input */}
      <div style={{position: "relative", zIndex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20, marginBottom: 22}}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: 4,
            borderRadius: 14,
            background: "transparent"
          }}
        >
          {["字幕", "概览", "AI 对话"].map((tab, index) => (
            <div
              key={tab}
              style={{
                padding: "9px 22px",
                borderRadius: 10,
                background: index === 0 ? MIST_GLASS.cardElevated : "transparent",
                boxShadow: index === 0 ? MIST_GLASS.tabActiveShadow : "none",
                color: index === 0 ? MIST_GLASS.accent : MIST_GLASS.muted,
                fontSize: 20,
                fontWeight: index === 0 ? 700 : 560
              }}
            >
              {tab}
            </div>
          ))}
        </div>

        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            height: 74,
            padding: "0 26px",
            borderRadius: 18,
            background: MIST_GLASS.cardElevated,
            boxShadow: `${MIST_GLASS.cardShadow}, 0 0 0 2px rgba(0, 140, 255, 0.20)`
          }}
        >
          <div style={{display: "flex", alignItems: "center", gap: 14}}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
              <circle cx="11" cy="11" r="7" stroke={MIST_GLASS.accent} strokeWidth="2.4" />
              <path d="M16.5 16.5L21 21" stroke={MIST_GLASS.accent} strokeWidth="2.4" strokeLinecap="round" />
            </svg>
            <span
              style={{
                color: typedQuery ? MIST_GLASS.text : MIST_GLASS.faint,
                fontSize: 34,
                fontWeight: 740,
                letterSpacing: -0.6
              }}
            >
              {typedQuery || "搜索字幕…"}
            </span>
            <span
              style={{
                width: 3,
                height: 34,
                borderRadius: 2,
                background: MIST_GLASS.accent,
                opacity: frame % 16 < 10 ? 0.9 : 0.2
              }}
            />
          </div>
          {frame >= 16 && (
            <div style={{display: "flex", alignItems: "center", gap: 10}}>
              <span
                style={{
                  padding: "6px 16px",
                  borderRadius: 999,
                  background: enterKeyPressed ? MIST_GLASS.accent : MIST_GLASS.accentSoft,
                  color: enterKeyPressed ? "#FFFFFF" : MIST_GLASS.accent,
                  boxShadow: enterKeyPressed ? "0 6px 18px -4px rgba(0, 140, 255, 0.48)" : "none",
                  fontFamily: BRAND_FONT_FAMILY,
                  fontSize: 20,
                  fontWeight: 700,
                  fontVariantNumeric: "tabular-nums",
                  scale: enterKeyScale
                }}
              >
                4 / 5 · ↵ 回车跳播
              </span>
              <span
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 9,
                  background: "rgba(15, 23, 42, 0.04)",
                  color: MIST_GLASS.muted,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 18,
                  fontWeight: 700
                }}
              >
                ↑
              </span>
              <span
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 9,
                  background: "rgba(15, 23, 42, 0.04)",
                  color: MIST_GLASS.muted,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 18,
                  fontWeight: 700
                }}
              >
                ↓
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Filtered Subtitle Context & 48px Hero Row */}
      <div
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          opacity: resultsProgress,
          transform: `translateY(${(1 - resultsProgress) * 14}px)`
        }}
      >
        {/* Muted Context Row Above */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 22,
            padding: "14px 28px",
            borderRadius: 16,
            background: "rgba(255, 255, 255, 0.46)",
            boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.72)",
            opacity: 0.76
          }}
        >
          <span
            style={{
              padding: "5px 14px",
              borderRadius: 999,
              background: MIST_GLASS.timeBg,
              color: MIST_GLASS.timeColor,
              fontFamily: BRAND_FONT_FAMILY,
              fontSize: 22,
              fontWeight: 680,
              fontVariantNumeric: "tabular-nums"
            }}
          >
            02:32
          </span>
          <span style={{color: MIST_GLASS.muted, fontSize: 25, fontWeight: 560}}>
            机器
            <span
              style={{
                padding: "1px 6px",
                borderRadius: 5,
                background: MIST_GLASS.accentSoft,
                color: MIST_GLASS.accent,
                fontWeight: 700
              }}
            >
              幻觉
            </span>
            是怎么产生的
          </span>
        </div>

        {/* HERO MATCHED ROW: 48px font size */}
        <div
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 24,
            padding: "26px 30px",
            borderRadius: 22,
            background: isClicked
              ? "linear-gradient(165deg, rgba(242, 249, 255, 0.98) 0%, rgba(255, 255, 255, 0.94) 55%, rgba(235, 246, 255, 0.96) 100%)"
              : MIST_GLASS.cardElevated,
            boxShadow: isClicked
              ? "inset 0 1px 0 0 rgba(255, 255, 255, 0.98), 0 22px 48px -14px rgba(0, 140, 255, 0.26), 0 0 0 2px rgba(0, 140, 255, 0.52)"
              : `inset 0 1px 0 0 rgba(255, 255, 255, 0.96), inset 0 -1px 0 0 rgba(16, 136, 247, 0.12), 0 16px 38px -14px rgba(15, 23, 42, ${0.10 + rowHover * 0.06}), 0 0 0 1.5px rgba(0, 140, 255, ${0.18 + rowHover * 0.22})`,
            scale: rowPress
          }}
        >
          <div style={{display: "flex", alignItems: "center", gap: 26}}>
            <div style={{position: "relative", display: "flex", alignItems: "center", justifyContent: "center"}}>
              <div
                style={{
                  position: "absolute",
                  inset: -10,
                  borderRadius: 999,
                  background: "rgba(0, 140, 255, 0.24)",
                  opacity: rippleOpacity,
                  scale: rippleScale,
                  pointerEvents: "none"
                }}
              />
              <span
                style={{
                  padding: "10px 22px",
                  borderRadius: 999,
                  background: isClicked || rowHover > 0.5 ? MIST_GLASS.accent : MIST_GLASS.timeBg,
                  color: isClicked || rowHover > 0.5 ? "#FFFFFF" : MIST_GLASS.timeColor,
                  boxShadow: isClicked || rowHover > 0.5 ? "0 10px 24px -6px rgba(0, 140, 255, 0.45)" : "none",
                  fontFamily: BRAND_FONT_FAMILY,
                  fontSize: 32,
                  fontWeight: 780,
                  letterSpacing: 0.4,
                  fontVariantNumeric: "tabular-nums"
                }}
              >
                04:07
              </span>
              {cursorOpacity > 0.01 && (
                <svg
                  viewBox="0 0 30 38"
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    width: 34,
                    height: 42,
                    filter: "drop-shadow(0 6px 12px rgba(17, 24, 39, 0.32))",
                    opacity: cursorOpacity,
                    translate: `${cursorX}px ${cursorY}px`,
                    scale: interpolate(
                      frame,
                      [SUBTITLE_MATCH_FRAME - 2, SUBTITLE_MATCH_FRAME, SUBTITLE_MATCH_FRAME + 3],
                      [1, 0.84, 1],
                      CLAMP
                    ),
                    pointerEvents: "none",
                    zIndex: 5
                  }}
                >
                  <path
                    d="M3 2 L3 29 L10 23 L16 35 L22 32 L16 21 L26 20 Z"
                    fill="white"
                    stroke={MIST_GLASS.text}
                    strokeWidth="2"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </div>

            <div
              style={{
                color: MIST_GLASS.text,
                fontSize: 48,
                fontWeight: 760,
                lineHeight: 1.22,
                letterSpacing: -1.2,
                whiteSpace: "nowrap"
              }}
            >
              也可能会产生 · 也很难避免
              <span
                style={{
                  display: "inline-block",
                  marginLeft: 6,
                  padding: "2px 14px 4px",
                  borderRadius: 12,
                  background: MIST_GLASS.accent,
                  color: "#FFFFFF",
                  boxShadow: "0 4px 12px rgba(0, 140, 255, 0.28)"
                }}
              >
                幻觉
              </span>
            </div>
          </div>

          <div
            style={{
              padding: "10px 20px",
              borderRadius: 999,
              background: isClicked ? MIST_GLASS.accent : MIST_GLASS.timeBg,
              color: isClicked ? "#FFFFFF" : MIST_GLASS.timeColor,
              fontSize: 21,
              fontWeight: 700,
              whiteSpace: "nowrap"
            }}
          >
            {isClicked ? "正在跳播 04:07 ↗" : "点击时间戳跳播 ↗"}
          </div>
        </div>

        {/* Muted Context Row Below */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 22,
            padding: "14px 28px",
            borderRadius: 16,
            background: "rgba(255, 255, 255, 0.46)",
            boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.72)",
            opacity: 0.76
          }}
        >
          <span
            style={{
              padding: "5px 14px",
              borderRadius: 999,
              background: MIST_GLASS.timeBg,
              color: MIST_GLASS.timeColor,
              fontFamily: BRAND_FONT_FAMILY,
              fontSize: 22,
              fontWeight: 680,
              fontVariantNumeric: "tabular-nums"
            }}
          >
            04:28
          </span>
          <span style={{color: MIST_GLASS.muted, fontSize: 25, fontWeight: 560}}>
            大模型训练本质上是概率补全，因此难以根除
            <span
              style={{
                padding: "1px 6px",
                borderRadius: 5,
                background: MIST_GLASS.accentSoft,
                color: MIST_GLASS.accent,
                fontWeight: 700
              }}
            >
              幻觉
            </span>
          </span>
        </div>
      </div>
    </div>
  );
};

const SubtitleVoiceOverlay = ({duration}: {duration: number}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [62, 70, duration - 10, duration], [0, 1, 1, 0], CLAMP);
  if (opacity <= 0.01) return null;
  return (
    <VoiceWaveBar
      timestamp="04:07"
      quote="“也很难避免幻觉”"
      active={frame >= 62 && frame <= 112}
      style={{left: 88, top: 56, opacity}}
    />
  );
};

const Title = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 4, 52, 60], [0.38, 1, 1, 0], CLAMP);
  if (opacity <= 0.01) return null;
  return <EditorialHeaderBand title="找到那句，回到那一秒。" titleSize={52} delay={0} opacity={opacity} />;
};

export const SubtitleScene = ({duration}: {duration: number}) => (
  <div style={{position: "absolute", inset: 0, overflow: "hidden", background: COLORS.background}}>
    <LectureVideoBackdrop duration={duration} />
    <SubtitleHeroSpotlight />
    <SubtitleVoiceOverlay duration={duration} />
    <Title />
  </div>
);
