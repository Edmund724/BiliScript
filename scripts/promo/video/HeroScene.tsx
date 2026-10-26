import {AbsoluteFill, Easing, Img, OffthreadVideo, interpolate, staticFile, useCurrentFrame, useVideoConfig} from "remotion";
import {Brand, COLORS, FONT_FAMILY, Reveal} from "./design";

const BUTTON = {x: 1132, y: 1026};
const PANEL = {x: 1326, width: 594};

const Cursor = ({duration}: {duration: number}) => {
  const frame = useCurrentFrame();
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
          opacity: interpolate(frame, [clickAt, clickAt + duration * 0.12], [0.65, 0], {extrapolateLeft: "clamp", extrapolateRight: "clamp"}),
          scale: interpolate(frame, [clickAt, clickAt + duration * 0.12], [0.45, 1.55], {extrapolateLeft: "clamp", extrapolateRight: "clamp"})
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
          opacity: interpolate(frame, [0, duration * 0.06, clickAt + duration * 0.04, clickAt + duration * 0.12], [0, 1, 1, 0], {extrapolateLeft: "clamp", extrapolateRight: "clamp"}),
          translate: interpolate(frame, [duration * 0.06, clickAt - 2], ["940px 820px", `${BUTTON.x}px ${BUTTON.y}px`], {
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
  const clickAt = duration * 0.3;
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
          opacity: interpolate(frame, [clickAt, clickAt + 2], [0, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"})
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
          clipPath: `inset(0 0 0 ${interpolate(frame, [clickAt, clickAt + duration * 0.16], [100, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1)
          })}%)`,
          translate: `${interpolate(frame, [clickAt, clickAt + duration * 0.16], [36, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1)
          })}px 0px`
        }}
      >
        <Img src={staticFile("media/hero-panel.png")} style={{position: "absolute", left: -PANEL.x, top: 0, width: 1920, height: 1080, maxWidth: "none"}} />
      </div>
    </>
  );
};

const HeroMessage = ({duration}: {duration: number}) => {
  const frame = useCurrentFrame();
  const clickAt = duration * 0.3;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 480,
          width: PANEL.x,
          height: 600,
          background: "linear-gradient(180deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.94) 42%, #FFFFFF 100%)",
          opacity: interpolate(frame, [clickAt + duration * 0.08, duration * 0.5], [0, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"})
        }}
      />
      <Reveal delay={Math.round(duration * 0.5)} distance={22} style={{position: "absolute", left: 104, top: 706}}>
        <Brand size={32} iconSize={42} />
        <div style={{marginTop: 26, color: COLORS.foreground, fontSize: 66, lineHeight: 1.25, fontWeight: 600, letterSpacing: -2}}>
          在 B 站，读视频
        </div>
      </Reveal>
    </>
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
      <ReaderPanel duration={duration} />
      <HeroMessage duration={duration} />
      <Cursor duration={duration} />
    </AbsoluteFill>
  );
};
