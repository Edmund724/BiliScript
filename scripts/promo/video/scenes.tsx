import {Sequence} from "remotion";
import {CHAT_SHOTS} from "../timeline.mjs";
import {PANEL_CROPS, ProductFrame, SceneTitle} from "./design";

export const ChatScene = () => (
  <>
    <SceneTitle title={"看完还有问题？\n接着问。"} style={{left: 196, top: 370, width: 740}} />
    {CHAT_SHOTS.map((shot, index) => (
      <Sequence
        key={shot.startFrom}
        from={CHAT_SHOTS.slice(0, index).reduce((total, previous) => total + previous.duration, 0)}
        durationInFrames={shot.duration}
      >
        <ProductFrame
          source="chat.mp4"
          crop={PANEL_CROPS.chat}
          width={560}
          startFrom={shot.startFrom}
          playbackRate={shot.playbackRate}
          duration={shot.duration}
          pan={32}
          animate={index === 0}
          style={{left: 1160, top: 52}}
        />
      </Sequence>
    ))}
  </>
);

export const AppearanceScene = ({duration}: {duration: number}) => (
  <>
    <ProductFrame
      source="appearance.mp4"
      crop={PANEL_CROPS.appearance}
      width={560}
      playbackRate={1.23}
      duration={duration}
      pan={-32}
      style={{left: 200, top: 44}}
    />
    <SceneTitle title={"换成你习惯的\n阅读方式。"} style={{left: 1040, top: 370, width: 650}} />
  </>
);
