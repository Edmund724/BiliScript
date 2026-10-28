import {AbsoluteFill, Easing, Img, OffthreadVideo, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from "remotion";
import {BRAND_FONT_FAMILY, Brand, BrandWhisper, COLORS, ELEVATION, FONT_FAMILY, PaperGrainOverlay} from "./design";

const BUTTON = {x: 1132, y: 1026};
const PANEL = {x: 1356, y: 52, width: 554, height: 1014};
const PULLBACK_START = 36;
const PULLBACK_END = 43;
const CLICK_AT = 42;
const PANEL_OPEN_FRAMES = 14;
const HEADER_REVEAL_AT = 40;
const ZOOM_FOCUS_START = 54;
const ZOOM_FOCUS_END = 72;
const HERO_SOURCE_CLICK_FRAME = 36;

const QUESTIONS = [
  {
    enterAt: 0,
    prefix: "1 小时公开课，在收藏夹",
    highlight: "吃灰多久了？",
    left: 210,
    top: 204
  },
  {
    enterAt: 13,
    prefix: "记得 UP 主说过那句话，",
    highlight: "死活拖不到那一秒？",
    left: 280,
    top: 430
  },
  {
    enterAt: 26,
    prefix: "看视频卡在半路，",
    highlight: "想追问细节没人答？",
    left: 350,
    top: 656
  }
] as const;

const DANMAKU_ITEMS = [
  {text: "48 分钟太长了，课代表呢？求个省流总结！", top: 68, startX: 1460, speed: 12.5, highlight: true},
  {text: "前面老师提过「幻觉」，到底在第几分钟？", top: 126, startX: 1680, speed: 14.2, highlight: false},
  {text: "右键快进按烂了，死活拖不到刚刚那句话…", top: 76, startX: 720, speed: 11.4, highlight: false},
  {text: "人机象棋实验那段没听懂，有人解释下吗", top: 134, startX: 980, speed: 13.0, highlight: false}
] as const;

const SCRUB_STAMPS = ["02:14", "14:38", "27:09", "08:52", "35:41", "04:07"] as const;

const BiliPainPointBackdrop = () => {
  const frame = useCurrentFrame();
  if (frame >= PULLBACK_END) return null;

  const fadeOut = interpolate(frame, [PULLBACK_START - 2, PULLBACK_END - 1], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic)
  });
  const scrubProgress = interpolate(
    frame,
    [0, 8, 15, 22, 29, PULLBACK_START],
    [0.08, 0.34, 0.62, 0.21, 0.78, 0.14],
    {extrapolateLeft: "clamp", extrapolateRight: "clamp"}
  );
  const stampIndex = Math.min(SCRUB_STAMPS.length - 1, Math.floor((frame / PULLBACK_START) * SCRUB_STAMPS.length));

  return (
    <div style={{position: "absolute", inset: 0, opacity: fadeOut, pointerEvents: "none", zIndex: 4}}>
      {DANMAKU_ITEMS.map((item) => {
        const x = item.startX - frame * item.speed;
        return (
          <div
            key={item.text}
            style={{
              position: "absolute",
              left: x,
              top: item.top,
              padding: item.highlight ? "7px 20px" : "4px 12px",
              borderRadius: 999,
              background: item.highlight ? "rgba(15, 23, 42, 0.66)" : "rgba(15, 23, 42, 0.38)",
              border: item.highlight ? "1.5px solid rgba(251, 114, 153, 0.78)" : "1px solid rgba(255, 255, 255, 0.22)",
              backdropFilter: "blur(8px)",
              color: "#FFFFFF",
              fontSize: item.highlight ? 26 : 23,
              fontWeight: item.highlight ? 700 : 600,
              letterSpacing: -0.3,
              whiteSpace: "nowrap",
              textShadow: "0 2px 6px rgba(0, 0, 0, 0.55)",
              boxShadow: item.highlight ? "0 10px 28px -8px rgba(251, 114, 153, 0.45)" : "none"
            }}
          >
            {item.highlight ? <span style={{color: "#FB7299", marginRight: 8}}>● 弹幕热议</span> : null}
            {item.text}
          </div>
        );
      })}

      {/* Frantic Bilibili Progress Scrub Bar at Bottom */}
      <div
        style={{
          position: "absolute",
          left: 160,
          right: 160,
          bottom: 44,
          padding: "14px 24px 16px",
          borderRadius: 20,
          background: "rgba(15, 23, 42, 0.72)",
          backdropFilter: "blur(16px)",
          boxShadow: "0 18px 42px -16px rgba(15, 23, 42, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.14)",
          display: "flex",
          flexDirection: "column",
          gap: 10
        }}
      >
        <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", color: "#F8FAFC", fontSize: 19, fontWeight: 600}}>
          <div style={{display: "flex", alignItems: "center", gap: 12}}>
            <span
              style={{
                padding: "3px 12px",
                borderRadius: 999,
                background: "rgba(251, 114, 153, 0.24)",
                color: "#FF85AD",
                fontSize: 17,
                fontWeight: 700
              }}
            >
              ▸▸ 正在狂按右键找重点…
            </span>
            <span style={{color: "rgba(248, 250, 252, 0.78)", fontSize: 18}}>进度条太长，刚听到的金句又找不到了</span>
          </div>
          <span style={{fontFamily: BRAND_FONT_FAMILY, fontSize: 21, fontWeight: 700, fontVariantNumeric: "tabular-nums"}}>
            <span style={{color: "#FB7299"}}>{SCRUB_STAMPS[stampIndex]}</span>
            <span style={{color: "rgba(248, 250, 252, 0.55)"}}> / 48:16</span>
          </span>
        </div>
        <div style={{position: "relative", height: 8, borderRadius: 999, background: "rgba(255, 255, 255, 0.22)"}}>
          <div
            style={{
              width: `${Math.round(scrubProgress * 100)}%`,
              height: "100%",
              borderRadius: 999,
              background: "linear-gradient(90deg, #FB7299 0%, #FF9DBB 100%)",
              boxShadow: "0 0 16px rgba(251, 114, 153, 0.8)"
            }}
          />
          <div
            style={{
              position: "absolute",
              left: `${Math.round(scrubProgress * 100)}%`,
              top: "50%",
              width: 18,
              height: 18,
              marginLeft: -9,
              marginTop: -9,
              borderRadius: "50%",
              background: "#FFFFFF",
              border: "3px solid #FB7299",
              boxShadow: "0 0 14px rgba(251, 114, 153, 0.9)"
            }}
          />
        </div>
      </div>
    </div>
  );
};

