import {Easing, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame} from "remotion";
import {
  SUBTITLE_DURATION,
  SUBTITLE_MATCH_FRAME,
  SUBTITLE_PLAYBACK_RATE,
  SUBTITLE_SECOND_SHOT_SOURCE_FRAME
} from "../subtitle-timeline.mjs";
import {BottomLectureCaption, BRAND_FONT_FAMILY, COLORS, EditorialHeaderBand, FONT_FAMILY, MIST_GLASS} from "./design";

const SOURCE = "subtitle-seek-03.mp4";
const CLAMP = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;
const SMOOTH = Easing.bezier(0.16, 1, 0.3, 1);

export const SUBTITLE_HEADLINE = "记得 UP 主提过那句话？搜词秒跳那一秒。";
export const SUBTITLE_SEARCH_QUERY = "幻觉";

export const SUBTITLE_MATCHED_ROWS = [
  {
    timestamp: "04:07",
    prefix: "……也很难避免",
    keyword: SUBTITLE_SEARCH_QUERY
  }
] as const;

export const SUBTITLE_BOTTOM_CAPTION = {
  timestamp: "04:07",
  speaker: "赵老师原声",
  quote: "“……也很难避免幻觉。”"
} as const;

export function subtitleTypedQueryAtFrame(frame: number): string {
  if (frame < 12) return "";
  if (frame < 16) return "幻";
  return SUBTITLE_SEARCH_QUERY;
}

export function subtitleHeadlineOpacityAtFrame(frame: number, duration = SUBTITLE_DURATION): number {
  return interpolate(frame, [0, 4, duration - 5, duration], [0.85, 1, 1, 0], CLAMP);
}

export function subtitleBottomCaptionOpacityAtFrame(frame: number, duration = SUBTITLE_DURATION): number {
  if (frame <= SUBTITLE_MATCH_FRAME) return 0;
  return interpolate(frame, [SUBTITLE_MATCH_FRAME + 1, SUBTITLE_MATCH_FRAME + 6, duration - 5, duration], [0, 1, 1, 0], CLAMP);
}

const PLAYER_STAGE_TRANSFORM = {
  scale: 1.35,
  x: 101.4,
  y: -206.85
};

