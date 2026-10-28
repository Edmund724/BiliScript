import {AbsoluteFill, Easing, Img, OffthreadVideo, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from "remotion";
import {BrandWhisper, COLORS, ELEVATION, EditorialHeaderBand, FONT_FAMILY} from "./design";

const BUTTON = {x: 1132, y: 1026};
const PANEL = {x: 1326, width: 594};
const PULLBACK_START = 48;
const PULLBACK_END = 56;
const CLICK_AT = 56;
const PANEL_OPEN_FRAMES = 12;
const HEADER_REVEAL_AT = 58;
const HERO_SOURCE_CLICK_FRAME = 36;

const QUESTIONS = [
  {
    enterAt: 0,
    prefix: "1 小时公开课，在收藏夹",
    highlight: "吃灰多久了？",
    left: 210,
    top: 204
  },
  {
    enterAt: 16,
    prefix: "记得 UP 主说过那句话，",
    highlight: "死活拖不到那一秒？",
    left: 280,
    top: 430
  },
  {
    enterAt: 32,
    prefix: "看视频卡在半路，",
    highlight: "想追问细节没人答？",
    left: 350,
    top: 656
  }
] as const;

const PainPointQuestionStack = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  if (frame >= PULLBACK_END) return null;

  const collapse = interpolate(frame, [PULLBACK_START, PULLBACK_END], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1)
  });
  const collapseScale = interpolate(collapse, [0, 1], [1, 0.72]);
  const collapseOpacity = interpolate(collapse, [0, 0.82], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const collapseBlur = interpolate(collapse, [0, 1], [0, 12]);
  const whisperOpacity = interpolate(frame, [PULLBACK_START - 2, PULLBACK_START + 4], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });

  return (
    <>
      <BrandWhisper opacity={whisperOpacity} />
      {QUESTIONS.map((question, index) => {
        if (frame < question.enterAt) return null;
        const enterProgress = spring({
          frame: Math.max(0, frame - question.enterAt),
          fps,
          config: {damping: 16, stiffness: 155, mass: 0.78}
        });
        const enterOpacity =
          index === 0
            ? interpolate(frame, [0, 5], [0.92, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"})
            : interpolate(frame, [question.enterAt, question.enterAt + 5], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: Easing.out(Easing.cubic)
              });
        const enterLift = interpolate(enterProgress, [0, 1], [index === 0 ? 10 : 36, 0]);
        const enterScale = interpolate(enterProgress, [0, 1], [index === 0 ? 0.96 : 0.92, 1]);

        let depthLevel = 0;
        for (let nextIdx = index + 1; nextIdx < QUESTIONS.length; nextIdx += 1) {
          depthLevel += interpolate(
            frame,
            [QUESTIONS[nextIdx].enterAt, QUESTIONS[nextIdx].enterAt + 10],
            [0, 1],
            {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.out(Easing.cubic)
            }
          );
        }

        const recedeScale = 1 - depthLevel * 0.032;
        const recedeOpacity = 1 - depthLevel * 0.14;
        const recedeY = -depthLevel * 8;
        const isFrontCard = depthLevel < 0.5;

        return (
          <div
            key={question.highlight}
            style={{
              position: "absolute",
              left: question.left,
              top: question.top,
              padding: "32px 52px",
              borderRadius: 32,
              background: isFrontCard ? "rgba(255, 255, 255, 0.95)" : "rgba(255, 255, 255, 0.88)",
              backdropFilter: "blur(24px)",
              boxShadow: isFrontCard ? ELEVATION.heroFloat : ELEVATION.cardSoft,
              color: COLORS.foreground,
              fontSize: 58,
              fontWeight: 600,
              lineHeight: 1.24,
              letterSpacing: -1.9,
              whiteSpace: "nowrap",
              opacity: enterOpacity * recedeOpacity * collapseOpacity,
              translate: `0px ${enterLift + recedeY - collapse * 24}px`,
              scale: enterScale * recedeScale * collapseScale,
              filter: collapseBlur > 0.2 ? `blur(${collapseBlur.toFixed(1)}px)` : undefined,
              transformOrigin: "50% 50%",
              zIndex: 10 + index
            }}
          >
            <span>{question.prefix}</span>
            <span style={{color: COLORS.pink}}>{question.highlight}</span>
          </div>
        );
      })}
    </>
  );
};

const Cursor = () => {
  const frame = useCurrentFrame();
  if (frame < PULLBACK_END - 5) return null;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: BUTTON.x - 28,
          top: BUTTON.y - 28,
          width: 56,
          height: 56,
          background: "rgba(232, 93, 135, 0.24)",
          boxShadow: "0 0 36px rgba(232, 93, 135, 0.55)",
          borderRadius: "50%",
          opacity: interpolate(frame, [CLICK_AT, CLICK_AT + 10], [0.88, 0], {extrapolateLeft: "clamp", extrapolateRight: "clamp"}),
          scale: interpolate(frame, [CLICK_AT, CLICK_AT + 10], [0.45, 1.65], {extrapolateLeft: "clamp", extrapolateRight: "clamp"})
        }}
      />
      <svg
        viewBox="0 0 30 38"
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 30,
          height: 38,
          filter: "drop-shadow(0 4px 8px rgba(17, 24, 39, 0.35))",
          opacity: interpolate(frame, [PULLBACK_END - 5, PULLBACK_END - 2, CLICK_AT + 5, CLICK_AT + 12], [0, 1, 1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp"
          }),
          translate: interpolate(frame, [PULLBACK_END - 5, CLICK_AT - 1], ["980px 860px", `${BUTTON.x}px ${BUTTON.y}px`], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1)
          }),
          scale: interpolate(frame, [CLICK_AT - 2, CLICK_AT, CLICK_AT + 3], [1, 0.82, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"})
        }}
      >
        <path d="M3 2 L3 29 L10 23 L16 35 L22 32 L16 21 L26 20 Z" fill="white" stroke={COLORS.foreground} strokeWidth="2" strokeLinejoin="round" />
      </svg>
    </>
  );
};