const PainPointQuestionStack = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  if (frame >= PULLBACK_END) return null;

  const collapse = interpolate(frame, [PULLBACK_START, PULLBACK_END], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1)
  });
  const collapseScale = interpolate(collapse, [0, 1], [1, 0.72]);
  const collapseOpacity = interpolate(collapse, [0, 0.82], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const collapseBlur = interpolate(collapse, [0, 1], [0, 12]);
  const whisperOpacity = interpolate(frame, [PULLBACK_START - 2, PULLBACK_START + 4], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });

  return (
    <>
      <BrandWhisper opacity={whisperOpacity} />
      {QUESTIONS.map((question, index) => {
        if (frame < question.enterAt) return null;
        const enterProgress = spring({
          frame: Math.max(0, frame - question.enterAt),
          fps,
          config: {damping: 16, stiffness: 155, mass: 0.78}
        });
        const enterOpacity =
          index === 0
            ? interpolate(frame, [0, 5], [0.92, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"})
            : interpolate(frame, [question.enterAt, question.enterAt + 5], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: Easing.out(Easing.cubic)
              });
        const enterLift = interpolate(enterProgress, [0, 1], [index === 0 ? 10 : 36, 0]);
        const enterScale = interpolate(enterProgress, [0, 1], [index === 0 ? 0.96 : 0.92, 1]);

        let depthLevel = 0;
        for (let nextIdx = index + 1; nextIdx < QUESTIONS.length; nextIdx += 1) {
          depthLevel += interpolate(
            frame,
            [QUESTIONS[nextIdx].enterAt, QUESTIONS[nextIdx].enterAt + 10],
            [0, 1],
            {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.out(Easing.cubic)
            }
          );
        }

        const recedeScale = 1 - depthLevel * 0.032;
        const recedeOpacity = 1 - depthLevel * 0.14;
        const recedeY = -depthLevel * 8;
        const isFrontCard = depthLevel < 0.5;

        return (
          <div
            key={question.highlight}
            style={{
              position: "absolute",
              left: question.left,
              top: question.top,
              padding: "32px 52px",
              borderRadius: 32,
              background: isFrontCard ? "rgba(255, 255, 255, 0.95)" : "rgba(255, 255, 255, 0.88)",
              backdropFilter: "blur(24px)",
              boxShadow: isFrontCard ? ELEVATION.heroFloat : ELEVATION.cardSoft,
              color: COLORS.foreground,
              fontSize: 58,
              fontWeight: 600,
              lineHeight: 1.24,
              letterSpacing: -1.9,
              whiteSpace: "nowrap",
              opacity: enterOpacity * recedeOpacity * collapseOpacity,
              translate: `0px ${enterLift + recedeY - collapse * 24}px`,
              scale: enterScale * recedeScale * collapseScale,
              filter: collapseBlur > 0.2 ? `blur(${collapseBlur.toFixed(1)}px)` : undefined,
              transformOrigin: "50% 50%",
              zIndex: 10 + index
            }}
          >
            <span>{question.prefix}</span>
            <span style={{color: COLORS.pink}}>{question.highlight}</span>
          </div>
        );
      })}
    </>
  );
};