const LectureVideoBackdrop = ({duration}: {duration: number}) => {
  const frame = useCurrentFrame();
  const dimOpacity = interpolate(frame, [SUBTITLE_MATCH_FRAME - 1, SUBTITLE_MATCH_FRAME + 7], [1, 0], {
    ...CLAMP,
    easing: SMOOTH
  });
  const seekScale = interpolate(
    frame,
    [SUBTITLE_MATCH_FRAME, SUBTITLE_MATCH_FRAME + 2, SUBTITLE_MATCH_FRAME + 10, duration],
    [PLAYER_STAGE_TRANSFORM.scale * 1.055, PLAYER_STAGE_TRANSFORM.scale * 0.994, PLAYER_STAGE_TRANSFORM.scale, PLAYER_STAGE_TRANSFORM.scale],
    {...CLAMP, easing: SMOOTH}
  );
  const activeScale = frame >= SUBTITLE_MATCH_FRAME ? seekScale : PLAYER_STAGE_TRANSFORM.scale;
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
    style: {
      position: "absolute",
      left: PLAYER_STAGE_TRANSFORM.x,
      top: PLAYER_STAGE_TRANSFORM.y,
      width: 1920 * activeScale,
      height: 1080 * activeScale,
      maxWidth: "none"
    } as const
  };

  return (
    <div style={{position: "absolute", inset: 0, overflow: "hidden"}}>
      <div style={{position: "absolute", inset: 0}}>
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

const KEYWORD_SLICES = [
  {clip: "inset(0% 0% 64% 0%)", offset: -6},
  {clip: "inset(33% 0% 33% 0%)", offset: 7},
  {clip: "inset(64% 0% 0% 0%)", offset: -4}
] as const;

const SubtitleKeywordSlice = () => {
  const frame = useCurrentFrame();
  if (frame >= 12) return null;

  const sliceSpread = interpolate(frame, [0, 8], [1, 0], {...CLAMP, easing: SMOOTH});
  const dockProgress = interpolate(frame, [6, 11], [0, 1], {...CLAMP, easing: SMOOTH});
  const opacity = interpolate(frame, [0, 2, 9.5, 11.8], [0.9, 1, 1, 0], CLAMP);
  const pillChromeOpacity = interpolate(frame, [6, 10.5], [1, 0], CLAMP);
  const x = interpolate(dockProgress, [0, 1], [960, 824]);
  const y = interpolate(dockProgress, [0, 1], [222, 363]);
  const scale = interpolate(dockProgress, [0, 1], [1, 0.62]);
  const resolveFlash = interpolate(frame, [6, 8, 11], [0, 1, 0], CLAMP);

  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        transform: `translate(-50%, -50%) scale(${scale.toFixed(3)})`,
        opacity,
        pointerEvents: "none",
        zIndex: 9
      }}
    >
      <div
        style={{
          position: "relative",
          width: 212,
          height: 88,
          borderRadius: 22,
          background: `rgba(255, 255, 255, ${(0.94 * pillChromeOpacity).toFixed(2)})`,
          boxShadow:
            pillChromeOpacity > 0.05
              ? `0 20px 44px -12px rgba(0, 140, 255, ${((0.24 + resolveFlash * 0.22) * pillChromeOpacity).toFixed(2)}), 0 0 0 2px rgba(0, 140, 255, ${((0.32 + resolveFlash * 0.4) * pillChromeOpacity).toFixed(2)})`
              : "none"
        }}
      >
        {KEYWORD_SLICES.map((slice, index) => (
          <div
            key={index}
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              clipPath: slice.clip,
              transform: `translateX(${(slice.offset * sliceSpread).toFixed(1)}px)`,
              fontFamily: FONT_FAMILY,
              fontSize: 58,
              fontWeight: 860,
              letterSpacing: 4,
              color: MIST_GLASS.accent
            }}
          >
            {SUBTITLE_SEARCH_QUERY}
          </div>
        ))}
        {sliceSpread > 0.02 && (
          <>
            <div
              style={{
                position: "absolute",
                left: 16,
                right: 16,
                top: "35%",
                height: 2,
                background: "linear-gradient(90deg, transparent, rgba(0, 140, 255, 0.72), transparent)",
                opacity: sliceSpread
              }}
            />
            <div
              style={{
                position: "absolute",
                left: 16,
                right: 16,
                top: "65%",
                height: 2,
                background: "linear-gradient(90deg, transparent, rgba(232, 93, 135, 0.68), transparent)",
                opacity: sliceSpread
              }}
            />
          </>
        )}
      </div>
    </div>
  );
};

