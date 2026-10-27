import {Easing, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig} from "remotion";
import {SUBTITLE_DURATION, SUBTITLE_MATCH_FRAME, SUBTITLE_PLAYBACK_RATE, SUBTITLE_SECOND_SHOT_SOURCE_FRAME, subtitleCameraAtFrame} from "../subtitle-timeline.mjs";
import {COLORS, SceneTitle, microPerspective} from "./design";

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

const PlayerFeedback = ({duration}: {duration: number}) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        position: "absolute",
        left: 54,
        top: 171,
        width: 1272,
        height: 764,
        borderRadius: 4,
        boxShadow: "inset 0 0 0 2px rgba(232, 93, 135, 0.72)",
        opacity: interpolate(frame, [75, 84, duration - 12, duration], [0, 1, 1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp"
        })
      }}
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
      <PlayerFeedback duration={duration} />
    </div>
  );
};

const Title = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  return (
    <div
      style={{
        opacity: interpolate(frame, [0, 0.2 * fps, 0.65 * fps, 0.9 * fps], [0, 1, 1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp"
        })
      }}
    >
      <SceneTitle title="找到那句，回到那一秒。" size={54} style={{left: 104, top: 72, width: 820}} />
    </div>
  );
};

export const SubtitleScene = ({duration}: {duration: number}) => (
  <div style={{position: "absolute", inset: 0, overflow: "hidden", background: COLORS.background}}>
    <Camera duration={duration} />
    <Title />
  </div>
);
