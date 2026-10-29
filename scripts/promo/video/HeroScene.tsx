import {AbsoluteFill, Easing, Img, OffthreadVideo, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from "remotion";
import {BRAND_FONT_FAMILY, COLORS, ELEVATION, FONT_FAMILY, PaperGrainOverlay} from "./design";

const BUTTON = {x: 1132, y: 1026};
const PANEL = {x: 1356, y: 52, width: 554, height: 1014};
const PULLBACK_START = 38;
const PULLBACK_END = 43;
const CLICK_AT = 42;
const PANEL_OPEN_FRAMES = 14;
const HEADER_REVEAL_AT = 43;
const SNAP_EMPHASIS_AT = 75;
const HERO_SOURCE_CLICK_FRAME = 36;

export const HERO_STEM = "看 B 站长视频 ——";
export const HERO_HEADLINE = "BiliScript · 直接「读」视频";

export const HERO_SLOT_BEATS = [
  {text: "收藏夹吃灰？", from: 0, to: 14, popAt: 4},
  {text: "死活拖不到那秒？", from: 14, to: 28, popAt: 16},
  {text: "想追问没人答？", from: 28, to: 42, popAt: 28}
] as const;

export function heroBeatIndexAtFrame(frame: number): number {
  if (frame < HERO_SLOT_BEATS[1].from) return 0;
  if (frame < HERO_SLOT_BEATS[2].from) return 1;
  return 2;
}

export function heroSlotOpacityAtFrame(frame: number): number {
  if (frame <= 0) return 1;
  if (frame >= PULLBACK_END) return 0;
  return interpolate(frame, [PULLBACK_START, PULLBACK_END - 0.5], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
}

const SlotFlipHook = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  if (frame >= PULLBACK_END) return null;

  const beatIndex = heroBeatIndexAtFrame(frame);
  const activeBeat = HERO_SLOT_BEATS[beatIndex];
  const localBeatFrame = frame - activeBeat.from;

  const collapse = interpolate(frame, [PULLBACK_START, PULLBACK_END], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1)
  });
  const collapseScale = interpolate(collapse, [0, 1], [1, 0.78]);
  const collapseOpacity = heroSlotOpacityAtFrame(frame);
  const collapseBlur = interpolate(collapse, [0, 1], [0, 10]);

  const flipSpring =
    beatIndex === 0
      ? 1
      : spring({
          frame: Math.max(0, localBeatFrame),
          fps,
          config: {damping: 14, stiffness: 220, mass: 0.65}
        });
  const slotLiftY = beatIndex === 0 ? 0 : interpolate(flipSpring, [0, 1], [44, 0]);
  const slotRotateX = beatIndex === 0 ? 0 : interpolate(flipSpring, [0, 1], [-58, 0]);
  const popPulse =
    frame >= activeBeat.popAt && frame <= activeBeat.popAt + 7
      ? interpolate(frame, [activeBeat.popAt, activeBeat.popAt + 2, activeBeat.popAt + 7], [1, 1.045, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp"
        })
      : 1;

  const markerSweep =
    beatIndex === 0
      ? 1
      : interpolate(localBeatFrame, [0, 5], [0.42, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.bezier(0.16, 1, 0.3, 1)
        });

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 18,
        pointerEvents: "none"
      }}
    >
      <div
        style={{
          padding: "40px 62px",
          borderRadius: 42,
          background: "rgba(255, 255, 255, 0.96)",
          backdropFilter: "blur(26px)",
          boxShadow: ELEVATION.heroFloat,
          display: "flex",
          alignItems: "center",
          gap: 20,
          whiteSpace: "nowrap",
          opacity: collapseOpacity,
          translate: `0px ${(-collapse * 22).toFixed(1)}px`,
          scale: collapseScale,
          filter: collapseBlur > 0.2 ? `blur(${collapseBlur.toFixed(1)}px)` : undefined
        }}
      >
        <span
          style={{
            color: COLORS.inkSoft,
            fontSize: 64,
            fontWeight: 700,
            lineHeight: 1.16,
            letterSpacing: -2.2
          }}
        >
          {HERO_STEM}
        </span>
        <div
          style={{
            position: "relative",
            minWidth: 590,
            height: 112,
            padding: "0 28px",
            borderRadius: 26,
            background: "rgba(251, 245, 247, 0.95)",
            boxShadow: "inset 0 2px 8px rgba(17, 24, 39, 0.06), 0 0 0 1.5px rgba(232, 93, 135, 0.26)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden"
          }}
        >
          <div
            key={activeBeat.text}
            style={{
              position: "relative",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "6px 20px",
              fontSize: 70,
              fontWeight: 800,
              lineHeight: 1.08,
              letterSpacing: -2.4,
              color: "#C81E5B",
              transform: `perspective(900px) translateY(${slotLiftY.toFixed(1)}px) rotateX(${slotRotateX.toFixed(1)}deg) scale(${popPulse.toFixed(3)})`,
              transformOrigin: "50% 50%"
            }}
          >
            <span
              style={{
                position: "absolute",
                inset: "4px 0",
                borderRadius: 16,
                background: "linear-gradient(96deg, rgba(255, 212, 59, 0.78) 0%, rgba(251, 114, 153, 0.46) 100%)",
                boxShadow: "0 8px 22px -6px rgba(232, 93, 135, 0.36)",
                transformOrigin: "0% 50%",
                transform: `scaleX(${markerSweep.toFixed(3)}) skewX(-6deg)`,
                zIndex: -1
              }}
            />
            {activeBeat.text}
          </div>
        </div>
      </div>
    </div>
  );
};

