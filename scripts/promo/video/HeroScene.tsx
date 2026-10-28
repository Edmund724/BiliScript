import {AbsoluteFill, Easing, Img, OffthreadVideo, interpolate, staticFile, useCurrentFrame, useVideoConfig} from "remotion";
import {COLORS, EditorialHeaderBand, FONT_FAMILY} from "./design";

const BUTTON = {x: 1132, y: 1026};
const PANEL = {x: 1326, width: 594};
const POSTER_FRAMES = 5;

const Cursor = ({duration}: {duration: number}) => {
  const frame = useCurrentFrame();
  if (frame < POSTER_FRAMES) return null;
  const clickAt = duration * 0.3;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: BUTTON.x - 25,
          top: BUTTON.y - 25,
          width: 50,
          height: 50,
          border: `3px solid ${COLORS.pink}`,
          borderRadius: "50%",
          opacity: interpolate(frame, [clickAt, clickAt + duration * 0.12], [0.7, 0], {extrapolateLeft: "clamp", extrapolateRight: "clamp"}),
          scale: interpolate(frame, [clickAt, clickAt + duration * 0.12], [0.45, 1.6], {extrapolateLeft: "clamp", extrapolateRight: "clamp"})
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
          filter: "drop-shadow(0 3px 5px rgba(36, 52, 71, 0.35))",
          opacity: interpolate(frame, [POSTER_FRAMES, POSTER_FRAMES + 4, clickAt + duration * 0.05, clickAt + duration * 0.13], [0, 1, 1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp"
          }),
          translate: interpolate(frame, [POSTER_FRAMES, clickAt - 2], ["940px 820px", `${BUTTON.x}px ${BUTTON.y}px`], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1)
          }),
          scale: interpolate(frame, [clickAt - 2, clickAt, clickAt + 3], [1, 0.82, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"})
        }}
      >
        <path d="M3 2 L3 29 L10 23 L16 35 L22 32 L16 21 L26 20 Z" fill="white" stroke={COLORS.foreground} strokeWidth="2" strokeLinejoin="round" />
      </svg>
    </>
  );
};

const ReaderPanel = ({duration}: {duration: number}) => {
  const frame = useCurrentFrame();
  const isPoster = frame < POSTER_FRAMES;
  const clickAt = duration * 0.3;
  const clipRight = isPoster
    ? 0
    : interpolate(frame, [clickAt, clickAt + duration * 0.16], [100, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.bezier(0.16, 1, 0.3, 1)
      });
  const offsetX = isPoster
    ? 0
    : interpolate(frame, [clickAt, clickAt + duration * 0.16], [36, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.bezier(0.16, 1, 0.3, 1)
      });
  const bgOpacity = isPoster
    ? 1
    : interpolate(frame, [clickAt, clickAt + 2], [0, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"});

  return (
    <>
      <div
        style={{
          position: "absolute",
          left: PANEL.x,
          top: 0,
          width: PANEL.width,
          height: 1080,
          background: "#F4F8FC",
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

const HeroMessage = ({duration}: {duration: number}) => {
  const frame = useCurrentFrame();
  const isPoster = frame < POSTER_FRAMES;
  const revealAt = Math.round(duration * 0.46);
  const bandOpacity = isPoster
    ? 1
    : frame < revealAt
      ? 0
      : interpolate(frame, [revealAt, revealAt + 8], [0.38, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.out(Easing.cubic)
        });

  if (!isPoster && frame < revealAt) return null;

  return (
    <EditorialHeaderBand
      title="在 B 站，读视频"
      titleSize={78}
      delay={isPoster ? -20 : revealAt}
      showBrand
      opacity={bandOpacity}
    />
  );
};

const ToolbarEntryCallout = ({duration}: {duration: number}) => {
  const frame = useCurrentFrame();
  const isPoster = frame < POSTER_FRAMES;
  const clickAt = duration * 0.3;
  const opacity = isPoster
    ? 1
    : interpolate(frame, [POSTER_FRAMES, clickAt - 4, clickAt + 6, duration], [0.85, 1, 0.9, 0.9], {
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
        borderRadius: 12,
        border: `2px solid ${COLORS.pink}`,
        boxShadow: "0 0 0 4px rgba(232, 93, 135, 0.14)",
        pointerEvents: "none",
        opacity
      }}
    />
  );
};

export const HeroScene = ({duration = 90}: {duration?: number}) => {
  const {fps} = useVideoConfig();
  return (
    <AbsoluteFill style={{background: COLORS.background, fontFamily: FONT_FAMILY, overflow: "hidden"}}>
      <OffthreadVideo
        muted
        src={staticFile("media/hero-hook.mp4")}
        playbackRate={4 * fps / duration}
        style={{position: "absolute", inset: 0, width: 1920, height: 1080}}
      />
      <ToolbarEntryCallout duration={duration} />
      <ReaderPanel duration={duration} />
      <HeroMessage duration={duration} />
      <Cursor duration={duration} />
    </AbsoluteFill>
  );
};
