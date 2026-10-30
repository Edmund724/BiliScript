import {AbsoluteFill, Easing, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame} from "remotion";
import {HERO_TIMELINE} from "../timeline.mjs";
import {COLORS, ELEVATION, FONT_FAMILY, PaperGrainOverlay} from "./design";

const PANEL = {x: 1365, y: 64, width: 540, height: 1016};
const ICON = {x: 1359, y: 563, size: 36};
const CAMERA = {originX: 1470 / 1920, originY: 0.5, zoom: 2.05, drift: 0.04};

export const HERO_SOURCE = {
  recording: "media/hero-hook.mp4",
  panelFrame: 43,
  promptFrame: 60,
  answerFrame: 309,
  answerPlaybackRate: 0.7
};

export const HERO_FIRST_LINE = "点一下播放器，";
export const HERO_SECOND_LINE = "整期视频自动读完。";
export const HERO_FEATURE_LINE = "TL;DR · 分节要点 · 时间戳";

const HeroCopy = () => {
  const frame = useCurrentFrame();
  const line1 = interpolate(frame, [HERO_TIMELINE.firstLineAt, HERO_TIMELINE.firstLineAt + 14], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic)
  });
  const line2 = interpolate(frame, [HERO_TIMELINE.iconAt + 2, HERO_TIMELINE.iconAt + 14], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic)
  });
  const feature = interpolate(frame, [HERO_TIMELINE.pageTurnAt + 2, HERO_TIMELINE.pageTurnAt + 14], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic)
  });
  const underline = interpolate(frame, [HERO_TIMELINE.iconAt + 6, HERO_TIMELINE.iconAt + 16], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1)
  });

  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 250,
          width: 780,
          height: 370,
          background:
            "radial-gradient(ellipse 68% 62% at 28% 46%, rgba(8, 16, 30, 0.38) 0%, rgba(8, 16, 30, 0.16) 52%, rgba(8, 16, 30, 0) 74%)",
          opacity: line1,
          pointerEvents: "none",
          zIndex: 24
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 96,
          top: 350,
          width: 600,
          zIndex: 30,
          pointerEvents: "none",
          color: "#FFFFFF",
          textShadow: "0 2px 26px rgba(6, 12, 24, 0.62), 0 1px 3px rgba(6, 12, 24, 0.72)"
        }}
      >
        <div
          style={{
            fontSize: 64,
            lineHeight: 1.16,
            fontWeight: 700,
            letterSpacing: -2.2,
            whiteSpace: "nowrap",
            opacity: line1,
            translate: `0px ${((1 - line1) * 22).toFixed(1)}px`
          }}
        >
          {HERO_FIRST_LINE}
        </div>
        <div
          style={{
            fontSize: 64,
            lineHeight: 1.16,
            fontWeight: 700,
            letterSpacing: -2.2,
            whiteSpace: "nowrap",
            opacity: line2,
            translate: `0px ${((1 - line2) * 22).toFixed(1)}px`
          }}
        >
          整期视频
          <span style={{position: "relative", display: "inline-block"}}>
            自动读完
            <span
              style={{
                position: "absolute",
                left: -2,
                right: -2,
                bottom: -1,
                height: 4,
                borderRadius: 2,
                background: "linear-gradient(96deg, rgba(255, 212, 59, 0.95) 0%, rgba(251, 114, 153, 0.95) 100%)",
                boxShadow: "0 0 14px rgba(232, 93, 135, 0.55)",
                transformOrigin: "0% 50%",
                transform: `scaleX(${underline.toFixed(3)})`
              }}
            />
          </span>
          。
        </div>
        <div
          style={{
            marginTop: 22,
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontSize: 26,
            lineHeight: 1.4,
            fontWeight: 500,
            letterSpacing: 0.4,
            color: "rgba(255, 255, 255, 0.94)",
            opacity: feature,
            translate: `0px ${((1 - feature) * 14).toFixed(1)}px`
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "#FFA7C2",
              boxShadow: "0 0 12px rgba(255, 167, 194, 0.95)"
            }}
          />
          {HERO_FEATURE_LINE}
        </div>
      </div>
    </>
  );
};