const Cursor = () => {
  const frame = useCurrentFrame();
  if (frame < PULLBACK_START) return null;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: BUTTON.x - 28,
          top: BUTTON.y - 28,
          width: 56,
          height: 56,
          background: "rgba(232, 93, 135, 0.24)",
          boxShadow: "0 0 36px rgba(232, 93, 135, 0.55)",
          borderRadius: "50%",
          opacity: interpolate(frame, [CLICK_AT, CLICK_AT + 10], [0.88, 0], {extrapolateLeft: "clamp", extrapolateRight: "clamp"}),
          scale: interpolate(frame, [CLICK_AT, CLICK_AT + 10], [0.45, 1.65], {extrapolateLeft: "clamp", extrapolateRight: "clamp"})
        }}
      />
      <svg
        viewBox="0 0 30 38"
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 30,
          height: 38,
          filter: "drop-shadow(0 4px 8px rgba(17, 24, 39, 0.35))",
          opacity: interpolate(frame, [PULLBACK_START, PULLBACK_START + 2, CLICK_AT + 6, CLICK_AT + 13], [0, 1, 1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp"
          }),
          translate: interpolate(frame, [PULLBACK_START, CLICK_AT], ["980px 860px", `${BUTTON.x}px ${BUTTON.y}px`], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1)
          }),
          scale: interpolate(frame, [CLICK_AT - 2, CLICK_AT, CLICK_AT + 3], [1, 0.82, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"})
        }}
      >
        <path d="M3 2 L3 29 L10 23 L16 35 L22 32 L16 21 L26 20 Z" fill="white" stroke={COLORS.foreground} strokeWidth="2" strokeLinejoin="round" />
      </svg>
    </>
  );
};

