import {Easing, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig} from "remotion";
import {PANEL_FOCUS_HANDOFFS} from "../timeline.mjs";
import {
  BRAND_FONT_FAMILY,
  BrandWhisper,
  COLORS,
  Crop,
  ELEVATION,
  MIST_GLASS,
  ProductFrame,
  Reveal,
  SceneTitle,
  SpringLayout,
  VoiceWaveBar,
  microPerspective
} from "./design";

const CHAT_HANDOFF = PANEL_FOCUS_HANDOFFS.find((handoff) => handoff.to === "chat")!;

const CHAPTER_CROP: Crop = {x: 1365, y: 182, width: 540, height: 660};
const QUOTE_CROP: Crop = {x: 1365, y: 548, width: 540, height: 170};
const SHARE_CROP: Crop = {x: 1365, y: 288, width: 540, height: 564};
const PLAYER_CROP: Crop = {x: 54, y: 171, width: 1272, height: 764};
const CHAPTER_SOURCE_SECONDS = 5.6;
const QUOTE_SOURCE_SECONDS = 4.733333;
const QUOTE_LIFT_FRAMES = 16;

const SpatialChapterStack = () => (
  <Reveal
    delay={2}
    distance={18}
    style={{
      position: "absolute",
      left: 96,
      top: 436,
      width: 810,
      transform: "perspective(1600px) rotateX(4deg) rotateY(-8deg)"
    }}
  >
    <div
      style={{
        position: "relative",
        padding: "22px 32px",
        borderRadius: 28,
        background: MIST_GLASS.surface,
        backdropFilter: "blur(24px) saturate(1.2)",
        WebkitBackdropFilter: "blur(24px) saturate(1.2)",
        boxShadow: MIST_GLASS.shellShadow,
        display: "flex",
        flexDirection: "column",
        gap: 12
      }}
    >
      {/* Flyme Blue-Mist Ambient Blobs */}
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

      <div
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "10px 16px",
          borderRadius: 16,
          background: MIST_GLASS.card,
          boxShadow: MIST_GLASS.cardShadow,
          color: MIST_GLASS.muted,
          fontSize: 21,
          fontWeight: 540,
          opacity: 0.78
        }}
      >
        <span
          style={{
            fontFamily: BRAND_FONT_FAMILY,
            fontSize: 18,
            fontWeight: 620,
            color: MIST_GLASS.timeColor,
            background: MIST_GLASS.timeBg,
            padding: "3px 12px",
            borderRadius: 999
          }}
        >
          00:00
        </span>
        <span>什么是机器幻觉（Hallucination）</span>
      </div>

      <div
        style={{
          position: "relative",
          zIndex: 2,
          margin: "4px -14px",
          padding: "26px 34px",
          borderRadius: 24,
          background: MIST_GLASS.cardElevated,
          boxShadow: MIST_GLASS.cardFloatShadow
        }}
      >
        <div style={{display: "flex", alignItems: "center", gap: 14, marginBottom: 14}}>
          <span
            style={{
              background: MIST_GLASS.timeBg,
              color: MIST_GLASS.timeColor,
              boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.85), 0 0 0 1px rgba(46, 111, 194, 0.16)",
              fontFamily: BRAND_FONT_FAMILY,
              fontSize: 20,
              fontWeight: 700,
              padding: "4px 15px",
              borderRadius: 999
            }}
          >
            02:32
          </span>
          <span style={{fontSize: 28, fontWeight: 680, color: MIST_GLASS.text, letterSpacing: -0.6}}>
            AI 并非越强越好，适配才是关键
          </span>
        </div>
        <div style={{fontSize: 25, fontWeight: 580, lineHeight: 1.46, letterSpacing: -0.4, color: MIST_GLASS.text, marginBottom: 16}}>
          “人与 AI 的关系是<span style={{color: MIST_GLASS.timeColor, fontWeight: 700}}>「协作」</span>，而非<span style={{color: MIST_GLASS.timeColor, fontWeight: 700}}>「替代」</span>。哪怕投喂 100% 准确的数据，依然难以彻底消除幻觉。”
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            paddingTop: 14,
            borderTop: "1px solid rgba(15, 23, 42, 0.06)",
            color: MIST_GLASS.muted,
            fontSize: 19
          }}
        >
          <span>复旦大学 · 赵斌教授公开课</span>
          <span
            style={{
              color: MIST_GLASS.timeColor,
              fontFamily: BRAND_FONT_FAMILY,
              fontWeight: 650,
              background: MIST_GLASS.timeBg,
              padding: "5px 15px",
              borderRadius: 999
            }}
          >
            04:07 – 05:15 ↗
          </span>
        </div>
      </div>

      <div
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "10px 16px",
          borderRadius: 16,
          background: MIST_GLASS.card,
          boxShadow: MIST_GLASS.cardShadow,
          color: MIST_GLASS.muted,
          fontSize: 21,
          fontWeight: 540,
          opacity: 0.78
        }}
      >
        <span
          style={{
            fontFamily: BRAND_FONT_FAMILY,
            fontSize: 18,
            fontWeight: 620,
            color: MIST_GLASS.timeColor,
            background: MIST_GLASS.timeBg,
            padding: "3px 12px",
            borderRadius: 999
          }}
        >
          04:27
        </span>
        <span>人机协作象棋实验与实证</span>
      </div>
    </div>
  </Reveal>
);