const SubtitleHeroSpotlight = () => {
  const frame = useCurrentFrame();
  if (frame > 68) return null;

  const enter = interpolate(frame, [0, 8], [0.76, 1], {...CLAMP, easing: SMOOTH});
  const exit = interpolate(frame, [SUBTITLE_MATCH_FRAME, SUBTITLE_MATCH_FRAME + 6], [1, 0], {...CLAMP, easing: SMOOTH});
  const opacity = enter * exit;
  const cardScale =
    interpolate(frame, [0, 8], [0.97, 1], {...CLAMP, easing: SMOOTH}) *
    interpolate(frame, [SUBTITLE_MATCH_FRAME, SUBTITLE_MATCH_FRAME + 6], [1, 1.04], {...CLAMP, easing: SMOOTH});
  const cardY = interpolate(frame, [0, 8], [16, 0], {...CLAMP, easing: SMOOTH});

  const typedQuery = subtitleTypedQueryAtFrame(frame);
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
  const cursorX = interpolate(frame, [38, 56], [420, 56], {...CLAMP, easing: SMOOTH});
  const cursorY = interpolate(frame, [38, 56], [130, 30], {...CLAMP, easing: SMOOTH});
  const rippleOpacity = interpolate(frame, [SUBTITLE_MATCH_FRAME - 2, SUBTITLE_MATCH_FRAME, SUBTITLE_MATCH_FRAME + 6], [0, 0.9, 0], CLAMP);
  const rippleScale = interpolate(frame, [SUBTITLE_MATCH_FRAME - 2, SUBTITLE_MATCH_FRAME + 6], [0.55, 1.75], {...CLAMP, easing: SMOOTH});

  const matchedRow = SUBTITLE_MATCHED_ROWS[0];

  return (
    <div
      style={{
        position: "absolute",
        left: 340,
        top: 292,
        width: 1240,
        borderRadius: 32,
        overflow: "hidden",
        background: MIST_GLASS.surface,
        backdropFilter: "blur(24px) saturate(1.2)",
        WebkitBackdropFilter: "blur(24px) saturate(1.2)",
        boxShadow: MIST_GLASS.shellShadow,
        padding: "32px 40px 36px",
        fontFamily: FONT_FAMILY,
        opacity,
        transform: `perspective(1800px) rotateY(-1.2deg) rotateX(1deg) translateY(${cardY}px) scale(${cardScale})`,
        transformOrigin: "50% 50%"
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: MIST_GLASS.blobs,
          filter: "blur(28px)",
          pointerEvents: "none"
        }}
      />

      <div style={{position: "relative", zIndex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 22, marginBottom: 24}}>
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
                padding: "10px 22px",
                borderRadius: 10,
                background: index === 0 ? MIST_GLASS.cardElevated : "transparent",
                boxShadow: index === 0 ? MIST_GLASS.tabActiveShadow : "none",
                color: index === 0 ? MIST_GLASS.accent : MIST_GLASS.muted,
                fontSize: 21,
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
            height: 78,
            padding: "0 28px",
            borderRadius: 20,
            background: MIST_GLASS.cardElevated,
            boxShadow: `${MIST_GLASS.cardShadow}, 0 0 0 2px rgba(0, 140, 255, 0.22)`
          }}
        >
          <div style={{display: "flex", alignItems: "center", gap: 16}}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
              <circle cx="11" cy="11" r="7" stroke={MIST_GLASS.accent} strokeWidth="2.5" />
              <path d="M16.5 16.5L21 21" stroke={MIST_GLASS.accent} strokeWidth="2.5" strokeLinecap="round" />
            </svg>
            <span
              style={{
                color: typedQuery ? MIST_GLASS.text : MIST_GLASS.faint,
                opacity: typedQuery ? 1 : interpolate(frame, [6, 10], [0.85, 0], CLAMP),
                fontSize: 38,
                fontWeight: 760,
                letterSpacing: -0.8
              }}
            >
              {typedQuery || "搜索字幕…"}
            </span>
            <span
              style={{
                width: 3,
                height: 36,
                borderRadius: 2,
                background: MIST_GLASS.accent,
                opacity: frame % 16 < 10 ? 0.9 : 0.2
              }}
            />
          </div>
        </div>
      </div>

      <div
        style={{
          position: "relative",
          zIndex: 1,
          opacity: resultsProgress,
          transform: `translateY(${(1 - resultsProgress) * 14}px)`
        }}
      >
        <div
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            gap: 32,
            padding: "30px 36px",
            borderRadius: 24,
            background: isClicked
              ? "linear-gradient(165deg, rgba(242, 249, 255, 0.98) 0%, rgba(255, 255, 255, 0.94) 55%, rgba(235, 246, 255, 0.96) 100%)"
              : MIST_GLASS.cardElevated,
            boxShadow: isClicked
              ? "inset 0 1px 0 0 rgba(255, 255, 255, 0.98), 0 22px 48px -14px rgba(0, 140, 255, 0.28), 0 0 0 2px rgba(0, 140, 255, 0.56)"
              : `inset 0 1px 0 0 rgba(255, 255, 255, 0.96), inset 0 -1px 0 0 rgba(16, 136, 247, 0.12), 0 16px 38px -14px rgba(15, 23, 42, ${0.10 + rowHover * 0.06}), 0 0 0 1.5px rgba(0, 140, 255, ${0.20 + rowHover * 0.24})`,
            scale: rowPress
          }}
        >
          <div style={{position: "relative", display: "flex", alignItems: "center", justifyContent: "center"}}>
            <div
              style={{
                position: "absolute",
                inset: -12,
                borderRadius: 999,
                background: "rgba(0, 140, 255, 0.26)",
                opacity: rippleOpacity,
                scale: rippleScale,
                pointerEvents: "none"
              }}
            />
            <span
              style={{
                padding: "12px 26px",
                borderRadius: 999,
                background: isClicked || rowHover > 0.5 ? MIST_GLASS.accent : MIST_GLASS.timeBg,
                color: isClicked || rowHover > 0.5 ? "#FFFFFF" : MIST_GLASS.timeColor,
                boxShadow: isClicked || rowHover > 0.5 ? "0 12px 28px -6px rgba(0, 140, 255, 0.48)" : "none",
                fontFamily: BRAND_FONT_FAMILY,
                fontSize: 36,
                fontWeight: 800,
                letterSpacing: 0.4,
                fontVariantNumeric: "tabular-nums"
              }}
            >
              {matchedRow.timestamp}
            </span>
            {cursorOpacity > 0.01 && (
              <svg
                viewBox="0 0 30 38"
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: 36,
                  height: 44,
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
              fontSize: 52,
              fontWeight: 780,
              lineHeight: 1.2,
              letterSpacing: -1.4,
              whiteSpace: "nowrap"
            }}
          >
            {matchedRow.prefix}
            <span
              style={{
                display: "inline-block",
                marginLeft: 8,
                padding: "3px 16px 5px",
                borderRadius: 14,
                background: MIST_GLASS.accent,
                color: "#FFFFFF",
                boxShadow: "0 6px 16px rgba(0, 140, 255, 0.30)"
              }}
            >
              {matchedRow.keyword}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

