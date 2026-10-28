import {Easing, Img, interpolate, interpolateColors, staticFile, useCurrentFrame} from "remotion";
import {OUTRO_TIMELINE} from "../outro-timeline.mjs";
import {BRAND_FONT_FAMILY, BrandWhisper, COLORS, FONT_FAMILY, entranceOpacity} from "./design";

const CLAMP = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;
const ENTRANCE_EASING = Easing.bezier(0.16, 1, 0.3, 1);

const FEATURE_CARD = {width: 400, height: 360, gap: 36, top: 360};
const CANVAS_WIDTH = 1920;
const FEATURE_ROW_WIDTH = OUTRO_TIMELINE.features.length * FEATURE_CARD.width + (OUTRO_TIMELINE.features.length - 1) * FEATURE_CARD.gap;
const FEATURE_ROW_LEFT = (CANVAS_WIDTH - FEATURE_ROW_WIDTH) / 2;
const FEATURE_ROW_CENTER_Y = FEATURE_CARD.top + FEATURE_CARD.height / 2;

const BRAND_ICON = {size: 110, top: 350};
const BRAND_NAME = {size: 148, advance: 540, gap: 60, opticalLift: -11};
const BRAND_GROUP_WIDTH = BRAND_ICON.size + BRAND_NAME.gap + BRAND_NAME.advance;
const BRAND_ICON_OUTSET = (BRAND_GROUP_WIDTH - BRAND_ICON.size) / 2;
const BRAND_MARK = {x: CANVAS_WIDTH / 2, y: BRAND_ICON.top + BRAND_ICON.size / 2};
const FEATURE_CONVERGE_SCALE = BRAND_ICON.size / FEATURE_CARD.width;
const TAGLINE_TOP = 520;
const CTA_TOP = 616;
const INSTALL_POINTER = {x: 930, y: CTA_TOP + 60};

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

const FeatureMicroPreview = ({id, activeProgress}: {id: string; activeProgress: number}) => {
  if (id === "feature-bilingual") {
    return (
      <div
        style={{
          padding: "14px 18px",
          borderRadius: 18,
          background: "rgba(244, 245, 248, 0.88)",
          opacity: activeProgress,
          translate: `0px ${(1 - activeProgress) * 14}px`
        }}
      >
        <div style={{display: "flex", alignItems: "center", gap: 10, color: COLORS.foreground, fontSize: 18, fontWeight: 600}}>
          <span style={{color: COLORS.pink, fontFamily: BRAND_FONT_FAMILY}}>04:07</span>
          <span>即使给出证据也难避幻觉</span>
        </div>
        <div style={{marginTop: 4, color: COLORS.muted, fontSize: 15, fontWeight: 500}}>
          Even with evidence, hallucinations persist
        </div>
      </div>
    );
  }
  if (id === "feature-export") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          opacity: activeProgress,
          translate: `0px ${(1 - activeProgress) * 14}px`
        }}
      >
        {["SRT", "TXT", "MD", "复制全文"].map((tag, idx) => (
          <div
            key={tag}
            style={{
              padding: "10px 14px",
              borderRadius: 999,
              background: idx === 2 ? "rgba(232, 93, 135, 0.14)" : "rgba(244, 245, 248, 0.92)",
              color: idx === 2 ? COLORS.pink : COLORS.foreground,
              fontSize: 17,
              fontWeight: 600
            }}
          >
            {tag}
          </div>
        ))}
      </div>
    );
  }
  if (id === "feature-asr") {
    const bars = [0.42, 0.85, 0.62, 0.96, 0.54, 0.78, 0.9, 0.48, 0.74, 0.38];
    return (
      <div
        style={{
          padding: "14px 18px",
          borderRadius: 18,
          background: "rgba(244, 245, 248, 0.88)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          opacity: activeProgress,
          translate: `0px ${(1 - activeProgress) * 14}px`
        }}
      >
        <div style={{display: "flex", alignItems: "center", gap: 6, height: 34}}>
          {bars.map((h, i) => (
            <div
              key={i}
              style={{
                width: 6,
                height: Math.round(32 * h * activeProgress),
                borderRadius: 999,
                background: i % 2 === 0 ? COLORS.pink : COLORS.blue
              }}
            />
          ))}
        </div>
        <div style={{color: COLORS.foreground, fontSize: 16, fontWeight: 600}}>音轨直转时间轴</div>
      </div>
    );
  }
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        opacity: activeProgress,
        translate: `0px ${(1 - activeProgress) * 14}px`
      }}
    >
      <div
        style={{
          padding: "10px 16px",
          borderRadius: 999,
          background: "rgba(38, 121, 184, 0.10)",
          color: COLORS.blue,
          fontSize: 16,
          fontWeight: 600
        }}
      >
        实时检索
      </div>
      <div
        style={{
          padding: "10px 16px",
          borderRadius: 999,
          background: "rgba(244, 245, 248, 0.92)",
          color: COLORS.foreground,
          fontSize: 16,
          fontWeight: 600
        }}
      >
        外部事实核验 [1][2]
      </div>
    </div>
  );
};

