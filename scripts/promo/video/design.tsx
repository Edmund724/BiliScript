import type {CSSProperties, ReactNode} from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  OffthreadVideo,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig
} from "remotion";
import panelCrops from "../generated/panel-crops.json";

export const COLORS = {
  background: "#FBFAFC",
  foreground: "#243447",
  muted: "#697D90",
  pink: "#E85D87",
  blue: "#2679B8"
};

export const FONT_FAMILY = '"Microsoft YaHei UI", "PingFang SC", "Noto Sans CJK SC", sans-serif';
export const BRAND_FONT_FAMILY = 'Bahnschrift, "Aptos Display", sans-serif';

export type Crop = {x: number; y: number; width: number; height: number};

export const PANEL_CROPS = {
  overview: panelCrops.overview,
  chat: panelCrops.chat,
  appearance: panelCrops.appearance
} satisfies Record<string, Crop>;

export const Backdrop = () => (
  <AbsoluteFill
    style={{
      background: [
        "radial-gradient(ellipse 70% 75% at 8% 10%, rgba(232, 93, 135, 0.08) 0%, rgba(232, 93, 135, 0) 72%)",
        "radial-gradient(ellipse 75% 85% at 92% 88%, rgba(119, 157, 190, 0.10) 0%, rgba(119, 157, 190, 0) 74%)",
        "linear-gradient(145deg, #FBFAFC 0%, #F8F8FB 56%, #F5F7FB 100%)"
      ].join(", "),
      fontFamily: FONT_FAMILY
    }}
  />
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
    <div
      style={{
        ...style,
        opacity: entranceOpacity(frame, delay),
        translate: `0px ${(1 - progress) * distance}px`
      }}
    >
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

export const SPRING_LAYOUT = {damping: 15, stiffness: 115, mass: 0.85};
export const microPerspective = (tilt = 6) => `perspective(2200px) rotateY(${tilt}deg)`;
export const MICRO_PERSPECTIVE = microPerspective(6);

const ENTRANCE_FRAMES = 8;
const ENTRANCE_OPACITY = 0.35;
const ENTRANCE_EASING = Easing.out(Easing.cubic);

export const entranceOpacity = (frame: number, start = 0, from = ENTRANCE_OPACITY) =>
  frame < start
    ? 0
    : interpolate(frame, [start, start + ENTRANCE_FRAMES], [from, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: ENTRANCE_EASING
      });

export const SpringLayout = ({children, delay = 0, direction = 1, axis = "x", distance = 32, fade = true, style = {}}: {
  children: ReactNode;
  delay?: number;
  direction?: number;
  axis?: "x" | "y";
  distance?: number;
  fade?: boolean;
  style?: CSSProperties;
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const progress = spring({frame: Math.max(0, frame - delay), fps, config: SPRING_LAYOUT});
  const offset = (1 - progress) * direction * distance;
  return (
    <AbsoluteFill
      style={{
        opacity: fade ? entranceOpacity(frame, delay) : 1,
        translate: axis === "x" ? `${offset}px 0px` : `0px ${offset}px`,
        ...style
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

export const SceneTitle = ({title, style = {}, align = "left", size = 76, delay = 0}: {
  title: string;
  style?: CSSProperties;
  align?: "left" | "center";
  size?: number;
  delay?: number;
}) => {
  const frame = useCurrentFrame();
  return (
    <div style={{position: "absolute", textAlign: align, color: COLORS.foreground, fontSize: size, lineHeight: 1.22, fontWeight: 550, letterSpacing: -2, ...style}}>
      {title.split("\n").map((line, index) => {
        const start = delay + index * 3;
        return (
          <div key={`${index}-${line}`} style={{overflow: "hidden"}}>
            <div
              style={{
                opacity: entranceOpacity(frame, start, 0),
                translate: interpolate(frame, [start, start + 16], ["0px 1.15em", "0px 0em"], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                  easing: Easing.bezier(0.16, 1, 0.3, 1)
                }),
                whiteSpace: "nowrap"
              }}
            >
              {line}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export const SceneShell = ({children, duration, final = false, fadeOut = true}: {
  children: ReactNode;
  duration: number;
  final?: boolean;
  fadeOut?: boolean;
}) => {
  const frame = useCurrentFrame();
  const opacity = final
    ? entranceOpacity(frame)
    : fadeOut ? interpolate(frame, [duration - 6, duration], [1, 0.92], {extrapolateLeft: "clamp", extrapolateRight: "clamp"}) : 1;
  return (
    <AbsoluteFill style={{opacity, fontFamily: FONT_FAMILY}}>
      {children}
    </AbsoluteFill>
  );
};

export const EditorialHeaderBand = ({
  title,
  titleSize = 78,
  delay = 0,
  kicker,
  showBrand = false,
  opacity = 1
}: {
  title: string;
  titleSize?: number;
  delay?: number;
  kicker?: string;
  showBrand?: boolean;
  opacity?: number;
}) => (
  <div
    style={{
      position: "absolute",
      left: 0,
      top: 0,
      width: 1180,
      height: 156,
      background: "rgba(251, 250, 252, 0.98)",
      borderRight: "1px solid rgba(83, 110, 134, 0.16)",
      borderBottom: "1px solid rgba(83, 110, 134, 0.16)",
      borderBottomRightRadius: 28,
      boxShadow: "0 16px 40px -24px rgba(36, 52, 71, 0.14)",
      display: "flex",
      alignItems: "center",
      paddingLeft: 104,
      paddingRight: 48,
      gap: 28,
      opacity,
      transform: "translateZ(80px)",
      zIndex: 10
    }}
  >
    {showBrand ? (
      <div style={{display: "flex", alignItems: "center", gap: 24, flexShrink: 0}}>
        <Brand size={30} iconSize={40} />
        <div style={{width: 1, height: 42, background: "rgba(83, 110, 134, 0.22)"}} />
      </div>
    ) : kicker ? (
      <div
        style={{
          padding: "8px 18px",
          borderRadius: 999,
          background: "rgba(232, 93, 135, 0.10)",
          border: "1px solid rgba(232, 93, 135, 0.26)",
          color: COLORS.pink,
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: -0.4,
          whiteSpace: "nowrap",
          flexShrink: 0
        }}
      >
        {kicker}
      </div>
    ) : null}
    <SceneTitle
      title={title}
      size={titleSize}
      delay={delay}
      style={{
        position: "relative",
        left: 0,
        top: 0
      }}
    />
  </div>
);

export const ProductFrame = ({
  source,
  crop = PANEL_CROPS.overview,
  width,
  playbackRate = 1,
  startFrom = 0,
  duration = 210,
  animate = true,
  tilt = 6,
  variant = "rounded",
  focus,
  style = {}
}: {
  source?: string;
  crop?: Crop;
  width: number;
  playbackRate?: number;
  startFrom?: number;
  duration?: number;
  animate?: boolean;
  tilt?: number;
  variant?: "rounded" | "bleed";
  focus?: {direction: "in" | "out"; frames: number; maxBlur: number};
  style?: CSSProperties;
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const entrance = spring({frame, fps, config: SPRING_LAYOUT});
  const cropScale = width / crop.width;
  const isBleed = variant === "bleed";
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
        borderRadius: isBleed ? 0 : 28,
        overflow: "hidden",
        background: "#FFFFFF",
        border: isBleed ? "none" : "1px solid rgba(83, 110, 134, 0.16)",
        boxShadow: isBleed
          ? "0 32px 80px -28px rgba(15, 23, 42, 0.36)"
          : "0 28px 70px -30px rgba(43, 70, 93, 0.28), 0 4px 18px rgba(43, 70, 93, 0.05)",
        opacity: 1,
        transform: tilt === 0 ? undefined : microPerspective(tilt),
        scale: animate
          ? interpolate(entrance, [0, 1], [0.96, 1], {extrapolateLeft: "clamp"}) *
            interpolate(frame, [0, duration], [1, 1.024], {extrapolateLeft: "clamp", extrapolateRight: "clamp"})
          : 1,
        filter: focus
          ? `blur(${interpolate(
              frame,
              focus.direction === "in" ? [0, focus.frames] : [duration - focus.frames, duration],
              focus.direction === "in" ? [focus.maxBlur, 0] : [0, focus.maxBlur],
              {extrapolateLeft: "clamp", extrapolateRight: "clamp"}
            )}px)`
          : undefined,
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
