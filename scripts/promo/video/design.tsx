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
  background: "#FBFBFD",
  foreground: "#111827",
  inkSoft: "#1D2939",
  muted: "#667085",
  subtle: "#98A2B3",
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

export const ELEVATION = {
  heroFloat:
    "-28px 44px 110px -24px rgba(17, 24, 39, 0.20), 0 12px 32px -12px rgba(232, 93, 135, 0.12), 0 0 0 1px rgba(232, 93, 135, 0.16)",
  recessed:
    "0 40px 90px -32px rgba(17, 24, 39, 0.12), 0 0 0 1px rgba(17, 24, 39, 0.04)",
  videoPlane:
    "0 48px 100px -28px rgba(17, 24, 39, 0.24), 0 0 0 1px rgba(17, 24, 39, 0.06), 0 0 64px rgba(232, 93, 135, 0.18)",
  cardSoft:
    "0 28px 72px -26px rgba(17, 24, 39, 0.16), 0 8px 20px -10px rgba(17, 24, 39, 0.05), 0 0 0 1px rgba(17, 24, 39, 0.04)"
};

export const MIST_GLASS = {
  surface: "linear-gradient(180deg, rgba(235, 243, 250, 0.94), rgba(236, 239, 243, 0.92) 220px)",
  blobs: [
    "radial-gradient(420px 300px at 15% -15%, rgba(140, 200, 255, 0.55), rgba(140, 200, 255, 0))",
    "radial-gradient(380px 280px at 88% -10%, rgba(187, 228, 253, 0.75), rgba(187, 228, 253, 0))",
    "radial-gradient(420px 320px at 5% 95%, rgba(165, 205, 255, 0.45), rgba(165, 205, 255, 0))",
    "radial-gradient(400px 320px at 95% 90%, rgba(180, 225, 250, 0.50), rgba(180, 225, 250, 0))"
  ].join(", "),
  shellShadow:
    "-28px 44px 104px -24px rgba(15, 23, 42, 0.20), 0 10px 28px -8px rgba(15, 23, 42, 0.08), 0 0 0 1px rgba(255, 255, 255, 0.72), inset 0 1px 0 0 rgba(255, 255, 255, 0.88)",
  card:
    "linear-gradient(165deg, rgba(255, 255, 255, 0.88) 0%, rgba(255, 255, 255, 0.72) 55%, rgba(246, 250, 255, 0.78) 100%)",
  cardElevated:
    "linear-gradient(165deg, rgba(255, 255, 255, 0.95) 0%, rgba(255, 255, 255, 0.86) 55%, rgba(246, 250, 255, 0.92) 100%)",
  cardShadow:
    "inset 0 1px 0 0 rgba(255, 255, 255, 0.95), inset 1px 0 0 0 rgba(255, 255, 255, 0.65), inset 0 -1px 0 0 rgba(16, 136, 247, 0.08), 0 6px 24px -4px rgba(15, 23, 42, 0.06), 0 2px 6px -1px rgba(15, 23, 42, 0.03)",
  cardFloatShadow:
    "inset 0 1px 0 0 rgba(255, 255, 255, 0.98), inset 1px 0 0 0 rgba(255, 255, 255, 0.75), inset 0 -1px 0 0 rgba(16, 136, 247, 0.12), -18px 28px 68px -18px rgba(15, 23, 42, 0.16), 0 8px 24px -6px rgba(16, 136, 247, 0.10), 0 0 0 1px rgba(255, 255, 255, 0.82)",
  tabActiveShadow:
    "0 1px 4px rgba(23, 24, 26, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.9)",
  text: "#17181a",
  muted: "#666a71",
  faint: "#8a8e96",
  accent: "#008cff",
  accentSoft: "rgba(0, 140, 255, 0.10)",
  timeColor: "#2e6fc2",
  timeBg: "rgba(46, 111, 194, 0.10)"
};

