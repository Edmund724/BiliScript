import {Easing, Sequence, interpolate, useCurrentFrame, useVideoConfig} from "remotion";
import {PANEL_FOCUS_HANDOFFS} from "../timeline.mjs";
import {COLORS, Crop, ProductFrame, Reveal, SceneTitle, SpringLayout} from "./design";

const CHAT_HANDOFF = PANEL_FOCUS_HANDOFFS.find((handoff) => handoff.to === "chat")!;

const CHAPTER_CROP: Crop = {x: 1365, y: 182, width: 540, height: 660};
const QUOTE_CROP: Crop = {x: 1365, y: 548, width: 540, height: 170};
const SHARE_CROP: Crop = {x: 1365, y: 288, width: 540, height: 564};
const CHAPTER_SOURCE_SECONDS = 5.6;
const QUOTE_SOURCE_SECONDS = 4.733333;
const QUOTE_LIFT_FRAMES = 16;

const ChapterPills = () => {
  const pills = [
    {time: "00:00", label: "什么是机器幻觉"},
    {time: "02:32", label: "AI 并非越强越好"},
    {time: "04:27", label: "人机协作象棋实验"}
  ];
  return (
    <Reveal delay={2} distance={18} style={{position: "absolute", left: 130, top: 610, display: "flex", flexDirection: "column", gap: 14}}>
      {pills.map((pill, idx) => (
        <div
          key={pill.time}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            padding: "12px 22px",
            borderRadius: 18,
            background: idx === 1 ? "rgba(232, 93, 135, 0.09)" : "rgba(255, 255, 255, 0.88)",
            border: idx === 1 ? "1px solid rgba(232, 93, 135, 0.32)" : "1px solid rgba(83, 110, 134, 0.15)",
            boxShadow: "0 10px 26px -18px rgba(43, 70, 93, 0.18)"
          }}
        >
          <span
            style={{
              padding: "4px 12px",
              borderRadius: 999,
              background: idx === 1 ? COLORS.pink : "rgba(36, 52, 71, 0.08)",
              color: idx === 1 ? "#FFFFFF" : COLORS.foreground,
              fontSize: 20,
              fontWeight: 600
            }}
          >
            {pill.time}
          </span>
          <span style={{color: COLORS.foreground, fontSize: 24, fontWeight: 500}}>{pill.label}</span>
        </div>
      ))}
    </Reveal>
  );
};

const PaletteSwatches = () => {
  const frame = useCurrentFrame();
  const activeIndex = frame >= 33 ? 2 : frame >= 21 ? 1 : 0;
  const palettes = [
    {name: "紫粉 · 橙金", dot: "#E85D87"},
    {name: "灰蓝 · 深棕", dot: "#7B6B5E"},
    {name: "雾蓝 · 深海", dot: "#3A6E8C"}
  ];
  return (
    <Reveal delay={10} distance={16} style={{position: "absolute", left: 130, top: 590, display: "flex", gap: 16}}>
      {palettes.map((palette, idx) => {
        const active = idx === activeIndex;
        return (
          <div
            key={palette.name}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "12px 22px",
              borderRadius: 999,
              background: active ? "rgba(255, 255, 255, 0.98)" : "rgba(255, 255, 255, 0.72)",
              border: active ? `2px solid ${palette.dot}` : "1px solid rgba(83, 110, 134, 0.16)",
              boxShadow: active ? "0 14px 32px -18px rgba(43, 70, 93, 0.28)" : "none",
              scale: active ? 1.04 : 1
            }}
          >
            <span style={{width: 16, height: 16, borderRadius: "50%", background: palette.dot, display: "inline-block"}} />
            <span style={{color: COLORS.foreground, fontSize: 22, fontWeight: active ? 600 : 500}}>{palette.name}</span>
          </div>
        );
      })}
    </Reveal>
  );
};

const QuoteCamera = ({duration}: {duration: number}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const easing = Easing.bezier(0.16, 1, 0.3, 1);
  const liftProgress = interpolate(frame, [0, QUOTE_LIFT_FRAMES], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing
  });
  const expandProgress = interpolate(frame, [0, 10, QUOTE_LIFT_FRAMES], [0, 0.15, 1], {
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
        left: 1030,
        top: mixLift(340, 68),
        width: 740,
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
        width={740}
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
          <SceneTitle title={"这条视频，\n讲了什么？"} style={{left: 130, top: 340, width: 720}} />
          <ChapterPills />
          <ProductFrame
            source="overview-04-chapters.mp4"
            crop={CHAPTER_CROP}
            width={760}
            playbackRate={CHAPTER_SOURCE_SECONDS / (chapterDuration / fps)}
            duration={chapterDuration}
            style={{left: 1030, top: 68}}
          />
        </SpringLayout>
      </Sequence>
      <Sequence from={chapterDuration} durationInFrames={quoteDuration}>
        <SpringLayout direction={1} fade={false}>
          <SceneTitle title={"一句金句，\n生成分享卡片。"} size={68} style={{left: 130, top: 340, width: 840}} />
          <PaletteSwatches />
          <QuoteCamera duration={quoteDuration} />
        </SpringLayout>
      </Sequence>
    </>
  );
};