const ReaderPanel = () => {
  const frame = useCurrentFrame();
  if (frame < CLICK_AT) return null;
  const unfoldProgress = interpolate(frame, [CLICK_AT, CLICK_AT + PANEL_OPEN_FRAMES + 2], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1)
  });
  const offsetX = interpolate(unfoldProgress, [0, 1], [136, 0]);
  const bookRotateY = interpolate(unfoldProgress, [0, 1], [-54, 0]);
  const spineShadowOpacity = interpolate(frame, [CLICK_AT, CLICK_AT + 4, CLICK_AT + PANEL_OPEN_FRAMES + 4], [0, 0.95, 0.42], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const paperSheenX = interpolate(unfoldProgress, [0, 1], [105, -25]);
  const paperSheenOpacity = interpolate(unfoldProgress, [0, 0.35, 1], [0, 0.82, 0]);
  const panelOpacity = interpolate(frame, [CLICK_AT, CLICK_AT + 2], [0.76, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"});
  const snapHighlight = interpolate(frame, [SNAP_EMPHASIS_AT - 2, SNAP_EMPHASIS_AT + 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1)
  });

  return (
    <div
      style={{
        position: "absolute",
        left: PANEL.x,
        top: PANEL.y,
        width: PANEL.width,
        height: PANEL.height,
        transformOrigin: "100% 50%",
        transform: `perspective(1600px) translateX(${offsetX.toFixed(1)}px) rotateY(${bookRotateY.toFixed(2)}deg)`,
        opacity: panelOpacity,
        zIndex: 6
      }}
    >
      <div
        style={{
          position: "absolute",
          left: -42,
          top: 0,
          width: 42,
          height: PANEL.height,
          background: "linear-gradient(90deg, rgba(17, 24, 39, 0) 0%, rgba(17, 24, 39, 0.28) 100%)",
          opacity: spineShadowOpacity,
          pointerEvents: "none"
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 24,
          background: "#FBF9F4",
          boxShadow: `-36px 24px 96px -20px rgba(17, 24, 39, ${(0.28 + snapHighlight * 0.14).toFixed(2)}), 0 0 ${Math.round(snapHighlight * 44)}px rgba(232, 93, 135, ${(snapHighlight * 0.28).toFixed(2)}), 0 0 0 ${(1 + snapHighlight * 1.2).toFixed(1)}px rgba(232, 93, 135, ${(0.18 + snapHighlight * 0.36).toFixed(2)})`
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 24,
          overflow: "hidden"
        }}
      >
        <Img
          src={staticFile("media/overview-poster.jpg")}
          style={{position: "absolute", left: -PANEL.x, top: -PANEL.y, width: 1920, height: 1080, maxWidth: "none"}}
        />
        <PaperGrainOverlay opacity={0.14} warm borderRadius={24} />
        {paperSheenOpacity > 0.01 ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: `linear-gradient(102deg, rgba(255, 250, 238, 0) ${paperSheenX - 24}%, rgba(255, 246, 224, 0.68) ${paperSheenX}%, rgba(255, 250, 238, 0) ${paperSheenX + 24}%)`,
              opacity: paperSheenOpacity,
              pointerEvents: "none"
            }}
          />
        ) : null}
      </div>
    </div>
  );
};

const HeroBrandHeadline = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  if (frame < HEADER_REVEAL_AT) return null;

  const enterSpring = spring({
    frame: Math.max(0, frame - HEADER_REVEAL_AT),
    fps,
    config: {damping: 16, stiffness: 160, mass: 0.78}
  });
  const bandOpacity = interpolate(frame, [HEADER_REVEAL_AT, HEADER_REVEAL_AT + 5], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic)
  });
  const snapPulse =
    frame >= SNAP_EMPHASIS_AT - 1
      ? spring({
          frame: Math.max(0, frame - (SNAP_EMPHASIS_AT - 1)),
          fps,
          config: {damping: 14, stiffness: 185, mass: 0.7}
        })
      : 0;
  const enterScale = interpolate(enterSpring, [0, 1], [0.9, 1]) * interpolate(snapPulse, [0, 0.5, 1], [1, 1.04, 1.02]);
  const enterLift = interpolate(enterSpring, [0, 1], [28, 0]);
  const readSweep = interpolate(frame, [HEADER_REVEAL_AT + 3, SNAP_EMPHASIS_AT + 4], [0.65, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1)
  });

  return (
    <div
      style={{
        position: "absolute",
        left: 678,
        top: "50%",
        translate: `-50% calc(-50% + ${enterLift.toFixed(1)}px)`,
        padding: "32px 58px",
        borderRadius: 999,
        background: "rgba(255, 255, 255, 0.96)",
        backdropFilter: "blur(28px)",
        boxShadow: ELEVATION.heroFloat,
        display: "flex",
        alignItems: "center",
        gap: 24,
        zIndex: 24,
        opacity: bandOpacity,
        scale: enterScale,
        whiteSpace: "nowrap"
      }}
    >
      <Img src={staticFile("media/logo.svg")} style={{width: 58, height: 58, borderRadius: 15}} />
      <div
        style={{
          color: COLORS.foreground,
          fontSize: 64,
          fontWeight: 800,
          lineHeight: 1.1,
          letterSpacing: -2.4,
          display: "flex",
          alignItems: "baseline",
          gap: 16
        }}
      >
        <span style={{fontFamily: BRAND_FONT_FAMILY, fontWeight: 700, letterSpacing: -1.8}}>BiliScript</span>
        <span style={{color: COLORS.subtle, fontWeight: 600}}>·</span>
        <span>
          直接
          <span
            style={{
              position: "relative",
              display: "inline-block",
              margin: "0 -6px 0 -2px",
              padding: "2px 4px",
              color: "#C81E5B"
            }}
          >
            <span
              style={{
                position: "absolute",
                inset: "4px 6px",
                borderRadius: 12,
                background: "linear-gradient(96deg, rgba(255, 212, 59, 0.72) 0%, rgba(251, 114, 153, 0.44) 100%)",
                transformOrigin: "0% 50%",
                transform: `scaleX(${readSweep.toFixed(3)}) skewX(-6deg)`,
                zIndex: -1
              }}
            />
            「读」
          </span>
          视频
        </span>
      </div>
    </div>
  );
};

