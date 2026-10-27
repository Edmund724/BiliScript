import {Sequence, interpolate, useCurrentFrame, useVideoConfig} from "remotion";
import {Crop, ProductFrame, SceneTitle, SpringLayout} from "./design";

const CHAPTER_CROP: Crop = {x: 1380, y: 230, width: 500, height: 650};
const QUOTE_CROP: Crop = {x: 1415, y: 293, width: 440, height: 558};
const CHAPTER_SOURCE_SECONDS = 5.6;
const QUOTE_SOURCE_SECONDS = 4.733333;

const QuoteCamera = ({duration}: {duration: number}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  return (
    <div
      style={{
        position: "absolute",
        left: 1040,
        top: 58,
        width: 760,
        height: 964,
        transformOrigin: "50% 0%",
        scale: interpolate(frame, [0, 18, duration], [1, 1.06, 1.1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp"
        })
      }}
    >
      <ProductFrame
        source="overview-04-quote.mp4"
        crop={QUOTE_CROP}
        width={760}
        playbackRate={QUOTE_SOURCE_SECONDS / (Math.max(1, duration - 12) / fps)}
        duration={duration}
        animate={false}
        tilt={-6}
        style={{left: 0, top: 0}}
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