const SubtitleVoiceOverlay = ({duration}: {duration: number}) => {
  const frame = useCurrentFrame();
  const opacity = subtitleBottomCaptionOpacityAtFrame(frame, duration);
  if (opacity <= 0.01) return null;
  return (
    <BottomLectureCaption
      timestamp={SUBTITLE_BOTTOM_CAPTION.timestamp}
      speaker={SUBTITLE_BOTTOM_CAPTION.speaker}
      quote={SUBTITLE_BOTTOM_CAPTION.quote}
      active={frame >= 62 && frame <= 114}
      from={SUBTITLE_MATCH_FRAME + 1}
      style={{opacity}}
    />
  );
};

const Title = ({duration}: {duration: number}) => {
  const frame = useCurrentFrame();
  const opacity = subtitleHeadlineOpacityAtFrame(frame, duration);
  if (opacity <= 0.01) return null;
  return (
    <EditorialHeaderBand
      title={SUBTITLE_HEADLINE}
      titleNode={
        <>
          记得 UP 主提过那句话？<span style={{color: COLORS.pink}}>搜词秒跳那一秒。</span>
        </>
      }
      titleSize={60}
      delay={-12}
      opacity={opacity}
    />
  );
};

export const SubtitleScene = ({duration}: {duration: number}) => (
  <div style={{position: "absolute", inset: 0, overflow: "hidden", background: COLORS.background}}>
    <LectureVideoBackdrop duration={duration} />
    <SubtitleHeroSpotlight />
    <SubtitleKeywordSlice />
    <SubtitleVoiceOverlay duration={duration} />
    <Title duration={duration} />
  </div>
);
