import {Easing, Sequence, interpolate, useCurrentFrame} from "remotion";
import {OVERVIEW_TIMELINE, PANEL_FOCUS_HANDOFFS} from "../timeline.mjs";
import {
  BRAND_FONT_FAMILY,
  BottomLectureCaption,
  BrandWhisper,
  COLORS,
  Crop,
  FONT_FAMILY,
  MIST_GLASS,
  PaperGrainOverlay,
  ReadingLampBeam,
  SceneTitle,
  VideoReferenceCard,
  microPerspective
} from "./design";

const CLAMP = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;
const SMOOTH = Easing.bezier(0.16, 1, 0.3, 1);

const CHAT_HANDOFF = PANEL_FOCUS_HANDOFFS.find((handoff) => handoff.from === "overview")!;

export const OVERVIEW_HEADLINE = "48 分钟长视频，\n3 秒提炼章节脉络与金句。";

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

const CHAPTER_RATIO = OVERVIEW_TIMELINE.chapterRatio;
const SCENE_REFERENCE_DURATION = OVERVIEW_TIMELINE.duration;
const QUOTE_CLICK_FRAME = OVERVIEW_TIMELINE.quoteClickFrame;

export const OVERVIEW_CHAPTER_DURATION = Math.round(SCENE_REFERENCE_DURATION * CHAPTER_RATIO);
export const OVERVIEW_QUOTE_START_FRAME = OVERVIEW_CHAPTER_DURATION;
export const OVERVIEW_QUOTE_DURATION = SCENE_REFERENCE_DURATION - OVERVIEW_CHAPTER_DURATION;

const QUOTE_LIFT_FRAMES = OVERVIEW_TIMELINE.quoteLiftFrames;

export function overviewChapterDuration(duration: number): number {
  return Math.round(duration * CHAPTER_RATIO);
}

export function overviewQuoteDuration(duration: number): number {
  return duration - overviewChapterDuration(duration);
}

export function overviewPhaseAtFrame(frame: number, duration: number): "chapters" | "quote" {
  return frame < overviewChapterDuration(duration) ? "chapters" : "quote";
}

export function overviewQuoteLiftProgress(frame: number): number {
  return interpolate(frame, [OVERVIEW_QUOTE_START_FRAME, OVERVIEW_QUOTE_START_FRAME + QUOTE_LIFT_FRAMES], [0, 1], {
    ...CLAMP,
    easing: SMOOTH
  });
}

export function overviewVoiceCaptionOpacityAtFrame(frame: number, duration = SCENE_REFERENCE_DURATION): number {
  const quoteStart = overviewChapterDuration(duration);
  if (frame < quoteStart) return 0;
  return interpolate(frame, [quoteStart, quoteStart + 6, duration - 6, duration], [0, 1, 1, 0], CLAMP);
}

const REFERENCE_CROP: Crop = {x: 56, y: 236, width: 1344, height: 664};
const REFERENCE_WIDTH = 780;

const PANEL_STAGE = {left: 964, top: 256, width: 860};
const POLAROID_STAGE = {left: 1068, top: 420, width: 728};
const POLAROID_LIFT = {x: -36, y: 72, scale: 0.76};

