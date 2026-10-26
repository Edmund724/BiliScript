import type {CSSProperties, ReactNode} from "react";
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig
} from "remotion";

export const COLORS = {
  background: "#F6F8FC",
  foreground: "#243447",
  muted: "#697D90",
  pink: "#E85D87"
};

export const FONT_FAMILY = '"Microsoft YaHei UI", "PingFang SC", "Noto Sans CJK SC", sans-serif';
const BRAND_FONT_FAMILY = 'Bahnschrift, "Aptos Display", sans-serif';

export type Crop = {x: number; y: number; width: number; height: number};

export const PANEL_CROPS = {
  subtitle: {x: 1326, y: 66, width: 580, height: 1014},
  overview: {x: 1326, y: 66, width: 580, height: 1014},
  chat: {x: 1326, y: 66, width: 580, height: 1014},
  appearance: {x: 1326, y: 55, width: 580, height: 1025}
} satisfies Record<string, Crop>;

export const Backdrop = () => (
  <AbsoluteFill style={{background: "linear-gradient(145deg, #FCFDFE 0%, #F6F8FC 56%, #EDF3F8 100%)", fontFamily: FONT_FAMILY}} />
);

export const Reveal = ({children, delay = 0, distance = 16, style = {}}: {
  children: ReactNode;
  delay?: number;
  distance?: number;
  style?: CSSProperties;
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const progress = spring({frame: Math.max(0, frame - delay), fps, config: {damping: 22, stiffness: 100, mass: 0.8}});
  return (
    <div style={{...style, opacity: progress, translate: `0px ${(1 - progress) * distance}px`}}>
      {children}
    </div>
  );
};

export const Brand = ({style = {}, size = 26, iconSize = 38}: {style?: CSSProperties; size?: number; iconSize?: number}) => (
  <div style={{display: "flex", alignItems: "center", gap: Math.max(14, size * 0.18), ...style}}>
    <Img src={staticFile("media/logo.svg")} style={{width: iconSize, height: iconSize, borderRadius: iconSize * 0.24}} />
    <div style={{color: COLORS.foreground, fontFamily: BRAND_FONT_FAMILY, fontSize: size, fontWeight: 500, letterSpacing: -size * 0.045}}>
      BiliScript
    </div>
  </div>
);

export const SceneTitle = ({title, style = {}, align = "left", size = 62}: {
  title: string;
  style?: CSSProperties;
  align?: "left" | "center";
  size?: number;
}) => (
  <Reveal style={{position: "absolute", textAlign: align, ...style}}>
    <div style={{color: COLORS.foreground, fontSize: size, lineHeight: 1.34, fontWeight: 550, letterSpacing: -1.8, whiteSpace: "pre-line"}}>
      {title}
    </div>
  </Reveal>
);

export const SceneShell = ({children, duration, direction, final = false}: {
  children: ReactNode;
  duration: number;
  direction: number;
  final?: boolean;
}) => {
  const frame = useCurrentFrame();
  const opacity = final
    ? interpolate(frame, [0, 12], [0, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"})
    : interpolate(frame, [0, 10, duration - 12, duration], [0, 1, 1, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp"
      });
  return (
    <AbsoluteFill
      style={{
        opacity,
        fontFamily: FONT_FAMILY,
        translate: final ? "0px 0px" : interpolate(frame, [0, 14, duration - 12, duration], [`${-direction * 18}px 0px`, "0px 0px", "0px 0px", `${direction * 18}px 0px`], {extrapolateLeft: "clamp", extrapolateRight: "clamp"})
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

export const ProductFrame = ({source, crop = PANEL_CROPS.overview, width, playbackRate = 1, startFrom = 0, duration = 210, pan = 0, animate = true, style = {}}: {
  source?: string;
  crop?: Crop;
  width: number;
  playbackRate?: number;
  startFrom?: number;
  duration?: number;
  pan?: number;
  animate?: boolean;
  style?: CSSProperties;
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const entrance = spring({frame, fps, config: {damping: 24, stiffness: 82, mass: 0.9}});
  const cropScale = width / crop.width;
  const mediaStyle: CSSProperties = {
    position: "absolute",
    left: -crop.x * cropScale,
    top: -crop.y * cropScale,
    width: 1920 * cropScale,
    height: 1080 * cropScale,
    maxWidth: "none"
  };
  return (
    <div
      style={{
        position: "absolute",
        width,
        height: crop.height * cropScale,
        borderRadius: 28 * cropScale,
        overflow: "hidden",
        background: "#F4F8FC",
        border: "1px solid rgba(83, 110, 134, 0.18)",
        boxShadow: "0 28px 70px -30px rgba(43, 70, 93, 0.35), 0 4px 18px rgba(43, 70, 93, 0.06)",
        opacity: animate ? entrance : 1,
        scale: animate ? entrance * interpolate(frame, [0, duration], [1, 1.028], {extrapolateLeft: "clamp", extrapolateRight: "clamp"}) : 1,
        translate: animate ? `${(1 - entrance) * pan}px ${(1 - entrance) * 24}px` : "0px 0px",
        ...style
      }}
    >
      {source ? (
        <OffthreadVideo muted src={staticFile(`media/${source}`)} playbackRate={playbackRate} startFrom={startFrom} style={mediaStyle} />
      ) : (
        <Img src={staticFile("media/overview-poster.jpg")} style={mediaStyle} />
      )}
    </div>
  );
};