const FeatureCards = () => {
  const frame = useCurrentFrame();
  const boardStart = OUTRO_TIMELINE.featureBoardAt;
  const boardOpacity = entranceOpacity(frame, boardStart);
  const boardRise = interpolate(frame, [boardStart, boardStart + 8], [22, 0], {...CLAMP, easing: ENTRANCE_EASING});
  const converge = interpolate(frame, [OUTRO_TIMELINE.convergeAt, OUTRO_TIMELINE.convergeAt + 12], [0, 1], {...CLAMP, easing: ENTRANCE_EASING});
  const convergeOpacity = interpolate(frame, [OUTRO_TIMELINE.convergeAt + 12, OUTRO_TIMELINE.convergeAt + 16], [1, 0], CLAMP);
  const contentOpacity = interpolate(frame, [OUTRO_TIMELINE.convergeAt, OUTRO_TIMELINE.convergeAt + 4], [1, 0], CLAMP);

  return (
    <>
      <BrandWhisper opacity={boardOpacity * contentOpacity} />
      {OUTRO_TIMELINE.features.map((feature, index) => {
        const left = FEATURE_ROW_LEFT + index * (FEATURE_CARD.width + FEATURE_CARD.gap);
        const dx = BRAND_MARK.x - (left + FEATURE_CARD.width / 2);
        const dy = BRAND_MARK.y - FEATURE_ROW_CENTER_Y;
        const activeProgress = interpolate(
          frame,
          [feature.at - OUTRO_TIMELINE.featureContentFrames, feature.at],
          [0, 1],
          {...CLAMP, easing: ENTRANCE_EASING}
        );
        const hitPulse = interpolate(frame, [feature.at - 2, feature.at + 2, feature.at + 12], [0, 1, 0], CLAMP);
        return (
          <div
            key={feature.id}
            style={{
              position: "absolute",
              left,
              top: FEATURE_CARD.top,
              width: FEATURE_CARD.width,
              height: FEATURE_CARD.height,
              padding: "34px 36px 32px",
              display: "flex",
              flexDirection: "column",
              borderRadius: 32,
              background: "rgba(255, 255, 255, 0.94)",
              backdropFilter: "blur(24px)",
              boxShadow: `0 32px 76px -28px rgba(17, 24, 39, ${0.18 * (1 - converge)}), 0 0 ${Math.round(hitPulse * 38)}px rgba(232, 93, 135, ${hitPulse * 0.28}), 0 0 0 1px rgba(232, 93, 135, ${0.06 + hitPulse * 0.34})`,
              opacity: boardOpacity * convergeOpacity,
              translate: `${dx * converge}px ${boardRise + dy * converge}px`,
              scale: (1 + hitPulse * 0.02) * (1 + (FEATURE_CONVERGE_SCALE - 1) * converge)
            }}
          >
            <div style={{flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between", opacity: contentOpacity}}>
              <div>
                <div style={{width: 40, height: 4, borderRadius: 99, background: COLORS.pink, marginBottom: 20}} />
                <div style={{height: 66, overflow: "hidden"}}>
                  <div
                    style={{
                      color: COLORS.foreground,
                      fontSize: 52,
                      fontWeight: 600,
                      lineHeight: 1.15,
                      letterSpacing: -1.4,
                      whiteSpace: "nowrap",
                      translate: interpolate(frame, [feature.at - OUTRO_TIMELINE.featureContentFrames, feature.at], ["0px 72px", "0px 0px"], {
                        ...CLAMP,
                        easing: ENTRANCE_EASING
                      })
                    }}
                  >
                    {feature.label}
                  </div>
                </div>
              </div>

              <FeatureMicroPreview id={feature.id} activeProgress={activeProgress} />

              <div style={{height: 34, overflow: "hidden"}}>
                <div
                  style={{
                    color: COLORS.muted,
                    fontSize: 22,
                    fontWeight: 500,
                    lineHeight: 1.4,
                    whiteSpace: "nowrap",
                    translate: interpolate(frame, [feature.at - OUTRO_TIMELINE.featureContentFrames, feature.at], ["0px 34px", "0px 0px"], {
                      ...CLAMP,
                      easing: ENTRANCE_EASING
                    })
                  }}
                >
                  {feature.description}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
};

const FinalBrand = () => {
  const frame = useCurrentFrame();
  const nameSettledAt = OUTRO_TIMELINE.brandNameAt + 14;
  const iconAt = OUTRO_TIMELINE.convergeAt + 12;
  const iconSoftAt = iconAt - 6;
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
  const buttonFrames = [156, 162, 165, clickAt, clickAt + 4, clickAt + 8];
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
            [OUTRO_TIMELINE.pointerAppearAt, 156, 166, clickAt, OUTRO_TIMELINE.pointerGoneAt],
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
      <FeatureCards />
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