const PaletteSwatches = () => {
  const frame = useCurrentFrame();
  const activeIndex = frame >= 33 ? 2 : frame >= 21 ? 1 : 0;
  const palettes = [
    {name: "紫粉 · 橙金", dot: "#E85D87", glow: "rgba(232, 93, 135, 0.22)"},
    {name: "灰蓝 · 深棕", dot: "#7B6B5E", glow: "rgba(123, 107, 94, 0.22)"},
    {name: "雾蓝 · 深海", dot: "#3A6E8C", glow: "rgba(58, 110, 140, 0.22)"}
  ];
  const playerScale = 780 / PLAYER_CROP.width;
  const playerHeight = Math.round(PLAYER_CROP.height * playerScale * 0.78);

  return (
    <Reveal delay={6} distance={16} style={{position: "absolute", left: 96, top: 432, width: 780}}>
      <div style={{display: "flex", gap: 16, marginBottom: 28}}>
        {palettes.map((palette, idx) => {
          const active = idx === activeIndex;
          return (
            <div
              key={palette.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 24px",
                borderRadius: 999,
                background: active ? "rgba(255, 255, 255, 0.98)" : "rgba(255, 255, 255, 0.68)",
                backdropFilter: "blur(20px)",
                boxShadow: active
                  ? `0 18px 42px -16px rgba(17, 24, 39, 0.18), 0 0 24px ${palette.glow}, 0 0 0 1.5px ${palette.dot}`
                  : "0 10px 24px -14px rgba(17, 24, 39, 0.10), 0 0 0 1px rgba(17, 24, 39, 0.04)",
                scale: active ? 1.04 : 1
              }}
            >
              <span style={{width: 14, height: 14, borderRadius: "50%", background: palette.dot, display: "inline-block"}} />
              <span style={{color: COLORS.foreground, fontSize: 22, fontWeight: active ? 600 : 500}}>{palette.name}</span>
            </div>
          );
        })}
      </div>

      <div
        style={{
          position: "relative",
          width: 780,
          height: playerHeight,
          borderRadius: 26,
          overflow: "hidden",
          boxShadow: ELEVATION.videoPlane,
          transform: "perspective(1600px) rotateX(5deg) rotateY(-9deg)",
          background: "#0F172A"
        }}
      >
        <OffthreadVideo
          muted
          src={staticFile("media/subtitle-seek-03.mp4")}
          startFrom={135}
          playbackRate={1}
          style={{
            position: "absolute",
            left: -PLAYER_CROP.x * playerScale,
            top: -PLAYER_CROP.y * playerScale - 24,
            width: 1920 * playerScale,
            height: 1080 * playerScale,
            maxWidth: "none"
          }}
        />
        <VoiceWaveBar timestamp="04:07" quote="“也可能会产生，也很难避免幻觉”" active={false} />
      </div>
    </Reveal>
  );
};

