import {Sequence} from "remotion";
import {CHAT_SHOTS} from "../timeline.mjs";
import {Brand, COLORS, PANEL_CROPS, ProductFrame, Reveal, SceneTitle} from "./design";

export const HeroScene = () => (
  <>
    <Reveal style={{position: "absolute", left: 184, top: 330}}>
      <Brand size={112} iconSize={76} />
    </Reveal>
    <SceneTitle title="在 B 站，读视频。" size={38} style={{left: 190, top: 504, width: 720}} />
    <ProductFrame
      source="overview.mp4"
      crop={PANEL_CROPS.overview}
      width={560}
      startFrom={60}
      playbackRate={0.75}
      duration={135}
      pan={-32}
      style={{left: 1180, top: 48}}
    />
  </>
);

export const SubtitleScene = ({duration}: {duration: number}) => (
  <>
    <SceneTitle title={"找到那句，\n回到那一秒。"} style={{left: 196, top: 370, width: 660}} />
    <ProductFrame
      source="subtitle.mp4"
      crop={PANEL_CROPS.subtitle}
      width={560}
      playbackRate={1.3}
      duration={duration}
      pan={32}
      style={{left: 1160, top: 52}}
    />
  </>
);

export const OverviewScene = ({duration}: {duration: number}) => (
  <>
    <ProductFrame
      source="overview.mp4"
      crop={PANEL_CROPS.overview}
      width={560}
      playbackRate={1.4}
      duration={duration}
      pan={-32}
      style={{left: 200, top: 52}}
    />
    <SceneTitle title={"这条视频，\n讲了什么？"} style={{left: 1040, top: 370, width: 650}} />
  </>
);

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

export const OutroScene = () => (
  <>
    <div style={{position: "absolute", top: 98, left: 0, right: 0, display: "flex", justifyContent: "center", gap: 40, color: COLORS.muted, fontSize: 20}}>
      <span>双语字幕</span>
      <span>字幕导出</span>
      <span>语音识别</span>
      <span>联网搜索</span>
    </div>
    <Reveal delay={90} style={{position: "absolute", top: 286, left: 0, right: 0, display: "flex", flexDirection: "column", alignItems: "center"}}>
      <Brand size={98} iconSize={72} />
      <div style={{color: COLORS.foreground, fontSize: 34, marginTop: 34}}>在 B 站，读下一条视频。</div>
      <div style={{display: "flex", gap: 52, marginTop: 58, fontSize: 23}}>
        <span style={{color: COLORS.pink, textDecoration: "underline", textUnderlineOffset: 8, textDecorationThickness: 1}}>Edge 应用商店</span>
        <span style={{color: COLORS.muted}}>GitHub 开源</span>
      </div>
    </Reveal>
    <div style={{position: "absolute", left: 0, right: 0, bottom: 48, textAlign: "center", color: COLORS.muted, fontSize: 14}}>
      Music: “Wholesome” — Kevin MacLeod (incompetech.com), CC BY 4.0
    </div>
  </>
);
