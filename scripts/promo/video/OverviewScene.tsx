import {Easing, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame} from "remotion";
import {OVERVIEW_TIMELINE, PANEL_FOCUS_HANDOFFS} from "../timeline.mjs";
import {
  BottomLectureCaption,
  BrandWhisper,
  COLORS,
  Crop,
  ELEVATION,
  SceneTitle,
  VideoReferenceCard
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

const CHAPTER_RATIO = OVERVIEW_TIMELINE.chapterRatio;
const SCENE_REFERENCE_DURATION = OVERVIEW_TIMELINE.duration;

export const OVERVIEW_CHAPTER_DURATION = Math.round(SCENE_REFERENCE_DURATION * CHAPTER_RATIO);
export const OVERVIEW_QUOTE_START_FRAME = OVERVIEW_CHAPTER_DURATION;
export const OVERVIEW_QUOTE_DURATION = SCENE_REFERENCE_DURATION - OVERVIEW_CHAPTER_DURATION;

export function overviewChapterDuration(duration: number): number {
  return Math.round(duration * CHAPTER_RATIO);
}

export function overviewQuoteDuration(duration: number): number {
  return duration - overviewChapterDuration(duration);
}

export function overviewPhaseAtFrame(frame: number, duration: number): "chapters" | "quote" {
  return frame < overviewChapterDuration(duration) ? "chapters" : "quote";
}

export function overviewVoiceCaptionOpacityAtFrame(frame: number, duration = SCENE_REFERENCE_DURATION): number {
  const quoteStart = overviewChapterDuration(duration);
  if (frame < quoteStart) return 0;
  return interpolate(frame, [quoteStart, quoteStart + 6, duration - 6, duration], [0, 1, 1, 0], CLAMP);
}

const REFERENCE_CROP: Crop = {x: 56, y: 236, width: 1344, height: 664};
const REFERENCE_WIDTH = 780;

const PANEL_STAGE = {left: 964, top: 104, width: 860, height: 876};
const PANEL_CROP = {x: 1365, width: 540, height: 550};
const CHAPTER_CROP_Y = 64;
const QUOTE_CROP_Y = 500;
const QUOTE_MODAL_CROP_Y = 280;

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

const RecordedPanel = ({
  source,
  cropY,
  startFrom = 0,
  playbackRate = 1
}: {
  source: string;
  cropY: number;
  startFrom?: number;
  playbackRate?: number;
}) => {
  const scale = PANEL_STAGE.width / PANEL_CROP.width;
  return (
    <OffthreadVideo
      muted
      src={staticFile(`media/${source}`)}
      startFrom={startFrom}
      playbackRate={playbackRate}
      style={{
        position: "absolute",
        left: -PANEL_CROP.x * scale,
        top: -cropY * scale,
        width: 1920 * scale,
        height: 1080 * scale,
        maxWidth: "none"
      }}
    />
  );
};

const QuoteRecording = () => {
  const frame = useCurrentFrame();
  const cropY = interpolate(frame, [0, 18, 28], [QUOTE_CROP_Y, QUOTE_CROP_Y, QUOTE_MODAL_CROP_Y], {
    ...CLAMP,
    easing: SMOOTH
  });
  return <RecordedPanel source="overview-04-quote.mp4" cropY={cropY} startFrom={45} playbackRate={1.2} />;
};

const OverviewPanel = ({chapterDuration}: {chapterDuration: number}) => {
  const frame = useCurrentFrame();
  const enter = interpolate(frame, [0, 12], [0, 1], {...CLAMP, easing: SMOOTH});
  const enterY = interpolate(frame, [0, 12], [22, 0], {...CLAMP, easing: SMOOTH});

  return (
    <div
      style={{
        position: "absolute",
        left: PANEL_STAGE.left,
        top: PANEL_STAGE.top,
        width: PANEL_STAGE.width,
        height: PANEL_STAGE.height,
        borderRadius: 30,
        overflow: "hidden",
        background: COLORS.background,
        boxShadow: ELEVATION.videoPlane,
        opacity: enter,
        translate: `0px ${enterY.toFixed(1)}px`,
        zIndex: 8
      }}
    >
      <Sequence from={0} durationInFrames={chapterDuration}>
        <RecordedPanel source="overview-04-chapters.mp4" cropY={CHAPTER_CROP_Y} playbackRate={2} />
      </Sequence>
      <Sequence from={chapterDuration} durationInFrames={SCENE_REFERENCE_DURATION - chapterDuration}>
        <QuoteRecording />
      </Sequence>
    </div>
  );
};

export const OverviewScene = ({duration}: {duration: number}) => {
  const frame = useCurrentFrame();
  const chapterDuration = overviewChapterDuration(duration);
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
        <OverviewPanel chapterDuration={chapterDuration} />
      </div>
    </>
  );
};