const VideoReference = ({duration}: {duration: number}) => {
  const frame = useCurrentFrame();
  const captionOpacity = overviewVoiceCaptionOpacityAtFrame(frame, duration);
  const quoteStart = overviewChapterDuration(duration);

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

const OverviewSpotlightCard = ({chapterDuration}: {chapterDuration: number}) => {
  const frame = useCurrentFrame();
  const enter = interpolate(frame, [0, 12], [0, 1], {...CLAMP, easing: SMOOTH});
  const enterY = interpolate(frame, [0, 12], [22, 0], {...CLAMP, easing: SMOOTH});
  const quoteDefocus = interpolate(frame, [chapterDuration, chapterDuration + 16], [0, 2.6], {...CLAMP, easing: SMOOTH});
  const quoteDimOpacity = interpolate(frame, [chapterDuration, chapterDuration + 16], [1, 0.68], {...CLAMP, easing: SMOOTH});
  const quoteBackScale = interpolate(frame, [chapterDuration, chapterDuration + 16], [1, 0.965], {...CLAMP, easing: SMOOTH});
  const quoteRetreatY = interpolate(frame, [chapterDuration, chapterDuration + 16], [0, -76], {...CLAMP, easing: SMOOTH});

  const cursorMoveStart = QUOTE_CLICK_FRAME - 18;
  const cursorOpacity =
    interpolate(frame, [cursorMoveStart, cursorMoveStart + 5], [0, 1], CLAMP) *
    interpolate(frame, [chapterDuration - 4, chapterDuration], [1, 0], CLAMP);
  const cursorX = interpolate(frame, [cursorMoveStart, QUOTE_CLICK_FRAME], [96, 18], {...CLAMP, easing: SMOOTH});
  const cursorY = interpolate(frame, [cursorMoveStart, QUOTE_CLICK_FRAME], [64, 18], {...CLAMP, easing: SMOOTH});
  const isQuoteClicked = frame >= QUOTE_CLICK_FRAME;
  const buttonPress = interpolate(
    frame,
    [QUOTE_CLICK_FRAME - 1, QUOTE_CLICK_FRAME + 1, QUOTE_CLICK_FRAME + 5],
    [1, 0.95, 1.03],
    CLAMP
  );
  const rippleOpacity = interpolate(
    frame,
    [QUOTE_CLICK_FRAME - 1, QUOTE_CLICK_FRAME + 1, chapterDuration + 2],
    [0, 0.85, 0],
    CLAMP
  );
  const rippleScale = interpolate(frame, [QUOTE_CLICK_FRAME - 1, chapterDuration + 2], [0.5, 1.85], {
    ...CLAMP,
    easing: SMOOTH
  });

  return (
    <div
      style={{
        position: "absolute",
        left: PANEL_STAGE.left,
        top: PANEL_STAGE.top,
        width: PANEL_STAGE.width,
        opacity: enter * quoteDimOpacity,
        translate: `0px ${(enterY + quoteRetreatY).toFixed(1)}px`,
        scale: quoteBackScale,
        filter: quoteDefocus > 0.05 ? `blur(${quoteDefocus.toFixed(2)}px)` : undefined,
        transformOrigin: "50% 50%",
        zIndex: 8
      }}
    >
      <div
        style={{
          position: "relative",
          borderRadius: 30,
          overflow: "hidden",
          background: MIST_GLASS.surface,
          backdropFilter: "blur(24px) saturate(1.2)",
          WebkitBackdropFilter: "blur(24px) saturate(1.2)",
          boxShadow: MIST_GLASS.shellShadow,
          padding: "26px 34px 30px",
          fontFamily: FONT_FAMILY,
          transform: microPerspective(-7),
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

        {/* Reader Header & Tabs */}
        <div
          style={{
            position: "relative",
            zIndex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 20
          }}
        >
          <div style={{display: "flex", alignItems: "center", gap: 6, padding: 4, borderRadius: 14}}>
            {["字幕", "概览", "AI 对话"].map((tab, index) => (
              <div
                key={tab}
                style={{
                  padding: "9px 22px",
                  borderRadius: 10,
                  background: index === 1 ? MIST_GLASS.cardElevated : "transparent",
                  boxShadow: index === 1 ? MIST_GLASS.tabActiveShadow : "none",
                  color: index === 1 ? MIST_GLASS.accent : MIST_GLASS.muted,
                  fontSize: 20,
                  fontWeight: index === 1 ? 740 : 580
                }}
              >
                {tab}
              </div>
            ))}
          </div>
          <span style={{color: MIST_GLASS.muted, fontSize: 18, fontWeight: 620}}>
            AI 章节脉络 · 精要
          </span>
        </div>

        {/* Zoomed-in 2 Chapter Cards */}
        <div style={{position: "relative", zIndex: 1, display: "flex", flexDirection: "column", gap: 16}}>
          {OVERVIEW_CHAPTERS.map((chapter, index) => {
            const cardStart = 3 + index * 6;
            const cardEnter = interpolate(frame, [cardStart, cardStart + 12], [0, 1], {...CLAMP, easing: SMOOTH});
            const cardLift = interpolate(frame, [cardStart, cardStart + 12], [14, 0], {...CLAMP, easing: SMOOTH});
            const isSecond = index === 1;

            return (
              <div
                key={chapter.timestamp}
                style={{
                  padding: "22px 26px",
                  borderRadius: 22,
                  background: MIST_GLASS.cardElevated,
                  boxShadow: isSecond
                    ? "inset 0 1px 0 0 rgba(255, 255, 255, 0.98), 0 18px 38px -14px rgba(0, 140, 255, 0.18), 0 0 0 1.5px rgba(0, 140, 255, 0.34)"
                    : MIST_GLASS.cardShadow,
                  opacity: cardEnter,
                  translate: `0px ${cardLift.toFixed(1)}px`
                }}
              >
                <div style={{display: "flex", alignItems: "center", gap: 16, marginBottom: 10}}>
                  <span
                    style={{
                      padding: "6px 16px",
                      borderRadius: 999,
                      background: isSecond ? MIST_GLASS.accent : MIST_GLASS.timeBg,
                      color: isSecond ? "#FFFFFF" : MIST_GLASS.timeColor,
                      boxShadow: isSecond ? "0 8px 20px -4px rgba(0, 140, 255, 0.42)" : "none",
                      fontFamily: BRAND_FONT_FAMILY,
                      fontSize: 22,
                      fontWeight: 800,
                      letterSpacing: 0.3,
                      fontVariantNumeric: "tabular-nums",
                      flexShrink: 0
                    }}
                  >
                    {chapter.timestamp}
                  </span>
                  <span
                    style={{
                      color: MIST_GLASS.text,
                      fontSize: 27,
                      fontWeight: 760,
                      lineHeight: 1.24,
                      letterSpacing: -0.6
                    }}
                  >
                    {chapter.title}
                  </span>
                </div>
                <div
                  style={{
                    color: MIST_GLASS.muted,
                    fontSize: 20,
                    fontWeight: 560,
                    lineHeight: 1.42,
                    letterSpacing: -0.2,
                    paddingLeft: 4
                  }}
                >
                  {chapter.summary}
                </div>
              </div>
            );
          })}
        </div>

        {/* Bottom Quote Row + Share / Polaroid Trigger */}
        <div
          style={{
            position: "relative",
            zIndex: 1,
            marginTop: 18,
            padding: "20px 26px",
            borderRadius: 22,
            background: isQuoteClicked
              ? "linear-gradient(135deg, rgba(255, 244, 248, 0.98) 0%, rgba(242, 249, 255, 0.98) 100%)"
              : "rgba(255, 255, 255, 0.86)",
            boxShadow: isQuoteClicked
              ? "0 20px 44px -14px rgba(232, 93, 135, 0.28), 0 0 0 2px rgba(232, 93, 135, 0.52)"
              : "inset 0 1px 0 0 rgba(255, 255, 255, 0.92), 0 12px 28px -14px rgba(15, 23, 42, 0.10), 0 0 0 1px rgba(232, 93, 135, 0.22)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 20
          }}
        >
          <div style={{minWidth: 0, flex: 1}}>
            <div style={{display: "flex", alignItems: "center", gap: 10, marginBottom: 6}}>
              <span
                style={{
                  padding: "3px 11px",
                  borderRadius: 999,
                  background: "rgba(232, 93, 135, 0.14)",
                  color: COLORS.pink,
                  fontSize: 16,
                  fontWeight: 740
                }}
              >
                金句提炼
              </span>
              <span
                style={{
                  fontFamily: BRAND_FONT_FAMILY,
                  fontSize: 18,
                  fontWeight: 760,
                  color: MIST_GLASS.timeColor,
                  fontVariantNumeric: "tabular-nums"
                }}
              >
                02:32
              </span>
            </div>
            <div
              style={{
                color: MIST_GLASS.text,
                fontSize: 17.5,
                fontWeight: 680,
                lineHeight: 1.35,
                letterSpacing: -0.3,
                whiteSpace: "nowrap"
              }}
            >
              “他只要去答这个题目，得的就不是零分；但如果他不答，一定是零分！”
            </div>
          </div>

          <div style={{position: "relative", flexShrink: 0}}>
            <div
              style={{
                position: "absolute",
                inset: -10,
                borderRadius: 999,
                background: "rgba(232, 93, 135, 0.28)",
                opacity: rippleOpacity,
                scale: rippleScale,
                pointerEvents: "none"
              }}
            />
            <div
              style={{
                padding: "11px 20px",
                borderRadius: 999,
                background: isQuoteClicked ? COLORS.pink : "rgba(232, 93, 135, 0.12)",
                color: isQuoteClicked ? "#FFFFFF" : COLORS.pink,
                boxShadow: isQuoteClicked
                  ? "0 12px 26px -6px rgba(232, 93, 135, 0.52)"
                  : "0 0 0 1.5px rgba(232, 93, 135, 0.34)",
                fontSize: 18,
                fontWeight: 740,
                whiteSpace: "nowrap",
                scale: buttonPress
              }}
            >
              ✦ 生成金句卡
            </div>
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
        </div>
      </div>
    </div>
  );
};

const QuotePolaroid = ({chapterDuration}: {chapterDuration: number}) => {
  const frame = useCurrentFrame();
  const lift = interpolate(frame, [0, QUOTE_LIFT_FRAMES], [0, 1], {
    ...CLAMP,
    easing: SMOOTH
  });
  const translateX = interpolate(lift, [0, 1], [POLAROID_LIFT.x, 0]);
  const translateY = interpolate(lift, [0, 1], [POLAROID_LIFT.y, 0]);
  const scale = interpolate(lift, [0, 1], [POLAROID_LIFT.scale, 1]);
  const polaroidOpacity = interpolate(frame, [0, 6], [0, 1], {...CLAMP, easing: SMOOTH});
  const rotateX = interpolate(lift, [0, 1], [0, 4]);
  const rotateY = interpolate(lift, [0, 1], [0, -8]);
  const rotateZ = interpolate(lift, [0, 1], [0, -1.4]);
  const sheenX = interpolate(lift, [0.08, 0.78], [-24, 122], CLAMP);
  const sheenOpacity = interpolate(lift, [0.06, 0.34, 0.82], [0, 0.86, 0], CLAMP);
  const shadowSpread = interpolate(lift, [0, 1], [0.3, 0.52]);

  return (
    <div
      data-quote-start={chapterDuration}
      style={{
        position: "absolute",
        left: POLAROID_STAGE.left,
        top: POLAROID_STAGE.top,
        width: POLAROID_STAGE.width,
        opacity: polaroidOpacity,
        transformOrigin: "50% 84%",
        transform: `translate(${translateX.toFixed(1)}px, ${translateY.toFixed(1)}px) scale(${scale.toFixed(3)}) perspective(1600px) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg) rotateZ(${rotateZ.toFixed(2)}deg)`,
        zIndex: 20
      }}
    >
      <div
        style={{
          borderRadius: 14,
          padding: "18px 18px 0",
          background: "#FFFDF8",
          boxShadow: `-34px 54px 110px -24px rgba(15, 23, 42, ${shadowSpread.toFixed(2)}), -10px 18px 44px -16px rgba(15, 23, 42, 0.26), 0 0 0 1px rgba(15, 23, 42, 0.06)`
        }}
      >
        <div
          style={{
            position: "relative",
            height: 356,
            borderRadius: 6,
            overflow: "hidden",
            background: "linear-gradient(146deg, #8FB0C6 0%, #56799B 44%, #2C4864 100%)"
          }}
        >
          <PaperGrainOverlay opacity={0.34} borderRadius={6} />
          <ReadingLampBeam intensity={0.92} borderRadius={6} />
          <div
            style={{
              position: "absolute",
              inset: 0,
              background:
                "radial-gradient(120% 96% at 82% 2%, rgba(255, 224, 170, 0.24) 0%, rgba(255, 224, 170, 0) 58%), linear-gradient(180deg, rgba(15, 23, 42, 0) 62%, rgba(15, 23, 42, 0.18) 100%)",
              pointerEvents: "none"
            }}
          />
          <div
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: 6,
              boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.18)",
              pointerEvents: "none"
            }}
          />
          {sheenOpacity > 0.01 && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: `linear-gradient(112deg, rgba(255, 255, 255, 0) ${sheenX - 26}%, rgba(255, 255, 255, 0.66) ${sheenX}%, rgba(198, 232, 255, 0.28) ${sheenX + 10}%, rgba(255, 255, 255, 0) ${sheenX + 28}%)`,
                opacity: sheenOpacity,
                pointerEvents: "none"
              }}
            />
          )}
          <div
            style={{
              position: "relative",
              height: "100%",
              boxSizing: "border-box",
              padding: "34px 38px 30px"
            }}
          >
            <span
              style={{
                position: "absolute",
                left: 36,
                top: 24,
                color: "rgba(255, 255, 255, 0.58)",
                fontFamily: "Georgia, serif",
                fontSize: 58,
                lineHeight: 0.6
              }}
            >
              “
            </span>
            <div
              style={{
                height: "100%",
                display: "flex",
                alignItems: "center",
                color: "#FFFFFF",
                fontFamily: '"Noto Serif SC", "Songti SC", "SimSun", serif',
                fontSize: 34,
                fontWeight: 500,
                lineHeight: 1.62,
                letterSpacing: 0.3,
                whiteSpace: "pre-line",
                textShadow: "0 2px 12px rgba(15, 23, 42, 0.28)"
              }}
            >
              {OVERVIEW_POLAROID_QUOTE}
            </div>
            <div
              style={{
                position: "absolute",
                left: 38,
                bottom: 26,
                display: "flex",
                alignItems: "center"
              }}
            >
              <span
                style={{
                  padding: "6px 18px",
                  borderRadius: 999,
                  background: "rgba(255, 255, 255, 0.16)",
                  boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.32)",
                  color: "#FFE6EE",
                  fontFamily: BRAND_FONT_FAMILY,
                  fontSize: 21,
                  fontWeight: 700,
                  letterSpacing: 0.6
                }}
              >
                {OVERVIEW_VIDEO_REFERENCE.captionTimestamp}
              </span>
            </div>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "15px 8px 18px"
          }}
        >
          <span style={{fontSize: 18, fontWeight: 520, color: COLORS.muted, letterSpacing: -0.2}}>
            复旦赵斌《大模型公开课》
          </span>
          <span style={{fontFamily: BRAND_FONT_FAMILY, fontSize: 17, fontWeight: 700, color: COLORS.inkSoft}}>
            BiliScript
          </span>
        </div>
      </div>
    </div>
  );
};