const ToolbarEntryCallout = () => {
  const frame = useCurrentFrame();
  if (frame < PULLBACK_START || frame > CLICK_AT + 10) return null;
  const opacity = interpolate(frame, [PULLBACK_START, CLICK_AT - 1, CLICK_AT + 2, CLICK_AT + 10], [0, 1, 0.92, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  return (
    <div
      style={{
        position: "absolute",
        left: BUTTON.x - 44,
        top: BUTTON.y - 22,
        width: 88,
        height: 44,
        borderRadius: 999,
        background: "rgba(232, 93, 135, 0.14)",
        boxShadow: "0 0 28px 4px rgba(232, 93, 135, 0.32), 0 0 0 1px rgba(232, 93, 135, 0.38)",
        pointerEvents: "none",
        opacity
      }}
    />
  );
};

export const HeroScene = () => {
  const frame = useCurrentFrame();
  const pullbackProgress = interpolate(frame, [PULLBACK_START, PULLBACK_END], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1)
  });
  const focusProgress = interpolate(frame, [SNAP_EMPHASIS_AT - 3, SNAP_EMPHASIS_AT + 18], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1)
  });
  const hookDriftScale = interpolate(frame, [0, PULLBACK_START], [1.28, 1.24], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const videoScale = interpolate(pullbackProgress, [0, 1], [hookDriftScale, 1]);
  const pullbackBlur = interpolate(pullbackProgress, [0, 1], [5.5, 1.2]);
  const videoBlur = interpolate(focusProgress, [0, 1], [pullbackBlur, 3.6]);
  const veilOpacity = interpolate(pullbackProgress, [0, 1], [0.88, 0.24]);
  const stageZoomScale = interpolate(focusProgress, [0, 1], [1, 1.08]);

  return (
    <AbsoluteFill style={{background: COLORS.background, fontFamily: FONT_FAMILY, overflow: "hidden"}}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          transformOrigin: "92% 42%",
          scale: stageZoomScale
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            transformOrigin: "54% 46%",
            scale: videoScale,
            filter: videoBlur > 0.1 ? `blur(${videoBlur.toFixed(2)}px)` : undefined
          }}
        >
          <OffthreadVideo
            muted
            src={staticFile("media/hero-hook.mp4")}
            playbackRate={HERO_SOURCE_CLICK_FRAME / CLICK_AT}
            style={{position: "absolute", inset: 0, width: 1920, height: 1080}}
          />
        </div>
        {veilOpacity > 0.01 ? (
          <AbsoluteFill
            style={{
              background: [
                "radial-gradient(ellipse 55% 60% at 24% 42%, rgba(232, 93, 135, 0.10) 0%, rgba(232, 93, 135, 0) 70%)",
                "radial-gradient(ellipse 60% 65% at 78% 52%, rgba(38, 121, 184, 0.10) 0%, rgba(38, 121, 184, 0) 72%)",
                "linear-gradient(160deg, rgba(251, 251, 253, 0.76) 0%, rgba(244, 245, 248, 0.68) 100%)"
              ].join(", "),
              opacity: veilOpacity,
              pointerEvents: "none"
            }}
          />
        ) : null}
        <ToolbarEntryCallout />
        <ReaderPanel />
        <Cursor />
      </div>
      <HeroBrandHeadline />
      <SlotFlipHook />
    </AbsoluteFill>
  );
};
