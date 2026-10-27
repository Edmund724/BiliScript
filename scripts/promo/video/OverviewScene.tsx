import {Easing, Sequence, interpolate, useCurrentFrame, useVideoConfig} from "remotion";
import {PANEL_FOCUS_HANDOFFS} from "../timeline.mjs";
import {Crop, ProductFrame, SceneTitle, SpringLayout} from "./design";

const CHAT_HANDOFF = PANEL_FOCUS_HANDOFFS.find((handoff) => handoff.to === "chat")!;

const CHAPTER_CROP: Crop = {x: 1380, y: 230, width: 500, height: 650};
const QUOTE_CROP: Crop = {x: 1418, y: 572, width: 462, height: 145};
const SHARE_CROP: Crop = {x: 1407, y: 294, width: 458, height: 558};
const CHAPTER_SOURCE_SECONDS = 5.6;
const QUOTE_SOURCE_SECONDS = 4.733333;
const QUOTE_LIFT_FRAMES = 16;

const QuoteCamera = ({duration}: {duration: number}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const easing = Easing.bezier(0.16, 1, 0.3, 1);
  const liftProgress = interpolate(frame, [0, QUOTE_LIFT_FRAMES], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing
  });
  const expandProgress = interpolate(frame, [0, 12, QUOTE_LIFT_FRAMES], [0, 0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing
  });
  const mix = (from: number, to: number) => from + (to - from) * expandProgress;
  const mixLift = (from: number, to: number) => from + (to - from) * liftProgress;
  const crop: Crop = {
    x: mix(QUOTE_CROP.x, SHARE_CROP.x),
    y: mix(QUOTE_CROP.y, SHARE_CROP.y),
    width: mix(QUOTE_CROP.width, SHARE_CROP.width),
    height: mix(QUOTE_CROP.height, SHARE_CROP.height)
  };
  return (
    <div
      style={{
        position: "absolute",
        left: 1040,
        top: mixLift(370, 58),
        width: 760,
        transformOrigin: "50% 50%",
        scale: interpolate(frame, [0, QUOTE_LIFT_FRAMES, duration], [0.96, 1, 1.015], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp"
        })
      }}
    >
      <ProductFrame
        source="overview-04-quote.mp4"
        crop={crop}
        width={760}
        playbackRate={QUOTE_SOURCE_SECONDS / (Math.max(1, duration - 12) / fps)}
        duration={duration}
        animate={false}
        tilt={-6}
        focus={{direction: "out", frames: CHAT_HANDOFF.exitFrames, maxBlur: CHAT_HANDOFF.maxBlur}}
        style={{
          left: 0,
          top: 0,
          boxShadow: `0 ${mixLift(14, 28)}px ${mixLift(36, 70)}px -30px rgba(43, 70, 93, ${mixLift(0.16, 0.28)})`
        }}
      />
    </div>
  );
};

export const OverviewScene = ({duration}: {duration: number}) => {
  const {fps} = useVideoConfig();
  const chapterDuration = Math.round(duration * 0.43);
  const quoteDuration = duration - chapterDuration;
  return (
    <>
      <Sequence durationInFrames={chapterDuration}>
        <SpringLayout direction={-1}>
          <SceneTitle title={"这条视频，\n讲了什么？"} style={{left: 130, top: 370, width: 720}} />
          <ProductFrame
            source="overview-04-chapters.mp4"
            crop={CHAPTER_CROP}
            width={760}
            playbackRate={CHAPTER_SOURCE_SECONDS / (chapterDuration / fps)}
            duration={chapterDuration}
            style={{left: 1040, top: 42}}
          />
        </SpringLayout>
      </Sequence>
      <Sequence from={chapterDuration} durationInFrames={quoteDuration}>
        <SpringLayout direction={1}>
          <SceneTitle title={"一句金句，\n生成分享卡片。"} size={68} style={{left: 130, top: 350, width: 840}} />
          <QuoteCamera duration={quoteDuration} />
        </SpringLayout>
      </Sequence>
    </>
  );
};
