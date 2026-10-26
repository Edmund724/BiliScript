import {Easing, OffthreadVideo, interpolate, staticFile, useCurrentFrame, useVideoConfig} from "remotion";
import {SceneTitle, microPerspective} from "./design";

const SOURCE = "subtitle-seek-03.mp4";
const PLAYBACK_RATE = 1.25;

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
      <SceneTitle title="找到那句，回到那一秒。" size={44} style={{left: 58, top: 72, width: 720}} />
    </div>
  );
};

export const SubtitleScene = ({duration}: {duration: number}) => (
  <div style={{position: "absolute", inset: 0, overflow: "hidden", background: "#F6F8FC"}}>
    <Camera duration={duration} />
    <Title />
  </div>
);
