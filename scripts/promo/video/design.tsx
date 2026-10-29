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
  chat: panelCrops.chat
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
        color: style.color ?? COLORS.inkSoft,
        letterSpacing: -0.6
      }}
    >
      BiliScript
    </span>
  </div>
);

export const PaperGrainOverlay = ({
  opacity = 0.08,
  warm = true,
  borderRadius = 24
}: {
  opacity?: number;
  warm?: boolean;
  borderRadius?: number;
}) => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      borderRadius,
      overflow: "hidden",
      pointerEvents: "none",
      backgroundImage: [
        `repeating-linear-gradient(32deg, ${warm ? "rgba(180, 142, 104, 0.09)" : "rgba(255, 255, 255, 0.07)"} 0px 1px, transparent 1px 4px)`,
        `repeating-linear-gradient(-58deg, ${warm ? "rgba(120, 92, 68, 0.07)" : "rgba(15, 23, 42, 0.05)"} 0px 1px, transparent 1px 5px)`,
        warm
          ? "radial-gradient(ellipse 90% 80% at 18% 12%, rgba(255, 248, 232, 0.36) 0%, rgba(244, 230, 206, 0.08) 58%, rgba(196, 164, 128, 0.14) 100%)"
          : "radial-gradient(ellipse 90% 80% at 18% 12%, rgba(255, 255, 255, 0.22) 0%, rgba(255, 255, 255, 0) 70%)"
      ].join(", "),
      boxShadow: warm
        ? "inset 0 1px 0 rgba(255, 252, 244, 0.62), inset -3px 0 14px rgba(138, 102, 68, 0.12), inset 0 -1px 0 rgba(138, 102, 68, 0.10)"
        : "inset 0 1px 0 rgba(255, 255, 255, 0.38)",
      opacity
    }}
  />
);

export const ReadingLampBeam = ({
  intensity = 1,
  warm = true,
  borderRadius = 24
}: {
  intensity?: number;
  warm?: boolean;
  borderRadius?: number;
}) => {
  if (intensity <= 0.01) return null;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        borderRadius,
        overflow: "hidden",
        pointerEvents: "none",
        opacity: intensity,
        background: [
          warm
            ? "radial-gradient(ellipse 82% 66% at 88% 6%, rgba(255, 214, 148, 0.34) 0%, rgba(238, 168, 88, 0.15) 44%, rgba(238, 168, 88, 0) 78%)"
            : "radial-gradient(ellipse 82% 66% at 88% 6%, rgba(191, 219, 254, 0.30) 0%, rgba(96, 165, 250, 0.12) 44%, rgba(96, 165, 250, 0) 78%)",
          warm
            ? "linear-gradient(126deg, rgba(255, 230, 182, 0) 14%, rgba(255, 220, 158, 0.16) 46%, rgba(255, 230, 182, 0) 76%)"
            : "linear-gradient(126deg, rgba(219, 234, 254, 0) 14%, rgba(147, 197, 253, 0.14) 46%, rgba(219, 234, 254, 0) 76%)"
        ].join(", "),
        boxShadow: warm ? "inset -1px 1px 0 rgba(255, 224, 168, 0.34)" : "inset -1px 1px 0 rgba(191, 219, 254, 0.30)"
      }}
    />
  );
};

export type BottomLectureCaptionProps = {
  timestamp: string;
  quote?: string;
  text?: string;
  speaker?: string;
  active?: boolean;
  from?: number;
  duration?: number;
  style?: CSSProperties;
};