export const Backdrop = () => (
  <AbsoluteFill
    style={{
      background: [
        "radial-gradient(ellipse 55% 60% at 22% 45%, rgba(232, 93, 135, 0.06) 0%, rgba(232, 93, 135, 0) 70%)",
        "radial-gradient(ellipse 60% 65% at 78% 50%, rgba(38, 121, 184, 0.07) 0%, rgba(38, 121, 184, 0) 72%)",
        "linear-gradient(160deg, #FBFBFD 0%, #F4F5F8 100%)"
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

export const Brand = ({style = {}, size = 26, iconSize = 36}: {style?: CSSProperties; size?: number; iconSize?: number}) => (
  <div style={{display: "flex", alignItems: "center", gap: Math.max(14, size * 0.18), ...style}}>
    <Img src={staticFile("media/logo.svg")} style={{width: iconSize, height: iconSize, borderRadius: iconSize * 0.25}} />
    <div style={{color: COLORS.inkSoft, fontFamily: BRAND_FONT_FAMILY, fontSize: size, fontWeight: 600, letterSpacing: -size * 0.025}}>
      BiliScript
    </div>
  </div>
);

export const BrandWhisper = ({style = {}, opacity = 1}: {style?: CSSProperties; opacity?: number}) => (
  <div
    style={{
      position: "absolute",
      left: 96,
      top: 58,
      display: "flex",
      alignItems: "center",
      gap: 14,
      opacity,
      zIndex: 30,
      pointerEvents: "none",
      ...style
    }}
  >
    <Img src={staticFile("media/logo.svg")} style={{width: 36, height: 36, borderRadius: 9}} />
    <span
      style={{
        fontFamily: BRAND_FONT_FAMILY,
        fontSize: 26,
        fontWeight: 600,
        color: COLORS.inkSoft,
        letterSpacing: -0.6
      }}
    >
      BiliScript
    </span>
  </div>
);

export const VoiceWaveBar = ({
  timestamp,
  quote,
  active = true,
  style = {}
}: {
  timestamp: string;
  quote: string;
  active?: boolean;
  style?: CSSProperties;
}) => {
  const frame = useCurrentFrame();
  const baseHeights = [9, 17, 12, 19, 14, 10];
  return (
    <div
      style={{
        position: "absolute",
        left: 22,
        top: 22,
        padding: "10px 22px",
        borderRadius: 999,
        background: "rgba(15, 23, 42, 0.74)",
        backdropFilter: "blur(16px)",
        boxShadow: "0 12px 32px -12px rgba(15, 23, 42, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.12)",
        color: "#FFFFFF",
        fontSize: 19,
        fontWeight: 500,
        display: "flex",
        alignItems: "center",
        gap: 14,
        pointerEvents: "none",
        ...style
      }}
    >
      <div style={{display: "flex", alignItems: "center", gap: 3.5, height: 20}}>
        {baseHeights.map((base, idx) => {
          const wave = active ? 0.55 + 0.45 * Math.abs(Math.sin(frame * 0.45 + idx * 1.15)) : 0.4;
          return (
            <span
              key={idx}
              style={{
                display: "inline-block",
                width: 3.5,
                height: Math.max(5, Math.round(base * wave)),
                borderRadius: 99,
                background: COLORS.pink
              }}
            />
          );
        })}
      </div>
      <span style={{letterSpacing: -0.2}}>
        <strong style={{fontFamily: BRAND_FONT_FAMILY, fontWeight: 600, marginRight: 6}}>{timestamp}</strong>· {quote}
      </span>
    </div>
  );
};

export const SPRING_LAYOUT = {damping: 15, stiffness: 115, mass: 0.85};
export const microPerspective = (tilt = 6) => `perspective(1600px) rotateX(${tilt < 0 ? 4 : 3}deg) rotateY(${tilt}deg)`;
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

export const SceneTitle = ({title, subtitle, style = {}, align = "left", size = 68, delay = 0}: {
  title: string;
  subtitle?: string;
  style?: CSSProperties;
  align?: "left" | "center";
  size?: number;
  delay?: number;
}) => {
  const frame = useCurrentFrame();
  const lines = title.split("\n");
  const subStart = delay + lines.length * 3 + 2;
  return (
    <div
      style={{
        position: "absolute",
        textAlign: align,
        color: COLORS.foreground,
        fontSize: size,
        lineHeight: 1.16,
        fontWeight: 600,
        letterSpacing: -2.4,
        ...style
      }}
    >
      {lines.map((line, index) => {
        const start = delay + index * 3;
        return (
          <div key={`${index}-${line}`} style={{overflow: "hidden", paddingBottom: 4}}>
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
      {subtitle ? (
        <div
          style={{
            marginTop: 18,
            fontSize: 25,
            fontWeight: 400,
            lineHeight: 1.5,
            letterSpacing: -0.3,
            color: COLORS.muted,
            opacity: entranceOpacity(frame, subStart, 0),
            translate: interpolate(frame, [subStart, subStart + 14], ["0px 12px", "0px 0px"], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(0.16, 1, 0.3, 1)
            })
          }}
        >
          {subtitle}
        </div>
      ) : null}
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
  titleSize = 64,
  delay = 0,
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
      left: 72,
      top: 40,
      padding: "22px 42px",
      borderRadius: 999,
      background: "rgba(251, 251, 253, 0.86)",
      backdropFilter: "blur(24px)",
      boxShadow: "0 28px 68px -24px rgba(17, 24, 39, 0.14), 0 0 0 1px rgba(17, 24, 39, 0.04)",
      display: "flex",
      alignItems: "center",
      gap: 28,
      opacity,
      transform: "translateZ(80px)",
      zIndex: 10
    }}
  >
    {showBrand ? <Brand size={30} iconSize={40} /> : null}
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
        borderRadius: isBleed ? 28 : 32,
        overflow: "hidden",
        background: "#FFFFFF",
        boxShadow: isBleed
          ? "0 44px 100px -28px rgba(17, 24, 39, 0.24), 0 0 0 1px rgba(17, 24, 39, 0.05)"
          : "-28px 44px 104px -26px rgba(17, 24, 39, 0.20), 0 12px 32px -12px rgba(17, 24, 39, 0.06), 0 0 0 1px rgba(17, 24, 39, 0.05)",
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
