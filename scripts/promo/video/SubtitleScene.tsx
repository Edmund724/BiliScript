import {Easing, OffthreadVideo, interpolate, staticFile, useCurrentFrame, useVideoConfig} from "remotion";
import {COLORS, SceneTitle, microPerspective} from "./design";

const SOURCE = "subtitle-seek-03.mp4";
const PLAYBACK_RATE = 1.25;

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
  const {fps} = useVideoConfig();
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
        opacity: interpolate(frame, [2.2 * fps, 2.4 * fps, duration - 12, duration], [0, 1, 1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp"
        })
      }}
    />
  );
};

const Camera = ({duration}: {duration: number}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const tilt = interpolate(frame, [0.3 * fps, 0.75 * fps, 1.85 * fps, 2.2 * fps], [0, -6, -6, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1)
  });
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        transformOrigin: "0 0",
        transform: microPerspective(tilt),
        scale: interpolate(frame, [0.3 * fps, 0.75 * fps, 1.5 * fps, 1.85 * fps, 2.2 * fps, 2.25 * fps], [1, 2, 2, 2, 1, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.bezier(0.16, 1, 0.3, 1)
        }),
        translate: interpolate(
          frame,
          [0.3 * fps, 0.75 * fps, 1.5 * fps, 1.85 * fps, 2.2 * fps, 2.25 * fps],
          ["0px 0px", "-1540px -232px", "-1540px -232px", "-1410px -400px", "0px 0px", "0px 0px"],
          {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1)
          }
        )
      }}
    >
      <OffthreadVideo
        muted
        src={staticFile(`media/${SOURCE}`)}
        playbackRate={PLAYBACK_RATE}
        style={{width: 1920, height: 1080, maxWidth: "none"}}
      />
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
