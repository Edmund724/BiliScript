import {Audio, AbsoluteFill, Sequence, staticFile} from "remotion";
import {AUDIO, cueMixStartFrame, musicVolumeAtFrame} from "../audio.mjs";
import {PANEL_FOCUS_HANDOFFS, PROMO_DURATION, SCENES} from "../timeline.mjs";
import {Backdrop, COLORS, SceneShell} from "./design";
import {ChatScene, SubtoolsScene, WebSearchScene} from "./scenes";
import {LiveScene} from "./LiveScene";
import {OutroScene} from "./OutroScene";
import {OverviewScene} from "./OverviewScene";
import {ProviderScene} from "./ProviderScene";
import {SubtitleScene} from "./SubtitleScene";

const isSeamlessOutgoing = (id: string) =>
  PANEL_FOCUS_HANDOFFS.some((handoff) => handoff.from === id) || id === "subtitle";

const Scene = ({id, duration}: {id: string; duration: number}) => {
  switch (id) {
    case "subtitle":
      return <SubtitleScene duration={duration} />;
    case "overview":
      return <OverviewScene duration={duration} />;
    case "chat":
      return <ChatScene />;
    case "live":
      return <LiveScene />;
    case "subtools":
      return <SubtoolsScene />;
    case "websearch":
      return <WebSearchScene />;
    case "providers":
      return <ProviderScene />;
    case "outro":
      return <OutroScene />;
    default:
      throw new Error(`Unknown promo scene: ${id}`);
  }
};

const Soundtrack = () => (
  <>
    <Audio src={staticFile(AUDIO.music.src)} volume={musicVolumeAtFrame} />
    {[...AUDIO.cues, ...AUDIO.voices].map((cue) => {
      const fromFrame = cueMixStartFrame(cue);
      return (
        <Sequence key={cue.id} from={fromFrame} durationInFrames={PROMO_DURATION - fromFrame}>
          <Audio src={staticFile(cue.src)} volume={cue.gain} />
        </Sequence>
      );
    })}
  </>
);

export type PromoSceneProps = {
  id: string;
  duration: number;
  final?: boolean;
};

export const PromoScene = ({id, duration, final = false}: PromoSceneProps) => (
  <AbsoluteFill style={{background: COLORS.background}}>
    <Backdrop />
    <SceneShell
      duration={duration}
      final={final}
      fadeOut={!isSeamlessOutgoing(id)}
    >
      <Scene id={id} duration={duration} />
    </SceneShell>
  </AbsoluteFill>
);

export const Promo = () => {
  return (
    <AbsoluteFill style={{background: COLORS.background}}>
      <Backdrop />
      {SCENES.map((scene, index) => {
        const duration = scene.duration;
        return (
          <Sequence key={scene.id} from={scene.from} durationInFrames={duration}>
            <SceneShell
              duration={duration}
              final={index === SCENES.length - 1}
              fadeOut={!isSeamlessOutgoing(scene.id)}
            >
              <Scene id={scene.id} duration={duration} />
            </SceneShell>
          </Sequence>
        );
      })}
      <Soundtrack />
    </AbsoluteFill>
  );
};
