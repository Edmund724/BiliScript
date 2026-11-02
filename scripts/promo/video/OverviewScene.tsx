import {Easing, Sequence, interpolate, useCurrentFrame} from "remotion";
import {OVERVIEW_TIMELINE} from "../timeline.mjs";
import {
  BRAND_FONT_FAMILY,
  BottomLectureCaption,
  BrandWhisper,
  COLORS,
  Crop,
  FONT_FAMILY,
  MIST_GLASS,
  PaperGrainOverlay,
  ReadingHeaderActions,
  SceneTitle,
  VideoReferenceCard,
  microPerspective
} from "./design";

const CLAMP = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;
const SMOOTH = Easing.bezier(0.16, 1, 0.3, 1);

const SERIF_FONT_FAMILY =
  'Georgia, "Times New Roman", "Source Han Serif SC", "Noto Serif SC", "Noto Serif CJK SC", "Source Han Serif CN", "LXGW Neo ZhiSong", "Songti SC", "STSong", "SimSun", serif';

const GEMINI_BADGE_BG =
  "linear-gradient(135deg, rgba(66, 133, 244, 0.14) 0%, rgba(155, 114, 203, 0.14) 40%, rgba(217, 101, 112, 0.14) 75%, rgba(242, 166, 64, 0.14) 100%)";

export const OVERVIEW_HEADLINE = "48 分钟公开课，\n3 秒提炼脉络与结论";

export const OVERVIEW_TLDR = {
  lead: "UP 主认为大模型被训练成“必须作答”，只模仿语言规律、不辨事实，幻觉因此无法根除。核心结论：",
  bold: "选 AI 不是越强越好，能和你“接得上、对得齐”的才最好",
  tail: "。"
} as const;

export const OVERVIEW_VIDEO_REFERENCE = {
  headerText: "正在阅读：复旦赵斌《大模型公开课》48:16",
  badgeText: "复旦赵斌 · 48:16 公开课",
  captionTimestamp: "02:32",
  captionQuote: "“如果他不答，一定是零分！”"
};

export const OVERVIEW_CHAPTERS = [
  {
    timestamp: "00:00",
    title: "机器幻觉的成因：评分机制与语言本质",
    summary: "训练机制“答错不扣分、不答得零分”，模型宁可去蒙也不留空。"
  },
  {
    timestamp: "02:32",
    title: "幻觉无法彻底避免：商业价值与数据局限",
    summary: "处处回答“不知道”会丧失价值；仅靠已有数据无法推演无关事实。"
  }
] as const;

export const OVERVIEW_POLAROID_QUOTE = "他只要去答这个题目，\n得的就不是零分；\n但如果他不答，一定是零分！";
export const OVERVIEW_QUOTE_TEXT = "他只要去答这个题目，得的就不是零分；但如果他不答，一定是零分！";
export const OVERVIEW_QUOTE_SOURCE = "复旦赵斌《大模型公开课》";

const RAYS_COUNT = 48;
const RAYS_LINES = Array.from({length: RAYS_COUNT}, (_, i) => {
  const angle = (i * 2 * Math.PI) / RAYS_COUNT;
  return {
    x2: Number((200 + 320 * Math.cos(angle)).toFixed(1)),
    y2: Number((150 + 320 * Math.sin(angle)).toFixed(1))
  };
});

const T = OVERVIEW_TIMELINE;
const SEEK_TARGET_SECONDS = 152;
const VIDEO_TOTAL_SECONDS = 2896;
const PLAYBACK_START_SECONDS = 0;

export const OVERVIEW_QUOTE_START_FRAME = T.quoteStartAt;
export const OVERVIEW_QUOTE_DURATION = T.duration - T.quoteStartAt;

export function overviewQuoteLiftProgress(frame: number): number {
  return interpolate(frame, [T.quoteStartAt, T.quoteStartAt + T.quoteLiftFrames], [0, 1], {
    ...CLAMP,
    easing: SMOOTH
  });
}

export function overviewVoiceCaptionOpacityAtFrame(frame: number, duration = T.duration): number {
  if (frame < T.quoteStartAt) return 0;
  return interpolate(frame, [T.quoteStartAt, T.quoteStartAt + 6, duration - 6, duration], [0, 1, 1, 0], CLAMP);
}