export const BottomLectureCaption = ({
  timestamp,
  quote,
  text,
  speaker,
  active = true,
  from,
  duration,
  style = {}
}: BottomLectureCaptionProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const local = from !== undefined ? frame - from : frame;
  if (from !== undefined && local < 0) return null;
  if (duration !== undefined && local >= duration) return null;

  const enterProgress = spring({
    frame: Math.max(0, local),
    fps,
    config: {damping: 18, stiffness: 165, mass: 0.76}
  });
  const enterOpacity = from !== undefined
    ? interpolate(local, [0, 5], [0, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"})
    : 1;
  const exitOpacity = duration !== undefined
    ? interpolate(local, [Math.max(0, duration - 6), duration], [1, 0], {extrapolateLeft: "clamp", extrapolateRight: "clamp"})
    : 1;
  const liftY = from !== undefined ? interpolate(enterProgress, [0, 1], [18, 0]) : 0;
  const baseHeights = [10, 19, 13, 21, 15, 11];
  const contentText = quote ?? text ?? "";

  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        bottom: 48,
        translate: `-50% ${liftY.toFixed(1)}px`,
        padding: "16px 36px 16px 22px",
        borderRadius: 999,
        background: "rgba(15, 23, 42, 0.90)",
        backdropFilter: "blur(22px)",
        boxShadow:
          "0 28px 64px -18px rgba(15, 23, 42, 0.62), 0 0 0 1.5px rgba(255, 255, 255, 0.18), 0 0 36px rgba(232, 93, 135, 0.24)",
        color: "#FFFFFF",
        display: "flex",
        alignItems: "center",
        gap: 18,
        whiteSpace: "nowrap",
        opacity: enterOpacity * exitOpacity,
        zIndex: 35,
        pointerEvents: "none",
        ...style
      }}
    >
      <div
        style={{
          padding: "8px 18px",
          borderRadius: 999,
          background: "rgba(232, 93, 135, 0.24)",
          boxShadow: "inset 0 0 0 1px rgba(232, 93, 135, 0.54)",
          display: "flex",
          alignItems: "center",
          gap: 10
        }}
      >
        <div style={{display: "flex", alignItems: "center", gap: 3.5, height: 22}}>
          {baseHeights.map((base, idx) => {
            const wave = active ? 0.55 + 0.45 * Math.abs(Math.sin(frame * 0.45 + idx * 1.15)) : 0.4;
            return (
              <span
                key={idx}
                style={{
                  display: "inline-block",
                  width: 3.5,
                  height: Math.max(6, Math.round(base * wave)),
                  borderRadius: 99,
                  background: "#FF709A"
                }}
              />
            );
          })}
        </div>
        <strong
          style={{
            fontFamily: BRAND_FONT_FAMILY,
            fontSize: 27,
            fontWeight: 700,
            letterSpacing: 0.4,
            color: "#FFE4EC"
          }}
        >
          {timestamp}
        </strong>
      </div>
      {speaker ? (
        <span
          style={{
            fontSize: 24,
            fontWeight: 600,
            color: "rgba(255, 255, 255, 0.72)",
            letterSpacing: -0.3
          }}
        >
          {speaker}
        </span>
      ) : null}
      <span
        style={{
          fontSize: 34,
          fontWeight: 700,
          letterSpacing: -0.6,
          color: "#FFFFFF",
          textShadow: "0 2px 10px rgba(0, 0, 0, 0.35)"
        }}
      >
        {contentText}
      </span>
    </div>
  );
};

const DEFAULT_PLAYER_CROP: Crop = {x: 54, y: 171, width: 1272, height: 764};

export type VideoReferenceCardProps = {
  source?: string;
  poster?: string;
  startFrom?: number;
  playbackRate?: number;
  width?: number;
  height?: number;
  crop?: Crop;
  upName?: string;
  title?: string;
  durationLabel?: string;
  headerText?: string;
  badgeText?: string;
  captionTimestamp?: string;
  captionQuote?: string;
  captionActive?: boolean;
  variant?: "window" | "bar";
  tilt?: number;
  delay?: number;
  style?: CSSProperties;
  children?: ReactNode;
};

