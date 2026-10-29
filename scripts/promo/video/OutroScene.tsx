import {Easing, Img, interpolate, interpolateColors, staticFile, useCurrentFrame} from "remotion";
import {OUTRO_TIMELINE} from "../outro-timeline.mjs";
import {BRAND_FONT_FAMILY, BrandWhisper, COLORS, FONT_FAMILY, entranceOpacity} from "./design";

const CLAMP = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;
const ENTRANCE_EASING = Easing.bezier(0.16, 1, 0.3, 1);

const CANVAS_WIDTH = 1920;
const FEATURE_COUNT = OUTRO_TIMELINE.features.length;

const BEAT_BADGE = {size: 104, top: 328};
const BEAT_INDEX_TOP = 280;
const BEAT_WORD = {top: 470, size: 200};
const BEAT_NOTE_TOP = 744;

const BRAND_ICON = {size: 110, top: 350};
const BRAND_NAME = {size: 148, advance: 540, gap: 60, opticalLift: -11};
const BRAND_GROUP_WIDTH = BRAND_ICON.size + BRAND_NAME.gap + BRAND_NAME.advance;
const BRAND_ICON_OUTSET = (BRAND_GROUP_WIDTH - BRAND_ICON.size) / 2;
const BRAND_MARK = {x: CANVAS_WIDTH / 2, y: BRAND_ICON.top + BRAND_ICON.size / 2};
const TAGLINE_TOP = 520;
const CTA_TOP = 616;
const INSTALL_POINTER = {x: 880, y: CTA_TOP + 42};

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

const BeatGlyph = ({id}: {id: string}) => (
  <svg width={64} height={64} viewBox="0 0 72 72" fill="none" aria-hidden="true">
    {id === "feature-bilingual" ? (
      <>
        <rect x="16" y="25" width="40" height="8" rx="4" fill={COLORS.pink} />
        <rect x="16" y="41" width="27" height="8" rx="4" fill={COLORS.blue} fillOpacity={0.72} />
      </>
    ) : id === "feature-export" ? (
      <>
        <path d="M36 16v23" stroke={COLORS.pink} strokeWidth={4.5} strokeLinecap="round" />
        <path d="m26 32 10 10 10-10" stroke={COLORS.pink} strokeWidth={4.5} strokeLinecap="round" strokeLinejoin="round" />
        <path d="M21 53h30" stroke={COLORS.blue} strokeWidth={4.5} strokeLinecap="round" />
      </>
    ) : id === "feature-asr" ? (
      <>
        {[18, 32, 46, 32, 18].map((height, index) => (
          <rect
            key={index}
            x={15 + index * 9}
            y={36 - height / 2}
            width={5.5}
            height={height}
            rx={2.75}
            fill={index === 2 ? COLORS.pink : COLORS.blue}
            fillOpacity={index === 2 ? 1 : 0.68}
          />
        ))}
      </>
    ) : (
      <>
        <circle cx="33" cy="31" r="13" stroke={COLORS.pink} strokeWidth={4.5} />
        <path d="m43 41 10 10" stroke={COLORS.pink} strokeWidth={4.5} strokeLinecap="round" />
        <circle cx="33" cy="31" r="3.2" fill={COLORS.blue} fillOpacity={0.8} />
      </>
    )}
  </svg>
);

const badgeTileStyle = {
  width: BEAT_BADGE.size,
  height: BEAT_BADGE.size,
  borderRadius: 30,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "linear-gradient(158deg, rgba(255, 255, 255, 0.99) 0%, rgba(255, 243, 247, 0.94) 100%)",
  boxShadow:
    "0 24px 52px -20px rgba(232, 93, 135, 0.38), inset 0 1px 0 rgba(255, 255, 255, 0.95), inset 0 0 0 1px rgba(232, 93, 135, 0.10)"
} as const;

type Feature = (typeof OUTRO_TIMELINE.features)[number];

