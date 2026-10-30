import {Easing, Img, interpolate, staticFile, useCurrentFrame} from "remotion";
import {PROVIDER_LOGOS} from "../provider-logos.mjs";
import {PROVIDER_TIMELINE} from "../timeline.mjs";
import {BrandWhisper, COLORS, ELEVATION, FONT_FAMILY} from "./design";

const CLAMP = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;
const ENTRANCE = Easing.bezier(0.16, 1, 0.3, 1);
const {plateAt, orbitAt, logoOffsets, logoPopFrames, exitAt, exitDuration} = PROVIDER_TIMELINE;

const ORBIT = {
  centerX: 944,
  centerY: 552,
  radiusX: 746,
  radiusY: 296,
  startAngle: 90,
  stepDegrees: 360 / PROVIDER_LOGOS.length,
  spinPerFrame: 0.42
};

const orbitAngle = (index: number, frame: number) =>
  (ORBIT.startAngle + index * ORBIT.stepDegrees + Math.max(0, frame - orbitAt) * ORBIT.spinPerFrame) * (Math.PI / 180);

const OrbitTrack = ({opacity}: {opacity: number}) => (
  <svg
    width={1920}
    height={1080}
    viewBox="0 0 1920 1080"
    style={{position: "absolute", inset: 0, opacity, pointerEvents: "none"}}
  >
    <defs>
      <linearGradient id="provider-orbit-stroke" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stopColor="rgba(38, 121, 184, 0.34)" />
        <stop offset="46%" stopColor="rgba(232, 93, 135, 0.48)" />
        <stop offset="100%" stopColor="rgba(38, 121, 184, 0.34)" />
      </linearGradient>
    </defs>
    <ellipse
      cx={ORBIT.centerX}
      cy={ORBIT.centerY}
      rx={ORBIT.radiusX}
      ry={ORBIT.radiusY}
      fill="none"
      stroke="url(#provider-orbit-stroke)"
      strokeWidth={1.8}
    />
    <ellipse
      cx={ORBIT.centerX}
      cy={ORBIT.centerY}
      rx={ORBIT.radiusX - 16}
      ry={ORBIT.radiusY - 8}
      fill="none"
      stroke="rgba(17, 24, 39, 0.08)"
      strokeWidth={1}
    />
  </svg>
);

export const PROVIDER_HEADLINE = "接入你顺手的 AI 大脑";
export const PROVIDER_SUBHEADLINE = "支持切换 DeepSeek、Kimi、Qwen 等 14+ 平台，亦支持本地模型";
export const PROVIDER_BENEFIT_TAG = "不被单一 AI 绑定 · 自由接入外部 API";

const CenterPlate = ({exitProgress}: {exitProgress: number}) => {
  const frame = useCurrentFrame();
  const enter = interpolate(frame, [plateAt, plateAt + 12], [0, 1], {...CLAMP, easing: ENTRANCE});
  const lift = interpolate(enter, [0, 1], [24, 0]);
  const plateZoom = interpolate(enter, [0, 1], [0.9, 1]) * (1 + exitProgress * 0.04);

  return (
    <div
      style={{
        position: "absolute",
        left: ORBIT.centerX,
        top: ORBIT.centerY,
        translate: `-50% calc(-50% + ${lift.toFixed(1)}px)`,
        opacity: enter * (1 - exitProgress),
        zIndex: 200
      }}
    >
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: 1080,
          height: 480,
          translate: "-50% -50%",
          borderRadius: "50%",
          background: "radial-gradient(ellipse at center, rgba(232, 93, 135, 0.14) 0%, rgba(232, 93, 135, 0) 68%)",
          pointerEvents: "none"
        }}
      />
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 14,
          padding: "34px 42px",
          borderRadius: 42,
          background: "rgba(255, 255, 255, 0.96)",
          backdropFilter: "blur(26px)",
          boxShadow: ELEVATION.heroFloat,
          zoom: Math.abs(plateZoom - 1) > 0.001 ? plateZoom : undefined
        }}
      >
        <div
          style={{
            color: COLORS.foreground,
            fontSize: 58,
            fontWeight: 700,
            lineHeight: 1.14,
            letterSpacing: -1.8,
            whiteSpace: "nowrap"
          }}
        >
          {PROVIDER_HEADLINE}
        </div>
        <div
          style={{
            color: COLORS.muted,
            fontSize: 32,
            fontWeight: 600,
            lineHeight: 1.3,
            letterSpacing: -0.8,
            whiteSpace: "nowrap"
          }}
        >
          {PROVIDER_SUBHEADLINE}
        </div>
      </div>
    </div>
  );
};