const ReaderPanel = () => {
  const frame = useCurrentFrame();
  if (frame < CLICK_AT) return null;
  const clipRight = interpolate(frame, [CLICK_AT, CLICK_AT + PANEL_OPEN_FRAMES], [100, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1)
  });
  const offsetX = interpolate(frame, [CLICK_AT, CLICK_AT + PANEL_OPEN_FRAMES], [36, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1)
  });
  const bgOpacity = interpolate(frame, [CLICK_AT, CLICK_AT + 2], [0, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"});

  return (
    <>
      <div
        style={{
          position: "absolute",
          left: PANEL.x,
          top: 0,
          width: PANEL.width,
          height: 1080,
          background: "#FBFBFD",
          boxShadow: "-36px 0 96px -20px rgba(17, 24, 39, 0.24)",
          opacity: bgOpacity
        }}
      />
      <div
        style={{
          position: "absolute",
          left: PANEL.x,
          top: 0,
          width: PANEL.width,
          height: 1080,
          overflow: "hidden",
          clipPath: `inset(0 0 0 ${clipRight}%)`,
          translate: `${offsetX}px 0px`
        }}
      >
        <Img src={staticFile("media/hero-panel.png")} style={{position: "absolute", left: -PANEL.x, top: 0, width: 1920, height: 1080, maxWidth: "none"}} />
      </div>
    </>
  );
};

const HeroMessage = () => {
  const frame = useCurrentFrame();
  if (frame < HEADER_REVEAL_AT) return null;
  const bandOpacity = interpolate(frame, [HEADER_REVEAL_AT, HEADER_REVEAL_AT + 8], [0.38, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic)
  });

  return (
    <EditorialHeaderBand
      title="别光看，试试在 B 站「读」视频。"
      titleNode={
        <>
          别光看，试试在 B 站<span style={{color: COLORS.pink}}>「读」</span>视频。
        </>
      }
      titleSize={46}
      delay={HEADER_REVEAL_AT}
      showBrand
      opacity={bandOpacity}
    />
  );
};

const ToolbarEntryCallout = () => {
  const frame = useCurrentFrame();
  if (frame < PULLBACK_END - 4 || frame > CLICK_AT + 10) return null;
  const opacity = interpolate(frame, [PULLBACK_END - 4, CLICK_AT - 1, CLICK_AT + 2, CLICK_AT + 10], [0, 1, 0.92, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  return (
    <div
      style={{
        position: "absolute",
        left: BUTTON.x - 44,
        top: BUTTON.y - 22,
        width: 88,
        height: 44,
        borderRadius: 999,
        background: "rgba(232, 93, 135, 0.14)",
        boxShadow: "0 0 28px 4px rgba(232, 93, 135, 0.32), 0 0 0 1px rgba(232, 93, 135, 0.38)",
        pointerEvents: "none",
        opacity
      }}
    />
  );
};

export const HeroScene = () => {
  const frame = useCurrentFrame();
  const pullbackProgress = interpolate(frame, [PULLBACK_START, PULLBACK_END], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1)
  });
  const hookDriftScale = interpolate(frame, [0, PULLBACK_START], [1.38, 1.34], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const videoScale = interpolate(pullbackProgress, [0, 1], [hookDriftScale, 1]);
  const videoBlur = interpolate(pullbackProgress, [0, 1], [12, 0]);
  const veilOpacity = interpolate(pullbackProgress, [0, 1], [1, 0]);

  return (
    <AbsoluteFill style={{background: COLORS.background, fontFamily: FONT_FAMILY, overflow: "hidden"}}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          transformOrigin: "54% 46%",
          scale: videoScale,
          filter: videoBlur > 0.1 ? `blur(${videoBlur.toFixed(2)}px)` : undefined
        }}
      >
        <OffthreadVideo
          muted
          src={staticFile("media/hero-hook.mp4")}
          playbackRate={HERO_SOURCE_CLICK_FRAME / CLICK_AT}
          style={{position: "absolute", inset: 0, width: 1920, height: 1080}}
        />
      </div>
      {veilOpacity > 0.01 ? (
        <AbsoluteFill
          style={{
            background: [
              "radial-gradient(ellipse 55% 60% at 24% 42%, rgba(232, 93, 135, 0.08) 0%, rgba(232, 93, 135, 0) 70%)",
              "radial-gradient(ellipse 60% 65% at 78% 52%, rgba(38, 121, 184, 0.08) 0%, rgba(38, 121, 184, 0) 72%)",
              "linear-gradient(160deg, rgba(251, 251, 253, 0.58) 0%, rgba(244, 245, 248, 0.52) 100%)"
            ].join(", "),
            opacity: veilOpacity,
            pointerEvents: "none"
          }}
        />
      ) : null}
      <ToolbarEntryCallout />
      <ReaderPanel />
      <HeroMessage />
      <Cursor />
      <PainPointQuestionStack />
    </AbsoluteFill>
  );
};