const FeatureBeat = ({feature, index}: {feature: Feature; index: number}) => {
  const frame = useCurrentFrame();
  const last = index === FEATURE_COUNT - 1;
  const enterStart = feature.at - OUTRO_TIMELINE.featureEnterFrames;
  const exitStart = last ? OUTRO_TIMELINE.convergeAt : feature.at + OUTRO_TIMELINE.featureHoldFrames;
  const exitEnd = last ? exitStart + OUTRO_TIMELINE.convergeFrames : exitStart + OUTRO_TIMELINE.featureExitFrames;
  if (frame < enterStart || frame > exitEnd) return null;

  const enter = interpolate(frame, [enterStart, enterStart + 2], [0.4, 1], CLAMP);
  const rise = interpolate(frame, [enterStart, feature.at], [86, 0], {...CLAMP, easing: ENTRANCE_EASING});
  const badgeExit = last ? 0 : interpolate(frame, [exitStart, exitEnd], [0, 1], CLAMP);
  const contentExit = interpolate(frame, [exitStart, exitEnd], [0, 1], {
    ...CLAMP,
    easing: last ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic)
  });
  const contentDrift = interpolate(frame, [exitStart, exitEnd], [0, last ? -104 : -74], {
    ...CLAMP,
    easing: last ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic)
  });
  const contentScale = last ? 1 - contentExit * 0.8 : 0.97 + enter * 0.03;

  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: BEAT_INDEX_TOP,
          textAlign: "center",
          fontFamily: BRAND_FONT_FAMILY,
          fontSize: 30,
          fontWeight: 700,
          letterSpacing: 2,
          opacity: enter * (1 - contentExit),
          translate: `0px ${rise}px`
        }}
      >
        <span style={{color: COLORS.pink}}>{String(index + 1).padStart(2, "0")}</span>
        <span style={{color: COLORS.subtle}}> / {String(FEATURE_COUNT).padStart(2, "0")}</span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: BEAT_BADGE.top,
          display: "flex",
          justifyContent: "center",
          opacity: enter * (1 - badgeExit),
          translate: `0px ${rise}px`
        }}
      >
        <div style={badgeTileStyle}>
          <BeatGlyph id={feature.id} />
        </div>
      </div>
      <div style={{position: "absolute", inset: 0, opacity: enter * (1 - contentExit), translate: `0px ${rise + contentDrift}px`, scale: contentScale}}>
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: BEAT_WORD.top,
            textAlign: "center",
            color: COLORS.foreground,
            fontSize: BEAT_WORD.size,
            fontWeight: 700,
            lineHeight: 1,
            letterSpacing: -7,
            whiteSpace: "nowrap"
          }}
        >
          {feature.label}
        </div>
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: BEAT_NOTE_TOP,
            textAlign: "center",
            color: COLORS.muted,
            fontSize: 46,
            fontWeight: 500,
            letterSpacing: 0.4,
            whiteSpace: "nowrap"
          }}
        >
          {feature.note}
        </div>
      </div>
    </>
  );
};

const FeatureBeats = () => {
  const frame = useCurrentFrame();
  const whisperOpacity = entranceOpacity(frame, OUTRO_TIMELINE.featureBoardAt) *
    (1 - interpolate(frame, [OUTRO_TIMELINE.convergeAt, OUTRO_TIMELINE.convergeAt + 6], [0, 1], CLAMP));
  const lastFeature = OUTRO_TIMELINE.features[FEATURE_COUNT - 1];

  return (
    <>
      <BrandWhisper opacity={whisperOpacity} />
      {OUTRO_TIMELINE.features.map((feature, index) => (
        <FeatureBeat key={feature.id} feature={feature} index={index} />
      ))}
      <BrandSeal feature={lastFeature} />
    </>
  );
};

const BrandSeal = ({feature}: {feature: Feature}) => {
  const frame = useCurrentFrame();
  const startAt = OUTRO_TIMELINE.convergeAt + OUTRO_TIMELINE.convergeFrames;
  const resolveAt = OUTRO_TIMELINE.brandResolveAt;
  if (frame < startAt || frame > resolveAt) return null;

  const drift = interpolate(frame, [startAt, resolveAt], [0, BRAND_MARK.y - (BEAT_BADGE.top + BEAT_BADGE.size / 2)], {
    ...CLAMP,
    easing: Easing.inOut(Easing.cubic)
  });
  const swell = interpolate(frame, [startAt, startAt + 5, resolveAt], [1, 1.42, BRAND_ICON.size / BEAT_BADGE.size], {
    ...CLAMP,
    easing: Easing.inOut(Easing.cubic)
  });
  const fade = interpolate(frame, [resolveAt - 4, resolveAt], [1, 0], CLAMP);
  const ringProgress = interpolate(frame, [startAt, resolveAt], [0, 1], CLAMP);

  return (
    <div
      style={{
        position: "absolute",
        left: CANVAS_WIDTH / 2 - BEAT_BADGE.size / 2,
        top: BEAT_BADGE.top,
        width: BEAT_BADGE.size,
        height: BEAT_BADGE.size,
        opacity: fade,
        translate: `0px ${drift}px`,
        scale: swell,
        zIndex: 4
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: -6,
          borderRadius: "50%",
          border: "2.5px solid rgba(232, 93, 135, 0.55)",
          opacity: (1 - ringProgress) * 0.7,
          scale: 1 + ringProgress * 1.6,
          pointerEvents: "none"
        }}
      />
      <div style={{...badgeTileStyle, width: "100%", height: "100%"}}>
        <BeatGlyph id={feature.id} />
      </div>
    </div>
  );
};

