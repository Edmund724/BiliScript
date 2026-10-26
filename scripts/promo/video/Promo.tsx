import {Audio, AbsoluteFill, Sequence, interpolate, staticFile, useCurrentFrame} from "remotion";
import {PROMO_DURATION, SCENES} from "../timeline.mjs";
import {Backdrop, COLORS, SceneShell} from "./design";
import {AppearanceScene, ChatScene} from "./scenes";
import {HeroScene} from "./HeroScene";
import {OutroScene} from "./OutroScene";
import {OverviewScene} from "./OverviewScene";
import {SubtitleScene} from "./SubtitleScene";

const Scene = ({id, duration}: {id: string; duration: number}) => {
  switch (id) {
    case "hero":
      return <HeroScene />;
    case "subtitle":
      return <SubtitleScene duration={duration} />;
    case "overview":
      return <OverviewScene duration={duration} />;
    case "chat":
      return <ChatScene />;
    case "appearance":
      return <AppearanceScene />;
    case "outro":
      return <OutroScene />;
    default:
      throw new Error(`Unknown promo scene: ${id}`);
  }
};

const Soundtrack = () => {
  const frame = useCurrentFrame();
  return (
    <Audio
      src={staticFile("media/Wholesome.mp3")}
      volume={() =>
        interpolate(frame, [0, 24, PROMO_DURATION - 150, PROMO_DURATION - 60, PROMO_DURATION - 1], [0, 0.16, 0.16, 0.13, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp"
        })
      }
    />
  );
};

export const Promo = () => {
  return (
    <AbsoluteFill style={{background: COLORS.background}}>
      <Backdrop />
      {SCENES.map((scene, index) => {
        const duration = scene.duration + (index < SCENES.length - 1 ? 12 : 0);
        return (
          <Sequence key={scene.id} from={scene.from} durationInFrames={duration} premountFor={30}>
            <SceneShell duration={duration} direction={index % 2 === 0 ? 1 : -1} final={index === SCENES.length - 1}>
              <Scene id={scene.id} duration={duration} />
            </SceneShell>
          </Sequence>
        );
      })}
      <Soundtrack />
    </AbsoluteFill>
  );
};