const PageSheet = () => {
  const frame = useCurrentFrame();
  if (frame < HERO_SOURCE.panelFrame || frame >= HERO_TIMELINE.answerAt) return null;

  const land = interpolate(frame, [HERO_SOURCE.panelFrame, HERO_TIMELINE.pageTurnAt], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic)
  });
  const open = interpolate(frame, [HERO_TIMELINE.pageTurnAt, HERO_TIMELINE.answerAt - 2], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.quad)
  });
  const angle = open * 104;
  const opacity = interpolate(frame, [42, HERO_SOURCE.panelFrame, 62, HERO_TIMELINE.answerAt], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });

  return (
    <div
      style={{
        position: "absolute",
        left: PANEL.x,
        top: PANEL.y,
        width: PANEL.width,
        height: PANEL.height,
        zIndex: 8,
        pointerEvents: "none"
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 24,
          overflow: "hidden",
          opacity,
          transformOrigin: "0% 50%",
          transform: `translateY(${((1 - land) * -34).toFixed(1)}px) perspective(1800px) rotateX(${((1 - land) * 8).toFixed(2)}deg) rotateY(${angle.toFixed(2)}deg)`,
          background: "linear-gradient(158deg, #FFFFFF 0%, #FFFDF8 44%, #F7F1E6 100%)",
          boxShadow: `${ELEVATION.heroFloat}, -34px 26px 76px -26px rgba(17, 24, 39, 0.34)`,
          backfaceVisibility: "hidden"
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 28,
            top: 0,
            width: 12,
            height: 118,
            borderRadius: "0 0 8px 8px",
            background: "linear-gradient(180deg, rgba(232, 93, 135, 0.86), rgba(251, 114, 153, 0.42))",
            boxShadow: "0 12px 24px -10px rgba(232, 93, 135, 0.55)"
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 64,
            top: 62,
            color: "rgba(29, 41, 57, 0.34)",
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: 2
          }}
        >
          文摘
        </div>
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <div
            key={index}
            style={{
              position: "absolute",
              left: 64,
              top: 136 + index * 42,
              width: index === 5 ? 236 : index === 4 ? 352 : 416,
              height: 9,
              borderRadius: 5,
              background: index === 0 ? "rgba(29, 41, 57, 0.18)" : "rgba(29, 41, 57, 0.07)"
            }}
          />
        ))}
        <PaperGrainOverlay opacity={0.12} warm borderRadius={24} />
      </div>
    </div>
  );
};

const IconOrbit = () => {
  const frame = useCurrentFrame();
  if (frame < HERO_TIMELINE.iconAt || frame >= HERO_TIMELINE.pageTurnAt) return null;

  const appear = interpolate(frame, [HERO_TIMELINE.iconAt, HERO_TIMELINE.iconAt + 7], [0.35, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic)
  });
  const fade = interpolate(frame, [HERO_SOURCE.panelFrame, HERO_SOURCE.panelFrame + 4], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const hover = interpolate(frame, [33, 36], [0, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"});
  const pulse = frame >= HERO_TIMELINE.clickAt
    ? interpolate(frame, [HERO_TIMELINE.clickAt, HERO_TIMELINE.clickAt + 3, HERO_TIMELINE.clickAt + 12], [0, 1, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.cubic)
      })
    : 0;
  const center = {x: ICON.x + ICON.size / 2, y: ICON.y + ICON.size / 2};

  return (
    <>
      <div
        style={{
          position: "absolute",
          left: center.x,
          top: center.y,
          width: 92,
          height: 92,
          translate: "-50% -50%",
          borderRadius: "50%",
          border: "2px solid rgba(232, 93, 135, 0.92)",
          boxShadow: `0 0 26px rgba(232, 93, 135, ${(0.42 + hover * 0.2).toFixed(2)}), inset 0 0 22px rgba(232, 93, 135, 0.28)`,
          opacity: appear * fade,
          scale: 0.84 + appear * 0.16 + hover * 0.03,
          zIndex: 18
        }}
      />
      <div
        style={{
          position: "absolute",
          left: center.x,
          top: center.y,
          width: 40,
          height: 40,
          translate: "-50% -50%",
          borderRadius: "50%",
          border: "2px solid rgba(232, 93, 135, 0.9)",
          opacity: pulse * 0.9,
          scale: 0.7 + pulse * 2.1,
          zIndex: 19
        }}
      />
      <div
        style={{
          position: "absolute",
          left: center.x,
          top: center.y,
          width: 56,
          height: 56,
          translate: "-50% -50%",
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(255, 255, 255, 0.82) 0%, rgba(255, 203, 219, 0.42) 52%, rgba(232, 93, 135, 0) 72%)",
          opacity: pulse * 0.8,
          zIndex: 17
        }}
      />
    </>
  );
};