const REFERENCE_CROP: Crop = {x: 56, y: 236, width: 1344, height: 664};
const REFERENCE_WIDTH = 780;

const PANEL_STAGE = {left: 964, top: 150, width: 860};
const POLAROID_STAGE = {left: 1048, top: 396, width: 748, height: 486};
const POLAROID_LIFT = {x: -32, y: 76, scale: 0.76};

const formatClock = (seconds: number) =>
  `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

const PlayerSeekOverlay = () => {
  const frame = useCurrentFrame();
  const seek = interpolate(frame, [T.chapterClickAt, T.chapterClickAt + T.chapterSeekFrames], [0, 1], {
    ...CLAMP,
    easing: SMOOTH
  });
  const flash = interpolate(
    frame,
    [T.chapterClickAt, T.chapterClickAt + 2, T.chapterClickAt + T.chapterSeekFrames],
    [0, 0.5, 0],
    CLAMP
  );
  const clickClock = PLAYBACK_START_SECONDS + T.chapterClickAt / 30;
  const seconds =
    frame < T.chapterClickAt
      ? PLAYBACK_START_SECONDS + frame / 30
      : clickClock + (SEEK_TARGET_SECONDS - clickClock) * seek + Math.max(0, frame - T.chapterClickAt - T.chapterSeekFrames) / 30;
  const ratio = seconds / VIDEO_TOTAL_SECONDS;
  const pillPop = interpolate(frame, [T.chapterClickAt, T.chapterClickAt + 4, T.chapterClickAt + 12], [1, 1.14, 1], CLAMP);

  return (
    <>
      <div style={{position: "absolute", inset: 0, background: "#FFFFFF", opacity: flash, pointerEvents: "none"}} />
      <div
        style={{
          position: "absolute",
          right: 18,
          top: 18,
          padding: "7px 16px",
          borderRadius: 999,
          background: "rgba(15, 23, 42, 0.76)",
          color: "#FFFFFF",
          fontFamily: BRAND_FONT_FAMILY,
          fontSize: 20,
          fontWeight: 700,
          fontVariantNumeric: "tabular-nums",
          scale: pillPop,
          transformOrigin: "100% 0%"
        }}
      >
        {formatClock(seconds)} / 48:16
      </div>
      <div style={{position: "absolute", left: 0, right: 0, bottom: 0, height: 6, background: "rgba(255, 255, 255, 0.28)"}}>
        <div style={{width: `${(ratio * 100).toFixed(2)}%`, height: "100%", background: "#FF709A"}} />
      </div>
    </>
  );
};

const VideoReference = ({duration}: {duration: number}) => {
  const frame = useCurrentFrame();
  const captionOpacity = overviewVoiceCaptionOpacityAtFrame(frame, duration);
  const quoteStart = T.quoteStartAt;

  return (
    <VideoReferenceCard
      source="subtitle-seek-03.mp4"
      crop={REFERENCE_CROP}
      width={REFERENCE_WIDTH}
      height={Math.round((REFERENCE_CROP.height * REFERENCE_WIDTH) / REFERENCE_CROP.width)}
      startFrom={84}
      playbackRate={0.2}
      headerText={OVERVIEW_VIDEO_REFERENCE.headerText}
      badgeText={OVERVIEW_VIDEO_REFERENCE.badgeText}
      tilt={-6}
      delay={2}
      style={{position: "absolute", left: 96, top: 388}}
    >
      <PlayerSeekOverlay />
      {captionOpacity > 0.01 && (
        <BottomLectureCaption
          timestamp={OVERVIEW_VIDEO_REFERENCE.captionTimestamp}
          speaker="赵老师原声"
          quote={OVERVIEW_VIDEO_REFERENCE.captionQuote}
          active={frame >= quoteStart + 2 && frame <= quoteStart + 47}
          from={quoteStart}
          style={{
            bottom: 16,
            padding: "10px 24px 10px 16px",
            scale: 0.72,
            transformOrigin: "50% 100%",
            opacity: captionOpacity
          }}
        />
      )}
    </VideoReferenceCard>
  );
};

const OverviewSpotlightCard = () => {
  const frame = useCurrentFrame();
  const enter = interpolate(frame, [0, 12], [0, 1], {...CLAMP, easing: SMOOTH});
  const enterY = interpolate(frame, [0, 12], [22, 0], {...CLAMP, easing: SMOOTH});
  const quoteDefocus = interpolate(frame, [T.quoteStartAt, T.quoteStartAt + 16], [0, 2.6], {...CLAMP, easing: SMOOTH});
  const quoteDimOpacity = interpolate(frame, [T.quoteStartAt, T.quoteStartAt + 16], [1, 0.68], {...CLAMP, easing: SMOOTH});
  const quoteBackScale = interpolate(frame, [T.quoteStartAt, T.quoteStartAt + 16], [1, 0.965], {...CLAMP, easing: SMOOTH});
  const quoteRetreatY = interpolate(frame, [T.quoteStartAt, T.quoteStartAt + 16], [0, -76], {...CLAMP, easing: SMOOTH});

  const cursorMoveStart = T.quoteClickAt - 18;
  const cursorOpacity =
    interpolate(frame, [cursorMoveStart, cursorMoveStart + 5], [0, 1], CLAMP) *
    interpolate(frame, [T.quoteStartAt + 1, T.quoteStartAt + 6], [1, 0], CLAMP);
  const cursorX = interpolate(frame, [cursorMoveStart, T.quoteClickAt], [76, 16], {...CLAMP, easing: SMOOTH});
  const cursorY = interpolate(frame, [cursorMoveStart, T.quoteClickAt], [48, 18], {...CLAMP, easing: SMOOTH});
  const isShareHovered = frame >= cursorMoveStart + 8;
  const isQuoteClicked = frame >= T.quoteClickAt;
  const buttonPress = interpolate(
    frame,
    [T.quoteClickAt - 1, T.quoteClickAt + 1, T.quoteClickAt + 5],
    [1, 0.91, 1],
    CLAMP
  );
  const rippleOpacity = interpolate(
    frame,
    [T.quoteClickAt - 1, T.quoteClickAt + 1, T.quoteStartAt + 4],
    [0, 0.78, 0],
    CLAMP
  );
  const rippleScale = interpolate(frame, [T.quoteClickAt - 1, T.quoteStartAt + 4], [0.5, 1.9], {
    ...CLAMP,
    easing: SMOOTH
  });

  const tldrTotal = OVERVIEW_TLDR.lead.length + OVERVIEW_TLDR.bold.length + OVERVIEW_TLDR.tail.length;
  const tldrRevealed = Math.round(interpolate(frame, [T.tldrAt, T.tldrAt + 34], [0, tldrTotal], CLAMP));
  const tldrLead = OVERVIEW_TLDR.lead.slice(0, tldrRevealed);
  const tldrBold = OVERVIEW_TLDR.bold.slice(0, Math.max(0, tldrRevealed - OVERVIEW_TLDR.lead.length));
  const tldrTail = OVERVIEW_TLDR.tail.slice(0, Math.max(0, tldrRevealed - OVERVIEW_TLDR.lead.length - OVERVIEW_TLDR.bold.length));

  const quoteCardEnter = interpolate(frame, [T.quoteCardAt, T.quoteCardAt + 12], [0, 1], {...CLAMP, easing: SMOOTH});
  const quoteCardLift = interpolate(frame, [T.quoteCardAt, T.quoteCardAt + 12], [14, 0], {...CLAMP, easing: SMOOTH});

  const chapterCursorStart = T.chapterClickAt - 18;
  const chapterCursorOpacity =
    interpolate(frame, [chapterCursorStart, chapterCursorStart + 5], [0, 1], CLAMP) *
    interpolate(frame, [T.chapterClickAt + 8, T.chapterClickAt + 13], [1, 0], CLAMP);
  const chapterCursorX = interpolate(frame, [chapterCursorStart, T.chapterClickAt], [150, 40], {...CLAMP, easing: SMOOTH});
  const chapterCursorY = interpolate(frame, [chapterCursorStart, T.chapterClickAt], [96, 20], {...CLAMP, easing: SMOOTH});
  const chapterPress = interpolate(frame, [T.chapterClickAt - 1, T.chapterClickAt + 1, T.chapterClickAt + 5], [1, 0.91, 1], CLAMP);
  const chapterRippleOpacity = interpolate(frame, [T.chapterClickAt - 1, T.chapterClickAt + 1, T.chapterClickAt + 12], [0, 0.78, 0], CLAMP);
  const chapterRippleScale = interpolate(frame, [T.chapterClickAt - 1, T.chapterClickAt + 12], [0.5, 1.9], {...CLAMP, easing: SMOOTH});

  return (
    <div
      style={{
        position: "absolute",
        left: PANEL_STAGE.left,
        top: PANEL_STAGE.top,
        width: PANEL_STAGE.width,
        opacity: enter * quoteDimOpacity,
        translate: `0px ${(enterY + quoteRetreatY).toFixed(1)}px`,
        scale: undefined,
        filter: quoteDefocus > 0.05 ? `blur(${quoteDefocus.toFixed(2)}px)` : undefined,
        transformOrigin: "50% 50%",
        zIndex: 8
      }}
    >
      <div
        style={{
          position: "relative",
          borderRadius: 28,
          background: MIST_GLASS.surface,
          backdropFilter: "blur(24px) saturate(1.2)",
          WebkitBackdropFilter: "blur(24px) saturate(1.2)",
          boxShadow: MIST_GLASS.shellShadow,
          padding: "20px 28px 24px",
          fontFamily: FONT_FAMILY,
          transform: microPerspective(-7, quoteBackScale),
          transformOrigin: "50% 50%",
          color: MIST_GLASS.text
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 28,
            overflow: "hidden",
            pointerEvents: "none"
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: MIST_GLASS.blobs,
              filter: "blur(28px)"
            }}
          />
        </div>

        {/* .biliscript-reading-header */}
        <div
          style={{
            position: "relative",
            zIndex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12
          }}
        >
          <span style={{fontSize: 18, fontWeight: 620, color: MIST_GLASS.muted}}>UP主：复旦赵斌</span>
          <ReadingHeaderActions iconSize={19} />
        </div>

        {/* .biliscript-reading-tabs-row */}
        <div
          style={{
            position: "relative",
            zIndex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 16
          }}
        >
          <div
            style={{
              display: "inline-grid",
              gridAutoFlow: "column",
              gridAutoColumns: "1fr",
              gap: 8,
              padding: 4,
              width: 440
            }}
          >
            {["字幕", "概览", "AI 对话"].map((tab, index) => (
              <div
                key={tab}
                style={{
                  padding: "8px 18px",
                  borderRadius: 16,
                  background: index === 1 ? MIST_GLASS.cardElevated : "transparent",
                  boxShadow: index === 1 ? MIST_GLASS.tabActiveShadow : "none",
                  color: index === 1 ? MIST_GLASS.accent : MIST_GLASS.muted,
                  fontSize: 19,
                  fontWeight: index === 1 ? 720 : 600,
                  textAlign: "center"
                }}
              >
                {tab}
              </div>
            ))}
          </div>
        </div>

        {/* .biliscript-reading-ov-section: 简介 */}
        <div style={{position: "relative", zIndex: 1, marginBottom: 14}}>
          <div style={{display: "flex", alignItems: "center", gap: 10, marginBottom: 8}}>
            <span style={{fontSize: 20, fontWeight: 740, letterSpacing: "0.04em", color: MIST_GLASS.text}}>简介</span>
          </div>
          <div style={{fontSize: 20, lineHeight: 1.6, color: MIST_GLASS.text, letterSpacing: -0.1, minHeight: 96}}>
            <span>{tldrLead}</span>
            {tldrBold ? <strong style={{fontWeight: 740}}>{tldrBold}</strong> : null}
            <span>{tldrTail}</span>
          </div>
        </div>

        {/* .biliscript-reading-ov-section: 章节 */}
        <div style={{position: "relative", zIndex: 1, marginBottom: 14}}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 10
            }}
          >
            <span style={{fontSize: 20, fontWeight: 740, letterSpacing: "0.04em", color: MIST_GLASS.text}}>章节</span>
            <span
              style={{
                padding: "2px 10px",
                borderRadius: 999,
                background: GEMINI_BADGE_BG,
                boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.75)",
                color: MIST_GLASS.accent,
                fontSize: 15,
                fontWeight: 660
              }}
            >
              AI 生成
            </span>
          </div>

          <div style={{display: "flex", flexDirection: "column", gap: 12}}>
            {OVERVIEW_CHAPTERS.map((chapter, index) => {
              const cardStart = T.chaptersAt + index * 5;
              const isSeekTarget = index === OVERVIEW_CHAPTERS.length - 1;
              const isChapterClicked = isSeekTarget && frame >= T.chapterClickAt;
              const cardEnter = interpolate(frame, [cardStart, cardStart + 12], [0, 1], {...CLAMP, easing: SMOOTH});
              const cardLift = interpolate(frame, [cardStart, cardStart + 12], [14, 0], {...CLAMP, easing: SMOOTH});

              return (
                <div
                  key={chapter.timestamp}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "auto minmax(0, 1fr)",
                    gap: 14,
                    alignItems: "start",
                    padding: "14px 18px",
                    borderRadius: 24,
                    position: "relative",
                    background: MIST_GLASS.cardElevated,
                    boxShadow: isChapterClicked ? `0 0 0 2px ${MIST_GLASS.accent}, ${MIST_GLASS.cardShadow}` : MIST_GLASS.cardShadow,
                    opacity: cardEnter,
                    translate: `0px ${cardLift.toFixed(1)}px`
                  }}
                >
                  <span
                    style={{
                      position: "relative",
                      padding: "3px 11px",
                      borderRadius: 999,
                      background: isChapterClicked ? MIST_GLASS.accent : MIST_GLASS.timeBg,
                      color: isChapterClicked ? "#FFFFFF" : MIST_GLASS.timeColor,
                      scale: isSeekTarget ? chapterPress : 1,
                      fontFamily: BRAND_FONT_FAMILY,
                      fontSize: 17,
                      fontWeight: 700,
                      lineHeight: 1.5,
                      fontVariantNumeric: "tabular-nums",
                      flexShrink: 0
                    }}
                  >
                    {isSeekTarget ? (
                      <span
                        style={{
                          position: "absolute",
                          inset: -8,
                          borderRadius: 999,
                          background: "rgba(0, 140, 255, 0.24)",
                          opacity: chapterRippleOpacity,
                          scale: chapterRippleScale,
                          pointerEvents: "none"
                        }}
                      />
                    ) : null}
                    {chapter.timestamp}
                    {isSeekTarget && chapterCursorOpacity > 0.01 ? (
                      <svg
                        viewBox="0 0 30 38"
                        style={{
                          position: "absolute",
                          left: 0,
                          top: 0,
                          width: 32,
                          height: 40,
                          filter: "drop-shadow(0 6px 12px rgba(17, 24, 39, 0.32))",
                          opacity: chapterCursorOpacity,
                          translate: `${chapterCursorX.toFixed(1)}px ${chapterCursorY.toFixed(1)}px`,
                          scale: chapterPress,
                          pointerEvents: "none",
                          zIndex: 10
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
                    ) : null}
                  </span>
                  <div style={{display: "grid", gap: 4, minWidth: 0}}>
                    <span
                      style={{
                        color: MIST_GLASS.text,
                        fontSize: 21,
                        fontWeight: 680,
                        lineHeight: 1.35,
                        letterSpacing: -0.3
                      }}
                    >
                      {chapter.title}
                    </span>
                    <span
                      style={{
                        color: MIST_GLASS.muted,
                        fontSize: 17,
                        fontWeight: 520,
                        lineHeight: 1.48,
                        letterSpacing: -0.1
                      }}
                    >
                      {chapter.summary}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* .biliscript-reading-ov-section: 金句 */}
        <div
          style={{
            position: "relative",
            zIndex: 1,
            opacity: quoteCardEnter,
            translate: `0px ${quoteCardLift.toFixed(1)}px`
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 10
            }}
          >
            <span style={{fontSize: 20, fontWeight: 740, letterSpacing: "0.04em", color: MIST_GLASS.text}}>金句</span>
            <span
              style={{
                padding: "2px 10px",
                borderRadius: 999,
                background: GEMINI_BADGE_BG,
                boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.75)",
                color: MIST_GLASS.accent,
                fontSize: 15,
                fontWeight: 660
              }}
            >
              AI 精选
            </span>
          </div>

          {/* .biliscript-reading-ov-quote */}
          <div
            style={{
              position: "relative",
              padding: "16px 20px 12px",
              borderRadius: 24,
              background: MIST_GLASS.cardElevated,
              boxShadow: isShareHovered
                ? "0 2px 5px rgba(23, 24, 26, 0.09), 0 6px 16px rgba(23, 24, 26, 0.09), inset 0 1px 0 rgba(255, 255, 255, 0.82)"
                : MIST_GLASS.cardShadow
            }}
          >
            {/* 右上角装饰水印引号 .biliscript-reading-ov-quote::after */}
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                top: 4,
                right: 12,
                fontFamily: 'Georgia, "Times New Roman", serif',
                fontSize: 44,
                lineHeight: 1,
                color: "rgba(23, 24, 26, 0.09)",
                pointerEvents: "none",
                userSelect: "none",
                zIndex: 0
              }}
            >
              ”
            </span>

            {/* .biliscript-reading-ov-quote-text（包「」直角引号） */}
            <div
              style={{
                position: "relative",
                zIndex: 1,
                fontFamily: SERIF_FONT_FAMILY,
                fontVariantNumeric: "lining-nums",
                fontSize: 21,
                lineHeight: 1.62,
                color: MIST_GLASS.text
              }}
            >
              「{OVERVIEW_QUOTE_TEXT}」
            </div>

            {/* .biliscript-reading-ov-quote-foot */}
            <div
              style={{
                position: "relative",
                zIndex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginTop: 8
              }}
            >
              {/* .biliscript-reading-ov-quote-seek */}
              <div style={{display: "inline-flex", alignItems: "center", gap: 8}}>
                <span style={{display: "inline-flex", color: MIST_GLASS.accent}}>
                  <svg viewBox="0 0 24 24" width={18} height={18} fill="currentColor" aria-hidden="true">
                    <path d="M8.8 5.5v13l11-6.5z" />
                  </svg>
                </span>
                <span
                  style={{
                    padding: "2px 10px",
                    borderRadius: 999,
                    background: MIST_GLASS.timeBg,
                    color: MIST_GLASS.timeColor,
                    fontFamily: BRAND_FONT_FAMILY,
                    fontSize: 17,
                    fontWeight: 700,
                    lineHeight: 1.5,
                    fontVariantNumeric: "tabular-nums"
                  }}
                >
                  02:32
                </span>
              </div>

              {/* .biliscript-reading-ov-quote-actions */}
              <div style={{display: "inline-flex", alignItems: "center", gap: 4}}>
                <div
                  role="button"
                  aria-label="分享金句卡片"
                  title="分享金句卡片"
                  style={{
                    position: "relative",
                    width: 36,
                    height: 36,
                    borderRadius: 14,
                    background: isShareHovered
                      ? isQuoteClicked
                        ? MIST_GLASS.accentSoft
                        : "rgba(23, 24, 26, 0.06)"
                      : "transparent",
                    color: isShareHovered ? MIST_GLASS.accent : MIST_GLASS.muted,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    scale: buttonPress
                  }}
                >
                  <div
                    style={{
                      position: "absolute",
                      inset: -8,
                      borderRadius: 999,
                      background: "rgba(0, 140, 255, 0.24)",
                      opacity: rippleOpacity,
                      scale: rippleScale,
                      pointerEvents: "none"
                    }}
                  />
                  <svg
                    viewBox="0 0 24 24"
                    width={18}
                    height={18}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.8}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="18" cy="5" r="3" />
                    <circle cx="6" cy="12" r="3" />
                    <circle cx="18" cy="19" r="3" />
                    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                    <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                  </svg>
                  {cursorOpacity > 0.01 && (
                    <svg
                      viewBox="0 0 30 38"
                      style={{
                        position: "absolute",
                        left: 0,
                        top: 0,
                        width: 32,
                        height: 40,
                        filter: "drop-shadow(0 6px 12px rgba(17, 24, 39, 0.32))",
                        opacity: cursorOpacity,
                        translate: `${cursorX.toFixed(1)}px ${cursorY.toFixed(1)}px`,
                        scale: buttonPress,
                        pointerEvents: "none",
                        zIndex: 10
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
                  role="button"
                  aria-label="复制该金句"
                  title="复制该金句"
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 14,
                    background: "transparent",
                    color: MIST_GLASS.muted,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center"
                  }}
                >
                  <svg
                    viewBox="0 0 24 24"
                    width={18}
                    height={18}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.8}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="9" y="9" width="10" height="10" rx="2" />
                    <path d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1" />
                  </svg>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const QuotePolaroid = () => {
  const frame = useCurrentFrame();
  const lift = interpolate(frame, [0, T.quoteLiftFrames], [0, 1], {
    ...CLAMP,
    easing: SMOOTH
  });
  const translateX = interpolate(lift, [0, 1], [POLAROID_LIFT.x, 0]);
  const translateY = interpolate(lift, [0, 1], [POLAROID_LIFT.y, 0]);
  const scale = interpolate(lift, [0, 1], [POLAROID_LIFT.scale, 1]);
  const cardOpacity = interpolate(frame, [0, 6], [0, 1], {...CLAMP, easing: SMOOTH});
  const rotateX = interpolate(lift, [0, 1], [0, 4]);
  const rotateY = interpolate(lift, [0, 1], [0, -8]);
  const rotateZ = interpolate(lift, [0, 1], [0, -1.2]);
  const sheenX = interpolate(lift, [0.08, 0.78], [-24, 122], CLAMP);
  const sheenOpacity = interpolate(lift, [0.06, 0.34, 0.82], [0, 0.56, 0], CLAMP);
  const shadowSpread = interpolate(lift, [0, 1], [0.3, 0.52]);
  const springParallaxX = interpolate(lift, [0, 1], [-8, 6]);
  const springParallaxY = interpolate(lift, [0, 1], [6, -4]);

  return (
    <div
      data-quote-start={T.quoteStartAt}
      data-preset="mist-deep-sea"
      data-pattern="rays"
      style={{
        position: "absolute",
        left: POLAROID_STAGE.left,
        top: POLAROID_STAGE.top,
        width: POLAROID_STAGE.width,
        height: POLAROID_STAGE.height,
        opacity: cardOpacity,
        transformOrigin: "50% 84%",
        transform: `translate(${translateX.toFixed(1)}px, ${translateY.toFixed(1)}px) scale(${scale.toFixed(3)}) perspective(1600px) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg) rotateZ(${rotateZ.toFixed(2)}deg)`,
        zIndex: 20
      }}
    >
      {/* .biliscript-quote-card[data-preset="mist-deep-sea"][data-pattern="rays"] */}
      <div
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          borderRadius: 32,
          overflow: "hidden",
          boxShadow: `inset 0 0 0 1px rgba(255, 255, 255, 0.16), inset 0 0 0 0.5px rgba(0, 0, 0, 0.12), -34px 54px 110px -24px rgba(15, 23, 42, ${shadowSpread.toFixed(2)}), -10px 18px 44px -16px rgba(15, 23, 42, 0.28)`
        }}
      >
        {/* .biliscript-quote-card-bg (mist-deep-sea) */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "linear-gradient(165deg, #c6d6df 0%, #4b8393 45%, #0b3544 100%)"
          }}
        >
          {/* .biliscript-quote-card-blobs-layer */}
          <div
            style={{
              position: "absolute",
              inset: -24,
              transform: `translate(${springParallaxX.toFixed(1)}px, ${springParallaxY.toFixed(1)}px)`,
              backgroundImage: [
                "radial-gradient(circle at 18% 18%, rgba(191, 212, 222, 0.75) 0%, transparent 55%)",
                "radial-gradient(circle at 82% 20%, rgba(167, 196, 212, 0.72) 0%, transparent 50%)",
                "radial-gradient(circle at 20% 82%, rgba(51, 123, 129, 0.72) 0%, transparent 55%)",
                "radial-gradient(circle at 82% 80%, rgba(16, 63, 81, 0.86) 0%, transparent 50%)"
              ].join(", ")
            }}
          />

          {/* .biliscript-quote-card-pattern (rays + radial center mask) */}
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: -18,
              opacity: 0.38,
              pointerEvents: "none",
              overflow: "hidden",
              transform: `translate(${(-springParallaxX * 0.7).toFixed(1)}px, ${(-springParallaxY * 0.7).toFixed(1)}px)`,
              WebkitMaskImage:
                "radial-gradient(circle at 50% 50%, transparent 0%, transparent 45%, rgba(0, 0, 0, 0.4) 75%, #000000 100%)",
              maskImage:
                "radial-gradient(circle at 50% 50%, transparent 0%, transparent 45%, rgba(0, 0, 0, 0.4) 75%, #000000 100%)"
            }}
          >
            <svg
              viewBox="0 0 400 300"
              fill="none"
              stroke="#ffffff"
              strokeWidth="0.8"
              preserveAspectRatio="xMidYMid slice"
              style={{display: "block", width: "100%", height: "100%"}}
            >
              {RAYS_LINES.map((line, idx) => (
                <line key={idx} x1="200" y1="150" x2={line.x2} y2={line.y2} vectorEffect="non-scaling-stroke" />
              ))}
            </svg>
          </div>

          {/* .biliscript-quote-card-noise */}
          <PaperGrainOverlay opacity={0.08} borderRadius={32} />

          {sheenOpacity > 0.01 && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: `linear-gradient(112deg, rgba(255, 255, 255, 0) ${sheenX - 26}%, rgba(255, 255, 255, 0.56) ${sheenX}%, rgba(198, 232, 255, 0.24) ${sheenX + 10}%, rgba(255, 255, 255, 0) ${sheenX + 28}%)`,
                opacity: sheenOpacity,
                pointerEvents: "none"
              }}
            />
          )}
        </div>

        {/* .biliscript-quote-card-content */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 2,
            display: "flex",
            alignItems: "center",
            padding: "56px 64px",
            boxSizing: "border-box",
            color: "#FFFFFF",
            textShadow: "0 1px 3px rgba(0, 0, 0, 0.35)"
          }}
        >
          {/* .biliscript-quote-card-quote-mark */}
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              top: 40,
              left: 64,
              fontFamily: 'Georgia, "Times New Roman", serif',
              fontSize: 60,
              lineHeight: 1,
              opacity: 0.6
            }}
          >
            “
          </div>

          {/* .biliscript-quote-card-text */}
          <p
            style={{
              margin: 0,
              maxWidth: "100%",
              fontFamily: SERIF_FONT_FAMILY,
              fontVariantNumeric: "lining-nums",
              fontSize: 34,
              fontWeight: 400,
              lineHeight: 1.78,
              letterSpacing: "0.025em",
              textAlign: "left",
              whiteSpace: "pre-line"
            }}
          >
            {OVERVIEW_POLAROID_QUOTE}
          </p>

          {/* .biliscript-quote-card-footer */}
          <footer
            style={{
              position: "absolute",
              right: 64,
              bottom: 38,
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              fontFamily: FONT_FAMILY,
              fontSize: 20,
              fontWeight: 520,
              opacity: 0.75,
              letterSpacing: "0.04em",
              textAlign: "right"
            }}
          >
            <span>{OVERVIEW_QUOTE_SOURCE}</span>
          </footer>
        </div>
      </div>
    </div>
  );
};

export const OverviewScene = ({duration}: {duration: number}) => (
  <>
    <BrandWhisper />
    <SceneTitle title={OVERVIEW_HEADLINE} size={66} style={{left: 96, top: 186, width: 848}} />
    <VideoReference duration={duration} />
    <div style={{position: "absolute", inset: 0}}>
      <OverviewSpotlightCard />
      <Sequence from={T.quoteStartAt} durationInFrames={duration - T.quoteStartAt}>
        <QuotePolaroid />
      </Sequence>
    </div>
  </>
);
