import {Easing, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame} from "remotion";
import {
  SUBTITLE_ANCHORS,
  SUBTITLE_DURATION,
  SUBTITLE_MATCH_FRAME,
  SUBTITLE_PLAYBACK_RATE,
  SUBTITLE_SECOND_SHOT_SOURCE_FRAME,
  subtitleCameraAtFrame
} from "../subtitle-timeline.mjs";
import {COLORS, EditorialHeaderBand, VoiceWaveBar, microPerspective} from "./design";

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
  if (frame < 55 || frame > 68) return null;
  const anchor = frame < SUBTITLE_MATCH_FRAME ? SUBTITLE_ANCHORS.before.center : SUBTITLE_ANCHORS.after.center;
  const ringOpacity = interpolate(frame, [55, 58, 63, 68], [0, 0.92, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const rippleScale = interpolate(frame, [59, 67], [0.85, 1.45], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  return (
    <div
      style={{
        position: "absolute",
        left: anchor.x - 32,
        top: anchor.y - 15,
        width: 64,
        height: 30,
        borderRadius: 999,
        background: "rgba(232, 93, 135, 0.16)",
        boxShadow: "0 12px 28px -6px rgba(232, 93, 135, 0.45), 0 0 0 1.5px rgba(232, 93, 135, 0.38)",
        opacity: ringOpacity,
        scale: frame >= 59 ? rippleScale : 1,
        transformOrigin: "50% 50%",
        pointerEvents: "none"
      }}
    />
  );
};

const PlayerFeedback = ({duration}: {duration: number}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [64, 74, duration - 10, duration], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  if (opacity <= 0.01) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: 54,
        top: 171,
        width: 1272,
        height: 764,
        borderRadius: 20,
        boxShadow: "0 48px 100px -28px rgba(17, 24, 39, 0.24), 0 0 64px rgba(232, 93, 135, 0.22), 0 0 0 1px rgba(232, 93, 135, 0.22)",
        opacity,
        pointerEvents: "none"
      }}
    />
  );
};

const SubtitleVoiceOverlay = ({duration}: {duration: number}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [64, 74, duration - 10, duration], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  if (opacity <= 0.01) return null;
  return (
    <VoiceWaveBar
      timestamp="04:07"
      quote="“也很难避免幻觉”"
      active={frame >= 63 && frame <= 112}
      style={{left: 88, top: 56, opacity}}
    />
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
        transform: camera.tilt === 0 ? undefined : microPerspective(camera.tilt),
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
  const opacity = interpolate(frame, [0, 4, 28, 36], [0.38, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  if (opacity <= 0.01) return null;
  return <EditorialHeaderBand title="找到那句，回到那一秒。" titleSize={52} delay={0} opacity={opacity} />;
};

export const SubtitleScene = ({duration}: {duration: number}) => (
  <div style={{position: "absolute", inset: 0, overflow: "hidden", background: COLORS.background}}>
    <Camera duration={duration} />
    <SubtitleVoiceOverlay duration={duration} />
    <Title />
  </div>
);
