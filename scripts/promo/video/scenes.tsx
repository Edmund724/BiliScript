import {Sequence} from "remotion";
import {CHAT_SHOTS} from "../timeline.mjs";
import {PANEL_CROPS, ProductFrame, SceneTitle, SpringLayout} from "./design";

export const ChatScene = () => (
  <>
    {CHAT_SHOTS.map((shot, index) => (
      <Sequence
        key={shot.startFrom}
        from={CHAT_SHOTS.slice(0, index).reduce((total, previous) => total + previous.duration, 0)}
        durationInFrames={shot.duration}
      >
        <SpringLayout direction={index % 2 === 0 ? 1 : -1}>
          <SceneTitle title={"看完还有问题？\n接着问。"} style={{left: 176, top: 370, width: 740}} />
          <ProductFrame
            source="chat.mp4"
            crop={PANEL_CROPS.chat}
            width={600}
            startFrom={shot.startFrom}
            playbackRate={shot.playbackRate}
            duration={shot.duration}
            pan={44}
            tilt={index % 2 === 0 ? 6 : -6}
            style={{left: 1150, top: 16}}
          />
        </SpringLayout>
      </Sequence>
    ))}
  </>
);

const APPEARANCE_SHOTS = [
  {title: "深色模式，\n完整切换。", startFrom: 0, duration: 42, playbackRate: 1.35, crop: PANEL_CROPS.appearance, width: 580, top: 28},
  {title: "阅读色板，\n随你偏好。", startFrom: 84, duration: 60, playbackRate: 1.15, crop: {x: 1360, y: 390, width: 520, height: 500}, width: 760, top: 190}
];

export const AppearanceScene = () => (
  <>
    {APPEARANCE_SHOTS.map((shot, index) => (
      <Sequence
        key={shot.title}
        from={APPEARANCE_SHOTS.slice(0, index).reduce((total, previous) => total + previous.duration, 0)}
        durationInFrames={shot.duration}
      >
        <SpringLayout direction={index === 0 ? -1 : 1}>
          <ProductFrame
            source="appearance.mp4"
            crop={shot.crop}
            width={shot.width}
            startFrom={shot.startFrom}
            playbackRate={shot.playbackRate}
            duration={shot.duration}
            pan={-44}
            tilt={index === 0 ? 6 : -6}
            style={{left: 220, top: shot.top}}
          />
          <SceneTitle title={shot.title} style={{left: 1120, top: 370, width: 650}} />
        </SpringLayout>
      </Sequence>
    ))}
  </>
);
