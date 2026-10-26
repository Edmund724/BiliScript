import {Sequence} from "remotion";
import {APPEARANCE_SHOTS, CHAT_SHOTS} from "../timeline.mjs";
import {Crop, PANEL_CROPS, ProductFrame, SceneTitle, SpringLayout} from "./design";

const CHAT_FRAMING: Array<{crop: Crop; width: number; top: number; tilt: number}> = [
  {crop: PANEL_CROPS.chat, width: 580, top: 20, tilt: -6},
  {crop: {x: 1342, y: 145, width: 554, height: 420}, width: 720, top: 230, tilt: -6},
  {crop: {x: 1342, y: 120, width: 554, height: 590}, width: 720, top: 120, tilt: -6}
];

const shotOffset = (shots: ReadonlyArray<{duration: number}>, index: number) =>
  shots.slice(0, index).reduce((total, previous) => total + previous.duration, 0);

export const ChatScene = () => (
  <SpringLayout direction={1}>
    <SceneTitle title={"看完还有问题？\n接着问。"} style={{left: 176, top: 370, width: 740}} />
    {CHAT_SHOTS.map((shot, index) => {
      const framing = CHAT_FRAMING[index] ?? CHAT_FRAMING[0];
      return (
        <Sequence key={shot.startFrom} from={shotOffset(CHAT_SHOTS, index)} durationInFrames={shot.duration}>
          <ProductFrame
            source="chat.mp4"
            crop={framing.crop}
            width={framing.width}
            startFrom={shot.startFrom}
            playbackRate={shot.playbackRate}
            duration={shot.duration}
            pan={32}
            tilt={framing.tilt}
            style={{left: 1060, top: framing.top}}
          />
        </Sequence>
      );
    })}
  </SpringLayout>
);

export const AppearanceScene = () => (
  <SpringLayout direction={-1}>
    {APPEARANCE_SHOTS.map((shot, index) => (
      <Sequence key={shot.title} from={shotOffset(APPEARANCE_SHOTS, index)} durationInFrames={shot.duration}>
        <ProductFrame
          source="appearance.mp4"
          crop={shot.crop}
          width={shot.width}
          startFrom={shot.startFrom}
          playbackRate={shot.playbackRate}
          duration={shot.duration}
          pan={-32}
          tilt={6}
          style={{left: 220, top: shot.top}}
        />
        <SceneTitle title={shot.title} style={{left: 1120, top: 370, width: 650}} />
      </Sequence>
    ))}
  </SpringLayout>
);