const QuoteShareModalOverlay = ({duration}: {duration: number}) => {
  const frame = useCurrentFrame();
  const activeIndex = frame >= 33 ? 2 : frame >= 21 ? 1 : 0;
  const modalOpacity = interpolate(frame, [10, 15], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1)
  });
  if (modalOpacity <= 0.01) return null;

  const defocusProgress = interpolate(
    frame,
    [Math.max(0, duration - CHAT_HANDOFF.exitFrames), duration],
    [0, 1],
    {extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.4, 0, 1, 1)}
  );
  const blur = CHAT_HANDOFF.maxBlur * defocusProgress;
  const defocusOpacity = 1 - 0.88 * defocusProgress;

  const modalPalettes = [
    {name: "紫粉·橙金", dot: "#E87A90"},
    {name: "灰蓝·深棕", dot: "#7B6B5E"},
    {name: "雾蓝·深海", dot: "#3A6E8C"},
    {name: "雾蓝·墨绿", dot: "#2E5E4E"},
    {name: "薰衣草·深夜紫", dot: "#5B4B8A"},
    {name: "天灰·锈红", dot: "#8C4A3A"}
  ];

  const cardGradients = [
    "linear-gradient(135deg, #9C96C9 0%, #BA88A8 46%, #D98B5F 100%)",
    "linear-gradient(135deg, #8F9AA5 0%, #6D6059 52%, #8C5832 100%)",
    "linear-gradient(135deg, #6E8EA6 0%, #365B77 54%, #1B3952 100%)"
  ];

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: 760,
        borderRadius: 28,
        padding: "28px 34px 26px",
        background: "#FFFFFF",
        boxShadow: "-28px 48px 110px -26px rgba(17, 24, 39, 0.24), 0 0 0 1px rgba(17, 24, 39, 0.06)",
        transformOrigin: "50% 50%",
        transform: microPerspective(-8),
        opacity: modalOpacity * defocusOpacity,
        filter: blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : undefined,
        boxSizing: "border-box"
      }}
    >
      <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20}}>
        <span style={{fontSize: 24, fontWeight: 700, color: COLORS.foreground, letterSpacing: -0.4}}>分享金句卡片</span>
        <span style={{fontSize: 24, color: COLORS.muted, lineHeight: 1}}>×</span>
      </div>

      <div style={{display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 10, marginBottom: 14}}>
        {modalPalettes.map((item, idx) => {
          const active = idx === activeIndex;
          return (
            <div
              key={item.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "7px 16px",
                borderRadius: 999,
                background: active ? "rgba(38, 121, 184, 0.12)" : "#F3F5F8",
                boxShadow: active ? "0 0 0 1.5px rgba(38, 121, 184, 0.48)" : "none",
                color: active ? "#1D63B8" : COLORS.inkSoft,
                fontSize: 16,
                fontWeight: active ? 600 : 500
              }}
            >
              <span style={{width: 10, height: 10, borderRadius: "50%", background: item.dot, display: "inline-block"}} />
              <span>{item.name}</span>
            </div>
          );
        })}
      </div>

      <div style={{display: "flex", justifyContent: "center", gap: 12, marginBottom: 20}}>
        {["无纹样", "射线", "等高线", "声波", "点阵", "透镜"].map((tab, idx) => {
          const active = idx === 1;
          return (
            <div
              key={tab}
              style={{
                padding: "5px 14px",
                borderRadius: 999,
                background: active ? "rgba(38, 121, 184, 0.12)" : "transparent",
                color: active ? "#1D63B8" : COLORS.muted,
                fontSize: 15,
                fontWeight: active ? 600 : 500
              }}
            >
              {tab}
            </div>
          );
        })}
      </div>

      <div
        style={{
          position: "relative",
          borderRadius: 22,
          padding: "30px 38px 28px",
          background: cardGradients[activeIndex],
          overflow: "hidden",
          boxShadow: "0 20px 44px -18px rgba(15, 23, 42, 0.32)"
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              "repeating-conic-gradient(from -15deg at 105% -10%, rgba(255, 255, 255, 0.07) 0deg 2deg, transparent 2deg 7deg)",
            pointerEvents: "none"
          }}
        />
        <div
          style={{
            position: "relative",
            color: "rgba(255, 255, 255, 0.65)",
            fontFamily: "Georgia, serif",
            fontSize: 44,
            lineHeight: 0.9,
            marginBottom: 12
          }}
        >
          “
        </div>
        <div
          style={{
            position: "relative",
            color: "#FFFFFF",
            fontFamily: '"Noto Serif SC", "Songti SC", "SimSun", serif',
            fontSize: 27,
            fontWeight: 500,
            lineHeight: 1.62,
            letterSpacing: 0.2,
            marginBottom: 28
          }}
        >
          他只要去答这个题目，得的就不是零分，但是他如果不答一定是零分。我们训练大模型的时候就是这样训练的，那么在这种情况下，他一定会去蒙。
        </div>
        <div
          style={{
            position: "relative",
            textAlign: "right",
            color: "rgba(255, 255, 255, 0.84)",
            fontSize: 16,
            fontWeight: 500
          }}
        >
          AI并非越强越好，适配才是关键
        </div>
      </div>

      <div style={{display: "flex", alignItems: "center", justifyContent: "center", gap: 22, marginTop: 22}}>
        <div style={{color: COLORS.inkSoft, fontSize: 18, fontWeight: 500}}>⧉ 复制图片</div>
        <div
          style={{
            padding: "10px 26px",
            borderRadius: 999,
            background: "#2B7FFF",
            color: "#FFFFFF",
            fontSize: 18,
            fontWeight: 600,
            boxShadow: "0 10px 22px -8px rgba(43, 127, 255, 0.55)"
          }}
        >
          ↓ 保存 PNG
        </div>
      </div>
    </div>
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
  const baseVideoOpacity = interpolate(frame, [11, 16], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  return (
    <div
      style={{
        position: "absolute",
        left: 1016,
        top: mixLift(340, 88),
        width: 760,
        transformOrigin: "50% 50%",
        scale: interpolate(frame, [0, QUOTE_LIFT_FRAMES, duration], [0.96, 1, 1.015], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp"
        })
      }}
    >
      {baseVideoOpacity > 0.01 && (
        <div style={{opacity: baseVideoOpacity}}>
          <ProductFrame
            source="overview-04-quote.mp4"
            crop={crop}
            width={760}
            startFrom={42}
            playbackRate={QUOTE_SOURCE_SECONDS / (Math.max(1, duration - 12) / fps)}
            duration={duration}
            animate={false}
            tilt={-8}
            focus={{direction: "out", frames: CHAT_HANDOFF.exitFrames, maxBlur: CHAT_HANDOFF.maxBlur}}
            style={{
              left: 0,
              top: 0,
              boxShadow: `-28px ${mixLift(24, 48)}px ${mixLift(64, 110)}px -26px rgba(17, 24, 39, ${mixLift(0.16, 0.24)}), 0 0 0 1px rgba(17, 24, 39, 0.05)`
            }}
          />
        </div>
      )}
      <QuoteShareModalOverlay duration={duration} />
    </div>
  );
};

