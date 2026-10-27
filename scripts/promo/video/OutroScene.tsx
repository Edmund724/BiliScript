import {Easing, Img, interpolate, interpolateColors, staticFile, useCurrentFrame, useVideoConfig} from "remotion";
import {Brand, COLORS, FONT_FAMILY} from "./design";

const CLAMP = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;
const ENTRANCE_EASING = Easing.bezier(0.16, 1, 0.3, 1);

const FEATURES = [
  {label: "双语字幕", x: -330, y: -170, driftX: -18, driftY: -10},
  {label: "字幕导出", x: 330, y: -170, driftX: 18, driftY: -10},
  {label: "语音识别", x: -330, y: 170, driftX: -18, driftY: 10},
  {label: "联网搜索", x: 330, y: 170, driftX: 18, driftY: 10}
];

const EdgeIcon = () => (
  <svg width={32} height={32} viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <defs>
      <linearGradient id="edge-wave" x1="5" y1="5" x2="27" y2="27" gradientUnits="userSpaceOnUse">
        <stop stopColor="#B9F4F1" />
        <stop offset="0.48" stopColor="#56D6E8" />
        <stop offset="1" stopColor="#8CE5C1" />
      </linearGradient>
    </defs>
    <path d="M28.4 18.1c.5-7.8-4.6-13.8-12.5-13.8C8.8 4.3 3.2 10 3.1 17.9c4.2-5.8 9.1-8.7 14.8-8.7 4.4 0 7.2 2.1 7.2 5.2 0 2.5-1.8 4.1-5.2 4.1h-6.1c-3.5 0-5.8 1.6-5.8 4.1 0 3.1 3.3 5.2 8.2 5.2 6.5 0 11.1-3.8 12.2-9.7Z" fill="url(#edge-wave)" />
    <path d="M3.2 17.8C5.4 10.4 11 6.2 17.8 6.2c5.1 0 8.5 2.2 10.3 6.2-.4-5.4-5.3-9.5-12.2-9.5C8.7 2.9 2.8 9.1 3.2 17.8Z" fill="#D7FAF4" fillOpacity={0.85} />
  </svg>
);

const GitHubIcon = () => (
  <svg width={32} height={32} viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">
    <path d="M16 1.4C7.9 1.4 1.4 7.9 1.4 16c0 6.5 4.2 12 10 13.9.7.1 1-.3 1-.7v-2.7c-4.1.9-5-1.7-5-1.7-.7-1.7-1.6-2.2-1.6-2.2-1.3-.9.1-.9.1-.9 1.5.1 2.2 1.5 2.2 1.5 1.3 2.2 3.4 1.6 4.2 1.2.1-1 .5-1.6.9-2-3.3-.4-6.7-1.6-6.7-7.2 0-1.6.6-2.9 1.5-3.9-.2-.4-.7-1.9.1-3.9 0 0 1.2-.4 4 1.5 1.2-.3 2.4-.5 3.7-.5s2.5.2 3.7.5c2.8-1.9 4-1.5 4-1.5.8 2 .3 3.5.1 3.9.9 1 1.5 2.3 1.5 3.9 0 5.6-3.4 6.8-6.7 7.2.5.5 1 1.4 1 2.8v4.1c0 .4.3.8 1 .7 5.8-1.9 10-7.4 10-13.9C30.6 7.9 24.1 1.4 16 1.4Z" />
  </svg>
);

const FeatureReveal = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  return (
    <>
      <Img
        src={staticFile("media/logo.svg")}
        style={{
          position: "absolute",
          left: "50%",
          top: 306,
          width: 88,
          height: 88,
          marginLeft: -44,
          borderRadius: 22,
          opacity: interpolate(frame, [1.67 * fps, 1.85 * fps, 2.2 * fps, 2.4 * fps], [0, 1, 1, 0], CLAMP),
          scale: interpolate(frame, [1.67 * fps, 2.2 * fps], [0.72, 1], {...CLAMP, easing: ENTRANCE_EASING}),
          boxShadow: "0 20px 60px rgba(64, 92, 116, 0.18)"
        }}
      />
      {FEATURES.map((feature, index) => {
        const start = (0.27 + index * 0.25) * fps;
        return (
          <div
            key={feature.label}
            style={{
              position: "absolute",
              left: "50%",
              top: 350,
              width: 196,
              height: 64,
              marginLeft: -98,
              marginTop: -32,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 999,
              border: "1px solid rgba(92, 119, 141, 0.18)",
              background: "rgba(255, 255, 255, 0.96)",
              boxShadow: "0 14px 34px rgba(56, 82, 104, 0.12)",
              color: COLORS.foreground,
              fontSize: 28,
              fontWeight: 600,
              letterSpacing: 0.5,
              opacity: interpolate(frame, [start, start + 0.18 * fps, 1.67 * fps, 2.02 * fps], [0, 1, 1, 0], CLAMP),
              translate: interpolate(
                frame,
                [start, start + 0.42 * fps, 1.67 * fps, 2.2 * fps],
                [
                  `${feature.x * 1.22}px ${feature.y * 1.22}px`,
                  `${feature.x}px ${feature.y}px`,
                  `${feature.x + feature.driftX}px ${feature.y + feature.driftY}px`,
                  "0px 0px"
                ],
                {...CLAMP, easing: ENTRANCE_EASING}
              ),
              scale: interpolate(frame, [start, start + 0.36 * fps, 1.67 * fps, 2.2 * fps], [0.68, 1, 1, 0.3], {
                ...CLAMP,
                easing: ENTRANCE_EASING
              })
            }}
          >
            {feature.label}
          </div>
        );
      })}
    </>
  );
};

