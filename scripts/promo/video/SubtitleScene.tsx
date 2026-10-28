import {Easing, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig} from "remotion";
import {
  SUBTITLE_ANCHORS,
  SUBTITLE_DURATION,
  SUBTITLE_MATCH_FRAME,
  SUBTITLE_PLAYBACK_RATE,
  SUBTITLE_SECOND_SHOT_SOURCE_FRAME,
  subtitleCameraAtFrame
} from "../subtitle-timeline.mjs";
import {COLORS, EditorialHeaderBand, microPerspective} from "./design";

const SOURCE = "subtitle-seek-03.mp4";

const Keyword = () => {
  const frame = useCurrentFrame();
  const left = interpolate(frame, [10, 12], [1420, 1404], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1)
  });
  const top = interpolate(frame, [10, 12], [365, 210], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1)
  });
  const scale = interpolate(frame, [10, 12], [1, 0.2], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1)
  });
  const slices = [
    {clip: "inset(0 0 66.66% 0)", color: COLORS.foreground, offset: -34},
    {clip: "inset(33.33% 0 33.33% 0)", color: COLORS.pink, offset: 28},
    {clip: "inset(66.66% 0 0 0)", color: "#779DBE", offset: -22}
  ];
  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        width: 180,
        height: 94,
        opacity: interpolate(frame, [23, 24], [1, 0], {extrapolateLeft: "clamp", extrapolateRight: "clamp"}),
        transformOrigin: "0 0",
        scale
      }}
    >
      {slices.map((slice, index) => {
        const x = interpolate(frame, [0, 3, 10], [slice.offset, slice.offset, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.bezier(0.16, 1, 0.3, 1)
        });
        return (
          <div
            key={index}
            style={{
              position: "absolute",
              inset: 0,
              clipPath: slice.clip,
              color: frame >= 10 ? COLORS.foreground : slice.color,
              fontSize: 84,
              fontWeight: 500,
              lineHeight: "94px",
              letterSpacing: -2,
              whiteSpace: "nowrap",
              translate: `${x}px 0px`
            }}
          >
            幻觉
          </div>
        );
      })}
    </div>
  );
};

const TimestampMatchCallout = () => {
  const frame = useCurrentFrame();
  if (frame < 40 || frame > 72) return null;
  const anchor = frame < SUBTITLE_MATCH_FRAME ? SUBTITLE_ANCHORS.before.center : SUBTITLE_ANCHORS.after.center;
  const ringOpacity = interpolate(frame, [42, 48, 61, 68], [0, 0.9, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const rippleScale = interpolate(frame, [59, 67], [0.75, 1.55], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  return (
    <div
      style={{
        position: "absolute",
        left: anchor.x - 44,
        top: anchor.y - 16,
        width: 240,
        height: 34,
        borderRadius: 10,
        border: `2px solid ${COLORS.pink}`,
        background: "rgba(232, 93, 135, 0.10)",
        boxShadow: "0 10px 24px -10px rgba(232, 93, 135, 0.45)",
        opacity: ringOpacity,
        scale: frame >= 59 ? rippleScale : 1,
        transformOrigin: "18% 50%",
        pointerEvents: "none"
      }}
    />
  );
};

const PlayerFeedback = ({duration}: {duration: number}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [72, 82, duration - 10, duration], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  return (
    <div
      style={{
        position: "absolute",
        left: 54,
        top: 171,
        width: 1272,
        height: 764,
        borderRadius: 8,
        boxShadow: "inset 0 0 0 3px rgba(232, 93, 135, 0.82), 0 24px 60px -28px rgba(232, 93, 135, 0.28)",
        opacity,
        pointerEvents: "none"
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 24,
          top: 22,
          padding: "8px 18px",
          borderRadius: 999,
          background: "rgba(36, 52, 71, 0.88)",
          border: "1px solid rgba(232, 93, 135, 0.55)",
          color: "#FFFFFF",
          fontSize: 18,
          fontWeight: 600,
          letterSpacing: -0.2,
          display: "flex",
          alignItems: "center",
          gap: 10
        }}
      >
        <span style={{width: 9, height: 9, borderRadius: "50%", background: COLORS.pink, display: "inline-block"}} />
        <span>已跳播至 04:07 · 「也很难避免幻觉」</span>
      </div>
    </div>
  );
};

const Camera = ({duration}: {duration: number}) => {
  const frame = useCurrentFrame();
  const camera = subtitleCameraAtFrame(frame);
  const videoProps = {
    muted: true,
    src: staticFile(`media/${SOURCE}`),
    playbackRate: SUBTITLE_PLAYBACK_RATE,
    style: {width: 1920, height: 1080, maxWidth: "none"} as const
  };
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        transformOrigin: "0 0",
        transform: microPerspective(camera.tilt),
        scale: camera.scale,
        translate: `${camera.x}px ${camera.y}px`
      }}
    >
      <Sequence durationInFrames={SUBTITLE_MATCH_FRAME}>
        <OffthreadVideo {...videoProps} />
      </Sequence>
      <Sequence from={SUBTITLE_MATCH_FRAME} durationInFrames={SUBTITLE_DURATION - SUBTITLE_MATCH_FRAME}>
        <OffthreadVideo {...videoProps} startFrom={SUBTITLE_SECOND_SHOT_SOURCE_FRAME} />
      </Sequence>
      <Keyword />
      <TimestampMatchCallout />
      <PlayerFeedback duration={duration} />
    </div>
  );
};

const Title = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const opacity = interpolate(frame, [0, 4, Math.round(1.35 * fps), Math.round(1.65 * fps)], [0.38, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  if (opacity <= 0.01) return null;
  return <EditorialHeaderBand title="找到那句，回到那一秒。" titleSize={54} kicker="字幕检索" delay={0} opacity={opacity} />;
};

export const SubtitleScene = ({duration}: {duration: number}) => (
  <div style={{position: "absolute", inset: 0, overflow: "hidden", background: COLORS.background}}>
    <Camera duration={duration} />
    <Title />
  </div>
);
