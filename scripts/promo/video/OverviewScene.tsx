import {Easing, Sequence, interpolate, useCurrentFrame} from "remotion";
import {OVERVIEW_TIMELINE} from "../timeline.mjs";
import {
  BRAND_FONT_FAMILY,
  BottomLectureCaption,
  BrandWhisper,
  COLORS,
  Crop,
  PaperGrainOverlay,
  ProductFrame,
  ReadingLampBeam,
  SceneTitle,
  VideoReferenceCard
} from "./design";

const CLAMP = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;
const SMOOTH = Easing.bezier(0.16, 1, 0.3, 1);

export const OVERVIEW_HEADLINE = "48 分钟长视频，\n3 秒提炼章节脉络与金句。";

export const OVERVIEW_VIDEO_REFERENCE = {
  headerText: "正在阅读：复旦赵斌《大模型公开课》48:16",
  badgeText: "复旦赵斌 · 48:16 公开课",
  captionTimestamp: "02:32",
  captionQuote: "“如果他不答，一定是零分！”"
};

export const OVERVIEW_POLAROID_QUOTE = "他只要去答这个题目，\n得的就不是零分；\n但如果他不答，一定是零分！";

const CHAPTER_RATIO = OVERVIEW_TIMELINE.chapterRatio;
const SCENE_REFERENCE_DURATION = 120;

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

const REFERENCE_CROP: Crop = {x: 56, y: 236, width: 1344, height: 664};
const REFERENCE_WIDTH = 780;
const PANEL_CROP: Crop = {x: 1365, y: 182, width: 540, height: 620};
const PANEL_WIDTH = 800;

const PANEL_STAGE = {left: 1000, top: 76};
const POLAROID_STAGE = {left: 1040, top: PANEL_STAGE.top, width: 720};
const POLAROID_LIFT = {x: -6, y: 540, scale: 0.9};

const VideoReference = () => (
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
    style={{position: "absolute", left: 96, top: 352}}
  >
    <BottomLectureCaption
      timestamp={OVERVIEW_VIDEO_REFERENCE.captionTimestamp}
      quote={OVERVIEW_VIDEO_REFERENCE.captionQuote}
      style={{bottom: 16, padding: "10px 24px 10px 16px", scale: 0.74, transformOrigin: "50% 100%"}}
    />
  </VideoReferenceCard>
);

const ChapterPanel = () => (
  <ProductFrame
    source="overview-04-chapters.mp4"
    crop={PANEL_CROP}
    width={PANEL_WIDTH}
    tilt={-8}
    duration={OVERVIEW_CHAPTER_DURATION}
    animate={false}
    style={{left: PANEL_STAGE.left, top: PANEL_STAGE.top}}
  />
);

const QuotePanel = () => {
  const frame = useCurrentFrame();
  const defocus = interpolate(frame, [4, 20], [0, 3.2], {...CLAMP, easing: SMOOTH});
  return (
    <div style={{filter: defocus > 0.05 ? `blur(${defocus.toFixed(2)}px)` : undefined}}>
      <ProductFrame
        source="overview-04-quote.mp4"
        crop={PANEL_CROP}
        width={PANEL_WIDTH}
        tilt={-8}
        duration={OVERVIEW_QUOTE_DURATION}
        animate={false}
        style={{left: PANEL_STAGE.left, top: PANEL_STAGE.top}}
      />
    </div>
  );
};

const QuotePolaroid = () => {
  const frame = useCurrentFrame();
  const lift = overviewQuoteLiftProgress(frame + OVERVIEW_QUOTE_START_FRAME);
  const translateX = interpolate(lift, [0, 1], [POLAROID_LIFT.x, 0]);
  const translateY = interpolate(lift, [0, 1], [POLAROID_LIFT.y, 0]);
  const scale = interpolate(lift, [0, 1], [POLAROID_LIFT.scale, 1]);
  const rotateX = interpolate(lift, [0, 1], [0, 4]);
  const rotateY = interpolate(lift, [0, 1], [0, -8]);
  const rotateZ = interpolate(lift, [0, 1], [0, -1.4]);
  const sheenX = interpolate(lift, [0.08, 0.78], [-24, 122], CLAMP);
  const sheenOpacity = interpolate(lift, [0.06, 0.34, 0.82], [0, 0.86, 0], CLAMP);
  const shadowSpread = interpolate(lift, [0, 1], [0.3, 0.52]);

  return (
    <div
      style={{
        position: "absolute",
        left: POLAROID_STAGE.left,
        top: POLAROID_STAGE.top,
        width: POLAROID_STAGE.width,
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
  const chapterDuration = overviewChapterDuration(duration);
  const quoteDuration = overviewQuoteDuration(duration);
  return (
    <>
      <BrandWhisper />
      <SceneTitle
        title={OVERVIEW_HEADLINE}
        size={66}
        style={{left: 96, top: 150, width: 848}}
      />
      <VideoReference />
      <Sequence durationInFrames={chapterDuration}>
        <ChapterPanel />
      </Sequence>
      <Sequence from={chapterDuration} durationInFrames={quoteDuration}>
        <QuotePanel />
      </Sequence>
      <Sequence from={chapterDuration} durationInFrames={quoteDuration}>
        <QuotePolaroid />
      </Sequence>
    </>
  );
};
