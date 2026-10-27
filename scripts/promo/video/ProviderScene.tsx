import {Easing, Img, Sequence, interpolate, staticFile, useCurrentFrame} from "remotion";
import {PROVIDER_LOGOS} from "../provider-logos.mjs";
import {COLORS, FONT_FAMILY, ProductFrame} from "./design";

const CLAMP = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;
const ENTRANCE = Easing.bezier(0.16, 1, 0.3, 1);

const Claim = ({compact = false}: {compact?: boolean}) => (
  <div style={{display: "flex", alignItems: "center", justifyContent: compact ? "center" : "flex-start", gap: compact ? 22 : 26}}>
    <div style={{color: COLORS.pink, fontFamily: 'Bahnschrift, "Aptos Display", sans-serif', fontSize: compact ? 92 : 168, fontWeight: 600, lineHeight: 1, letterSpacing: -5}}>
      {PROVIDER_LOGOS.length}
    </div>
    <div style={{color: COLORS.foreground, fontSize: compact ? 38 : 48, fontWeight: 550, lineHeight: 1.3, letterSpacing: -1}}>
      个 AI 平台预设
      <div style={{color: COLORS.muted, fontSize: compact ? 26 : 30, fontWeight: 400, marginTop: 10, letterSpacing: 0}}>
        另支持自定义端点
      </div>
    </div>
  </div>
);

const CountReveal = () => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        position: "absolute",
        left: 120,
        top: 390,
        opacity: interpolate(frame, [0, 4, 7], [0, 1, 1], CLAMP),
        translate: interpolate(frame, [0, 7], ["0px 24px", "0px 0px"], {...CLAMP, easing: ENTRANCE})
      }}
    >
      <Claim />
    </div>
  );
};

const ProviderCard = ({logo, index}: {logo: (typeof PROVIDER_LOGOS)[number]; index: number}) => {
  const frame = useCurrentFrame();
  const start = 34 + index * 0.45;
  return (
    <div
      style={{
        width: 218,
        height: 188,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 22,
        borderRadius: 28,
        border: "1px solid rgba(83, 110, 134, 0.15)",
        background: "rgba(255, 255, 255, 0.94)",
        boxShadow: "0 16px 36px -24px rgba(43, 70, 93, 0.24)",
        opacity: interpolate(frame, [start, start + 4], [0, 1], CLAMP),
        translate: interpolate(frame, [start, start + 7], ["0px 24px", "0px 0px"], {...CLAMP, easing: ENTRANCE}),
        scale: interpolate(frame, [start, start + 7], [0.94, 1], {...CLAMP, easing: ENTRANCE, output: "perceptual-scale"})
      }}
    >
      <div style={{width: 116, height: 64, display: "flex", alignItems: "center", justifyContent: "center"}}>
        <Img src={staticFile(`media/providers/${logo.file}`)} style={{width: 64, height: 64, objectFit: "contain"}} />
      </div>
      <div style={{color: COLORS.foreground, fontSize: logo.id === "amd" ? 22 : 24, fontWeight: 500, lineHeight: 1.2, whiteSpace: "nowrap", textAlign: "center"}}>{logo.name}</div>
    </div>
  );
};

const LogoWall = () => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity: interpolate(frame, [34, 36, 56, 60], [0, 1, 1, 0], CLAMP),
        scale: interpolate(frame, [50, 60], [1, 0.16], {...CLAMP, easing: ENTRANCE, output: "perceptual-scale"}),
        translate: interpolate(frame, [50, 60], ["0px 0px", "0px 120px"], {...CLAMP, easing: ENTRANCE})
      }}
    >
      <div style={{position: "absolute", left: 0, right: 0, top: 92}}>
        <Claim compact />
      </div>
      <div style={{position: "absolute", left: 122, right: 122, top: 302, display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "28px 18px"}}>
        {PROVIDER_LOGOS.map((logo, index) => <ProviderCard key={logo.id} logo={logo} index={index} />)}
      </div>
    </div>
  );
};

export const ProviderScene = () => {
  const frame = useCurrentFrame();
  return (
    <div style={{position: "absolute", inset: 0, fontFamily: FONT_FAMILY}}>
      <div style={{position: "absolute", left: 120, top: 250, width: 780, color: COLORS.foreground, fontSize: 64, fontWeight: 550, lineHeight: 1.25, letterSpacing: -2, opacity: interpolate(frame, [0, 24, 27], [1, 1, 0], CLAMP)}}>
        选择平台，<br />从预设开始。
      </div>
      <div style={{opacity: interpolate(frame, [24, 34], [1, 0], CLAMP), scale: interpolate(frame, [24, 34], [1, 0.92], {...CLAMP, easing: ENTRANCE})}}>
        <Sequence durationInFrames={12}>
          <ProductFrame source="ai-providers.mp4" crop={{x: 1380, y: 174, width: 500, height: 104}} width={770} playbackRate={3} duration={12} animate={false} tilt={0} style={{left: 1060, top: 354}} />
        </Sequence>
        <Sequence from={12} durationInFrames={6}>
          <ProductFrame source="ai-providers.mp4" crop={{x: 1390, y: 290, width: 490, height: 128}} width={770} startFrom={36} playbackRate={2} duration={6} animate={false} tilt={0} style={{left: 1060, top: 330}} />
        </Sequence>
        <Sequence from={18} durationInFrames={16}>
          <ProductFrame source="ai-providers.mp4" crop={{x: 1390, y: 290, width: 490, height: 445}} width={770} startFrom={84} playbackRate={3} duration={16} animate={false} tilt={0} style={{left: 1060, top: 124}} />
        </Sequence>
      </div>
      <Sequence from={27} durationInFrames={7}>
        <CountReveal />
      </Sequence>
      <LogoWall />
    </div>
  );
};