const FinalBrand = () => {
  const frame = useCurrentFrame();
  const nameSettledAt = OUTRO_TIMELINE.brandNameAt + 14;
  const iconAt = OUTRO_TIMELINE.brandResolveAt - 4;
  const iconSoftAt = iconAt - 3;
  const lockup = interpolate(frame, [OUTRO_TIMELINE.brandNameAt, nameSettledAt], [0, 1], {...CLAMP, easing: ENTRANCE_EASING});
  const nameRevealLockup = 1 - BRAND_NAME.gap / BRAND_ICON_OUTSET;
  const nameOpacity = interpolate(lockup, [nameRevealLockup, 1], [0, 1], CLAMP);

  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: BRAND_ICON.top,
          height: BRAND_ICON.size,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: BRAND_NAME.gap
        }}
      >
        <Img
          src={staticFile("media/logo.svg")}
          style={{
            width: BRAND_ICON.size,
            height: BRAND_ICON.size,
            borderRadius: BRAND_ICON.size * 0.24,
            opacity: interpolate(frame, [iconAt, iconAt + 4], [0, 1], CLAMP),
            filter: `blur(${interpolate(frame, [iconSoftAt, OUTRO_TIMELINE.brandResolveAt], [6, 0], CLAMP)}px)`,
            translate: `${(1 - lockup) * BRAND_ICON_OUTSET}px 0px`,
            boxShadow: "0 24px 64px -16px rgba(17, 24, 39, 0.20)"
          }}
        />
        <div
          style={{
            color: COLORS.foreground,
            fontFamily: BRAND_FONT_FAMILY,
            fontSize: BRAND_NAME.size,
            fontWeight: 500,
            lineHeight: 1,
            letterSpacing: BRAND_NAME.size * -0.045,
            whiteSpace: "nowrap",
            opacity: nameOpacity,
            translate: `${(1 - nameOpacity) * 18}px ${BRAND_NAME.opticalLift}px`
          }}
        >
          BiliScript
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: TAGLINE_TOP,
          textAlign: "center",
          color: COLORS.foreground,
          fontSize: 34,
          lineHeight: 1.4,
          opacity: interpolate(frame, [OUTRO_TIMELINE.taglineAt, OUTRO_TIMELINE.taglineAt + 12], [0, 1], CLAMP),
          translate: interpolate(frame, [OUTRO_TIMELINE.taglineAt, OUTRO_TIMELINE.taglineAt + 12], ["0px 16px", "0px 0px"], {
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

const TRIPLE_SPARK_RAYS = [
  {angle: -142, dist: 84, color: "#FB7299", kind: "star"},
  {angle: -108, dist: 96, color: "#F59E0B", kind: "coin"},
  {angle: -72, dist: 92, color: "#FB7299", kind: "thumb"},
  {angle: -36, dist: 86, color: "#F59E0B", kind: "star"},
  {angle: 18, dist: 76, color: "#FB7299", kind: "coin"},
  {angle: 56, dist: 82, color: "#00AEEC", kind: "star"},
  {angle: 132, dist: 74, color: "#FB7299", kind: "coin"},
  {angle: 168, dist: 80, color: "#F59E0B", kind: "star"}
] as const;

const TripleLikeBurst = ({clickAt}: {clickAt: number}) => {
  const frame = useCurrentFrame();
  if (frame < clickAt - 2 || frame > clickAt + 20) return null;
  const burstProgress = interpolate(frame, [clickAt - 1, clickAt + 16], [0, 1], {
    ...CLAMP,
    easing: Easing.bezier(0.16, 1, 0.3, 1)
  });
  const burstOpacity = interpolate(frame, [clickAt - 1, clickAt + 2, clickAt + 12, clickAt + 18], [0, 1, 0.86, 0], CLAMP);
  const ringScale = interpolate(frame, [clickAt - 1, clickAt + 14], [0.32, 2.15], {
    ...CLAMP,
    easing: Easing.bezier(0.16, 1, 0.3, 1)
  });

  return (
    <div
      style={{
        position: "absolute",
        left: INSTALL_POINTER.x,
        top: INSTALL_POINTER.y,
        width: 0,
        height: 0,
        pointerEvents: "none",
        zIndex: 12
      }}
    >
      {/* Dual Bilibili Pink + Gold Pulse Rings */}
      <div
        style={{
          position: "absolute",
          left: -34,
          top: -34,
          width: 68,
          height: 68,
          borderRadius: "50%",
          border: "2.5px solid rgba(251, 114, 153, 0.78)",
          boxShadow: "0 0 28px rgba(251, 114, 153, 0.55), inset 0 0 16px rgba(245, 158, 11, 0.35)",
          opacity: burstOpacity,
          scale: ringScale
        }}
      />
      {/* Radiating Geometric Triple-Like Sparks */}
      {TRIPLE_SPARK_RAYS.map((ray, index) => {
        const rad = (ray.angle * Math.PI) / 180;
        const r = ray.dist * burstProgress;
        const x = Math.cos(rad) * r;
        const y = Math.sin(rad) * r;
        const itemScale = interpolate(frame, [clickAt - 1, clickAt + 4, clickAt + 16], [0.35, 1.15, 0.55], CLAMP);
        return (
          <svg
            key={index}
            width={22}
            height={22}
            viewBox="0 0 24 24"
            style={{
              position: "absolute",
              left: -11,
              top: -11,
              translate: `${x.toFixed(1)}px ${y.toFixed(1)}px`,
              scale: itemScale,
              opacity: burstOpacity,
              filter: `drop-shadow(0 0 8px ${ray.color})`
            }}
          >
            {ray.kind === "star" ? (
              <path
                d="M12 2.2 L14.7 8.4 L21.4 9.1 L16.3 13.5 L17.8 20.1 L12 16.6 L6.2 20.1 L7.7 13.5 L2.6 9.1 L9.3 8.4 Z"
                fill={ray.color}
              />
            ) : ray.kind === "coin" ? (
              <>
                <circle cx="12" cy="12" r="8.5" fill={ray.color} />
                <circle cx="12" cy="12" r="4.2" fill="rgba(255, 255, 255, 0.78)" />
              </>
            ) : (
              <path
                d="M12 3.5 L14.8 9.2 L20.5 12 L14.8 14.8 L12 20.5 L9.2 14.8 L3.5 12 L9.2 9.2 Z"
                fill={ray.color}
              />
            )}
          </svg>
        );
      })}
    </div>
  );
};

const CallToAction = () => {
  const frame = useCurrentFrame();
  const clickAt = OUTRO_TIMELINE.installClickAt;
  const buttonFrames = [clickAt - 18, clickAt - 12, clickAt - 9, clickAt, clickAt + 4, clickAt + 8];
  const pointerOpacity =
    interpolate(frame, [OUTRO_TIMELINE.pointerAppearAt, OUTRO_TIMELINE.pointerAppearAt + 4], [0, 1], CLAMP) *
    interpolate(frame, [OUTRO_TIMELINE.pointerExitAt, OUTRO_TIMELINE.pointerGoneAt], [1, 0], CLAMP);
  const pointerRest = `${INSTALL_POINTER.x}px ${INSTALL_POINTER.y}px`;

  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: CTA_TOP,
          display: "flex",
          justifyContent: "center",
          gap: 24,
          opacity: interpolate(frame, [OUTRO_TIMELINE.ctaAt, OUTRO_TIMELINE.ctaAt + 12], [0, 1], CLAMP),
          translate: interpolate(frame, [OUTRO_TIMELINE.ctaAt, OUTRO_TIMELINE.ctaAt + 12], ["0px 20px", "0px 0px"], {
            ...CLAMP,
            easing: ENTRANCE_EASING
          })
        }}
      >
        <div
          style={{
            height: 68,
            padding: "0 32px",
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
              buttonFrames,
              [COLORS.pink, "#D94D79", "#D94D79", "#C9436D", "#D94D79", COLORS.pink]
            ),
            boxShadow: "0 18px 40px -12px rgba(232, 93, 135, 0.38)",
            scale: interpolate(
              frame,
              buttonFrames,
              [1, 1.045, 1.045, 0.965, 1.045, 1],
              {...CLAMP, easing: ENTRANCE_EASING}
            ),
            translate: interpolate(
              frame,
              buttonFrames,
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
            padding: "0 32px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            borderRadius: 999,
            background: "rgba(255, 255, 255, 0.94)",
            backdropFilter: "blur(20px)",
            boxShadow: "0 16px 38px -14px rgba(17, 24, 39, 0.14), 0 0 0 1px rgba(17, 24, 39, 0.05)",
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
          left: 0,
          right: 0,
          top: CTA_TOP + 96,
          textAlign: "center",
          color: COLORS.muted,
          fontSize: 16,
          fontWeight: 500,
          letterSpacing: 0.4,
          opacity: interpolate(frame, [OUTRO_TIMELINE.ctaAt + 4, OUTRO_TIMELINE.ctaAt + 16], [0, 0.86], CLAMP),
          translate: interpolate(frame, [OUTRO_TIMELINE.ctaAt + 4, OUTRO_TIMELINE.ctaAt + 16], ["0px 10px", "0px 0px"], {
            ...CLAMP,
            easing: ENTRANCE_EASING
          })
        }}
      >
        支持 Chrome / Edge 等 Chromium 内核浏览器 · 免费开源
      </div>
      <div
        style={{
          position: "absolute",
          left: INSTALL_POINTER.x,
          top: INSTALL_POINTER.y,
          width: 48,
          height: 48,
          marginLeft: -24,
          marginTop: -24,
          borderRadius: "50%",
          background: "rgba(232, 93, 135, 0.24)",
          boxShadow: "0 0 32px rgba(232, 93, 135, 0.55)",
          opacity: interpolate(frame, [clickAt - 4, clickAt - 2, clickAt + 6], [0, 0.75, 0], CLAMP),
          scale: interpolate(frame, [clickAt - 4, clickAt + 6], [0.35, 1.5], CLAMP)
        }}
      />
      <TripleLikeBurst clickAt={clickAt} />
      <svg
        width={36}
        height={46}
        viewBox="0 0 30 38"
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          overflow: "visible",
          filter: "drop-shadow(0 4px 8px rgba(17, 24, 39, 0.28))",
          opacity: pointerOpacity,
          translate: interpolate(
            frame,
            [OUTRO_TIMELINE.pointerAppearAt, clickAt - 18, clickAt - 8, clickAt, OUTRO_TIMELINE.pointerGoneAt],
            ["1240px 790px", pointerRest, pointerRest, `${INSTALL_POINTER.x}px ${INSTALL_POINTER.y + 4}px`, pointerRest],
            {...CLAMP, easing: Easing.bezier(0.4, 0, 0.2, 1)}
          )
        }}
      >
        <path d="M3 2.5 3.7 28 10 21.8 15.8 33.2 21 30.8 15.2 19.8 24.5 18.5Z" fill="white" stroke="#111827" strokeWidth={2} strokeLinejoin="round" />
      </svg>
    </>
  );
};

const BrandStage = () => {
  const frame = useCurrentFrame();
  const push = interpolate(frame, [OUTRO_TIMELINE.brandPushAt, OUTRO_TIMELINE.duration - 1], [1, OUTRO_TIMELINE.brandPushScale], CLAMP);
  return (
    <div style={{position: "absolute", inset: 0, scale: push, transformOrigin: "50% 50%"}}>
      <FinalBrand />
      <CallToAction />
    </div>
  );
};

export const OutroScene = () => {
  const frame = useCurrentFrame();
  return (
    <div style={{position: "absolute", inset: 0, fontFamily: FONT_FAMILY}}>
      <div style={{position: "absolute", inset: 0, background: "radial-gradient(ellipse 42% 40% at 50% 40%, rgba(232, 93, 135, 0.06) 0%, rgba(232, 93, 135, 0) 72%)"}} />
      <FeatureBeats />
      <BrandStage />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 48,
          textAlign: "center",
          color: COLORS.muted,
          fontSize: 14,
          opacity: entranceOpacity(frame, OUTRO_TIMELINE.finalHoldAt)
        }}
      >
        Music: “BiliScript Pulse” — BiliScript, MIT License
      </div>
    </div>
  );
};