export const OverviewScene = ({duration}: {duration: number}) => {
  const {fps} = useVideoConfig();
  const chapterDuration = Math.round(duration * 0.43);
  const quoteDuration = duration - chapterDuration;
  return (
    <>
      <BrandWhisper />
      <Sequence durationInFrames={chapterDuration}>
        <SpringLayout direction={-1}>
          <SceneTitle
            title={"这条视频，\n讲了什么？"}
            subtitle="48 分钟课程自动凝练为章节脉络，点按时间直达原片。"
            style={{left: 96, top: 152, width: 720}}
          />
          <SpatialChapterStack />
          <ProductFrame
            source="overview-04-chapters.mp4"
            crop={CHAPTER_CROP}
            width={760}
            tilt={-8}
            playbackRate={CHAPTER_SOURCE_SECONDS / (chapterDuration / fps)}
            duration={chapterDuration}
            style={{left: 1016, top: 68}}
          />
        </SpringLayout>
      </Sequence>
      <Sequence from={chapterDuration} durationInFrames={quoteDuration}>
        <SpringLayout direction={1} fade={false}>
          <SceneTitle
            title={"一句金句，\n生成分享卡片。"}
            subtitle="焦点随视线在空间中自然浮起，多款阅读色板一键分享。"
            size={68}
            style={{left: 96, top: 152, width: 760}}
          />
          <PaletteSwatches />
          <QuoteCamera duration={quoteDuration} />
        </SpringLayout>
      </Sequence>
    </>
  );
};