export const VideoReferenceCard = ({
  source = "subtitle-seek-03.mp4",
  poster,
  startFrom = 84,
  playbackRate = 0.2,
  width = 760,
  height,
  crop = DEFAULT_PLAYER_CROP,
  upName = "复旦赵斌",
  title = "《大模型公开课》",
  durationLabel = "48:16",
  headerText,
  badgeText,
  captionTimestamp,
  captionQuote,
  captionActive = true,
  variant = "window",
  tilt = -7,
  delay = 2,
  style = {},
  children
}: VideoReferenceCardProps) => {
  const playerScale = width / crop.width;
  const resolvedHeight = height ?? Math.round(crop.height * playerScale * 0.78);
  const resolvedHeader = headerText ?? `正在阅读：${upName}${title} ${durationLabel}`;
  const resolvedBadge = badgeText ?? `${upName} · ${durationLabel} 公开课`;

  if (variant === "bar") {
    return (
      <Reveal
        delay={delay}
        distance={14}
        style={{
          width,
          padding: "16px 24px",
          borderRadius: 999,
          background: "rgba(255, 255, 255, 0.94)",
          backdropFilter: "blur(20px)",
          boxShadow: ELEVATION.cardSoft,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          pointerEvents: "none",
          ...style
        }}
      >
        <div style={{display: "flex", alignItems: "center", gap: 14}}>
          <span
            style={{
              padding: "5px 14px",
              borderRadius: 999,
              background: "rgba(232, 93, 135, 0.14)",
              color: COLORS.pink,
              fontSize: 18,
              fontWeight: 700,
              whiteSpace: "nowrap"
            }}
          >
            当前 B 站视频
          </span>
          <span style={{color: COLORS.foreground, fontSize: 22, fontWeight: 680, letterSpacing: -0.4}}>
            {resolvedHeader}
          </span>
        </div>
        <span
          style={{
            padding: "5px 14px",
            borderRadius: 999,
            background: "rgba(38, 121, 184, 0.10)",
            color: COLORS.blue,
            fontFamily: BRAND_FONT_FAMILY,
            fontSize: 18,
            fontWeight: 700,
            whiteSpace: "nowrap"
          }}
        >
          {resolvedBadge}
        </span>
      </Reveal>
    );
  }

  return (
    <Reveal
      delay={delay}
      distance={16}
      style={{
        width,
        transform: tilt === 0 ? undefined : `perspective(1600px) rotateX(4deg) rotateY(${tilt}deg)`,
        ...style
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 14,
          padding: "12px 22px",
          marginBottom: 14,
          borderRadius: 999,
          background: "rgba(255, 255, 255, 0.94)",
          backdropFilter: "blur(20px)",
          boxShadow: "0 14px 34px -16px rgba(17, 24, 39, 0.14), 0 0 0 1px rgba(17, 24, 39, 0.06)"
        }}
      >
        <div style={{display: "flex", alignItems: "center", gap: 12, minWidth: 0}}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: COLORS.pink,
              boxShadow: "0 0 10px rgba(232, 93, 135, 0.65)",
              flexShrink: 0
            }}
          />
          <span
            style={{
              color: COLORS.foreground,
              fontSize: 21,
              fontWeight: 700,
              letterSpacing: -0.3,
              whiteSpace: "nowrap"
            }}
          >
            {resolvedHeader}
          </span>
        </div>
        <span
          style={{
            padding: "4px 14px",
            borderRadius: 999,
            background: "rgba(232, 93, 135, 0.12)",
            color: COLORS.pink,
            fontFamily: BRAND_FONT_FAMILY,
            fontSize: 18,
            fontWeight: 700,
            whiteSpace: "nowrap"
          }}
        >
          {resolvedBadge}
        </span>
      </div>

      <div
        style={{
          position: "relative",
          width,
          height: resolvedHeight,
          borderRadius: 26,
          overflow: "hidden",
          boxShadow: ELEVATION.videoPlane,
          background: "#0F172A"
        }}
      >
        {poster ? (
          <Img
            src={staticFile(`media/${poster}`)}
            style={{
              position: "absolute",
              left: -crop.x * playerScale,
              top: -crop.y * playerScale - 28,
              width: 1920 * playerScale,
              height: 1080 * playerScale,
              maxWidth: "none"
            }}
          />
        ) : (
          <OffthreadVideo
            muted
            src={staticFile(`media/${source}`)}
            startFrom={startFrom}
            playbackRate={playbackRate}
            style={{
              position: "absolute",
              left: -crop.x * playerScale,
              top: -crop.y * playerScale - 28,
              width: 1920 * playerScale,
              height: 1080 * playerScale,
              maxWidth: "none"
            }}
          />
        )}
        <div
          style={{
            position: "absolute",
            left: 18,
            top: 18,
            padding: "7px 16px",
            borderRadius: 999,
            background: "rgba(15, 23, 42, 0.76)",
            backdropFilter: "blur(14px)",
            boxShadow: "0 8px 24px -8px rgba(15, 23, 42, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.16)",
            color: "#FFFFFF",
            fontSize: 18,
            fontWeight: 650,
            display: "flex",
            alignItems: "center",
            gap: 8,
            pointerEvents: "none"
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "#FF709A"
            }}
          />
          <span>{resolvedBadge}</span>
        </div>
        {captionTimestamp && captionQuote ? (
          <BottomLectureCaption
            timestamp={captionTimestamp}
            quote={captionQuote}
            active={captionActive}
            style={{
              bottom: 18,
              padding: "10px 24px 10px 16px",
              scale: 0.78,
              transformOrigin: "50% 100%"
            }}
          />
        ) : null}
        {children}
      </div>
    </Reveal>
  );
};

export const SPRING_LAYOUT = {damping: 15, stiffness: 115, mass: 0.85};
export const microPerspective = (tilt = 6) => `perspective(1600px) rotateX(${tilt < 0 ? 4 : 3}deg) rotateY(${tilt}deg)`;

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

export const SceneTitle = ({title, titleNode, subtitle, style = {}, align = "left", size = 68, delay = 0}: {
  title: string;
  titleNode?: ReactNode;
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
              {index === 0 && titleNode ? titleNode : line}
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
  titleNode,
  titleSize = 64,
  delay = 0,
  showBrand = false,
  opacity = 1
}: {
  title: string;
  titleNode?: ReactNode;
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
      titleNode={titleNode}
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