const OrbitLogo = ({
  logo,
  index,
  exitProgress
}: {
  logo: (typeof PROVIDER_LOGOS)[number];
  index: number;
  exitProgress: number;
}) => {
  const frame = useCurrentFrame();
  const angle = orbitAngle(index, frame);
  const depth = Math.sin(angle);
  const depthRatio = (depth + 1) / 2;
  const offset = logoOffsets[index] ?? index * 2;
  const local = frame - (orbitAt + offset);
  const dormant = interpolate(frame, [orbitAt - 2 + index * 0.4, orbitAt + 8 + index * 0.4], [0, 0.22], {
    ...CLAMP,
    easing: ENTRANCE
  });
  const lit = interpolate(local, [0, logoPopFrames], [0, 1], {...CLAMP, easing: ENTRANCE});
  const pop = interpolate(local, [0, 3, 7, 11], [1, 1.12, 0.988, 1], {...CLAMP, easing: ENTRANCE});
  const flash = interpolate(local, [0, 2, 14], [0, 1, 0], CLAMP);
  const opacity = dormant + (1 - dormant) * lit;
  const scale = interpolate(lit, [0, 1], [0.94, 1]) * pop * (0.95 + 0.12 * depthRatio) * (1 - 0.1 * exitProgress);

  return (
    <div
      style={{
        position: "absolute",
        left: ORBIT.centerX + Math.cos(angle) * ORBIT.radiusX,
        top: ORBIT.centerY + Math.sin(angle) * ORBIT.radiusY,
        translate: "-50% -50%",
        scale,
        opacity: opacity * (0.68 + 0.32 * depthRatio) * (1 - exitProgress),
        zIndex: 100 + Math.round(depth * 45)
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: logo.id === "amd" ? "12px 24px 12px 14px" : "13px 28px 13px 15px",
          borderRadius: 999,
          background: "rgba(255, 255, 255, 0.96)",
          backdropFilter: "blur(18px)",
          boxShadow: `0 22px 46px -20px rgba(17, 24, 39, ${(0.1 + 0.1 * depthRatio).toFixed(2)}), 0 0 0 ${(1.2 + flash * 2.4).toFixed(2)}px rgba(232, 93, 135, ${(0.1 + flash * 0.42).toFixed(2)})`
        }}
      >
        <div
          style={{
            width: 62,
            height: 62,
            borderRadius: 19,
            background: "rgba(244, 245, 248, 0.92)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center"
          }}
        >
          <Img src={staticFile(`media/providers/${logo.file}`)} style={{width: 46, height: 46, objectFit: "contain"}} />
        </div>
        <div
          style={{
            color: COLORS.foreground,
            fontSize: logo.id === "amd" ? 29 : 34,
            fontWeight: 650,
            lineHeight: 1.2,
            letterSpacing: -0.5,
            whiteSpace: "nowrap"
          }}
        >
          {logo.name}
        </div>
      </div>
    </div>
  );
};

const OrbitArray = ({exitProgress}: {exitProgress: number}) => {
  const frame = useCurrentFrame();
  const trackOpacity = interpolate(frame, [orbitAt - 2, orbitAt + 10], [0, 1], {...CLAMP, easing: ENTRANCE}) * (1 - exitProgress);

  return (
    <div style={{position: "absolute", inset: 0}}>
      <OrbitTrack opacity={trackOpacity} />
      {PROVIDER_LOGOS.map((logo, index) => (
        <OrbitLogo key={logo.id} logo={logo} index={index} exitProgress={exitProgress} />
      ))}
      <CenterPlate exitProgress={exitProgress} />
    </div>
  );
};

export const ProviderScene = () => {
  const frame = useCurrentFrame();
  const exitProgress = interpolate(frame, [exitAt, exitAt + exitDuration], [0, 1], {...CLAMP, easing: Easing.in(Easing.cubic)});

  return (
    <div style={{position: "absolute", inset: 0, fontFamily: FONT_FAMILY}}>
      <BrandWhisper opacity={1 - exitProgress} />
      <OrbitArray exitProgress={exitProgress} />
    </div>
  );
};