export const OverviewScene = ({duration}: {duration: number}) => {
  const frame = useCurrentFrame();
  const chapterDuration = overviewChapterDuration(duration);
  const quoteDuration = overviewQuoteDuration(duration);
  const handoffBlur = interpolate(
    frame,
    [duration - CHAT_HANDOFF.exitFrames, duration],
    [0, CHAT_HANDOFF.maxBlur],
    {...CLAMP, easing: SMOOTH}
  );
  const handoffScale = interpolate(
    frame,
    [duration - CHAT_HANDOFF.exitFrames, duration],
    [1, 0.97],
    {...CLAMP, easing: SMOOTH}
  );

  return (
    <>
      <BrandWhisper />
      <SceneTitle
        title={OVERVIEW_HEADLINE}
        size={66}
        style={{left: 96, top: 186, width: 848}}
      />
      <VideoReference duration={duration} />
      <div
        style={{
          position: "absolute",
          inset: 0,
          scale: handoffScale,
          filter: handoffBlur > 0.05 ? `blur(${handoffBlur.toFixed(2)}px)` : undefined,
          transformOrigin: "72% 48%"
        }}
      >
        <OverviewSpotlightCard chapterDuration={chapterDuration} />
        <Sequence from={chapterDuration} durationInFrames={quoteDuration}>
          <QuotePolaroid chapterDuration={chapterDuration} />
        </Sequence>
      </div>
    </>
  );
};
