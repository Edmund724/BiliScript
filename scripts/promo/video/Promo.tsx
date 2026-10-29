import {Audio, AbsoluteFill, Sequence, staticFile} from "remotion";
import {AUDIO, musicVolumeAtFrame} from "../audio.mjs";
import {PANEL_FOCUS_HANDOFFS, PROMO_DURATION, SCENES} from "../timeline.mjs";
import {Backdrop, COLORS, SceneShell} from "./design";
import {AppearanceScene, ChatScene, SubtoolsScene, WebSearchScene} from "./scenes";
import {HeroScene} from "./HeroScene";
import {OutroScene} from "./OutroScene";
import {OverviewScene} from "./OverviewScene";
import {ProviderScene} from "./ProviderScene";
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
    case "subtools":
      return <SubtoolsScene />;
    case "websearch":
      return <WebSearchScene />;
    case "appearance":
      return <AppearanceScene />;
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
    {[...AUDIO.cues, ...AUDIO.voices].map((cue) => (
      <Sequence key={cue.id} from={cue.frame} durationInFrames={PROMO_DURATION - cue.frame}>
        <Audio src={staticFile(cue.src)} volume={cue.gain} />
      </Sequence>
    ))}
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
      fadeOut={!PANEL_FOCUS_HANDOFFS.some((handoff) => handoff.from === id)}
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
              fadeOut={!PANEL_FOCUS_HANDOFFS.some((handoff) => handoff.from === scene.id)}
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