const CURSOR_PATH = [
  {frame: 0, x: 2006, y: 792},
  {frame: 10, x: 1852, y: 726},
  {frame: 20, x: 1638, y: 626},
  {frame: 29, x: 1468, y: 590},
  {frame: 35, x: 1392, y: 584},
  {frame: HERO_TIMELINE.clickAt, x: 1377, y: 581}
] as const;

const Cursor = () => {
  const frame = useCurrentFrame();
  const x = interpolate(frame, CURSOR_PATH.map((point) => point.frame), CURSOR_PATH.map((point) => point.x), {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const y = interpolate(frame, CURSOR_PATH.map((point) => point.frame), CURSOR_PATH.map((point) => point.y), {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const opacity = interpolate(frame, [0, 3, 42, 49], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const press = interpolate(frame, [HERO_TIMELINE.clickAt - 2, HERO_TIMELINE.clickAt, HERO_TIMELINE.clickAt + 3], [1, 0.82, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  if (opacity <= 0.01) return null;

  return (
    <svg
      viewBox="0 0 30 38"
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: 34,
        height: 43,
        translate: `${x}px ${y}px`,
        filter: "drop-shadow(0 4px 9px rgba(8, 15, 30, 0.42))",
        opacity,
        scale: press,
        zIndex: 22
      }}
    >
      <path d="M3 2 L3 29 L10 23 L16 35 L22 32 L16 21 L26 20 Z" fill="white" stroke={COLORS.foreground} strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
};

const HeroVideo = () => {
  return (
    <>
      <Sequence from={0} durationInFrames={HERO_SOURCE.panelFrame}>
        <OffthreadVideo
          muted
          src={staticFile(HERO_SOURCE.recording)}
          playbackRate={1}
          style={{position: "absolute", inset: 0, width: 1920, height: 1080}}
        />
      </Sequence>
      <Sequence from={HERO_SOURCE.panelFrame} durationInFrames={HERO_TIMELINE.answerAt - HERO_SOURCE.panelFrame} premountFor={12}>
        <OffthreadVideo
          muted
          src={staticFile(HERO_SOURCE.recording)}
          trimBefore={HERO_SOURCE.promptFrame}
          playbackRate={1}
          style={{position: "absolute", inset: 0, width: 1920, height: 1080}}
        />
      </Sequence>
      <Sequence from={HERO_TIMELINE.answerAt} premountFor={24}>
        <OffthreadVideo
          muted
          src={staticFile(HERO_SOURCE.recording)}
          trimBefore={HERO_SOURCE.answerFrame}
          playbackRate={HERO_SOURCE.answerPlaybackRate}
          style={{position: "absolute", inset: 0, width: 1920, height: 1080}}
        />
      </Sequence>
      <PageSheet />
    </>
  );
};

export const HeroScene = () => {
  const frame = useCurrentFrame();
  const pan = interpolate(frame, [HERO_TIMELINE.pushInFrom, HERO_TIMELINE.pushInFrom + 14], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic)
  });
  const zoom = interpolate(frame, [HERO_TIMELINE.pushInFrom, HERO_TIMELINE.pushInTo], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic)
  });
  const settle = interpolate(frame, [HERO_TIMELINE.pushInTo, HERO_TIMELINE.holdAt], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic)
  });
  const cameraScale = 1 + zoom * (CAMERA.zoom - 1) + settle * CAMERA.drift;
  const focusX = 960 + (CAMERA.originX * 1920 - 960) * pan;
  const focusY = 540 + (CAMERA.originY * 1080 - 540) * pan;
  const cameraLeft = 960 - focusX * cameraScale;
  const cameraTop = 540 - focusY * cameraScale;

  return (
    <AbsoluteFill style={{background: COLORS.background, fontFamily: FONT_FAMILY, overflow: "hidden"}}>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 1920,
          height: 1080,
          transformOrigin: "0 0",
          transform: `translate(${cameraLeft.toFixed(2)}px, ${cameraTop.toFixed(2)}px) scale(${cameraScale.toFixed(4)})`
        }}
      >
        <HeroVideo />
      </div>
      <IconOrbit />
      <Cursor />
      <HeroCopy />
    </AbsoluteFill>
  );
};