const Cursor = () => {
  const frame = useCurrentFrame();
  if (frame < PULLBACK_END - 5) return null;
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
          opacity: interpolate(frame, [PULLBACK_END - 5, PULLBACK_END - 2, CLICK_AT + 5, CLICK_AT + 12], [0, 1, 1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp"
          }),
          translate: interpolate(frame, [PULLBACK_END - 5, CLICK_AT - 1], ["980px 860px", `${BUTTON.x}px ${BUTTON.y}px`], {
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
  const panelOpacity = interpolate(frame, [CLICK_AT, CLICK_AT + 2], [0.72, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"});

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
      {/* Book Spine Crease Shadow on Left Seam */}
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
          boxShadow: "-36px 24px 96px -20px rgba(17, 24, 39, 0.28), 0 0 0 1px rgba(232, 93, 135, 0.18)"
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

const HeroMessage = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  if (frame < HEADER_REVEAL_AT) return null;

  const enterSpring = spring({
    frame: Math.max(0, frame - HEADER_REVEAL_AT),
    fps,
    config: {damping: 18, stiffness: 150, mass: 0.8}
  });
  const bandOpacity = interpolate(frame, [HEADER_REVEAL_AT, HEADER_REVEAL_AT + 6], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic)
  });
  const dockProgress = interpolate(frame, [ZOOM_FOCUS_START, ZOOM_FOCUS_END], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1)
  });

  const left = interpolate(dockProgress, [0, 1], [230, 64]);
  const top = interpolate(dockProgress, [0, 1], [440, 56]);
  const baseScale = interpolate(dockProgress, [0, 1], [1.12, 0.86]);
  const enterScale = interpolate(enterSpring, [0, 1], [0.92, 1]);
  const enterLift = interpolate(enterSpring, [0, 1], [28, 0]);

  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        padding: "26px 46px",
        borderRadius: 999,
        background: "rgba(251, 251, 253, 0.95)",
        backdropFilter: "blur(28px)",
        boxShadow: ELEVATION.heroFloat,
        display: "flex",
        alignItems: "center",
        gap: 24,
        zIndex: 24,
        opacity: bandOpacity,
        translate: `0px ${enterLift.toFixed(1)}px`,
        scale: enterScale * baseScale,
        transformOrigin: "0% 50%"
      }}
    >
      <Brand size={32} iconSize={44} />
      <div
        style={{
          width: 2,
          height: 36,
          borderRadius: 999,
          background: "rgba(17, 24, 39, 0.12)"
        }}
      />
      <div
        style={{
          color: COLORS.foreground,
          fontSize: 50,
          fontWeight: 650,
          lineHeight: 1.16,
          letterSpacing: -1.8,
          whiteSpace: "nowrap"
        }}
      >
        不用等课代表，在 B 站直接<span style={{color: COLORS.pink}}>「读」</span>视频。
      </div>
    </div>
  );
};

const ToolbarEntryCallout = () => {
  const frame = useCurrentFrame();
  if (frame < PULLBACK_END - 4 || frame > CLICK_AT + 10) return null;
  const opacity = interpolate(frame, [PULLBACK_END - 4, CLICK_AT - 1, CLICK_AT + 2, CLICK_AT + 10], [0, 1, 0.92, 0], {
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
  const zoomFocusProgress = interpolate(frame, [ZOOM_FOCUS_START, ZOOM_FOCUS_END], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1)
  });
  const hookDriftScale = interpolate(frame, [0, PULLBACK_START], [1.34, 1.30], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const videoScale = interpolate(pullbackProgress, [0, 1], [hookDriftScale, 1]);
  const pullbackBlur = interpolate(pullbackProgress, [0, 1], [4.5, 1.2]);
  const videoBlur = interpolate(zoomFocusProgress, [0, 1], [pullbackBlur, 4.5]);
  const veilOpacity = interpolate(pullbackProgress, [0, 1], [1, 0.32]);
  const stageZoomScale = interpolate(zoomFocusProgress, [0, 1], [1, 1.26]);

  return (
    <AbsoluteFill style={{background: COLORS.background, fontFamily: FONT_FAMILY, overflow: "hidden"}}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          transformOrigin: "96% 6%",
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
                "radial-gradient(ellipse 55% 60% at 24% 42%, rgba(232, 93, 135, 0.08) 0%, rgba(232, 93, 135, 0) 70%)",
                "radial-gradient(ellipse 60% 65% at 78% 52%, rgba(38, 121, 184, 0.08) 0%, rgba(38, 121, 184, 0) 72%)",
                "linear-gradient(160deg, rgba(251, 251, 253, 0.34) 0%, rgba(244, 245, 248, 0.28) 100%)"
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
      <BiliPainPointBackdrop />
      <HeroMessage />
      <PainPointQuestionStack />
    </AbsoluteFill>
  );
};