const FinalBrand = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  return (
    <>
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 300,
          translate: interpolate(frame, [2.2 * fps, 2.75 * fps], ["-50% 18px", "-50% 0px"], {
            ...CLAMP,
            easing: ENTRANCE_EASING
          }),
          opacity: interpolate(frame, [2.2 * fps, 2.65 * fps], [0, 1], CLAMP),
          scale: interpolate(frame, [2.2 * fps, 2.75 * fps], [0.92, 1], {...CLAMP, easing: ENTRANCE_EASING})
        }}
      >
        <Brand size={104} iconSize={84} />
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 440,
          textAlign: "center",
          color: COLORS.foreground,
          fontSize: 34,
          lineHeight: 1.4,
          opacity: interpolate(frame, [2.6 * fps, 3 * fps], [0, 1], CLAMP),
          translate: interpolate(frame, [2.6 * fps, 3.05 * fps], ["0px 16px", "0px 0px"], {
            ...CLAMP,
            easing: ENTRANCE_EASING
          })
        }}
      >
        在 B 站，读下一条视频。
      </div>
    </>
  );
};

const CallToAction = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 550,
          display: "flex",
          justifyContent: "center",
          gap: 24,
          opacity: interpolate(frame, [2.85 * fps, 3.25 * fps], [0, 1], CLAMP),
          translate: interpolate(frame, [2.85 * fps, 3.3 * fps], ["0px 20px", "0px 0px"], {
            ...CLAMP,
            easing: ENTRANCE_EASING
          })
        }}
      >
        <div
          style={{
            height: 68,
            padding: "0 30px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            borderRadius: 999,
            color: "white",
            fontSize: 28,
            fontWeight: 600,
            backgroundColor: interpolateColors(
              frame,
              [3 * fps, 3.2 * fps, 3.5 * fps, 3.6 * fps, 3.85 * fps, 4 * fps],
              [COLORS.pink, "#D94D79", "#D94D79", "#C9436D", "#D94D79", COLORS.pink]
            ),
            boxShadow: "0 14px 30px rgba(196, 66, 106, 0.24)",
            scale: interpolate(
              frame,
              [3 * fps, 3.2 * fps, 3.5 * fps, 3.6 * fps, 3.85 * fps, 4 * fps],
              [1, 1.045, 1.045, 0.965, 1.045, 1],
              {...CLAMP, easing: ENTRANCE_EASING}
            ),
            translate: interpolate(
              frame,
              [3 * fps, 3.2 * fps, 3.5 * fps, 3.6 * fps, 3.85 * fps, 4 * fps],
              ["0px 0px", "0px -4px", "0px -4px", "0px 1px", "0px -4px", "0px 0px"],
              {...CLAMP, easing: ENTRANCE_EASING}
            )
          }}
        >
          <EdgeIcon />
          Edge 应用商店
        </div>
        <div
          style={{
            height: 68,
            padding: "0 30px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            borderRadius: 999,
            border: "1px solid rgba(64, 86, 105, 0.18)",
            background: "rgba(255, 255, 255, 0.97)",
            boxShadow: "0 12px 28px rgba(56, 82, 104, 0.12)",
            color: COLORS.foreground,
            fontSize: 28,
            fontWeight: 600
          }}
        >
          <GitHubIcon />
          GitHub 开源
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 930,
          top: 610,
          width: 48,
          height: 48,
          marginLeft: -24,
          marginTop: -24,
          borderRadius: "50%",
          border: `3px solid ${COLORS.pink}`,
          opacity: interpolate(frame, [3.48 * fps, 3.54 * fps, 3.78 * fps], [0, 0.65, 0], CLAMP),
          scale: interpolate(frame, [3.48 * fps, 3.78 * fps], [0.35, 1.5], CLAMP)
        }}
      />
      <svg
        width={36}
        height={46}
        viewBox="0 0 30 38"
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          overflow: "visible",
          filter: "drop-shadow(0 3px 4px rgba(31, 47, 61, 0.25))",
          opacity: interpolate(frame, [2.68 * fps, 2.8 * fps, 4 * fps, 4.25 * fps], [0, 1, 1, 0], CLAMP),
          translate: interpolate(
            frame,
            [2.72 * fps, 3.16 * fps, 3.5 * fps, 3.6 * fps, 3.85 * fps],
            ["1240px 790px", "930px 610px", "930px 610px", "930px 614px", "930px 610px"],
            {...CLAMP, easing: Easing.bezier(0.4, 0, 0.2, 1)}
          )
        }}
      >
        <path d="M3 2.5 3.7 28 10 21.8 15.8 33.2 21 30.8 15.2 19.8 24.5 18.5Z" fill="white" stroke="#243447" strokeWidth={2} strokeLinejoin="round" />
      </svg>
    </>
  );
};

export const OutroScene = () => (
  <div style={{position: "absolute", inset: 0, fontFamily: FONT_FAMILY}}>
    <div style={{position: "absolute", inset: 0, background: "radial-gradient(ellipse 42% 40% at 50% 40%, rgba(232, 93, 135, 0.07) 0%, rgba(232, 93, 135, 0) 72%)"}} />
    <FeatureReveal />
    <FinalBrand />
    <CallToAction />
    <div style={{position: "absolute", left: 0, right: 0, bottom: 48, textAlign: "center", color: COLORS.muted, fontSize: 14}}>
      Music: “BiliScript Pulse” — BiliScript, MIT License
    </div>
  </div>
);
